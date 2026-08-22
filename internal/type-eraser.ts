import { isNode as isAstNode, type AstNode } from "./ast.ts";
import { createAstVisitor, type AstVisitor, type NodeContext } from "./ast-walker.ts";
import { syntaxErrorAt } from "./errors.ts";
import {
	isSupportedRuntimeNamespaceExportDeclaration,
	isTypeOnlyModule,
	nearestRuntimeNamespace,
} from "./namespace-semantics.ts";
import {
	findTokenByLabel,
	firstTokenAtOrAfter,
	lastTokenBefore,
	requireLastTokenByLabel,
	requireLastTokenByText,
	requireLastTokenInRange,
	requireTokenAtOrAfterByLabel,
	requireTokenByLabel,
	requireTokenByText,
	tokenNameEnd,
	tokenText,
	type TokenIndexState,
} from "./token-index.ts";
import { containsLineTerminator } from "./source-layout.ts";
import type { SourceFile } from "./source-file.ts";
import { addFixedBlank, addFixedSubstitution, type EditTree } from "./edit-tree.ts";

type ErasureMode = "strip" | "transform";

const WHOLE_TYPE_DECLARATIONS: ReadonlySet<string> = new Set([
	"TSInterfaceDeclaration",
	"TSTypeAliasDeclaration",
	"TSDeclareFunction",
	"TSNamespaceExportDeclaration",
]);

const TYPE_RANGE_NODES: ReadonlySet<string> = new Set([
	"TSTypeAnnotation",
	"TSTypeParameterDeclaration",
	"TSTypeParameterInstantiation",
]);

interface ErasureContext {
	readonly exportedEnums: Set<string>;
	readonly mode: ErasureMode;
	readonly statementBoundaries: WeakMap<readonly unknown[], StatementBoundaryCursor>;
	readonly sourceFile: SourceFile;
	readonly edits: EditTree<"fixed">;
	readonly tokens: TokenIndexState;
}

interface StatementBoundaryCursor {
	nextIndex: number;
	previousRuntimeStatement: AstNode | null;
}

/** Parser fields consumed only by fixed-width type erasure. */
interface TypeErasureNode extends AstNode {
	readonly abstract?: boolean;
	readonly accessibility?: "private" | "protected" | "public";
	readonly argument?: TypeErasureNode | null;
	readonly async?: boolean;
	readonly body?: TypeErasureNode | readonly TypeErasureNode[] | null;
	readonly computed?: boolean;
	readonly consequent?: TypeErasureNode | readonly TypeErasureNode[];
	readonly declaration?: TypeErasureNode | null;
	readonly declare?: boolean;
	readonly decorators?: readonly TypeErasureNode[];
	readonly definite?: boolean;
	readonly exportKind?: "type" | "value";
	readonly expression?: TypeErasureNode;
	readonly id?: TypeErasureNode | null;
	readonly implements?: readonly TypeErasureNode[];
	readonly importKind?: "type" | "value";
	readonly key?: TypeErasureNode;
	readonly left?: TypeErasureNode;
	readonly name?: string;
	readonly operator?: string;
	readonly optional?: boolean;
	readonly override?: boolean;
	readonly parameter?: TypeErasureNode;
	readonly params?: readonly TypeErasureNode[];
	readonly readonly?: boolean;
	readonly returnType?: TypeErasureNode | null;
	readonly specifiers?: readonly TypeErasureNode[];
	readonly superTypeParameters?: TypeErasureNode | null;
	readonly typeAnnotation?: TypeErasureNode | null;
	readonly typeArguments?: TypeErasureNode | null;
	readonly typeParameters?: TypeErasureNode | null;
	readonly value?: unknown;
}

export function createTypeEraser(
	sourceFile: SourceFile,
	edits: EditTree<"fixed">,
	mode: "strip" | "transform",
): AstVisitor {
	const context: ErasureContext = {
		exportedEnums: new Set(),
		mode,
		statementBoundaries: new WeakMap(),
		sourceFile,
		edits,
		tokens: sourceFile.tokenIndex,
	};
	return createAstVisitor(context, visitNode);
}

