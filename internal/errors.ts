import type { AstNode } from "./ast.ts";

export interface LocatedSyntaxError extends SyntaxError {
	pos: number;
	loc?: {
		line: number;
		column: number;
	};
}

export function syntaxErrorAt(node: AstNode, message: string): LocatedSyntaxError {
	const position = node.loc?.start;
	const suffix = position === undefined ? "" : ` (${position.line}:${position.column})`;
	const error = new SyntaxError(message + suffix) as LocatedSyntaxError;
	error.pos = node.start;
	if (position !== undefined) {
		error.loc = { line: position.line, column: position.column };
	}
	return error;
}
