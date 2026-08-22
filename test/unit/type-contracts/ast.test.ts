import type { Node, TSEnumDeclaration } from "@yuku-parser/wasm";
import type { Visitors } from "yuku-ast";

declare const node: Node;
declare const enumDeclaration: TSEnumDeclaration;

void node.type;
void node.start;
void node.end;

// @ts-expect-error Yuku's Node union requires discriminant narrowing for node-specific fields.
void node.body;

void enumDeclaration.id;
void enumDeclaration.body.members;

const visitors = {
	TSEnumDeclaration(enumNode) {
		void enumNode.body.members;
	},
	Identifier(identifier) {
		void identifier.name;
	},
} satisfies Visitors;

void visitors;
