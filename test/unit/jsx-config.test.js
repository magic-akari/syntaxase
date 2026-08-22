import assert from "node:assert/strict";
import test from "node:test";

import { jsxConfigRuntimeIdentifierNames, resolveJSXConfig } from "../../internal/jsx-config.js";

test("automatic JSX configuration resolves all defaults", () => {
	assert.deepEqual(resolveJSXConfig(true), {
		development: false,
		importSource: "react",
		runtime: "automatic",
	});
});

test("classic JSX configuration exposes only pragma root bindings", () => {
	const config = resolveJSXConfig({
		pragma: "Factory.createElement",
		pragmaFrag: "Fragments.Root",
		runtime: "classic",
	});

	assert.deepEqual(jsxConfigRuntimeIdentifierNames(config), ["Factory", "Fragments"]);
});

test("preserve JSX configuration has no runtime bindings", () => {
	const config = resolveJSXConfig({ runtime: "preserve" });

	assert.deepEqual(config, { runtime: "preserve" });
	assert.deepEqual(jsxConfigRuntimeIdentifierNames(config), []);
});
