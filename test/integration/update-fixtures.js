import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectIntegrationCases, evaluateIntegrationCase, fixtureRoot, resultFileNames } from "./fixtures.js";

export async function updateIntegrationFixtures({
	root = fixtureRoot,
	check = false,
	caseNames,
	log = console.log,
} = {}) {
	const allCases = await collectIntegrationCases(root, { requireResult: check });
	const selected = selectCases(allCases, caseNames);
	const plan = [];
	const summary = { blockers: 0, cases: selected.length, errors: 0, outputs: 0, writes: 0, deletions: 0 };

	for (const integrationCase of selected) {
		const result = await evaluateIntegrationCase(integrationCase);
		if (result.kind === "blocker") {
			summary.blockers += 1;
		} else if (result.kind === "error") {
			summary.errors += 1;
		} else {
			summary.outputs += 1;
		}

		const resultPath = path.join(integrationCase.directory, result.fileName);
		const current = await readOptionalFile(resultPath);
		if (current !== result.content) {
			if (result.kind === "blocker" && current !== undefined) {
				throw new Error(`${integrationCase.name} blocker observation changed; review it manually`);
			}
			plan.push({ action: "write", content: result.content, filePath: resultPath });
		}

		for (const fileName of resultFileNames) {
			if (fileName === result.fileName || !integrationCase.fileNames.has(fileName)) {
				continue;
			}
			plan.push({ action: "delete", filePath: path.join(integrationCase.directory, fileName) });
		}
	}

	summary.writes = plan.filter((operation) => operation.action === "write").length;
	summary.deletions = plan.filter((operation) => operation.action === "delete").length;
	if (check && plan.length > 0) {
		throw new Error(formatDrift(root, plan));
	}
	if (!check) {
		for (const operation of plan.filter((item) => item.action === "write")) {
			await assertResultTarget(operation.filePath);
			await writeFileAtomically(operation.filePath, operation.content);
		}
		for (const operation of plan.filter((item) => item.action === "delete")) {
			await assertResultTarget(operation.filePath);
			await unlink(operation.filePath);
		}
	}

	log(
		`${check ? "Checked" : "Updated"} ${summary.cases} integration cases: ${summary.outputs} outputs, ${summary.errors} errors, ${summary.blockers} blockers, ${summary.writes} writes, ${summary.deletions} deletions.`,
	);
	return summary;
}

function selectCases(cases, caseNames) {
	if (caseNames === undefined) {
		return cases;
	}
	const requested = new Set(caseNames);
	const selected = cases.filter((integrationCase) => requested.delete(integrationCase.name));
	if (requested.size > 0) {
		throw new Error(`Unknown integration case: ${[...requested].join(", ")}`);
	}
	return selected;
}

async function assertResultTarget(filePath) {
	try {
		const stats = await lstat(filePath);
		if (!stats.isFile() || stats.isSymbolicLink()) {
			throw new Error(`${filePath} must be a regular file`);
		}
	} catch (error) {
		if (error.code !== "ENOENT") {
			throw error;
		}
	}
}

async function readOptionalFile(filePath) {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function writeFileAtomically(filePath, content) {
	const temporaryPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
		await rename(temporaryPath, filePath);
	} catch (error) {
		await unlink(temporaryPath).catch((cleanupError) => {
			if (cleanupError.code !== "ENOENT") {
				throw cleanupError;
			}
		});
		throw error;
	}
}

function formatDrift(root, plan) {
	const paths = plan
		.slice(0, 20)
		.map((operation) => `  ${operation.action} ${path.relative(root, operation.filePath)}`);
	if (plan.length > paths.length) {
		paths.push(`  ... and ${plan.length - paths.length} more`);
	}
	return `Integration fixtures are out of date:\n${paths.join("\n")}`;
}

function printHelp() {
	console.log(
		`Usage: node test/integration/update-fixtures.js (--all | --case ID...) [--check]\n\nUpdates are always explicit. --check validates every fixture without writing.`,
	);
}

async function main(arguments_) {
	let all = false;
	let check = false;
	const caseNames = [];
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--all") {
			all = true;
		} else if (argument === "--check") {
			check = true;
		} else if (argument === "--case") {
			index += 1;
			if (arguments_[index] === undefined) {
				throw new Error("--case requires an integration case id");
			}
			caseNames.push(arguments_[index]);
		} else if (argument === "--help" || argument === "-h") {
			printHelp();
			return;
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}
	if (all === caseNames.length > 0) {
		throw new Error("Choose exactly one of --all or --case");
	}
	await updateIntegrationFixtures({ check, caseNames: all ? undefined : caseNames });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
