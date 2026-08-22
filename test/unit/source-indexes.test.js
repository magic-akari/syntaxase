import assert from "node:assert/strict";
import test from "node:test";

import { sourceCommentsInRange } from "../../internal/source-file.js";
import { findTokenByText, requireLastTokenByText, requireTokenByText } from "../../internal/token-index.js";
import { parseTypeScript } from "../../parser.js";

test("SourceFile owns one token index and one physical-line layout", () => {
	const sourceFile = parseTypeScript("const value: number = 1;\n", false);

	assert.equal("tokens" in sourceFile, false);
	assert.equal(sourceFile.layout.length, 2);
	assert.equal(sourceFile.layout[0].terminator, "\n");
});

test("optional and required token queries have distinct missing-token semantics", () => {
	const source = "class Value extends Base.implements implements First, Second {}";
	const sourceFile = parseTypeScript(source, false);
	const firstStart = source.indexOf("First");
	const lastImplements = requireLastTokenByText(sourceFile.tokenIndex, 0, firstStart, "implements");

	assert.equal(lastImplements.start, source.lastIndexOf("implements", firstStart));
	assert.equal(findTokenByText(sourceFile.tokenIndex, 0, source.length, "missing"), undefined);
	assert.throws(
		() => requireTokenByText(sourceFile.tokenIndex, 0, source.length, "missing"),
		/Internal parser invariant: expected "missing"/u,
	);
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