function visitNode(node: TypeErasureNode, walkContext: NodeContext, context: ErasureContext): boolean | void {
	if (isWholeTypeOnlyExport(node)) {
		eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
		return false;
	}

	if (WHOLE_TYPE_DECLARATIONS.has(node.type)) {
		eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
		return false;
	}

	if (TYPE_RANGE_NODES.has(node.type)) {
		addFixedBlank(context.edits, node.start, node.end);
		return false;
	}

	if (isDeclareRuntimeDeclaration(node)) {
		eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
		return false;
	}

	switch (node.type) {
		case "ImportDeclaration":
			visitImportDeclaration(node, walkContext, context);
			break;
		case "ExportNamedDeclaration":
			visitExportNamedDeclaration(node, walkContext, context);
			break;
		case "ExportAllDeclaration":
			if (node.exportKind === "type") {
				eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
				return false;
			}
			break;
		case "TSEnumDeclaration":
			if (node.declare === true) {
				eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
				return false;
			}
			if (context.mode === "strip") {
				throw syntaxErrorAt(node, "TypeScript enum requires runtime lowering");
			}
			break;
		case "TSModuleDeclaration":
			if (isTypeOnlyModule(node)) {
				eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
				return false;
			}
			if (context.mode === "strip") {
				throw syntaxErrorAt(node, "Runtime TypeScript namespace/module is not supported");
			}
			break;
		case "TSImportEqualsDeclaration":
			if (node.importKind === "type") {
				eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
				return false;
			}
			if (context.mode === "strip") {
				throw syntaxErrorAt(node, "TypeScript import assignment requires runtime lowering");
			}
			return false;
		case "TSExportAssignment":
			if (context.mode === "strip") {
				throw syntaxErrorAt(node, "TypeScript export assignment requires runtime lowering");
			}
			throw syntaxErrorAt(node, "TypeScript export assignment is not supported in ESM output");
		case "TSTypeAssertion":
			if (context.mode === "strip") {
				throw syntaxErrorAt(node, "Prefix-style type assertions are not erasable in place");
			}
			erasePrefixAssertion(node, context);
			break;
		case "TSAsExpression":
		case "TSSatisfiesExpression":
		case "TSNonNullExpression":
			eraseSuffixExpression(node, walkContext, context);
			break;
		case "TSParameterProperty":
			if (context.mode === "strip") {
				throw syntaxErrorAt(node, "Constructor parameter properties require runtime lowering");
			}
			eraseParameterPropertyModifiers(node, context);
			return;
		case "ClassDeclaration":
		case "ClassExpression":
			eraseClassSyntax(node, context);
			break;
		case "PropertyDefinition":
			if (node.abstract === true || node.declare === true) {
				eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
				return false;
			}
			eraseMemberSyntax(node, context);
			break;
		case "MethodDefinition":
			if (isDeclareMethod(node) || node.abstract === true) {
				eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
				return false;
			}
			eraseMemberSyntax(node, context);
			break;
		case "TSIndexSignature":
			eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
			return false;
		case "TSDeclareMethod":
			eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
			return false;
		case "VariableDeclarator":
			eraseVariableDefinite(node, context);
			break;
		case "Identifier":
			eraseIdentifierSyntax(node, context);
			break;
		case "FunctionDeclaration":
		case "FunctionExpression":
			eraseThisParameter(node, context);
			break;
		case "ArrowFunctionExpression":
			eraseThisParameter(node, context);
			fixArrowParentheses(node, context);
			break;
		default:
			break;
	}

	eraseGenericTypeProperties(node, context);
	eraseTypeScriptModifiers(node, context);
}

function eraseGenericTypeProperties(node: TypeErasureNode, context: ErasureContext): void {
	const typeRanges = [
		node.typeAnnotation,
		node.typeParameters,
		node.typeArguments,
		node.returnType,
		node.superTypeParameters,
	];

	for (const value of typeRanges) {
		if (isAstNode(value)) {
			addFixedBlank(context.edits, value.start, value.end);
		}
	}
}

function eraseClassSyntax(node: TypeErasureNode, context: ErasureContext): void {
	if (node.abstract === true) {
		eraseRequiredKeyword(modifierStart(node), identifierStart(node), "abstract", context);
	}

	const implemented = node.implements;
	if (Array.isArray(implemented) && implemented.length > 0) {
		const first = implemented[0];
		const last = implemented[implemented.length - 1];
		if (isAstNode(first) && isAstNode(last)) {
			const keyword = requireLastTokenByText(context.tokens, node.start, first.start, "implements");
			addFixedBlank(context.edits, keyword.start, last.end);
		}
	}
}

