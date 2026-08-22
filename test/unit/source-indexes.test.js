import assert from "node:assert/strict";
import test from "node:test";

import { findSourceText, previousSyntaxEnd } from "../../internal/source-gap.js";
import { sourceCommentsInRange } from "../../internal/source-file.js";
import { parseTypeScript } from "../../parser.js";

test("SourceFile owns source gaps and one physical-line layout", () => {
	const sourceFile = parseTypeScript("const value: number = 1;\n", false);

	assert.equal("tokens" in sourceFile, false);
	assert.equal("tokenIndex" in sourceFile, false);
	assert.ok(sourceFile.gaps);
	assert.equal(sourceFile.layout.length, 2);
	assert.equal(sourceFile.layout[0].terminator, "\n");
});

test("source-gap queries use bounded spans and ignore comments", () => {
	const source = "class Value /* implements */ implements First {}";
	const sourceFile = parseTypeScript(source, false);
	const firstStart = source.indexOf("First");
	const actualImplements = findSourceText(sourceFile.gaps, 0, firstStart, "implements", "backward");

	assert.equal(actualImplements.start, source.lastIndexOf("implements", firstStart));
	assert.equal(findSourceText(sourceFile.gaps, 0, source.length, "missing"), undefined);
});

test("previous syntax boundaries skip comments and whitespace", () => {
	const source = "value /* trailing */   ";
	const sourceFile = parseTypeScript(source, false);

	assert.equal(previousSyntaxEnd(sourceFile.gaps, 0, source.length), "value".length);
});

test("comment range queries preserve interval semantics", () => {
	const source = "/* before */ value /* inside */ + other // after\n";
	const sourceFile = parseTypeScript(source, false);
	const start = source.indexOf("/* inside */");
	const end = source.indexOf("// after");

	assert.equal(sourceCommentsInRange(sourceFile, start, end), "/* inside */");
	assert.equal(sourceCommentsInRange(sourceFile, end, source.length), "// after\n");
	assert.equal(sourceCommentsInRange(sourceFile, start + 1, end), "");
});
