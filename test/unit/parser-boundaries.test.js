import assert from "node:assert/strict";
import test from "node:test";

import { parseTypeScript } from "../../parser.js";

const ambiguousConditional = "a ? (b) : (b = function () { c >> d; });\n";

test("a conditional expression does not consume a following local export", () => {
	const sourceFile = parseTypeScript(`${ambiguousConditional}let x;\nexport { x };\n`, false);

	assert.deepEqual(
		sourceFile.ast.body.map((statement) => statement.type),
		["ExpressionStatement", "VariableDeclaration", "ExportNamedDeclaration"],
	);
});

test("a conditional expression does not consume a following top-level await", () => {
	const sourceFile = parseTypeScript(`${ambiguousConditional}await 1;\n`, false);

	assert.deepEqual(
		sourceFile.ast.body.map((statement) => statement.type),
		["ExpressionStatement", "ExpressionStatement"],
	);
});

test("a conditional expression does not hide an invalid top-level return", () => {
	assert.throws(
		() => parseTypeScript(`${ambiguousConditional}return;\n`, false),
		/'return' statement is only valid inside a function/u,
	);
});