function eraseMemberSyntax(node: TypeErasureNode, context: ErasureContext): void {
	const key = isAstNode(node.key) ? node.key : undefined;
	const boundary = key?.start ?? node.end;
	const searchStart = modifierStart(node);
	let firstModifierStart = boundary;
	let hasRemovableModifier = false;
	if (node.readonly === true) {
		const modifierStart = eraseRequiredKeyword(searchStart, boundary, "readonly", context);
		firstModifierStart = Math.min(firstModifierStart, modifierStart);
		hasRemovableModifier = true;
	}
	if (node.override === true) {
		const modifierStart = eraseRequiredKeyword(searchStart, boundary, "override", context);
		firstModifierStart = Math.min(firstModifierStart, modifierStart);
		hasRemovableModifier = true;
	}
	if (typeof node.accessibility === "string") {
		const modifierStart = eraseRequiredKeyword(searchStart, boundary, node.accessibility, context);
		firstModifierStart = Math.min(firstModifierStart, modifierStart);
		hasRemovableModifier = true;
	}

	const decorators = Array.isArray(node.decorators) ? node.decorators.filter(isAstNode) : [];
	if (node.computed === true && hasRemovableModifier && decorators.length === 0) {
		addFixedSubstitution(context.edits, firstModifierStart, ";");
	}

	if (key === undefined) {
		return;
	}
	const keyEnd = runtimeNameEnd(key, context);
	const markerEnd = earliestNodeStart(node.typeAnnotation, node.typeParameters, node.value, node.end);
	if (node.optional === true) {
		eraseRequiredPunctuation(keyEnd, markerEnd, "?", context);
	}
	if (node.definite === true) {
		eraseRequiredPunctuation(keyEnd, markerEnd, "!", context);
	}
}

function eraseIdentifierSyntax(node: TypeErasureNode, context: ErasureContext): void {
	if (node.optional !== true) {
		return;
	}
	const annotation = isAstNode(node.typeAnnotation) ? node.typeAnnotation : undefined;
	const end = annotation?.start ?? node.end;
	eraseRequiredPunctuation(runtimeNameEnd(node, context), end, "?", context);
}

function eraseVariableDefinite(node: TypeErasureNode, context: ErasureContext): void {
	if (node.definite !== true || !isAstNode(node.id)) {
		return;
	}
	const annotation = isAstNode(node.id.typeAnnotation) ? node.id.typeAnnotation : undefined;
	const end = annotation?.start ?? node.id.end;
	eraseRequiredPunctuation(runtimeNameEnd(node.id, context), end, "!", context);
}

function eraseParameterPropertyModifiers(node: TypeErasureNode, context: ErasureContext): void {
	if (!isAstNode(node.parameter)) {
		return;
	}
	const boundary = parameterRuntimeStart(node.parameter, context);
	if (typeof node.accessibility === "string") {
		eraseRequiredKeyword(node.start, boundary, node.accessibility, context);
	}
	if (node.readonly === true) {
		eraseRequiredKeyword(node.start, boundary, "readonly", context);
	}
	if (node.override === true) {
		eraseRequiredKeyword(node.start, boundary, "override", context);
	}
}

function eraseTypeScriptModifiers(node: TypeErasureNode, context: ErasureContext): void {
	if (node.type === "PropertyDefinition" || node.type === "MethodDefinition") {
		return;
	}

	const boundary = identifierStart(node);
	const searchStart = modifierStart(node);
	if (node.readonly === true) {
		eraseRequiredKeyword(searchStart, boundary, "readonly", context);
	}
	if (node.override === true) {
		eraseRequiredKeyword(searchStart, boundary, "override", context);
	}
	if (typeof node.accessibility === "string") {
		eraseRequiredKeyword(searchStart, boundary, node.accessibility, context);
	}
}

function eraseSuffixExpression(node: TypeErasureNode, walkContext: NodeContext, context: ErasureContext): void {
	if (!isAstNode(node.expression)) {
		return;
	}
	const changesBinaryGrouping = assertionWouldChangeBinaryGrouping(node, context);
	if (assertionNeedsExponentParentheses(node, context, changesBinaryGrouping)) {
		preserveExponentAssertionGrouping(node, context);
	} else if (context.mode === "strip" && changesBinaryGrouping) {
		throw syntaxErrorAt(node, "Type assertion cannot be erased without changing operator grouping");
	}
	addFixedBlank(context.edits, node.expression.end, node.end);
	if (endsContainingStatement(node, walkContext, context.sourceFile.text)) {
		addFixedSubstitution(context.edits, node.expression.end, ";");
	}
}

