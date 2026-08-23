import wasmBytes from "./wasm.js";
import { assertSourceText, MODE_STRIP_TYPES, resolveTransformOptions } from "./options.js";

const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule);
const { alloc, free, memory, run } = wasmInstance.exports;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_WASM_LENGTH = 0xffff_ffff;

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
	const first = encoder.encode(firstOption);
	const second = encoder.encode(secondOption);
	const inputLength = source.length + first.length + second.length;
	if (inputLength > MAX_WASM_LENGTH) {
		throw new RangeError("encoded transform input exceeds WebAssembly memory limits");
	}

	const allocationLength = Math.max(inputLength, 1);
	const inputPointer = alloc(allocationLength) >>> 0;
	let outputPointer = 0;
	let outputLength = 0;
	try {
		const input = new Uint8Array(memory.buffer, inputPointer, inputLength);
		input.set(source, 0);
		input.set(first, source.length);
		input.set(second, source.length + first.length);

		outputPointer = run(inputPointer, source.length, first.length, second.length, mode) >>> 0;
		if (outputPointer === 0) {
			throw new Error("Syntaxase WebAssembly transform failed");
		}

		const header = new DataView(memory.buffer, outputPointer, 4);
		outputLength = header.getUint32(0, true);
		const output = new Uint8Array(memory.buffer, outputPointer + 4, outputLength);
		return decoder.decode(output);
	} finally {
		if (outputPointer !== 0) free(outputPointer, outputLength + 4);
		free(inputPointer, allocationLength);
	}
}
