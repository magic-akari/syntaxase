import type { BlockStatement, ClassBody, MethodDefinition, Node, TSParameterProperty } from "@yuku-parser/wasm";
import { walk, type WalkContext } from "yuku-ast";
import { syntaxErrorAt } from "../errors.ts";
import { addRuntimeInsertion, addRuntimeReplacement, type EditTree } from "../edit-tree.ts";
import { findNonTransparentExpressionContext } from "./expression-context.ts";

export interface ParameterPropertiesFeatureTask {
	readonly kind: "parameter-properties";
	readonly classBody: ClassBody;
	readonly constructor: MethodDefinition["value"];
	readonly method: MethodDefinition;
	readonly properties: readonly TSParameterProperty[];
}

export function collectParameterPropertiesFeature(
	node: MethodDefinition,
	parent: Node | null,
): ParameterPropertiesFeatureTask | null {
	if (parent?.type !== "ClassBody" || node.kind !== "constructor") {
		return null;
	}
	const parameters = node.value.params;
	const properties = parameters.filter(
		(parameter): parameter is TSParameterProperty => parameter.type === "TSParameterProperty",
	);
	if (properties.length === 0) {
		return null;
	}
	return {
		kind: "parameter-properties",
		classBody: parent,
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
	if (body === null) {
		throw syntaxErrorAt(method, "Constructor parameter properties require a body");
	}

	const assignmentExpressions = propertyNames.map((name) => `this.${name}=${name}`);
	const assignmentExpressionText = assignmentExpressions.join(",");
	const superState: ParameterPropertySuperState = {
		assignmentExpressionText,
		found: false,
		edits,
	};
	walk(body, {
		enter(node, context) {
			const descend = lowerParameterPropertySuperCall(node, context, superState);
			if (descend === false) {
				context.skip();
			}
		},
	});
	if (!superState.found) {
		const assignmentStatementText = assignmentExpressions.map((assignment) => `${assignment};`).join("");
		const insertionOffset = baseConstructorAssignmentOffset(body);
		addRuntimeInsertion(edits, insertionOffset, `;${assignmentStatementText}`);
	}
}

function lowerParameterPropertyClassFields(
	classBody: ClassBody,
	propertyNames: readonly string[],
	edits: EditTree<"runtime">,
): void {
	const requestedNames = new Set(propertyNames);
	const runtimeFieldNames = new Set<string>();
	const declareFieldSlots = new Map<string, Node>();
	const members = classBody.body;

	for (const member of members) {
		if (member.type !== "PropertyDefinition") {
			continue;
		}
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

function parameterPropertyClassFieldName(
	node: Extract<ClassBody["body"][number], { type: "PropertyDefinition" }>,
): string | null {
	if (node.static === true || node.computed === true || node.key.type !== "Identifier") {
		return null;
	}
	return node.key.name;
}

function isRuntimeDataField(node: Extract<ClassBody["body"][number], { type: "PropertyDefinition" }>): boolean {
	return node.declare !== true;
}

function isReusableDeclareField(node: Extract<ClassBody["body"][number], { type: "PropertyDefinition" }>): boolean {
	return node.declare === true && node.value === null;
}

interface ParameterPropertySuperState {
	readonly assignmentExpressionText: string;
	found: boolean;
	readonly edits: EditTree<"runtime">;
}

function lowerParameterPropertySuperCall(
	node: Node,
	context: WalkContext,
	state: ParameterPropertySuperState,
): boolean | void {
	if (isNestedSuperScope(node)) {
		return false;
	}
	if (node.type !== "CallExpression" || node.callee.type !== "Super") {
		return;
	}

	state.found = true;
	const expressionContext = findNonTransparentExpressionContext(node, context.ancestors());
	const isWholeStatement =
		expressionContext?.parent.type === "ExpressionStatement" &&
		expressionContext.parent.expression === expressionContext.value;
	if (isWholeStatement) {
		addRuntimeInsertion(state.edits, node.end, `,${state.assignmentExpressionText}`);
		return false;
	}

	addRuntimeInsertion(state.edits, node.start, "[");
	addRuntimeInsertion(state.edits, node.end, `,${state.assignmentExpressionText}][0]`);
	return false;
}

function isNestedSuperScope(node: Node): boolean {
	return (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression" ||
		node.type === "ClassDeclaration" ||
		node.type === "ClassExpression"
	);
}

function baseConstructorAssignmentOffset(body: BlockStatement): number {
	const statements = body.body;
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

function parameterPropertyName(node: TSParameterProperty): string {
	const parameter = node.parameter.type === "AssignmentPattern" ? node.parameter.left : node.parameter;
	if (parameter.type !== "Identifier") {
		throw syntaxErrorAt(node, "Parameter property must use an identifier");
	}
	return parameter.name;
}
