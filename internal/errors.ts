import type { Node } from "@yuku-parser/wasm";

export interface LocatedSyntaxError extends SyntaxError {
	pos: number;
	loc?: {
		line: number;
		column: number;
	};
}

export function syntaxErrorAt(node: Node, message: string): LocatedSyntaxError {
	const error = new SyntaxError(message) as LocatedSyntaxError;
	error.pos = node.start;
	return error;
}
