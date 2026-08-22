import { Parser } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";

import { type AstProgram, type SyntaxComment, type SyntaxToken } from "./internal/ast.ts";
import { createSourceFile, type SourceFile } from "./internal/source-file.ts";

const TypeScriptParser = Parser.extend(tsPlugin());
const TypeScriptJsxParser = Parser.extend(tsPlugin({ jsx: true }));

export function parseTypeScript(sourceText: string, jsx: boolean): SourceFile {
	const ParserClass = jsx ? TypeScriptJsxParser : TypeScriptParser;
	const tokens: SyntaxToken[] = [];
	const comments: SyntaxComment[] = [];
	const ast = ParserClass.parse(sourceText, {
		allowHashBang: true,
		ecmaVersion: "latest",
		locations: true,
		onComment: comments as never,
		onToken: tokens as never,
		preserveParens: true,
		sourceType: "module",
	}) as unknown as AstProgram;

	return createSourceFile(sourceText, ast, tokens, comments);
}
