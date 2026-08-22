import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArguments } from "node:util";

import {
	COMPARISON_EXCLUSIONS,
	COMPARISON_IMPLEMENTATIONS,
	comparisonLane,
	createComparisonExecutor,
	implementationsForCorpus,
} from "./competitors.mjs";
import { BENCHMARK_CORPUS, publicCorpusMetadata } from "./corpus.mjs";
import {
	assertStableExecutor,
	environmentDescription,
	measureExecutor,
	median,
	medianAbsoluteDeviation,
	preflightExecutor,
	readCorpus,
	throughput,
} from "./harness.mjs";
import { fileFingerprint, runtimeFingerprint } from "./identity.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MEBIBYTE = 1024 * 1024;
const DEFAULTS = {
	cycles: 1,
	samples: 5,
	sampleMilliseconds: 100,
	warmupMilliseconds: 200,
};

const options = parseArguments(process.argv.slice(2));
if (options.worker) {
	const result = await runWorker(options);
	process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
	const report = runComparison(options);
	writeReport(report, options.json);
}

function parseArguments(argumentsList) {
	const parsed = parseNodeArguments({
		args: argumentsList,
		allowPositionals: false,
		options: {
			case: { type: "string", multiple: true },
			cycles: { type: "string", default: String(DEFAULTS.cycles) },
			help: { type: "boolean", default: false },
			implementation: { type: "string" },
			json: { type: "boolean", default: false },
			samples: { type: "string", default: String(DEFAULTS.samples) },
			"sample-ms": { type: "string", default: String(DEFAULTS.sampleMilliseconds) },
			"warmup-ms": { type: "string", default: String(DEFAULTS.warmupMilliseconds) },
			worker: { type: "boolean", default: false },
		},
		strict: true,
	});
	if (parsed.values.help) {
		writeHelp();
		process.exit(0);
	}

	const result = {
		caseIds: parsed.values.case ?? [],
		cycles: parseInteger(parsed.values.cycles, "--cycles"),
		implementationId: parsed.values.implementation ?? null,
		json: parsed.values.json,
		samples: parseInteger(parsed.values.samples, "--samples"),
		sampleMilliseconds: parseInteger(parsed.values["sample-ms"], "--sample-ms"),
		warmupMilliseconds: parseInteger(parsed.values["warmup-ms"], "--warmup-ms"),
		worker: parsed.values.worker,
	};
	if (result.worker) {
		if (result.caseIds.length !== 1 || result.implementationId === null) {
			throw new TypeError("--worker requires one --case and one --implementation");
		}
	} else if (result.implementationId !== null) {
		throw new TypeError("--implementation is reserved for benchmark workers");
	}
	return result;
}

function parseInteger(value, option) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new TypeError(`${option} must be a positive integer`);
	}
	return parsed;
}

function writeHelp() {
	process.stdout.write(
		[
			"Usage:",
			"  npm run benchmark:compare",
			"  npm run benchmark:compare -- --case hono-types --case vue-errors",
			"",
			"Options:",
			"  --case ID        Limit the run to a corpus entry; may be repeated",
			"  --cycles N       Complete balanced order cycles (default: 1)",
			"  --samples N      Timed samples per isolated worker (default: 5)",
			"  --sample-ms N    Approximate duration of each sample (default: 100)",
			"  --warmup-ms N    Warmup duration per isolated worker (default: 200)",
			"  --json           Emit machine-readable JSON, including raw samples",
			"",
		].join("\n"),
	);
}

function runComparison(configuration) {
	const corpora = selectCorpora(configuration.caseIds);
	const runs = Object.fromEntries(corpora.map((corpus) => [corpus.id, []]));

	for (let cycle = 0; cycle < configuration.cycles; cycle += 1) {
		const largestRotation = Math.max(...corpora.map((corpus) => implementationsForCorpus(corpus).length));
		for (let rotation = 0; rotation < largestRotation; rotation += 1) {
			for (const corpus of corpora) {
				const implementations = implementationsForCorpus(corpus);
				if (rotation >= implementations.length) {
					continue;
				}
				const order = rotate(implementations, rotation).map((implementation) => implementation.id);
				const results = {};
				for (const implementationId of order) {
					results[implementationId] = runScenario(implementationId, corpus.id, configuration);
				}
				runs[corpus.id].push({ cycle, order, results, rotation });
			}
		}
	}
	assertStableWorkerResults(corpora, runs);

	return {
		kind: "tool-comparison",
		environment: environmentDescription(),
		configuration: publicConfiguration(configuration),
		benchmarkPackageLockSha256: fileFingerprint(new URL("./package-lock.json", import.meta.url)),
		syntaxaseRuntimeSha256: runtimeFingerprint(REPOSITORY_ROOT),
		implementations: COMPARISON_IMPLEMENTATIONS,
		corpus: corpora.map(publicCorpusMetadata),
		exclusions: selectedExclusions(corpora),
		runs,
		summary: summarizeRuns(corpora, runs),
	};
}

