import assert from "node:assert/strict";
import test from "node:test";

import { stripTypes, transform } from "syntaxase";

const invalidPublicCalls = [
	["stripTypes source", () => stripTypes(null), /sourceText must be a string/u],
	["transform source", () => transform([], {}), /sourceText must be a string/u],
	["null options", () => transform("", null), /options must be an object/u],
	["array options", () => transform("", []), /options must be an object/u],
	["unknown option", () => transform("", { jsxx: true }), /options contains unknown option jsxx/u],
	["jsx shape", () => transform("", { jsx: [] }), /jsx must be a boolean or an object/u],
	["jsx key", () => transform("", { jsx: { unknown: true } }), /jsx contains unknown option unknown/u],
	["jsx runtime", () => transform("", { jsx: { runtime: "future" } }), /jsx\.runtime must be/u],
	[
		"automatic-only options",
		() => transform("", { jsx: { runtime: "automatic", pragma: "h" } }),
		/pragma is not supported with automatic runtime/u,
	],
	[
		"classic-only options",
		() => transform("", { jsx: { runtime: "classic", importSource: "preact" } }),
		/importSource is not supported with classic runtime/u,
	],
	[
		"preserve-only options",
		() => transform("", { jsx: { runtime: "preserve", development: false } }),
		/development is not supported with preserve runtime/u,
	],
];

for (const [name, run, expectedMessage] of invalidPublicCalls) {
	test(`public API rejects ${name}`, () => {
		assert.throws(run, { name: "TypeError", message: expectedMessage });
	});
}

test("parameter properties on constructor overload signatures report a located syntax error", () => {
	const source = "class A { constructor(public x: number); constructor(x) { this.x = x; } }";

	assert.throws(() => transform(source), {
		name: "SyntaxError",
		message: /Constructor parameter properties require a body \(1:10\)/u,
	});
});

test("classic JSX accepts and ignores the development selector", () => {
	const source = "const element = <View />;\n";
	const production = transform(source, { jsx: { runtime: "classic", development: false } });
	const development = transform(source, { jsx: { runtime: "classic", development: true } });
	const unreadDevelopment = { runtime: "classic" };
	Object.defineProperty(unreadDevelopment, "development", {
		enumerable: true,
		get() {
			throw new Error("classic development must not be read");
		},
	});

	assert.equal(development, production);
	assert.equal(transform(source, { jsx: unreadDevelopment }), production);
});