function erasePrefixAssertion(node: TypeErasureNode, context: ErasureContext): void {
	if (!isAstNode(node.expression)) {
		return;
	}
	addFixedBlank(context.edits, node.start, node.expression.start);
}

function eraseThisParameter(node: TypeErasureNode, context: ErasureContext): void {
	if (!Array.isArray(node.params) || node.params.length === 0) {
		return;
	}
	const first = node.params[0];
	if (first === undefined || first.type !== "Identifier" || first.name !== "this") {
		return;
	}

	const second = node.params[1];
	if (isAstNode(second)) {
		const comma = requireTokenByLabel(context.tokens, first.end, second.start, ",");
		addFixedBlank(context.edits, first.start, comma.end);
	} else {
		const bodyStart = isAstNode(node.body) ? node.body.start : node.end;
		const comma = findTokenByLabel(context.tokens, first.end, bodyStart, ",");
		addFixedBlank(context.edits, first.start, comma?.end ?? first.end);
	}
}

function visitImportDeclaration(node: TypeErasureNode, walkContext: NodeContext, context: ErasureContext): void {
	if (node.importKind === "type") {
		eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
		return;
	}

	const specifiers = node.specifiers ?? [];
	const typeSpecifiers = specifiers.filter((specifier) => specifier.importKind === "type");
	if (typeSpecifiers.length === 0) {
		return;
	}
	const named = specifiers.filter((specifier) => specifier.type === "ImportSpecifier");
	for (const specifier of typeSpecifiers) {
		eraseListItem(specifier, named, context);
	}
}

function visitExportNamedDeclaration(node: TypeErasureNode, walkContext: NodeContext, context: ErasureContext): void {
	if (context.mode === "transform") {
		planTransformExportSyntax(node, walkContext, context);
	}
	if (node.exportKind === "type") {
		eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
		return;
	}

	const specifiers = node.specifiers ?? [];
	const typeSpecifiers = specifiers.filter((specifier) => specifier.exportKind === "type");
	if (typeSpecifiers.length === 0) {
		return;
	}
	for (const specifier of typeSpecifiers) {
		eraseListItem(specifier, specifiers, context);
	}
}

function planTransformExportSyntax(node: TypeErasureNode, walkContext: NodeContext, context: ErasureContext): void {
	const declaration = isAstNode(node.declaration) ? node.declaration : null;
	if (declaration === null) {
		return;
	}

	const namespace = nearestRuntimeNamespace(walkContext.ancestors);
	if (namespace !== null) {
		if (isSupportedRuntimeNamespaceExportDeclaration(declaration)) {
			blankExportKeyword(node, declaration, context);
		}
		return;
	}

	if (declaration.type !== "TSEnumDeclaration" || declaration.declare === true) {
		return;
	}
	const id = isAstNode(declaration.id) ? declaration.id : null;
	if (id === null || typeof id.name !== "string") {
		return;
	}
	if (context.exportedEnums.has(id.name)) {
		blankExportKeyword(node, declaration, context);
	} else {
		context.exportedEnums.add(id.name);
	}
}

function blankExportKeyword(wrapper: AstNode, declaration: AstNode, context: ErasureContext): void {
	const exportToken = requireTokenByText(context.tokens, wrapper.start, declaration.start, "export");
	addFixedBlank(context.edits, exportToken.start, exportToken.end);
}

function eraseListItem(item: AstNode, _siblings: readonly AstNode[], context: ErasureContext): void {
	const trailing = firstTokenAtOrAfter(context.tokens, item.end);
	if (trailing?.type.label === ",") {
		addFixedBlank(context.edits, item.start, trailing.end);
		return;
	}
	addFixedBlank(context.edits, item.start, item.end);
}

function eraseWholeNode(node: AstNode, context: ErasureContext, insertSemicolon = false): void {
	eraseWholeRange(node.start, node.end, context, insertSemicolon);
}

