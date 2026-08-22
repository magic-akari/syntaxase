import assert from "node:assert/strict";
import test from "node:test";

import {
	claimRuntimeReceiverName,
	claimSuffixedRuntimeName,
	createRuntimeNameAllocator,
	reserveRuntimeName,
	runtimeNameIsUsed,
} from "../../internal/runtime-name-allocator.js";

test("suffixed runtime names skip source and previously claimed bindings", () => {
	const allocator = createRuntimeNameAllocator(new Set(["_jsx1", "_jsx2"]));

	assert.equal(claimSuffixedRuntimeName(allocator, "_jsx", 1), "_jsx3");
	assert.equal(claimSuffixedRuntimeName(allocator, "_jsx", 1), "_jsx4");
});

test("runtime receiver names keep their preferred source binding until explicitly reserved", () => {
	const allocator = createRuntimeNameAllocator(new Set(["Namespace", "Namespace1"]));

	assert.equal(claimRuntimeReceiverName(allocator, "Namespace"), "Namespace");
	reserveRuntimeName(allocator, "Namespace");
	assert.equal(claimRuntimeReceiverName(allocator, "Namespace"), "Namespace2");
});

test("additional name constraints participate in allocation without becoming global reservations", () => {
	const allocator = createRuntimeNameAllocator(new Set());
	const unavailable = (name) => name === "value1";

	assert.equal(claimSuffixedRuntimeName(allocator, "value", 1, unavailable), "value2");
	assert.equal(runtimeNameIsUsed(allocator, "value1"), false);
});
