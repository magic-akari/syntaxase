import { parse } from "@yuku-parser/wasm";

import { createSourceFile, type SourceFile } from "./internal/source-file.ts";

export function parseTypeScript(sourceText: string, jsx: boolean): SourceFile {
	const result = parse(sourceText, {
		attachComments: false,
		lang: jsx ? "tsx" : "ts",
		preserveParens: true,
		sourceType: "module",
	});
	const diagnostic = result.diagnostics.find(({ severity }) => severity === "error");
	if (diagnostic !== undefined) {
		const error = new SyntaxError(diagnostic.message) as SyntaxError & { pos: number };
		error.pos = diagnostic.start;
		throw error;
	}

	return createSourceFile(sourceText, result.program, result.comments);
}