function eraseWholeRange(start: number, end: number, context: ErasureContext, insertSemicolon = false): void {
	addFixedBlank(context.edits, start, end);
	if (!insertSemicolon) {
		return;
	}
	const marker = firstNonWhitespace(context.sourceFile.text, start, end);
	if (marker !== null) {
		addFixedSubstitution(context.edits, marker, ";");
	}
}

function firstNonWhitespace(source: string, start: number, end: number): number | null {
	for (let offset = start; offset < end; offset += 1) {
		if (source[offset]!.trim() !== "") {
			return offset;
		}
	}
	return null;
}

function needsSemicolonBeforeErasure(walkContext: NodeContext, context: ErasureContext): boolean {
	const { parent, key, index } = walkContext;
	if (parent === null || key === null) {
		return false;
	}
	if (index === null) {
		return isRequiredStatementSlot(parent, key);
	}
	if (key !== "body" && key !== "consequent") {
		return false;
	}
	const statements = (parent as TypeErasureNode)[key];
	if (!Array.isArray(statements)) {
		return false;
	}
	const statement = previousRuntimeStatement(statements, index, context);
	return statement !== null && context.sourceFile.text[statement.end - 1] !== ";";
}

function previousRuntimeStatement(
	statements: readonly unknown[],
	index: number,
	context: ErasureContext,
): AstNode | null {
	let cursor = context.statementBoundaries.get(statements);
	if (cursor === undefined || index < cursor.nextIndex) {
		cursor = { nextIndex: 0, previousRuntimeStatement: null };
		context.statementBoundaries.set(statements, cursor);
	}
	while (cursor.nextIndex < index) {
		const statement = statements[cursor.nextIndex];
		if (isAstNode(statement) && !isErasableStatement(statement as TypeErasureNode)) {
			cursor.previousRuntimeStatement = statement;
		}
		cursor.nextIndex += 1;
	}
	// The caller invokes this only for the erasable statement at `index`.
	cursor.nextIndex = index + 1;
	return cursor.previousRuntimeStatement;
}

function isRequiredStatementSlot(parent: AstNode, key: string): boolean {
	if (parent.type === "IfStatement") {
		return key === "consequent" || key === "alternate";
	}
	if (parent.type === "LabeledStatement") {
		return key === "body";
	}
	if (
		parent.type === "WhileStatement" ||
		parent.type === "DoWhileStatement" ||
		parent.type === "ForStatement" ||
		parent.type === "ForInStatement" ||
		parent.type === "ForOfStatement"
	) {
		return key === "body";
	}
	return false;
}

function isErasableStatement(node: TypeErasureNode): boolean {
	if (WHOLE_TYPE_DECLARATIONS.has(node.type) || isWholeTypeOnlyExport(node) || isDeclareRuntimeDeclaration(node)) {
		return true;
	}
	if (node.type === "TSEnumDeclaration") {
		return node.declare === true;
	}
	if (node.type === "TSModuleDeclaration") {
		return isTypeOnlyModule(node);
	}
	if (node.type === "ImportDeclaration") {
		return node.importKind === "type";
	}
	if (node.type === "PropertyDefinition") {
		return node.abstract === true || node.declare === true;
	}
	if (node.type === "MethodDefinition") {
		return node.abstract === true || isDeclareMethod(node);
	}
	if (node.type === "TSIndexSignature" || node.type === "TSDeclareMethod") {
		return true;
	}
	return false;
}

function endsContainingStatement(node: AstNode, walkContext: NodeContext, source: string): boolean {
	if (source[node.end] === ";") {
		return false;
	}
	for (let index = walkContext.ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = walkContext.ancestors[index]!;
		if (ancestor.end !== node.end) {
			continue;
		}
		if (
			ancestor.type.endsWith("Statement") ||
			ancestor.type.endsWith("Declaration") ||
			ancestor.type === "PropertyDefinition"
		) {
			return true;
		}
	}
	return false;
}

