import binding from "./binding.js";
import { assertSourceText, MODE_STRIP_TYPES, resolveTransformOptions } from "./options.js";

const encoder = new TextEncoder();
const empty = new Uint8Array();

/** Transform erasable TypeScript and supported runtime TypeScript/JSX syntax to JavaScript. */
export function transform(sourceText, options = {}) {
	assertSourceText(sourceText);
	const normalized = resolveTransformOptions(options);
	return invoke(sourceText, normalized.mode, normalized.first, normalized.second);
}

/** Erase only fixed-width TypeScript syntax while preserving source length and line layout. */
export function stripTypes(sourceText) {
	assertSourceText(sourceText);
	return invoke(sourceText, MODE_STRIP_TYPES, "", "");
}

function invoke(sourceText, mode, firstOption, secondOption) {
	const source = encoder.encode(sourceText);
	const first = firstOption.length === 0 ? empty : encoder.encode(firstOption);
	const second = secondOption.length === 0 ? empty : encoder.encode(secondOption);
	return binding.run(source, mode, first, second);
}