function assertStableWorkerResults(corpora, runs) {
	for (const corpus of corpora) {
		for (const implementation of implementationsForCorpus(corpus)) {
			let expectedFingerprint = null;
			for (const run of runs[corpus.id]) {
				const result = run.results[implementation.id];
				expectedFingerprint ??= result.scenario.fingerprint;
				if (result.scenario.fingerprint !== expectedFingerprint) {
					throw new Error(`${implementation.id} produced inconsistent output across ${corpus.id} workers`);
				}
				if (JSON.stringify(result.packages) !== JSON.stringify(implementation.packages)) {
					throw new Error(`${implementation.id} dependency identity changed while benchmarking ${corpus.id}`);
				}
			}
		}
	}
}

function selectCorpora(caseIds) {
	if (caseIds.length === 0) {
		return BENCHMARK_CORPUS;
	}
	const selected = [];
	const seen = new Set();
	for (const caseId of caseIds) {
		if (seen.has(caseId)) {
			throw new TypeError(`Duplicate --case ${caseId}`);
		}
		const corpus = BENCHMARK_CORPUS.find((entry) => entry.id === caseId);
		if (corpus === undefined) {
			throw new TypeError(`Unknown benchmark corpus ${caseId}`);
		}
		seen.add(caseId);
		selected.push(corpus);
	}
	return selected;
}

function rotate(values, offset) {
	return [...values.slice(offset), ...values.slice(0, offset)];
}

function runScenario(implementationId, caseId, configuration) {
	const child = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			SCRIPT_PATH,
			"--worker",
			"--implementation",
			implementationId,
			"--case",
			caseId,
			"--samples",
			String(configuration.samples),
			"--sample-ms",
			String(configuration.sampleMilliseconds),
			"--warmup-ms",
			String(configuration.warmupMilliseconds),
		],
		{ encoding: "utf8", maxBuffer: 16 * MEBIBYTE },
	);
	if (child.error !== undefined) {
		throw child.error;
	}
	if (child.status !== 0) {
		const detail = child.stderr.trim() || child.stdout.trim() || `exit status ${child.status}`;
		throw new Error(`Benchmark worker failed for ${implementationId} (${caseId}): ${detail}`);
	}
	return JSON.parse(child.stdout);
}

async function runWorker(configuration) {
	const corpus = BENCHMARK_CORPUS.find((entry) => entry.id === configuration.caseIds[0]);
	if (corpus === undefined) {
		throw new TypeError(`Unknown benchmark corpus ${configuration.caseIds[0]}`);
	}
	const implementation = implementationsForCorpus(corpus).find(
		(entry) => entry.id === configuration.implementationId,
	);
	if (implementation === undefined) {
		throw new TypeError(`${configuration.implementationId} is not eligible for ${corpus.id}`);
	}

	const source = readCorpus(corpus).toString("utf8");
	const executor = await createComparisonExecutor(implementation.id, corpus, source);
	const scenarioName = `${implementation.label} / ${corpus.id}`;
	const preflight = preflightExecutor(executor, scenarioName);
	const measurement = measureExecutor(executor, corpus.bytes, configuration);
	assertStableExecutor(executor, scenarioName, preflight.fingerprint);
	const { checksum, ...scenario } = measurement;
	return {
		checksum,
		corpusId: corpus.id,
		implementationId: implementation.id,
		packages: implementation.packages,
		pid: process.pid,
		scenario: {
			...scenario,
			fingerprint: preflight.fingerprint,
			outputBytes: preflight.outputBytes,
		},
	};
}

