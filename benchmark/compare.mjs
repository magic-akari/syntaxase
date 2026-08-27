import { spawnSync } from "node:child_process";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { transformSync as oxcTransform } from "oxc-transform";

import { BENCHMARK_CORPUS, readCorpus } from "./corpus.mjs";

const executableName = process.platform === "win32" ? "syntaxase-native-benchmark.exe" : "syntaxase-native-benchmark";
const defaultExecutable = fileURLToPath(new URL(`../zig-out/bin/${executableName}`, import.meta.url));
const executable = process.argv[2] ?? defaultExecutable;

const typeErasureCorpusIds = ["astro-config", "effect-schema-ast", "hono-types"];
const scenarios = [
	...typeErasureCorpusIds.map((corpusId) => ({
		label: "Type erasure",
		corpusId,
		nativeMode: "strip",
		oxcOptions: {
			lang: "ts",
			sourceType: "module",
			target: "esnext",
		},
	})),
	{
		label: "TypeScript + JSX",
		corpusId: "react-router-tsx",
		nativeMode: "jsx",
		oxcOptions: {
			lang: "tsx",
			sourceType: "module",
			target: "esnext",
			jsx: {
				runtime: "automatic",
				development: false,
				importSource: "react",
			},
		},
	},
];

process.stdout.write("Initialization excluded; median of 7 warmed samples\n");
for (const scenario of scenarios) {
	const corpus = findCorpus(scenario.corpusId);
	const sourceBuffer = readCorpus(corpus);
	const source = sourceBuffer.toString("utf8");
	const oxcOptions = { lang: corpus.lang, ...scenario.oxcOptions };

	preflightNative(scenario, source);
	preflightOxc(scenario, corpus.upstreamPath, source, oxcOptions);

	const native = measureNative(scenario.nativeMode, source);
	const oxc = measureOxc(corpus.upstreamPath, source, oxcOptions);
	writeLane(`${scenario.label}: ${corpus.label}`, sourceBuffer.length, native, oxc);
}

function findCorpus(id) {
	const corpus = BENCHMARK_CORPUS.find((entry) => entry.id === id);
	if (corpus === undefined) throw new TypeError(`missing benchmark corpus ${id}`);
	return corpus;
}

function preflightNative(scenario, source) {
	const first = inspectNative(scenario.nativeMode, source);
	const second = inspectNative(scenario.nativeMode, source);
	if (first !== second) {
		throw new Error(`Syntaxase produced non-deterministic output for ${scenario.label}`);
	}
	validateJavaScript(`Syntaxase ${scenario.label}`, first);
}

function preflightOxc(scenario, filename, source, options) {
	const first = runOxc(filename, source, options, `Oxc ${scenario.label}`);
	const second = runOxc(filename, source, options, `Oxc ${scenario.label}`);
	if (first.code !== second.code) {
		throw new Error(`Oxc produced non-deterministic output for ${scenario.label}`);
	}
	validateJavaScript(`Oxc ${scenario.label}`, first.code);
}

function validateJavaScript(label, code) {
	if (code.length === 0) throw new Error(`${label} produced empty output`);
	const result = oxcTransform("output.mjs", code, {
		lang: "js",
		sourceType: "module",
		target: "esnext",
	});
	assertNoOxcErrors(result, `${label} JavaScript validation`);
}

function inspectNative(mode, source) {
	const child = spawnSync(executable, ["inspect", mode], {
		encoding: "utf8",
		input: source,
		maxBuffer: 4 * 1024 * 1024,
	});
	if (child.error !== undefined) throw child.error;
	if (child.status !== 0) throw new Error(child.stderr || `native inspection exited ${child.status}`);
	return child.stdout;
}

function measureNative(mode, source) {
	const child = spawnSync(executable, ["measure", mode], {
		encoding: "utf8",
		input: source,
		maxBuffer: 1024 * 1024,
	});
	if (child.error !== undefined) throw child.error;
	if (child.status !== 0) throw new Error(child.stderr || `native benchmark exited ${child.status}`);
	return JSON.parse(child.stdout);
}

function runOxc(filename, source, options, label) {
	const result = oxcTransform(filename, source, options);
	assertNoOxcErrors(result, label);
	return result;
}

function assertNoOxcErrors(result, label) {
	if (result.errors.length === 0) return;
	const messages = result.errors.map((error) => error.message).join("; ");
	throw new Error(`${label} failed: ${messages}`);
}

function measureOxc(filename, source, options) {
	let checksum = 0;
	const run = () => {
		const result = oxcTransform(filename, source, options);
		checksum = Math.imul(checksum ^ result.code.length ^ result.errors.length, 16_777_619);
	};

	const warmupEnd = performance.now() + 300;
	let warmupIterations = 0;
	while (performance.now() < warmupEnd) {
		run();
		warmupIterations += 1;
	}

	const calibration = [];
	for (let index = 0; index < 3; index += 1) {
		const start = process.hrtime.bigint();
		run();
		calibration.push(Math.max(1, Number(process.hrtime.bigint() - start)));
	}
	calibration.sort((left, right) => left - right);
	const iterations = Math.max(1, Math.min(10_000, Math.round(100_000_000 / calibration[1])));
	globalThis.gc?.();

	const samples = [];
	for (let sample = 0; sample < 7; sample += 1) {
		const start = process.hrtime.bigint();
		for (let iteration = 0; iteration < iterations; iteration += 1) run();
		const elapsed = Number(process.hrtime.bigint() - start);
		samples.push(elapsed / iterations);
	}
	samples.sort((left, right) => left - right);
	return {
		checksum: checksum >>> 0,
		iterationsPerSample: iterations,
		medianNanoseconds: samples[3],
		warmupIterations,
	};
}

function writeLane(label, bytes, native, oxc) {
	const entries = [
		["Syntaxase native", native.medianNanoseconds, 1],
		["Oxc native", oxc.medianNanoseconds, native.medianNanoseconds / oxc.medianNanoseconds],
	];

	process.stdout.write(`\n${label} (${bytes} bytes)\n`);
	process.stdout.write("Implementation          ms/op       MiB/s       speed\n");
	for (const [name, nanoseconds, ratio] of entries) {
		const milliseconds = nanoseconds / 1e6;
		const throughput = bytes / (1024 * 1024) / (nanoseconds / 1e9);
		process.stdout.write(
			`${name.padEnd(20)} ${milliseconds.toFixed(3).padStart(8)} ${throughput.toFixed(1).padStart(11)} ${`${ratio.toFixed(2)}x`.padStart(11)}\n`,
		);
	}
}
