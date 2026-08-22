import type { Node } from "@yuku-parser/wasm";
import type { WalkContext } from "yuku-ast";
import { syntaxErrorAt } from "./errors.ts";
import {
	isSupportedRuntimeNamespaceExportDeclaration,
	isTypeOnlyModule,
	nearestRuntimeNamespace,
} from "./namespace-semantics.ts";
import { findSourceText, previousSyntaxEnd, type SourceSpan } from "./source-gap.ts";
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

export interface TypeEraser {
	readonly exportedEnums: Set<string>;
	readonly mode: ErasureMode;
	readonly statementBoundaries: WeakMap<readonly unknown[], StatementBoundaryCursor>;
	readonly sourceFile: SourceFile;
	readonly edits: EditTree<"fixed">;
}

interface StatementBoundaryCursor {
	nextIndex: number;
	previousRuntimeStatement: Node | null;
}

export function createTypeEraser(
	sourceFile: SourceFile,
	edits: EditTree<"fixed">,
	mode: "strip" | "transform",
): TypeEraser {
	return {
		exportedEnums: new Set(),
		mode,
		statementBoundaries: new WeakMap(),
		sourceFile,
		edits,
	};
}

export function eraseTypeScriptNode(node: Node, walkContext: WalkContext, context: TypeEraser): boolean | void {
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
		case "AccessorProperty":
			if (node.declare === true) {
				eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
				return false;
			}
			eraseMemberSyntax(node, context);
			break;
		case "TSAbstractPropertyDefinition":
		case "TSAbstractAccessorProperty":
			eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
			return false;
		case "MethodDefinition":
			if (isDeclareMethod(node)) {
				eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
				return false;
			}
			eraseMemberSyntax(node, context);
			break;
		case "TSAbstractMethodDefinition":
			eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
			return false;
		case "TSIndexSignature":
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
			fixArrowParentheses(node, walkContext, context);
			break;
		default:
			break;
	}

	eraseGenericTypeProperties(node, context);
}

function eraseGenericTypeProperties(node: Node, context: TypeEraser): void {
	const typeRanges = genericTypeRanges(node);
	for (const value of typeRanges) {
		if (value !== null && value !== undefined) {
			addFixedBlank(context.edits, value.start, value.end);
		}
	}
}

function genericTypeRanges(node: Node): readonly (Node | null | undefined)[] {
	switch (node.type) {
		case "Identifier":
		case "ArrayPattern":
		case "ObjectPattern":
		case "AssignmentPattern":
		case "RestElement":
			return [node.typeAnnotation];
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "TSDeclareFunction":
		case "TSEmptyBodyFunctionExpression":
			return [node.typeParameters, node.returnType];
		case "ClassDeclaration":
		case "ClassExpression":
			return [node.typeParameters, node.superTypeArguments];
		case "CallExpression":
		case "NewExpression":
		case "TaggedTemplateExpression":
		case "TSInstantiationExpression":
		case "JSXOpeningElement":
			return [node.typeArguments];
		case "PropertyDefinition":
		case "AccessorProperty":
		case "TSAbstractPropertyDefinition":
		case "TSAbstractAccessorProperty":
			return [node.typeAnnotation];
		default:
			return [];
	}
}

function eraseClassSyntax(
	node: Extract<Node, { type: "ClassDeclaration" | "ClassExpression" }>,
	context: TypeEraser,
): void {
	if (node.abstract === true) {
		eraseRequiredKeyword(modifierStart(node), identifierStart(node), "abstract", context);
	}

	const implemented = node.implements;
	if (Array.isArray(implemented) && implemented.length > 0) {
		const first = implemented[0];
		const last = implemented[implemented.length - 1];
		const keyword = requireSourceText(context, node.start, first!.start, "implements", "backward");
		addFixedBlank(context.edits, keyword.start, last!.end);
	}
}

