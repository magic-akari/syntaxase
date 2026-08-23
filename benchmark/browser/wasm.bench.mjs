import Babel from "@babel/standalone";
import { transformSync as oxcTransform } from "oxc-transform/browser";
import { transform as sucraseTransform } from "sucrase";
import tsBlankSpace from "ts-blank-space";
import { expect, test } from "vitest";
import { commands } from "vitest/browser";

import { stripTypes, transform as syntaxaseTransform } from "syntaxase-wasm";
import { BENCHMARK_CORPUS } from "../.cache/browser-corpus.mjs";

const WARMUP_MILLISECONDS = 300;
const SAMPLE_MILLISECONDS = 100;
const SAMPLE_COUNT = 7;
const MAX_ITERATIONS = 10_000;

const corpusById = new Map(BENCHMARK_CORPUS.map((corpus) => [corpus.id, corpus]));

test("warmed browser transform comparison", async () => {
	expect(globalThis.crossOriginIsolated).toBe(true);

	const scenarios = createScenarios();
	for (const scenario of scenarios) {
		for (const implementation of scenario.implementations) {
			preflight(scenario, implementation);
		}
	}

	const results = scenarios.map((scenario) => ({
		...scenario,
		results: scenario.implementations.map((implementation) => ({
			name: implementation.name,
			...measure(implementation.run),
		})),
	}));

	await commands.reportBenchmark(formatReport(results));
});

function createScenarios() {
	const typeErasure = requireCorpus("hono-types");
	const tsx = requireCorpus("react-router-tsx");

	const typeErasureOxcOptions = {
		lang: "ts",
		sourceType: "module",
		target: "esnext",
	};
	const typeErasureBabelOptions = {
		filename: typeErasure.upstreamPath,
		sourceType: "module",
		ast: false,
		sourceMaps: false,
		presets: ["typescript"],
	};
	const typeErasureSucraseOptions = {
		transforms: ["typescript"],
		disableESTransforms: true,
	};

	const tsxOxcOptions = {
		lang: "tsx",
		sourceType: "module",
		target: "esnext",
		jsx: {
			runtime: "automatic",
			development: false,
			importSource: "react",
		},
	};
	const tsxBabelOptions = {
		filename: tsx.upstreamPath,
		sourceType: "module",
		ast: false,
		sourceMaps: false,
		presets: ["typescript", ["react", { runtime: "automatic", development: false, importSource: "react" }]],
	};
	const tsxSucraseOptions = {
		transforms: ["typescript", "jsx"],
		disableESTransforms: true,
		jsxRuntime: "automatic",
		jsxImportSource: "react",
		production: true,
	};
	const syntaxaseJSXOptions = {
		jsx: {
			runtime: "automatic",
			development: false,
			importSource: "react",
		},
	};

	return [
		{
			label: "Type erasure",
			corpus: typeErasure,
			implementations: [
				{
					name: "Syntaxase WASM",
					run: () => stripTypes(typeErasure.source),
				},
				{
					name: "Oxc WASI",
					run: () => runOxc(typeErasure.upstreamPath, typeErasure.source, typeErasureOxcOptions),
				},
				{
					name: "Babel standalone",
					run: () => runBabel(typeErasure.source, typeErasureBabelOptions),
				},
				{
					name: "Sucrase",
					run: () => sucraseTransform(typeErasure.source, typeErasureSucraseOptions).code,
				},
				{
					name: "ts-blank-space",
					run: () => tsBlankSpace(typeErasure.source, unsupportedTypeScript),
				},
			],
		},
		{
			label: "TypeScript + JSX automatic runtime",
			corpus: tsx,
			implementations: [
				{
					name: "Syntaxase WASM",
					run: () => syntaxaseTransform(tsx.source, syntaxaseJSXOptions),
				},
				{
					name: "Oxc WASI",
					run: () => runOxc(tsx.upstreamPath, tsx.source, tsxOxcOptions),
				},
				{
					name: "Babel standalone",
					run: () => runBabel(tsx.source, tsxBabelOptions),
				},
				{
					name: "Sucrase",
					run: () => sucraseTransform(tsx.source, tsxSucraseOptions).code,
				},
			],
			note: "ts-blank-space is omitted because it preserves JSX rather than lowering the automatic runtime.",
		},
	];
}

