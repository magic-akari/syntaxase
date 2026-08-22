import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";

import { Parser } from "acorn";

import { corpusCachePath } from "./corpus.mjs";

export const MEBIBYTE = 1024 * 1024;

export function readCorpus(corpus) {
	const cachePath = corpusCachePath(corpus);
	let buffer;
	try {
		buffer = readFileSync(cachePath);
	} catch (error) {
		if (error.code === "ENOENT") {
			throw new Error(`Missing benchmark corpus ${corpus.id}. Run \`npm run benchmark:prepare\` first.`);
		}
		throw error;
	}

	if (buffer.length !== corpus.bytes) {
		throw new Error(`${corpus.id} has ${buffer.length} bytes; expected ${corpus.bytes}`);
	}
	const digest = createHash("sha256").update(buffer).digest("hex");
	if (digest !== corpus.sha256) {
		throw new Error(`${corpus.id} has SHA-256 ${digest}; expected ${corpus.sha256}`);
	}
	return buffer;
}

export function preflightExecutor(executor, scenarioName) {
	const first = executor.inspect();
	const second = executor.inspect();
	assertJavaScriptString(first, scenarioName);
	assertJavaScriptString(second, scenarioName);

	const firstFingerprint = resultFingerprint(first);
	const secondFingerprint = resultFingerprint(second);
	if (firstFingerprint !== secondFingerprint) {
		throw new Error(`${scenarioName} produced non-deterministic output before timing`);
	}

	try {
		Parser.parse(first, { ecmaVersion: "latest", sourceType: "module" });
	} catch (error) {
		throw new Error(`${scenarioName} produced invalid JavaScript: ${error.message}`, { cause: error });
	}
	return {
		fingerprint: firstFingerprint,
		outputBytes: Buffer.byteLength(first),
	};
}

export function assertStableExecutor(executor, scenarioName, expectedFingerprint) {
	const code = executor.inspect();
	assertJavaScriptString(code, scenarioName);
	const fingerprint = resultFingerprint(code);
	if (fingerprint !== expectedFingerprint) {
		throw new Error(`${scenarioName} output changed after repeated timed calls`);
	}
}

export function measureExecutor(executor, sourceBytes, configuration) {
	let checksum = 0;
	const run = () => {
		const code = executor.execute();
		checksum = updateChecksum(checksum, code.length);
	};

	const warmupNanoseconds = configuration.warmupMilliseconds * 1e6;
	const warmupStart = process.hrtime.bigint();
	let warmupIterations = 0;
	while (Number(process.hrtime.bigint() - warmupStart) < warmupNanoseconds) {
		run();
		warmupIterations += 1;
	}

	const calibrationSamples = [];
	for (let calibration = 0; calibration < 3; calibration += 1) {
		const start = process.hrtime.bigint();
		run();
		const elapsed = Number(process.hrtime.bigint() - start);
		calibrationSamples.push(Math.max(1, elapsed));
	}
	const calibrationNanoseconds = median(calibrationSamples);
	const targetNanoseconds = configuration.sampleMilliseconds * 1e6;
	const estimatedIterations = Math.round(targetNanoseconds / calibrationNanoseconds);
	const iterations = Math.max(1, Math.min(10_000, estimatedIterations));

	globalThis.gc?.();
	const samples = [];
	for (let sample = 0; sample < configuration.samples; sample += 1) {
		const start = process.hrtime.bigint();
		for (let iteration = 0; iteration < iterations; iteration += 1) {
			run();
		}
		const elapsed = Number(process.hrtime.bigint() - start);
		samples.push(elapsed / iterations);
	}

	const medianNanoseconds = median(samples);
	return {
		checksum: checksum >>> 0,
		iterationsPerSample: iterations,
		madNanoseconds: medianAbsoluteDeviation(samples, medianNanoseconds),
		medianNanoseconds,
		samplesNanoseconds: samples,
		sourceBytes,
		warmupIterations,
	};
}

export function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[middle];
	}
	return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function medianAbsoluteDeviation(values, center) {
	const deviations = values.map((value) => Math.abs(value - center));
	return median(deviations);
}

export function throughput(sourceBytes, nanoseconds) {
	const mebibytes = sourceBytes / MEBIBYTE;
	const seconds = nanoseconds / 1e9;
	return mebibytes / seconds;
}

export function environmentDescription() {
	const cpu = os.cpus()[0];
	return {
		architecture: process.arch,
		cpu: cpu?.model ?? null,
		node: process.version,
		platform: process.platform,
	};
}

function resultFingerprint(code) {
	return createHash("sha256").update(code).digest("hex");
}

function assertJavaScriptString(code, scenarioName) {
	if (typeof code !== "string") {
		throw new TypeError(`${scenarioName} returned ${typeof code}; expected a JavaScript string`);
	}
}

function updateChecksum(checksum, codeLength) {
	return Math.imul(checksum ^ codeLength, 16_777_619);
}
