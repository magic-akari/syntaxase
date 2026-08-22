import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripTypes, transform } from "../../index.js";

export const fixtureRoot = fileURLToPath(new URL("./cases", import.meta.url));
export const resultFileNames = new Set(["blocker.json", "error.txt", "output.js"]);

const inputFileNames = new Set(["input.cts", "input.mts", "input.ts", "input.tsx"]);
const caseFileNames = new Set(["case.json", ...inputFileNames, ...resultFileNames]);

export async function collectIntegrationCases(root = fixtureRoot, { requireResult = true } = {}) {
	const cases = [];
	await collectCaseDirectories(root, root, cases, requireResult);
	cases.sort((left, right) => compareCodeUnits(left.name, right.name));
	validateManualInvariants(cases);
	await validateUniqueWorkloads(cases);
	return cases;
}

export async function evaluateIntegrationCase(integrationCase) {
	const source = await readCaseFile(integrationCase, integrationCase.inputName);
	const metadata = integrationCase.metadata;
	let actual;

	try {
		const output =
			metadata.operation === "stripTypes"
				? stripTypes(source)
				: transform(source, normalizedTransformOptions(integrationCase));
		assert.equal(typeof output, "string", `${integrationCase.name} must return a string`);
		if (metadata.operation === "stripTypes") {
			assert.equal(output.length, source.length, `${integrationCase.name} must preserve UTF-16 width`);
			assert.deepEqual(
				physicalLineTerminators(output),
				physicalLineTerminators(source),
				`${integrationCase.name} must preserve physical line terminators`,
			);
		}
		actual = { content: output, kind: "output" };
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}
		actual = { content: formatError(error), kind: "error" };
	}

	if (metadata.blocker !== undefined) {
		if (actual.kind === metadata.blocker.expected) {
			const reference = metadata.blocker.issue ?? metadata.blocker.reason;
			throw new Error(`${integrationCase.name} XPASS: blocker resolved (${reference})`);
		}
		return {
			content: formatJson({
				kind: actual.kind,
				[actual.kind === "error" ? "error" : "output"]: actual.content,
			}),
			fileName: "blocker.json",
			kind: "blocker",
		};
	}

	validateOracle(integrationCase, actual.kind);
	return {
		content: actual.content,
		fileName: actual.kind === "error" ? "error.txt" : "output.js",
		kind: actual.kind,
	};
}

export async function readCaseFile(integrationCase, fileName) {
	return readFile(path.join(integrationCase.directory, fileName), "utf8");
}

export function formatError(error) {
	assert.ok(error && typeof error === "object", "public API must throw an Error object");
	assert.equal(typeof error.name, "string", "public API error must have a name");
	assert.equal(typeof error.message, "string", "public API error must have a message");
	return `${error.name}: ${error.message}\n`;
}

export function visibleText(source) {
	let output = "";
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "\r" && source[index + 1] === "\n") {
			output += "␍␊\n";
			index += 1;
		} else if (character === "\r") {
			output += "␍\n";
		} else if (character === "\n") {
			output += "␊\n";
		} else if (character === "\u2028") {
			output += "⟨LS⟩\n";
		} else if (character === "\u2029") {
			output += "⟨PS⟩\n";
		} else if (character === " ") {
			output += "·";
		} else if (character === "\t") {
			output += "⇥";
		} else {
			output += character;
		}
	}
	return output;
}

async function collectCaseDirectories(root, directory, cases, requireResult) {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		assert.equal(entry.isSymbolicLink(), false, `${path.join(directory, entry.name)} must not be a symbolic link`);
	}

	const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
	const inputs = [...inputFileNames].filter((fileName) => fileNames.has(fileName));
	const reservedFiles = [...fileNames].filter((fileName) => caseFileNames.has(fileName));
	if (inputs.length > 0 || reservedFiles.length > 0) {
		assert.equal(inputs.length, 1, `${directory} must contain exactly one input file`);
		assert.ok(fileNames.has("case.json"), `${directory} must contain case.json`);
		const resultCount = [...resultFileNames].filter((fileName) => fileNames.has(fileName)).length;
		if (requireResult) {
			assert.equal(resultCount, 1, `${directory} must contain exactly one result file`);
		} else {
			assert.ok(resultCount <= 1, `${directory} must not contain multiple result files`);
		}
		const nested = entries.filter((entry) => entry.isDirectory());
		assert.equal(nested.length, 0, `${directory} case directory must not contain nested directories`);

		const name = path.relative(root, directory).split(path.sep).join("/");
		const metadata = JSON.parse(await readFile(path.join(directory, "case.json"), "utf8"));
		validateCaseMetadata(name, metadata);
		cases.push({ directory, fileNames, inputName: inputs[0], metadata, name });
		return;
	}

	for (const entry of entries) {
		if (entry.isDirectory()) {
			await collectCaseDirectories(root, path.join(directory, entry.name), cases, requireResult);
		}
	}
}