function requireCorpus(id) {
	const corpus = corpusById.get(id);
	if (corpus === undefined) throw new TypeError(`missing benchmark corpus ${id}`);
	return corpus;
}

function unsupportedTypeScript(node) {
	throw new Error(`ts-blank-space reported unsupported TypeScript syntax kind ${node.kind}`);
}

function runOxc(filename, source, options) {
	const result = oxcTransform(filename, source, options);
	return result.code;
}

function runBabel(source, options) {
	const result = Babel.transform(source, options);
	if (typeof result.code !== "string") throw new Error("Babel produced no output");
	return result.code;
}

function preflight(scenario, implementation) {
	const first = implementation.run();
	const second = implementation.run();
	if (first !== second) {
		throw new Error(`${implementation.name} produced non-deterministic output for ${scenario.label}`);
	}
	validateJavaScript(`${implementation.name} ${scenario.label}`, first);
}

function validateJavaScript(label, code) {
	if (code.length === 0) throw new Error(`${label} produced empty output`);
	const result = oxcTransform("output.mjs", code, {
		lang: "js",
		sourceType: "module",
		target: "esnext",
	});
	if (result.errors.length === 0) return;
	const messages = result.errors.map((error) => error.message).join("; ");
	throw new Error(`${label} JavaScript validation failed: ${messages}`);
}

function measure(run) {
	let checksum = 2_166_136_261;
	const invoke = () => {
		const output = run();
		checksum = Math.imul(checksum ^ output.length, 16_777_619);
	};

	const warmupEnd = performance.now() + WARMUP_MILLISECONDS;
	let warmupIterations = 0;
	while (performance.now() < warmupEnd) {
		invoke();
		warmupIterations += 1;
	}

	const calibration = [];
	for (let index = 0; index < 3; index += 1) {
		const start = performance.now();
		invoke();
		calibration.push(Math.max(0.000_001, performance.now() - start));
	}
	calibration.sort((left, right) => left - right);
	const iterations = Math.max(1, Math.min(MAX_ITERATIONS, Math.round(SAMPLE_MILLISECONDS / calibration[1])));
	globalThis.gc?.();

	const samples = [];
	for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
		const start = performance.now();
		for (let iteration = 0; iteration < iterations; iteration += 1) invoke();
		const elapsed = performance.now() - start;
		samples.push((elapsed * 1_000_000) / iterations);
	}
	samples.sort((left, right) => left - right);
	return {
		checksum: checksum >>> 0,
		iterationsPerSample: iterations,
		medianNanoseconds: samples[Math.floor(samples.length / 2)],
		warmupIterations,
	};
}

function formatReport(scenarios) {
	const lines = [
		"",
		"Initialization excluded; median of 7 warmed samples in a real browser",
		`${navigator.userAgent}; crossOriginIsolated=${globalThis.crossOriginIsolated}; gc=${typeof globalThis.gc === "function"}`,
	];

	for (const scenario of scenarios) {
		const syntaxase = scenario.results.find((result) => result.name === "Syntaxase WASM");
		lines.push("", `${scenario.label} (${scenario.corpus.bytes} bytes)`);
		lines.push("Implementation             ms/op       MiB/s       speed");
		for (const result of scenario.results) {
			const milliseconds = result.medianNanoseconds / 1e6;
			const throughput = scenario.corpus.bytes / (1024 * 1024) / (result.medianNanoseconds / 1e9);
			const ratio = syntaxase.medianNanoseconds / result.medianNanoseconds;
			lines.push(
				`${result.name.padEnd(26)} ${milliseconds.toFixed(3).padStart(8)} ${throughput.toFixed(1).padStart(11)} ${`${ratio.toFixed(2)}x`.padStart(11)}`,
			);
		}
		if (scenario.note !== undefined) lines.push(scenario.note);
	}
	return lines.join("\n");
}
