import type { Node } from "@yuku-parser/wasm";

export interface ExpressionContext {
	readonly parent: Node;
	readonly value: Node;
}

export function findNonTransparentExpressionContext(
	expression: Node,
	ancestors: readonly Node[],
): ExpressionContext | null {
	let value = expression;
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const parent = ancestors[index]!;
		if (isTransparentExpressionWrapper(parent, value)) {
			value = parent;
			continue;
		}
		return { parent, value };
	}
	return null;
}

function isTransparentExpressionWrapper(parent: Node, value: Node): boolean {
	switch (parent.type) {
		case "TSAsExpression":
		case "TSSatisfiesExpression":
		case "TSNonNullExpression":
		case "TSTypeAssertion":
		case "TSInstantiationExpression":
		case "ParenthesizedExpression":
		case "ChainExpression":
			return parent.expression === value;
		default:
			return false;
	}
}