function validateCaseMetadata(caseName, metadata) {
	assertRecord(metadata, `${caseName}/case.json`);
	assert.equal(metadata.schema, 1, `${caseName}/case.json has unsupported schema`);
	assert.ok(metadata.kind === "manual" || metadata.kind === "upstream", `${caseName} has invalid kind`);
	assert.ok(
		metadata.operation === "stripTypes" || metadata.operation === "transform",
		`${caseName} has invalid operation`,
	);
	validateOptions(caseName, metadata.options, metadata.operation);
	if (metadata.kind === "manual") {
		assertNonEmptyString(metadata.invariant, `${caseName} invariant`);
		assertNonEmptyString(metadata.whyManual, `${caseName} whyManual`);
		assert.equal(metadata.origins, undefined, `${caseName} manual case must not declare origins`);
		assert.equal(metadata.oracle, undefined, `${caseName} manual case must not declare an oracle`);
	} else {
		assert.ok(Array.isArray(metadata.origins) && metadata.origins.length > 0, `${caseName} must declare origins`);
		for (const [index, origin] of metadata.origins.entries()) {
			assertRecord(origin, `${caseName} origin ${index}`);
		}
		assert.ok(
			metadata.oracle === "input" || metadata.oracle === "accept" || metadata.oracle === "reject",
			`${caseName} has invalid oracle`,
		);
	}
	if (metadata.blocker !== undefined) {
		validateBlocker(caseName, metadata.blocker);
	}
}

function validateOptions(caseName, options, operation) {
	if (options === undefined) {
		return;
	}
	assert.equal(operation, "transform", `${caseName} stripTypes case must not have options`);
	assertRecord(options, `${caseName} options`);
	assert.deepEqual(
		Object.keys(options).filter((key) => key !== "jsx"),
		[],
		`${caseName} options contain unknown fields`,
	);
	if (options.jsx === undefined || typeof options.jsx === "boolean") {
		return;
	}
	assertRecord(options.jsx, `${caseName} jsx options`);
	const allowed = new Set(["development", "importSource", "pragma", "pragmaFrag", "runtime"]);
	for (const key of Object.keys(options.jsx)) {
		assert.ok(allowed.has(key), `${caseName} has unknown JSX option ${key}`);
	}
}

function validateBlocker(caseName, blocker) {
	assertRecord(blocker, `${caseName} blocker`);
	assertNonEmptyString(blocker.dependency, `${caseName} blocker dependency`);
	assert.ok(
		blocker.issue !== undefined || blocker.reason !== undefined,
		`${caseName} blocker needs an issue or reason`,
	);
	if (blocker.issue !== undefined) {
		assertNonEmptyString(blocker.issue, `${caseName} blocker issue`);
		assert.doesNotThrow(() => new URL(blocker.issue), `${caseName} blocker issue must be a URL`);
	}
	if (blocker.reason !== undefined) {
		assertNonEmptyString(blocker.reason, `${caseName} blocker reason`);
	}
	assert.ok(blocker.expected === "error" || blocker.expected === "output", `${caseName} blocker expected is invalid`);
	if (blocker.pullRequest !== undefined) {
		assertNonEmptyString(blocker.pullRequest, `${caseName} blocker pullRequest`);
		assert.doesNotThrow(() => new URL(blocker.pullRequest), `${caseName} blocker pullRequest must be a URL`);
	}
}

function validateManualInvariants(cases) {
	const owners = new Map();
	for (const integrationCase of cases) {
		if (integrationCase.metadata.kind !== "manual") {
			continue;
		}
		const invariant = integrationCase.metadata.invariant;
		assert.equal(owners.has(invariant), false, `${integrationCase.name} duplicates manual invariant ${invariant}`);
		owners.set(invariant, integrationCase.name);
	}
}

async function validateUniqueWorkloads(cases) {
	const owners = new Map();
	for (const integrationCase of cases) {
		const options = structuredClone(integrationCase.metadata.options ?? {});
		if (
			integrationCase.metadata.operation === "transform" &&
			options.jsx === undefined &&
			integrationCase.inputName === "input.tsx"
		) {
			options.jsx = true;
		}
		const source = await readCaseFile(integrationCase, integrationCase.inputName);
		const key = createHash("sha256")
			.update(integrationCase.metadata.operation)
			.update("\0")
			.update(JSON.stringify(canonicalize(options)))
			.update("\0")
			.update(source)
			.digest("hex");
		const prior = owners.get(key);
		if (prior !== undefined) {
			throw new Error(`${integrationCase.name} duplicates integration workload ${prior}`);
		}
		owners.set(key, integrationCase.name);
	}
}

function normalizedTransformOptions(integrationCase) {
	const options = structuredClone(integrationCase.metadata.options ?? {});
	if (options.jsx === undefined && integrationCase.inputName === "input.tsx") {
		options.jsx = true;
	}
	return options;
}

function validateOracle(integrationCase, actualKind) {
	const oracle = integrationCase.metadata.oracle;
	if (oracle === undefined || oracle === "input") {
		return;
	}
	const expectedKind = oracle === "accept" ? "output" : "error";
	assert.equal(actualKind, expectedKind, `${integrationCase.name} violates its ${oracle} upstream oracle`);
}

function physicalLineTerminators(source) {
	return source.match(/\r\n|[\r\n\u2028\u2029]/gu) ?? [];
}

function formatJson(value) {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function assertRecord(value, label) {
	assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertNonEmptyString(value, label) {
	assert.equal(typeof value, "string", `${label} must be a string`);
	assert.ok(value.length > 0, `${label} must not be empty`);
}

function canonicalize(value) {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