function assertionWouldChangeBinaryGrouping(node: TypeErasureNode, context: ErasureContext): boolean {
	let expression = node.expression;
	while (
		isAstNode(expression) &&
		(expression.type === "TSAsExpression" || expression.type === "TSSatisfiesExpression")
	) {
		expression = expression.expression;
	}
	if (
		!isAstNode(expression) ||
		(expression.type !== "BinaryExpression" && expression.type !== "LogicalExpression") ||
		typeof expression.operator !== "string"
	) {
		return false;
	}

	const next = firstTokenAtOrAfter(context.tokens, node.end);
	if (next === undefined) {
		return false;
	}
	const nextOperator = tokenText(context.tokens, next);
	const basePrecedence = binaryPrecedence(expression.operator);
	const nextPrecedence = binaryPrecedence(nextOperator);
	if (basePrecedence === undefined || nextPrecedence === undefined) {
		return false;
	}
	if (nextPrecedence > basePrecedence) {
		return true;
	}
	return nextPrecedence === basePrecedence && (expression.operator === "**" || nextOperator === "**");
}

function assertionNeedsExponentParentheses(
	node: TypeErasureNode,
	context: ErasureContext,
	changesBinaryGrouping: boolean,
): boolean {
	if (!isAstNode(node.expression)) {
		return false;
	}
	const next = firstTokenAtOrAfter(context.tokens, node.end);
	if (next === undefined || tokenText(context.tokens, next) !== "**") {
		return false;
	}
	return (
		node.expression.type === "UnaryExpression" ||
		node.expression.type === "AwaitExpression" ||
		changesBinaryGrouping
	);
}

function preserveExponentAssertionGrouping(node: TypeErasureNode, context: ErasureContext): void {
	const expression = isAstNode(node.expression) ? node.expression : null;
	const opening = expression === null ? -1 : expression.start - 1;
	const closing = node.end - 1;
	const openingCharacter = opening >= 0 ? context.sourceFile.text[opening] : undefined;
	if (
		expression === null ||
		openingCharacter === undefined ||
		!isHorizontalWhitespace(openingCharacter) ||
		closing < expression.end ||
		containsLineTerminator(context.sourceFile.text, closing, node.end)
	) {
		throw syntaxErrorAt(node, "Type assertion requires parentheses that cannot be inserted in place");
	}
	addFixedSubstitution(context.edits, opening, "(");
	addFixedSubstitution(context.edits, closing, ")");
}

function binaryPrecedence(operator: string): number | undefined {
	switch (operator) {
		case "**":
			return 15;
		case "*":
		case "/":
		case "%":
			return 14;
		case "+":
		case "-":
			return 13;
		case "<<":
		case ">>":
		case ">>>":
			return 12;
		case "<":
		case "<=":
		case ">":
		case ">=":
		case "instanceof":
		case "in":
			return 11;
		case "==":
		case "!=":
		case "===":
		case "!==":
			return 10;
		case "&":
			return 9;
		case "^":
			return 8;
		case "|":
			return 7;
		case "&&":
			return 6;
		case "||":
			return 5;
		case "??":
			return 4;
		default:
			return undefined;
	}
}

function fixArrowParentheses(node: TypeErasureNode, context: ErasureContext): void {
	moveOpeningParenthesisAcrossMultilineTypeParameters(node, context);
	moveArrowClosingParenthesisAcrossMultilineReturnType(node, context);
}

// Stripping type parameters can expose a line break that makes JavaScript
// invalid after `async` or `throw`, or changes the parsing of `return` and
// `yield`. Reuse the existing parameter-list parenthesis so the output keeps
// the same UTF-16 length and line breaks.
function moveOpeningParenthesisAcrossMultilineTypeParameters(node: TypeErasureNode, context: ErasureContext): void {
	const typeParameters = isAstNode(node.typeParameters) ? node.typeParameters : null;
	if (typeParameters === null || !hasLineSensitiveArrowPrefix(node, typeParameters, context)) {
		return;
	}

	const opening = requireTokenAtOrAfterByLabel(context.tokens, typeParameters.end, "(");
	if (!containsLineTerminator(context.sourceFile.text, typeParameters.start, opening.start)) {
		return;
	}

	addFixedSubstitution(context.edits, typeParameters.start, "(");
	addFixedBlank(context.edits, opening.start, opening.end);
}

function hasLineSensitiveArrowPrefix(node: TypeErasureNode, typeParameters: AstNode, context: ErasureContext): boolean {
	if (node.async === true) {
		return true;
	}

	const previous = lastTokenBefore(context.tokens, typeParameters.start);
	if (previous === undefined || containsLineTerminator(context.sourceFile.text, previous.end, typeParameters.start)) {
		return false;
	}

	const prefix = tokenText(context.tokens, previous);
	return prefix === "return" || prefix === "yield" || prefix === "throw";
}

