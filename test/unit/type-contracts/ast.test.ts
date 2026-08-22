import type { AstNode, TsEnumDeclaration } from "../../../internal/ast.ts";
import { createAstVisitor } from "../../../internal/ast-walker.ts";

declare const node: AstNode;
declare const enumDeclaration: TsEnumDeclaration;

void node.type;
void node.start;
void node.end;

// @ts-expect-error Feature-owned parser fields do not leak into shared node identity.
void node.body;

void enumDeclaration.id;
void enumDeclaration.members;

interface FeatureNode extends AstNode {
	readonly payload?: AstNode;
}

createAstVisitor({}, (featureNode: FeatureNode) => {
	void featureNode.payload;
});
