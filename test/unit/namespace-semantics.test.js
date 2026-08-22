import assert from "node:assert/strict";
import test from "node:test";

import { isTypeOnlyModule } from "../../internal/namespace-semantics.js";
import { parseTypeScript } from "../../parser.js";

test("a namespace containing only type declarations has no runtime state", () => {
	const sourceFile = parseTypeScript("namespace Types { export interface Value {} }\n", false);
	const namespace = sourceFile.ast.body[0];

	assert.equal(isTypeOnlyModule(namespace), true);
});

test("a namespace containing a value declaration has runtime state", () => {
	const sourceFile = parseTypeScript("namespace Values { export const value = 1; }\n", false);
	const namespace = sourceFile.ast.body[0];

	assert.equal(isTypeOnlyModule(namespace), false);
});
