import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "acorn";

import * as publicApi from "syntaxase";

test("public entry exposes the basic APIs", () => {
	assert.equal(typeof publicApi.stripTypes, "function");
	assert.equal(typeof publicApi.transform, "function");
});

test("stripTypes runs through the built public entry", () => {
	const source = "const answer: number = 42;\n";
	const output = publicApi.stripTypes(source);

	assert.equal(output.length, source.length);
	assert.doesNotThrow(() => parse(output, { ecmaVersion: "latest", sourceType: "module" }));
});

test("transform connects TypeScript runtime lowering and JSX emission", () => {
	const source = "enum E { A }\nexport const view = <div>{E.A}</div>;\n";
	const output = publicApi.transform(source, { jsx: true });

	assert.match(output, /react\/jsx-runtime/u);
	assert.doesNotThrow(() => parse(output, { ecmaVersion: "latest", sourceType: "module" }));
});
