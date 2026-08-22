import {
	isNode,
	type AstNode,
	type ClassBodyNode,
	type FunctionLikeNode,
	type MethodDefinitionNode,
	type TsParameterProperty,
} from "../ast.ts";
import { createAstVisitor, walkAst, type NodeContext } from "../ast-walker.ts";
import { syntaxErrorAt } from "../errors.ts";
import { addRuntimeInsertion, addRuntimeReplacement, type EditTree } from "../edit-tree.ts";
import { findNonTransparentExpressionContext } from "./expression-context.ts";

interface ParameterPropertySyntaxNode extends AstNode {
	readonly abstract?: boolean;
	readonly accessor?: boolean;
	readonly body?: ParameterPropertySyntaxNode | readonly ParameterPropertySyntaxNode[] | null;
	readonly callee?: ParameterPropertySyntaxNode;
	readonly computed?: boolean;
	readonly declare?: boolean;
	readonly directive?: string;
	readonly expression?: ParameterPropertySyntaxNode;
	readonly key?: ParameterPropertySyntaxNode;
	readonly kind?: string;
	readonly left?: ParameterPropertySyntaxNode;
	readonly name?: string;
	readonly params?: readonly ParameterPropertySyntaxNode[];
	readonly static?: boolean;
	readonly value?: unknown;
}

export interface ParameterPropertiesFeatureTask {
	readonly kind: "parameter-properties";
	readonly classBody: ClassBodyNode;
	readonly constructor: FunctionLikeNode;
	readonly method: MethodDefinitionNode;
	readonly properties: readonly TsParameterProperty[];
}

export function collectParameterPropertiesFeature(
	node: MethodDefinitionNode,
	parent: AstNode | null,
): ParameterPropertiesFeatureTask | null {
	if (parent?.type !== "ClassBody" || node.kind !== "constructor") {
		return null;
	}
	const parameters = node.value.params;
	const properties = parameters.filter(
		(parameter): parameter is TsParameterProperty => parameter.type === "TSParameterProperty",
	);
	if (properties.length === 0) {
		return null;
	}
	return {
		kind: "parameter-properties",
		classBody: parent as ClassBodyNode,
		constructor: node.value,
		method: node,
		properties,
	};
}

export function lowerParameterProperties(task: ParameterPropertiesFeatureTask, edits: EditTree<"runtime">): void {
	const { classBody, constructor, method, properties } = task;
	const propertyNames = properties.map(parameterPropertyName);
	lowerParameterPropertyClassFields(classBody, propertyNames, edits);

	const body = constructor.body;
	if (!isNode(body) || body.type !== "BlockStatement") {
		throw syntaxErrorAt(method, "Constructor parameter properties require a body");
	}

	const assignmentExpressions = propertyNames.map((name) => `this.${name}=${name}`);
	const assignmentExpressionText = assignmentExpressions.join(",");
	const superState: ParameterPropertySuperState = {
		assignmentExpressionText,
		found: false,
		edits,
	};
	walkAst(body, [createAstVisitor(superState, lowerParameterPropertySuperCall)]);
	if (!superState.found) {
		const assignmentStatementText = assignmentExpressions.map((assignment) => `${assignment};`).join("");
		const insertionOffset = baseConstructorAssignmentOffset(body);
		addRuntimeInsertion(edits, insertionOffset, `;${assignmentStatementText}`);
	}
}

function lowerParameterPropertyClassFields(
	classBody: ClassBodyNode,
	propertyNames: readonly string[],
	edits: EditTree<"runtime">,
): void {
	const requestedNames = new Set(propertyNames);
	const runtimeFieldNames = new Set<string>();
	const declareFieldSlots = new Map<string, AstNode>();
	const members = classBody.body as readonly ParameterPropertySyntaxNode[];

	for (const member of members) {
		const fieldName = parameterPropertyClassFieldName(member);
		if (fieldName === null || !requestedNames.has(fieldName)) {
			continue;
		}
		if (isRuntimeDataField(member)) {
			runtimeFieldNames.add(fieldName);
			continue;
		}
		if (isReusableDeclareField(member) && !declareFieldSlots.has(fieldName)) {
			declareFieldSlots.set(fieldName, member.key!);
		}
	}

	const plannedNames = new Set(runtimeFieldNames);
	const missingNames: string[] = [];
	for (const name of propertyNames) {
		if (plannedNames.has(name)) {
			continue;
		}
		const declareSlot = declareFieldSlots.get(name);
		if (declareSlot === undefined) {
			missingNames.push(name);
		} else {
			addRuntimeReplacement(edits, declareSlot.start, declareSlot.end, `${name};`);
		}
		plannedNames.add(name);
	}

	if (missingNames.length > 0) {
		const fields = missingNames.map((name) => `${name};`).join("");
		addRuntimeInsertion(edits, classBody.start + 1, fields);
	}
}

function parameterPropertyClassFieldName(node: ParameterPropertySyntaxNode): string | null {
	if (
		node.type !== "PropertyDefinition" ||
		node.static === true ||
		node.computed === true ||
		!isNode(node.key) ||
		node.key.type !== "Identifier" ||
		typeof node.key.name !== "string"
	) {
		return null;
	}
	return node.key.name;
}

function isRuntimeDataField(node: ParameterPropertySyntaxNode): boolean {
	return node.declare !== true && node.abstract !== true && node.accessor !== true;
}

function isReusableDeclareField(node: ParameterPropertySyntaxNode): boolean {
	return node.declare === true && node.abstract !== true && node.accessor !== true && node.value === null;
}

interface ParameterPropertySuperState {
	readonly assignmentExpressionText: string;
	found: boolean;
	readonly edits: EditTree<"runtime">;
}

function lowerParameterPropertySuperCall(
	node: ParameterPropertySyntaxNode,
	context: NodeContext,
	state: ParameterPropertySuperState,
): boolean | void {
	if (isNestedSuperScope(node)) {
		return false;
	}
	if (node.type !== "CallExpression" || !isNode(node.callee) || node.callee.type !== "Super") {
		return;
	}

	state.found = true;
	const expressionContext = findNonTransparentExpressionContext(node, context.ancestors);
	const isWholeStatement =
		expressionContext?.parent.type === "ExpressionStatement" &&
		(expressionContext.parent as ParameterPropertySyntaxNode).expression === expressionContext.value;
	if (isWholeStatement) {
		addRuntimeInsertion(state.edits, node.end, `,${state.assignmentExpressionText}`);
		return false;
	}

	addRuntimeInsertion(state.edits, node.start, "[");
	addRuntimeInsertion(state.edits, node.end, `,${state.assignmentExpressionText}][0]`);
	return false;
}

function isNestedSuperScope(node: AstNode): boolean {
	return (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression" ||
		node.type === "ClassDeclaration" ||
		node.type === "ClassExpression"
	);
}

function baseConstructorAssignmentOffset(body: ParameterPropertySyntaxNode): number {
	const statements = Array.isArray(body.body) ? body.body : [];
	let offset = body.start + 1;
	for (const statement of statements) {
		if (statement.type === "ExpressionStatement" && typeof statement.directive === "string") {
			offset = statement.end;
			continue;
		}
		break;
	}
	return offset;
}

function parameterPropertyName(node: TsParameterProperty): string {
	let parameter = node.parameter as ParameterPropertySyntaxNode;
	if (parameter.type === "AssignmentPattern") {
		parameter = parameter.left!;
	}
	if (parameter.type !== "Identifier" || typeof parameter.name !== "string") {
		throw syntaxErrorAt(node, "Parameter property must use an identifier");
	}
	return parameter.name;
}
