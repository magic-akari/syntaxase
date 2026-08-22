import type { AstNode } from "../ast.ts";

export interface ExpressionContext {
	readonly parent: AstNode;
	readonly value: AstNode;
}

export function findNonTransparentExpressionContext(
	expression: AstNode,
	ancestors: readonly AstNode[],
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

function isTransparentExpressionWrapper(parent: AstNode, value: AstNode): boolean {
	if ((parent as AstNode & { readonly expression?: AstNode }).expression !== value) {
		return false;
	}
	return (
		parent.type === "TSAsExpression" ||
		parent.type === "TSSatisfiesExpression" ||
		parent.type === "TSNonNullExpression" ||
		parent.type === "TSTypeAssertion" ||
		parent.type === "TSInstantiationExpression" ||
		parent.type === "ParenthesizedExpression" ||
		parent.type === "ChainExpression"
	);
}