function moveArrowClosingParenthesisAcrossMultilineReturnType(node: TypeErasureNode, context: ErasureContext): void {
	if (node.type !== "ArrowFunctionExpression") {
		return;
	}
	const returnType = isAstNode(node.returnType) ? node.returnType : null;
	const body = isAstNode(node.body) ? node.body : null;
	if (returnType === null || body === null) {
		return;
	}

	const beforeReturn = requireLastTokenByLabel(context.tokens, node.start, returnType.start, ")");
	const arrow = requireTokenByText(context.tokens, returnType.end, body.start, "=>");
	if (!containsLineTerminator(context.sourceFile.text, beforeReturn.end, arrow.start)) {
		return;
	}

	const lastTypeToken = requireLastTokenInRange(context.tokens, returnType.start, returnType.end);

	addFixedBlank(context.edits, beforeReturn.start, beforeReturn.end);
	addFixedSubstitution(context.edits, lastTypeToken.end - 1, ")");
}

function eraseRequiredKeyword(start: number, end: number, keyword: string, context: ErasureContext): number {
	const token = requireTokenByText(context.tokens, start, end, keyword);
	addFixedBlank(context.edits, token.start, token.end);
	return token.start;
}

function eraseRequiredPunctuation(start: number, end: number, punctuation: string, context: ErasureContext): void {
	const token = requireTokenByText(context.tokens, start, end, punctuation);
	addFixedBlank(context.edits, token.start, token.end);
}

function isWholeTypeOnlyExport(node: TypeErasureNode): boolean {
	if (node.type !== "ExportNamedDeclaration" && node.type !== "ExportDefaultDeclaration") {
		return false;
	}
	if (node.type === "ExportNamedDeclaration" && node.exportKind === "type") {
		return true;
	}
	const declaration = node.declaration;
	return (
		isAstNode(declaration) &&
		(WHOLE_TYPE_DECLARATIONS.has(declaration.type) ||
			isDeclareRuntimeDeclaration(declaration) ||
			(declaration.type === "TSModuleDeclaration" && isTypeOnlyModule(declaration)))
	);
}

function isDeclareRuntimeDeclaration(node: TypeErasureNode): boolean {
	if (node.declare !== true) {
		return false;
	}
	return (
		node.type === "ClassDeclaration" || node.type === "FunctionDeclaration" || node.type === "VariableDeclaration"
	);
}

function isDeclareMethod(node: TypeErasureNode): boolean {
	const value = node.value;
	if (!isAstNode(value)) {
		return false;
	}
	return value.type === "TSDeclareMethod" || (value as TypeErasureNode).body === null;
}

function parameterRuntimeStart(node: TypeErasureNode, context: ErasureContext): number {
	if (node.type === "AssignmentPattern" && isAstNode(node.left)) {
		return parameterRuntimeStart(node.left, context);
	}
	if (node.type === "RestElement" && isAstNode(node.argument)) {
		return parameterRuntimeStart(node.argument, context);
	}
	return node.type === "Identifier" ? node.start : runtimeNameEnd(node, context);
}

function runtimeNameEnd(node: AstNode, context: ErasureContext): number {
	if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
		return tokenNameEnd(context.tokens, node);
	}
	return node.end;
}

function identifierStart(node: TypeErasureNode): number {
	if (isAstNode(node.id)) {
		return node.id.start;
	}
	if (isAstNode(node.key)) {
		return node.key.start;
	}
	if (isAstNode(node.parameter)) {
		return node.parameter.start;
	}
	return node.end;
}

function modifierStart(node: TypeErasureNode): number {
	const decorators = node.decorators;
	if (!Array.isArray(decorators) || decorators.length === 0) {
		return node.start;
	}
	const lastDecorator = decorators.at(-1);
	return lastDecorator === undefined ? node.start : lastDecorator.end;
}

function earliestNodeStart(...values: unknown[]): number {
	let result = Number.POSITIVE_INFINITY;
	for (const value of values) {
		if (isAstNode(value)) {
			result = Math.min(result, value.start);
		} else if (typeof value === "number") {
			result = Math.min(result, value);
		}
	}
	return result;
}

function isHorizontalWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\v" || character === "\f";
}