function eraseMemberSyntax(
	node: Extract<Node, { type: "PropertyDefinition" | "AccessorProperty" | "MethodDefinition" }>,
	context: TypeEraser,
): void {
	const key = node.key;
	const boundary = key.start;
	const searchStart = modifierStart(node);
	let firstModifierStart = boundary;
	let hasRemovableModifier = false;
	if (node.type !== "MethodDefinition" && node.readonly === true) {
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

	const decorators = node.decorators;
	if (node.computed === true && hasRemovableModifier && decorators.length === 0) {
		addFixedSubstitution(context.edits, firstModifierStart, ";");
	}

	const keyEnd = runtimeNameEnd(key, context);
	const markerEnd = memberMarkerEnd(node);
	if (node.optional === true) {
		eraseRequiredPunctuation(keyEnd, markerEnd, "?", context);
	}
	if (node.type !== "MethodDefinition" && node.definite === true) {
		eraseRequiredPunctuation(keyEnd, markerEnd, "!", context);
	}
}

function memberMarkerEnd(
	node: Extract<Node, { type: "PropertyDefinition" | "AccessorProperty" | "MethodDefinition" }>,
): number {
	if (node.type === "MethodDefinition") {
		return node.value.start;
	}
	return earliestNodeStart(node.typeAnnotation, node.value, node.end);
}

function eraseIdentifierSyntax(node: Extract<Node, { type: "Identifier" }>, context: TypeEraser): void {
	if (node.optional !== true) {
		return;
	}
	const annotation = node.typeAnnotation;
	const end = annotation?.start ?? node.end;
	eraseRequiredPunctuation(runtimeNameEnd(node, context), end, "?", context);
}

function eraseVariableDefinite(node: Extract<Node, { type: "VariableDeclarator" }>, context: TypeEraser): void {
	if (node.definite !== true) {
		return;
	}
	const annotation = node.id.typeAnnotation;
	const end = annotation?.start ?? node.id.end;
	const marker = requireSourceText(context, node.id.start, end, "!", "backward");
	addFixedBlank(context.edits, marker.start, marker.end);
}

function eraseParameterPropertyModifiers(
	node: Extract<Node, { type: "TSParameterProperty" }>,
	context: TypeEraser,
): void {
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

function eraseSuffixExpression(
	node: Extract<Node, { type: "TSAsExpression" | "TSSatisfiesExpression" | "TSNonNullExpression" }>,
	walkContext: WalkContext,
	context: TypeEraser,
): void {
	const changesBinaryGrouping = assertionWouldChangeBinaryGrouping(node, walkContext);
	if (assertionNeedsExponentParentheses(node, walkContext, changesBinaryGrouping)) {
		preserveExponentAssertionGrouping(node, context);
	} else if (context.mode === "strip" && changesBinaryGrouping) {
		throw syntaxErrorAt(node, "Type assertion cannot be erased without changing operator grouping");
	}
	addFixedBlank(context.edits, node.expression.end, node.end);
	if (endsContainingStatement(node, walkContext, context.sourceFile.text)) {
		addFixedSubstitution(context.edits, node.expression.end, ";");
	}
}

function erasePrefixAssertion(node: Extract<Node, { type: "TSTypeAssertion" }>, context: TypeEraser): void {
	addFixedBlank(context.edits, node.start, node.expression.start);
}

function eraseThisParameter(
	node: Extract<Node, { type: "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression" }>,
	context: TypeEraser,
): void {
	if (node.params.length === 0) {
		return;
	}
	const first = node.params[0];
	if (first === undefined || first.type !== "Identifier" || first.name !== "this") {
		return;
	}

	const second = node.params[1];
	if (second !== undefined) {
		const comma = requireSourceText(context, first.end, second.start, ",");
		addFixedBlank(context.edits, first.start, comma.end);
	} else {
		const bodyStart = node.body?.start ?? node.end;
		const comma = findSourceText(context.sourceFile.gaps, first.end, bodyStart, ",");
		addFixedBlank(context.edits, first.start, comma?.end ?? first.end);
	}
}

function visitImportDeclaration(
	node: Extract<Node, { type: "ImportDeclaration" }>,
	walkContext: WalkContext,
	context: TypeEraser,
): void {
	if (node.importKind === "type") {
		eraseWholeNode(node, context, needsSemicolonBeforeErasure(walkContext, context));
		return;
	}

	const specifiers = node.specifiers ?? [];
	const typeSpecifiers = specifiers.filter(
		(specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type",
	);
	if (typeSpecifiers.length === 0) {
		return;
	}
	const named = specifiers.filter((specifier) => specifier.type === "ImportSpecifier");
	for (const specifier of typeSpecifiers) {
		eraseListItem(specifier, named, node, context);
	}
}

function visitExportNamedDeclaration(
	node: Extract<Node, { type: "ExportNamedDeclaration" }>,
	walkContext: WalkContext,
	context: TypeEraser,
): void {
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
		eraseListItem(specifier, specifiers, node, context);
	}
}

function planTransformExportSyntax(
	node: Extract<Node, { type: "ExportNamedDeclaration" }>,
	walkContext: WalkContext,
	context: TypeEraser,
): void {
	const declaration = node.declaration;
	if (declaration === null) {
		return;
	}

	const namespace = nearestRuntimeNamespace(walkContext.ancestors());
	if (namespace !== null) {
		if (isSupportedRuntimeNamespaceExportDeclaration(declaration)) {
			blankExportKeyword(node, declaration, context);
		}
		return;
	}

	if (declaration.type !== "TSEnumDeclaration" || declaration.declare === true) {
		return;
	}
	const id = declaration.id;
	if (context.exportedEnums.has(id.name)) {
		blankExportKeyword(node, declaration, context);
	} else {
		context.exportedEnums.add(id.name);
	}
}

function blankExportKeyword(wrapper: Node, declaration: Node, context: TypeEraser): void {
	const exportToken = requireSourceText(context, wrapper.start, declaration.start, "export");
	addFixedBlank(context.edits, exportToken.start, exportToken.end);
}

function eraseListItem(item: Node, siblings: readonly Node[], container: Node, context: TypeEraser): void {
	const itemIndex = siblings.indexOf(item);
	const next = itemIndex < 0 ? undefined : siblings[itemIndex + 1];
	const gapEnd = next?.start ?? findListClosingBrace(item.end, container.end, context).start;
	const comma = findSourceText(context.sourceFile.gaps, item.end, gapEnd, ",");
	if (comma !== undefined) {
		addFixedBlank(context.edits, item.start, comma.end);
		return;
	}
	addFixedBlank(context.edits, item.start, item.end);
}

function findListClosingBrace(start: number, end: number, context: TypeEraser): SourceSpan {
	return requireSourceText(context, start, end, "}");
}

function eraseWholeNode(node: Node, context: TypeEraser, insertSemicolon = false): void {
	eraseWholeRange(node.start, node.end, context, insertSemicolon);
}

function eraseWholeRange(start: number, end: number, context: TypeEraser, insertSemicolon = false): void {
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

function needsSemicolonBeforeErasure(walkContext: WalkContext, context: TypeEraser): boolean {
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
	const statements = statementList(parent, key);
	if (statements === null) {
		return false;
	}
	const statement = previousRuntimeStatement(statements, index, context);
	return statement !== null && context.sourceFile.text[statement.end - 1] !== ";";
}

function previousRuntimeStatement(statements: readonly Node[], index: number, context: TypeEraser): Node | null {
	let cursor = context.statementBoundaries.get(statements);
	if (cursor === undefined || index < cursor.nextIndex) {
		cursor = { nextIndex: 0, previousRuntimeStatement: null };
		context.statementBoundaries.set(statements, cursor);
	}
	while (cursor.nextIndex < index) {
		const statement = statements[cursor.nextIndex];
		if (statement !== undefined && !isErasableStatement(statement)) {
			cursor.previousRuntimeStatement = statement;
		}
		cursor.nextIndex += 1;
	}
	// The caller invokes this only for the erasable statement at `index`.
	cursor.nextIndex = index + 1;
	return cursor.previousRuntimeStatement;
}

function statementList(parent: Node, key: string): readonly Node[] | null {
	if (key === "body") {
		switch (parent.type) {
			case "Program":
			case "BlockStatement":
			case "ClassBody":
			case "TSModuleBlock":
			case "StaticBlock":
				return parent.body;
			default:
				break;
		}
	}
	if (key === "consequent" && parent.type === "SwitchCase") {
		return parent.consequent;
	}
	return null;
}

function isRequiredStatementSlot(parent: Node, key: string): boolean {
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

function isErasableStatement(node: Node): boolean {
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
	if (node.type === "PropertyDefinition" || node.type === "AccessorProperty") {
		return node.declare === true;
	}
	if (node.type === "MethodDefinition") {
		return isDeclareMethod(node);
	}
	if (
		node.type === "TSAbstractPropertyDefinition" ||
		node.type === "TSAbstractAccessorProperty" ||
		node.type === "TSAbstractMethodDefinition" ||
		node.type === "TSIndexSignature"
	) {
		return true;
	}
	return false;
}

function endsContainingStatement(node: Node, walkContext: WalkContext, source: string): boolean {
	if (source[node.end] === ";") {
		return false;
	}
	const ancestors = walkContext.ancestors();
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!;
		if (ancestor.end !== node.end) {
			continue;
		}
		if (
			ancestor.type.endsWith("Statement") ||
			ancestor.type.endsWith("Declaration") ||
			ancestor.type === "PropertyDefinition" ||
			ancestor.type === "AccessorProperty"
		) {
			return true;
		}
	}
	return false;
}

function assertionWouldChangeBinaryGrouping(
	node: Extract<Node, { type: "TSAsExpression" | "TSSatisfiesExpression" | "TSNonNullExpression" }>,
	walkContext: WalkContext,
): boolean {
	let expression = node.expression;
	while (expression.type === "TSAsExpression" || expression.type === "TSSatisfiesExpression") {
		expression = expression.expression;
	}
	if (
		(expression.type !== "BinaryExpression" && expression.type !== "LogicalExpression") ||
		typeof expression.operator !== "string"
	) {
		return false;
	}

	const parent = walkContext.parent;
	if (
		parent === null ||
		walkContext.key !== "left" ||
		(parent.type !== "BinaryExpression" && parent.type !== "LogicalExpression")
	) {
		return false;
	}
	const nextOperator = parent.operator;
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
	node: Extract<Node, { type: "TSAsExpression" | "TSSatisfiesExpression" | "TSNonNullExpression" }>,
	walkContext: WalkContext,
	changesBinaryGrouping: boolean,
): boolean {
	const parent = walkContext.parent;
	if (parent?.type !== "BinaryExpression" || walkContext.key !== "left" || parent.operator !== "**") {
		return false;
	}
	return (
		node.expression.type === "UnaryExpression" ||
		node.expression.type === "AwaitExpression" ||
		changesBinaryGrouping
	);
}

function preserveExponentAssertionGrouping(
	node: Extract<Node, { type: "TSAsExpression" | "TSSatisfiesExpression" | "TSNonNullExpression" }>,
	context: TypeEraser,
): void {
	const expression = node.expression;
	const opening = expression.start - 1;
	const closing = node.end - 1;
	const openingCharacter = opening >= 0 ? context.sourceFile.text[opening] : undefined;
	if (
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

function fixArrowParentheses(
	node: Extract<Node, { type: "ArrowFunctionExpression" }>,
	walkContext: WalkContext,
	context: TypeEraser,
): void {
	moveOpeningParenthesisAcrossMultilineTypeParameters(node, walkContext, context);
	moveArrowClosingParenthesisAcrossMultilineReturnType(node, context);
}

// Stripping type parameters can expose a line break that makes JavaScript
// invalid after `async` or `throw`, or changes the parsing of `return` and
// `yield`. Reuse the existing parameter-list parenthesis so the output keeps
// the same UTF-16 length and line breaks.
function moveOpeningParenthesisAcrossMultilineTypeParameters(
	node: Extract<Node, { type: "ArrowFunctionExpression" }>,
	walkContext: WalkContext,
	context: TypeEraser,
): void {
	const typeParameters = node.typeParameters ?? null;
	if (typeParameters === null || !hasLineSensitiveArrowPrefix(node, typeParameters, walkContext, context)) {
		return;
	}

	const firstParameter = node.params[0];
	const openingBoundary = firstParameter?.start ?? earliestNodeStart(node.returnType, node.body, node.end);
	const opening = requireSourceText(context, typeParameters.end, openingBoundary, "(");
	if (!containsLineTerminator(context.sourceFile.text, typeParameters.start, opening.start)) {
		return;
	}

	addFixedSubstitution(context.edits, typeParameters.start, "(");
	addFixedBlank(context.edits, opening.start, opening.end);
}

function hasLineSensitiveArrowPrefix(
	node: Extract<Node, { type: "ArrowFunctionExpression" }>,
	typeParameters: Extract<Node, { type: "TSTypeParameterDeclaration" }>,
	walkContext: WalkContext,
	context: TypeEraser,
): boolean {
	if (node.async === true) {
		return true;
	}

	const parent = walkContext.parent;
	if (parent === null || !isLineSensitiveArgument(parent, node)) {
		return false;
	}
	const keyword = statementArgumentKeyword(parent);
	if (keyword === undefined) {
		return false;
	}
	const keywordEnd = parent.start + keyword.length;
	return !containsLineTerminator(context.sourceFile.text, keywordEnd, typeParameters.start);
}

function isLineSensitiveArgument(parent: Node, node: Node): boolean {
	return (
		(parent.type === "ReturnStatement" || parent.type === "ThrowStatement" || parent.type === "YieldExpression") &&
		parent.argument === node
	);
}

function statementArgumentKeyword(node: Node): "return" | "throw" | "yield" | undefined {
	if (node.type === "ReturnStatement") {
		return "return";
	}
	if (node.type === "ThrowStatement") {
		return "throw";
	}
	return node.type === "YieldExpression" ? "yield" : undefined;
}

function moveArrowClosingParenthesisAcrossMultilineReturnType(
	node: Extract<Node, { type: "ArrowFunctionExpression" }>,
	context: TypeEraser,
): void {
	const returnType = node.returnType ?? null;
	const body = node.body;
	if (returnType === null) {
		return;
	}

	const beforeReturn = requireSourceText(context, node.start, returnType.start, ")", "backward");
	const arrow = requireSourceText(context, returnType.end, body.start, "=>");
	if (!containsLineTerminator(context.sourceFile.text, beforeReturn.end, arrow.start)) {
		return;
	}

	const lastTypeEnd = previousSyntaxEnd(context.sourceFile.gaps, returnType.start, returnType.end);
	if (lastTypeEnd === undefined) {
		throw new Error(
			`Internal parser invariant: expected return type syntax in [${returnType.start}, ${returnType.end})`,
		);
	}

	addFixedBlank(context.edits, beforeReturn.start, beforeReturn.end);
	addFixedSubstitution(context.edits, lastTypeEnd - 1, ")");
}

function eraseRequiredKeyword(start: number, end: number, keyword: string, context: TypeEraser): number {
	const token = requireSourceText(context, start, end, keyword);
	addFixedBlank(context.edits, token.start, token.end);
	return token.start;
}

function eraseRequiredPunctuation(start: number, end: number, punctuation: string, context: TypeEraser): void {
	const token = requireSourceText(context, start, end, punctuation);
	addFixedBlank(context.edits, token.start, token.end);
}

function isWholeTypeOnlyExport(node: Node): boolean {
	if (node.type !== "ExportNamedDeclaration" && node.type !== "ExportDefaultDeclaration") {
		return false;
	}
	if (node.type === "ExportNamedDeclaration" && node.exportKind === "type") {
		return true;
	}
	const declaration = node.declaration;
	return (
		declaration !== null &&
		(WHOLE_TYPE_DECLARATIONS.has(declaration.type) ||
			isDeclareRuntimeDeclaration(declaration) ||
			(declaration.type === "TSImportEqualsDeclaration" && declaration.importKind === "type") ||
			(declaration.type === "TSModuleDeclaration" && isTypeOnlyModule(declaration)))
	);
}

function isDeclareRuntimeDeclaration(node: Node): boolean {
	return (
		(node.type === "ClassDeclaration" ||
			node.type === "FunctionDeclaration" ||
			node.type === "VariableDeclaration") &&
		node.declare === true
	);
}

function isDeclareMethod(node: Extract<Node, { type: "MethodDefinition" }>): boolean {
	return node.value.body === null;
}

function parameterRuntimeStart(node: Node, context: TypeEraser): number {
	if (node.type === "AssignmentPattern") {
		return parameterRuntimeStart(node.left, context);
	}
	if (node.type === "RestElement") {
		return parameterRuntimeStart(node.argument, context);
	}
	return node.type === "Identifier" ? node.start : runtimeNameEnd(node, context);
}

function runtimeNameEnd(node: Node, context: TypeEraser): number {
	if (node.type === "Identifier") {
		const typeAnnotation = node.typeAnnotation ?? null;
		const boundary = typeAnnotation?.start ?? node.end;
		if (node.optional === true) {
			const optional = requireSourceText(context, node.start, boundary, "?", "backward");
			const nameEnd = previousSyntaxEnd(context.sourceFile.gaps, node.start, optional.start);
			if (nameEnd !== undefined) {
				return nameEnd;
			}
		}
		return previousSyntaxEnd(context.sourceFile.gaps, node.start, boundary) ?? node.end;
	}
	return node.end;
}

function requireSourceText(
	context: TypeEraser,
	start: number,
	end: number,
	text: string,
	direction: "forward" | "backward" = "forward",
): SourceSpan {
	const span = findSourceText(context.sourceFile.gaps, start, end, text, direction);
	if (span === undefined) {
		throw new Error(`Internal parser invariant: expected ${JSON.stringify(text)} in [${start}, ${end})`);
	}
	return span;
}

function identifierStart(
	node: Extract<
		Node,
		{
			type:
				| "ClassDeclaration"
				| "ClassExpression"
				| "PropertyDefinition"
				| "AccessorProperty"
				| "MethodDefinition";
		}
	>,
): number {
	if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
		return node.id?.start ?? node.body.start;
	}
	return node.key.start;
}

function modifierStart(
	node: Extract<
		Node,
		{
			type:
				| "ClassDeclaration"
				| "ClassExpression"
				| "PropertyDefinition"
				| "AccessorProperty"
				| "MethodDefinition";
		}
	>,
): number {
	const decorators = node.decorators;
	if (!Array.isArray(decorators) || decorators.length === 0) {
		return node.start;
	}
	const lastDecorator = decorators.at(-1);
	return lastDecorator === undefined ? node.start : lastDecorator.end;
}

function earliestNodeStart(...values: readonly (Node | number | null | undefined)[]): number {
	let result = Number.POSITIVE_INFINITY;
	for (const value of values) {
		if (typeof value === "number") {
			result = Math.min(result, value);
		} else if (value !== null && value !== undefined) {
			result = Math.min(result, value.start);
		}
	}
	return result;
}

function isHorizontalWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\v" || character === "\f";
}