function summarizeRuns(corpora, runs) {
	const lanes = {};
	for (const corpus of corpora) {
		const lane = comparisonLane(corpus);
		lanes[lane] ??= { corpus: {} };
		const implementations = implementationsForCorpus(corpus);
		const referenceId = "syntaxase";
		const summaries = {};
		for (const implementation of implementations) {
			const latencies = [];
			const pairedRatios = [];
			for (const run of runs[corpus.id]) {
				const latency = run.results[implementation.id].scenario.medianNanoseconds;
				const reference = run.results[referenceId].scenario.medianNanoseconds;
				latencies.push(latency);
				pairedRatios.push(latency / reference);
			}
			const medianNanoseconds = median(latencies);
			const pairedRatio = median(pairedRatios);
			summaries[implementation.id] = {
				latencyMadNanoseconds: medianAbsoluteDeviation(latencies, medianNanoseconds),
				medianNanoseconds,
				mebibytesPerSecond: throughput(corpus.bytes, medianNanoseconds),
				pairedDeltaPercent: (pairedRatio - 1) * 100,
				pairedRatio,
				pairedRatioMad: medianAbsoluteDeviation(pairedRatios, pairedRatio),
			};
		}
		lanes[lane].corpus[corpus.id] = { implementations: summaries };
	}
	return { lanes };
}

function publicConfiguration(configuration) {
	return {
		cycles: configuration.cycles,
		samples: configuration.samples,
		sampleMilliseconds: configuration.sampleMilliseconds,
		warmupMilliseconds: configuration.warmupMilliseconds,
	};
}

function selectedExclusions(corpora) {
	return Object.fromEntries(
		corpora
			.filter((corpus) => COMPARISON_EXCLUSIONS[corpus.id] !== undefined)
			.map((corpus) => [corpus.id, COMPARISON_EXCLUSIONS[corpus.id]]),
	);
}

function writeReport(report, json) {
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	writeEnvironment(report.environment);
	process.stdout.write(`Balanced order cycles: ${report.configuration.cycles}\n`);
	for (const [lane, laneSummary] of Object.entries(report.summary.lanes)) {
		process.stdout.write(`\n${lane.toUpperCase()}\n`);
		for (const corpus of report.corpus.filter((entry) => comparisonLane(entry) === lane)) {
			process.stdout.write(`\n${corpus.label} (${formatBytes(corpus.bytes)})\n`);
			process.stdout.write("Implementation             ms/op       MiB/s    vs Syntaxase   pair MAD\n");
			const summaries = laneSummary.corpus[corpus.id].implementations;
			for (const implementation of implementationsForCorpus(corpus)) {
				const summary = summaries[implementation.id];
				process.stdout.write(
					`${implementation.label.padEnd(23)} ` +
						`${formatMilliseconds(summary.medianNanoseconds).padStart(10)} ` +
						`${summary.mebibytesPerSecond.toFixed(2).padStart(11)} ` +
						`${formatRatio(summary.pairedRatio).padStart(16)} ` +
						`${formatPercentagePoints(summary.pairedRatioMad * 100).padStart(10)}\n`,
				);
			}
		}
	}

	for (const [caseId, exclusions] of Object.entries(report.exclusions)) {
		for (const [implementationId, reason] of Object.entries(exclusions)) {
			process.stdout.write(`\nExcluded ${implementationId} from ${caseId}: ${reason}\n`);
		}
	}
	process.stdout.write(
		"\nRatios use paired runs; below 1.00x is faster than Syntaxase. " +
			"Outputs are validated independently and are not required to be byte-identical.\n" +
			"No cross-corpus aggregate is reported, and this benchmark is non-gating.\n",
	);
}

function writeEnvironment(environment) {
	process.stdout.write(
		`Node ${environment.node} on ${environment.platform}/${environment.architecture}; ${environment.cpu ?? "unknown CPU"}\n`,
	);
}

function formatMilliseconds(nanoseconds) {
	return `${(nanoseconds / 1e6).toFixed(3)} ms`;
}

function formatRatio(ratio) {
	return `${ratio.toFixed(2)}x`;
}

function formatPercentagePoints(points) {
	return `${points.toFixed(2)} pp`;
}

function formatBytes(bytes) {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}
