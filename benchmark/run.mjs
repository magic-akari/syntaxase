import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs as parseNodeArguments } from "node:util";

import { BENCHMARK_CORPUS, publicCorpusMetadata } from "./corpus.mjs";
import {
	MEBIBYTE,
	assertStableExecutor,
	environmentDescription,
	measureExecutor,
	median,
	medianAbsoluteDeviation,
	preflightExecutor,
	readCorpus,
	throughput,
} from "./harness.mjs";
import { implementationIdentity } from "./identity.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULTS = {
	rounds: 4,
	samples: 7,
	sampleMilliseconds: 150,
	warmupMilliseconds: 300,
};

const options = parseArguments(process.argv.slice(2));
if (options.worker) {
	const result = await runWorker(options);
	process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (options.baseline !== null) {
	const report = compareImplementations(options);
	writeComparisonReport(report, options.json);
} else {
	const modulePath = options.module ?? "./index.js";
	const report = runSingleImplementation(modulePath, options);
	writeSingleReport(report, options.json);
}

function parseArguments(argumentsList) {
	const parsed = parseNodeArguments({
		args: argumentsList,
		allowPositionals: false,
		options: {
			baseline: { type: "string" },
			candidate: { type: "string" },
			case: { type: "string" },
			help: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			module: { type: "string" },
			rounds: { type: "string", default: String(DEFAULTS.rounds) },
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
		baseline: parsed.values.baseline ?? null,
		candidate: parsed.values.candidate ?? null,
		caseId: parsed.values.case ?? null,
		json: parsed.values.json,
		module: parsed.values.module ?? null,
		rounds: parseInteger(parsed.values.rounds, "--rounds", 1),
		samples: parseInteger(parsed.values.samples, "--samples", 1),
		sampleMilliseconds: parseInteger(parsed.values["sample-ms"], "--sample-ms", 1),
		warmupMilliseconds: parseInteger(parsed.values["warmup-ms"], "--warmup-ms", 1),
		worker: parsed.values.worker,
	};

	const hasBaseline = result.baseline !== null;
	const hasCandidate = result.candidate !== null;
	if (hasBaseline !== hasCandidate) {
		throw new TypeError("--baseline and --candidate must be provided together");
	}
	if (hasBaseline && result.rounds % 2 !== 0) {
		throw new TypeError("--rounds must be even so baseline/candidate order is balanced");
	}
	if (result.worker && (result.module === null || result.caseId === null)) {
		throw new TypeError("--worker requires --module and --case");
	}
	return result;
}

function parseInteger(value, option, minimum) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new TypeError(`${option} must be an integer greater than or equal to ${minimum}`);
	}
	return parsed;
}

function writeHelp() {
	process.stdout.write(
		[
			"Usage:",
			"  node benchmark/run.mjs --module ./index.js",
			"  node benchmark/run.mjs --baseline /path/to/baseline/index.js --candidate ./index.js",
			"",
			"Options:",
			"  --rounds N       Paired comparison rounds (default: 4)",
			"  --samples N      Timed samples per worker (default: 7)",
			"  --sample-ms N    Approximate duration of each sample (default: 150)",
			"  --warmup-ms N    Warmup duration per corpus entry (default: 300)",
			"  --json           Emit machine-readable JSON, including raw samples",
			"",
		].join("\n"),
	);
}

function runSingleImplementation(modulePath, configuration) {
	const absoluteModulePath = path.resolve(modulePath);
	const run = runImplementation(absoluteModulePath, configuration);
	return {
		kind: "single",
		environment: environmentDescription(),
		configuration: publicConfiguration(configuration),
		corpus: BENCHMARK_CORPUS.map(publicCorpusMetadata),
		module: absoluteModulePath,
		run,
	};
}

function compareImplementations(configuration) {
	const baselinePath = path.resolve(configuration.baseline);
	const candidatePath = path.resolve(configuration.candidate);
	const runs = [];
	for (let round = 0; round < configuration.rounds; round += 1) {
		const baselineFirst = round % 2 === 0;
		const paired = {
			baseline: createImplementationRun(baselinePath),
			candidate: createImplementationRun(candidatePath),
			round,
		};
		for (const corpus of BENCHMARK_CORPUS) {
			const targets = baselineFirst
				? [
						["baseline", baselinePath],
						["candidate", candidatePath],
					]
				: [
						["candidate", candidatePath],
						["baseline", baselinePath],
					];
			for (const [label, modulePath] of targets) {
				const worker = runScenario(modulePath, corpus.id, configuration);
				recordScenario(paired[label], corpus.id, worker);
			}
		}
		runs.push(paired);
	}

	assertStableImplementationIdentities(runs);
	assertEquivalentOutputs(runs);
	return {
		kind: "comparison",
		environment: environmentDescription(),
		configuration: publicConfiguration(configuration),
		corpus: BENCHMARK_CORPUS.map(publicCorpusMetadata),
		baseline: baselinePath,
		baselineIdentity: runs[0].baseline.identity,
		candidate: candidatePath,
		candidateIdentity: runs[0].candidate.identity,
		runs,
		summary: summarizeComparison(runs),
	};
}

function runImplementation(modulePath, configuration) {
	const run = createImplementationRun(modulePath);
	for (const corpus of BENCHMARK_CORPUS) {
		const worker = runScenario(modulePath, corpus.id, configuration);
		recordScenario(run, corpus.id, worker);
	}
	return run;
}

function createImplementationRun(modulePath) {
	return {
		identity: implementationIdentity(modulePath),
		module: modulePath,
		scenarios: {},
		workers: {},
	};
}

function recordScenario(run, caseId, worker) {
	run.scenarios[caseId] = worker.scenario;
	run.workers[caseId] = {
		checksum: worker.checksum,
		pid: worker.pid,
	};
}

function runScenario(modulePath, caseId, configuration) {
	const childArguments = [
		"--expose-gc",
		SCRIPT_PATH,
		"--worker",
		"--module",
		modulePath,
		"--case",
		caseId,
		"--samples",
		String(configuration.samples),
		"--sample-ms",
		String(configuration.sampleMilliseconds),
		"--warmup-ms",
		String(configuration.warmupMilliseconds),
	];
	const child = spawnSync(process.execPath, childArguments, {
		encoding: "utf8",
		maxBuffer: 16 * MEBIBYTE,
	});
	if (child.status !== 0) {
		const detail = child.stderr.trim() || child.stdout.trim() || `exit status ${child.status}`;
		throw new Error(`Benchmark worker failed for ${modulePath} (${caseId}): ${detail}`);
	}
	return JSON.parse(child.stdout);
}

async function runWorker(configuration) {
	const moduleUrl = pathToFileURL(path.resolve(configuration.module));
	moduleUrl.searchParams.set("benchmarkWorker", String(process.pid));
	const implementation = await import(moduleUrl.href);
	assertPublicApi(implementation, configuration.module);

	const corpus = findCorpus(configuration.caseId);
	const workload = createWorkload(implementation, corpus);
	const executor = createExecutor(workload);
	const preflight = preflightExecutor(executor, corpus.id);
	const measurement = measureExecutor(executor, corpus.bytes, configuration);
	assertStableExecutor(executor, corpus.id, preflight.fingerprint);
	const { checksum, ...scenario } = measurement;

	return {
		module: path.resolve(configuration.module),
		pid: process.pid,
		checksum,
		scenario: {
			...scenario,
			fingerprint: preflight.fingerprint,
			outputBytes: preflight.outputBytes,
		},
	};
}

function assertPublicApi(implementation, modulePath) {
	const hasStripTypes = typeof implementation.stripTypes === "function";
	const hasTransform = typeof implementation.transform === "function";
	if (!hasStripTypes || !hasTransform) {
		throw new TypeError(`${modulePath} does not expose the syntaxase public API`);
	}
}

function findCorpus(caseId) {
	for (const corpus of BENCHMARK_CORPUS) {
		if (corpus.id === caseId) {
			return corpus;
		}
	}
	throw new TypeError(`Unknown benchmark corpus ${caseId}`);
}

function createWorkload(implementation, corpus) {
	const buffer = readCorpus(corpus);
	const source = buffer.toString("utf8");
	return {
		corpus,
		implementation,
		source,
	};
}

function createExecutor(workload) {
	const execute = () => {
		if (workload.corpus.operation === "stripTypes") {
			return workload.implementation.stripTypes(workload.source);
		}
		return workload.implementation.transform(workload.source, { jsx: workload.corpus.jsx });
	};
	return { execute, inspect: execute };
}

function assertEquivalentOutputs(runs) {
	for (const corpus of BENCHMARK_CORPUS) {
		let expected = null;
		for (const run of runs) {
			const fingerprints = [
				run.baseline.scenarios[corpus.id].fingerprint,
				run.candidate.scenarios[corpus.id].fingerprint,
			];
			for (const fingerprint of fingerprints) {
				expected ??= fingerprint;
				if (fingerprint !== expected) {
					throw new Error(
						`${corpus.id} output differs between benchmark targets (${expected} !== ${fingerprint})`,
					);
				}
			}
		}
	}
}

function assertStableImplementationIdentities(runs) {
	for (const label of ["baseline", "candidate"]) {
		const expected = JSON.stringify(runs[0][label].identity);
		for (const run of runs) {
			const actual = JSON.stringify(run[label].identity);
			if (actual !== expected) {
				throw new Error(`${label} implementation changed while the benchmark was running`);
			}
		}
	}
}

function summarizeComparison(runs) {
	const scenarios = {};
	for (const corpus of BENCHMARK_CORPUS) {
		const baselineValues = [];
		const candidateValues = [];
		const pairedRatios = [];
		for (const run of runs) {
			const baseline = run.baseline.scenarios[corpus.id];
			const candidate = run.candidate.scenarios[corpus.id];
			baselineValues.push(baseline.medianNanoseconds);
			candidateValues.push(candidate.medianNanoseconds);
			pairedRatios.push(candidate.medianNanoseconds / baseline.medianNanoseconds);
		}

		const baselineNanoseconds = median(baselineValues);
		const candidateNanoseconds = median(candidateValues);
		const medianRatio = candidateNanoseconds / baselineNanoseconds;
		const pairedRatio = median(pairedRatios);
		scenarios[corpus.id] = {
			baselineNanoseconds,
			candidateNanoseconds,
			medianRatio,
			medianDeltaPercent: (medianRatio - 1) * 100,
			pairedRatio,
			pairedDeltaPercent: (pairedRatio - 1) * 100,
			pairedRatioMad: medianAbsoluteDeviation(pairedRatios, pairedRatio),
			baselineMebibytesPerSecond: throughput(corpus.bytes, baselineNanoseconds),
			candidateMebibytesPerSecond: throughput(corpus.bytes, candidateNanoseconds),
		};
	}
	return { scenarios };
}

function publicConfiguration(configuration) {
	return {
		rounds: configuration.rounds,
		samples: configuration.samples,
		sampleMilliseconds: configuration.sampleMilliseconds,
		warmupMilliseconds: configuration.warmupMilliseconds,
	};
}

function writeComparisonReport(report, json) {
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	writeEnvironment(report.environment);
	process.stdout.write(`Baseline:  ${report.baseline}\n`);
	writeIdentity("            ", report.baselineIdentity);
	process.stdout.write(`Candidate: ${report.candidate}\n`);
	writeIdentity("            ", report.candidateIdentity);
	process.stdout.write("\n");
	process.stdout.write(
		"Corpus                     baseline    candidate    median Δ    paired Δ      MiB/s (B -> C)  pair MAD\n",
	);
	for (const corpus of BENCHMARK_CORPUS) {
		const scenario = report.summary.scenarios[corpus.id];
		const throughputPair = `${scenario.baselineMebibytesPerSecond.toFixed(2)} -> ${scenario.candidateMebibytesPerSecond.toFixed(2)}`;
		process.stdout.write(
			`${corpus.id.padEnd(25)} ${formatMilliseconds(scenario.baselineNanoseconds).padStart(10)} ` +
				`${formatMilliseconds(scenario.candidateNanoseconds).padStart(12)} ` +
				`${formatPercent(scenario.medianDeltaPercent).padStart(11)} ` +
				`${formatPercent(scenario.pairedDeltaPercent).padStart(11)} ` +
				`${throughputPair.padStart(19)} ` +
				`${formatPercentagePoints(scenario.pairedRatioMad * 100).padStart(10)}\n`,
		);
	}
	process.stdout.write(
		"\nMedian Δ matches the displayed medians; paired Δ controls for AB/BA order. Negative means faster.\n" +
			"No cross-corpus aggregate is reported.\n",
	);
}

function writeSingleReport(report, json) {
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	writeEnvironment(report.environment);
	process.stdout.write(`Module: ${report.module}\n`);
	writeIdentity("        ", report.run.identity);
	process.stdout.write("\n");
	process.stdout.write("Corpus                    API              KiB       ms/op       MiB/s  sample MAD\n");
	for (const corpus of BENCHMARK_CORPUS) {
		const scenario = report.run.scenarios[corpus.id];
		const relativeMad = scenario.madNanoseconds / scenario.medianNanoseconds;
		process.stdout.write(
			`${corpus.id.padEnd(25)} ${corpus.operation.padEnd(11)} ` +
				`${(corpus.bytes / 1024).toFixed(1).padStart(8)} ` +
				`${formatMilliseconds(scenario.medianNanoseconds).padStart(11)} ` +
				`${throughput(corpus.bytes, scenario.medianNanoseconds).toFixed(2).padStart(11)} ` +
				`${formatPercent(relativeMad * 100).padStart(11)}\n`,
		);
	}
}

function writeEnvironment(environment) {
	process.stdout.write(
		`Node ${environment.node} ${environment.platform}/${environment.architecture}; ${environment.cpu ?? "unknown CPU"}\n`,
	);
}

function writeIdentity(prefix, identity) {
	const runtime = shortDigest(identity.runtimeSha256);
	const dependencies = Object.entries(identity.dependencies)
		.map(([name, dependency]) => `${name} ${shortDigest(dependency.sha256)}`)
		.join("; ");
	const suffix = dependencies === "" ? "" : `; ${dependencies}`;
	process.stdout.write(`${prefix}runtime ${runtime}${suffix}\n`);
}

function shortDigest(digest) {
	return digest.slice(0, 12);
}

function formatMilliseconds(nanoseconds) {
	return `${(nanoseconds / 1e6).toFixed(3)} ms`;
}

function formatPercent(percent) {
	const prefix = percent > 0 ? "+" : "";
	return `${prefix}${percent.toFixed(2)}%`;
}

function formatPercentagePoints(points) {
	return `${points.toFixed(2)} pp`;
}
