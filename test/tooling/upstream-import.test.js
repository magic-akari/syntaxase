import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseArguments } from "../integration/importers/cli.js";
import { discoverTypeScriptErasable } from "../integration/importers/adapters/typescript-erasable.js";
import { planWorkloads } from "../integration/importers/planner.js";
import { syncUpstreamFixtures, validateGeneratedCatalogs } from "../integration/importers/sync.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const repositoryConfigPath = fileURLToPath(new URL("../integration/upstream/config.json", import.meta.url));

test("committed upstream catalogs validate without upstream checkouts", async () => {
	assert.deepEqual(await validateGeneratedCatalogs({ configPath: repositoryConfigPath, root: repositoryRoot }), {
		blocked: 6,
		cases: 361,
		excluded: 5,
		projects: 3,
	});
});

test("workload planning merges exact public invocations and preserves every origin", () => {
	const first = selectedWorkload("first", "input.ts", undefined);
	const second = selectedWorkload("second", "input.ts", undefined);
	const planned = planWorkloads("transform", [first, second]);

	assert.equal(planned.length, 1);
	assert.equal(planned[0].target, "target/first");
	assert.deepEqual(planned[0].identities, [first.identity, second.identity]);
	assert.deepEqual(planned[0].origins, [first.origin, second.origin]);
});

test("workload planning treats implicit TSX parsing as an effective public option", () => {
	const typescript = selectedWorkload("typescript", "input.ts", undefined);
	const tsx = selectedWorkload("tsx", "input.tsx", undefined);

	assert.equal(planWorkloads("transform", [typescript, tsx]).length, 2);
});

test("TypeScript erasable adapter preserves each @filename virtual file as one workload", async () => {
	const discovery = await discoverSyntheticTypeScript();

	assert.equal(discovery.stats.declarationVirtualFiles, 1);
	assert.deepEqual(
		discovery.candidates.map((candidate) => candidate.oracle),
		["reject", "accept", "reject"],
	);
	assert.deepEqual(
		discovery.candidates.map((candidate) => candidate.inputFile),
		["input.ts", "input.mts", "input.ts"],
	);
	assert.deepEqual(
		discovery.candidates.map((candidate) => candidate.extraction),
		[["virtual-file"], ["virtual-file"], ["virtual-file"]],
	);
	assert.equal(discovery.candidates[0].input, "enum E {}\nconst value: number = 1;\n");
	assert.equal(discovery.candidates[2].input, "let first = <unknown\nlet second = <unknown\n");
});

test("upstream sync discovers, plans, writes, and rechecks a pinned Git tree", async (t) => {
	const fixture = await createTypeScriptRepository(t);
	const first = await syncUpstreamFixtures(fixture.syncOptions(true));
	assert.deepEqual(first.summary, { blocked: 0, discovered: 3, excluded: 0, included: 3 });
	assert.ok(first.changes.some((change) => change.relativePath.endsWith("CATALOG.json")));

	const checked = await syncUpstreamFixtures(fixture.syncOptions(false));
	assert.equal(checked.changes.length, 0);
	assert.deepEqual(await validateGeneratedCatalogs({ configPath: fixture.configPath, root: fixture.root }), {
		blocked: 0,
		cases: 3,
		excluded: 0,
		projects: 1,
	});

	const catalog = JSON.parse(await readFile(path.join(fixture.targetRoot, "CATALOG.json"), "utf8"));
	assert.equal(catalog.schema, 3);
	assert.deepEqual(catalog.cases.map((catalogCase) => catalogCase.oracle).sort(), ["accept", "reject", "reject"]);
});

test("CLI parses explicit checkout mappings", () => {
	const options = parseArguments([
		"--config",
		"custom.json",
		"--checkout",
		"typescript=/source/typescript",
		"--write",
	]);
	assert.equal(options.configPath, "custom.json");
	assert.equal(options.write, true);
	assert.deepEqual([...options.checkouts], [["typescript", "/source/typescript"]]);
});

test("CLI rejects duplicate checkout ids", () => {
	assert.throws(
		() => parseArguments(["--checkout", "duplicate=/one", "--checkout", "duplicate=/two"]),
		/Duplicate --checkout/u,
	);
});

function selectedWorkload(name, inputFile, options) {
	return {
		candidate: { input: "const value: number = 1;\n", inputFile },
		identity: { name },
		options,
		oracle: "input",
		origin: { name },
		target: `target/${name}`,
		targetDirectory: `/target/${name}`,
	};
}

async function discoverSyntheticTypeScript() {
	const sources = syntheticTypeScriptSources();
	return discoverTypeScriptErasable({
		listFiles: async () =>
			[...sources.keys()].filter((sourcePath) => sourcePath.startsWith("tests/cases/compiler/")),
		project: typescriptProject("test/integration/cases/upstream/typescript-fixture"),
		readText: async (sourcePath) => sources.get(sourcePath),
	});
}

function syntheticTypeScriptSources() {
	return new Map([
		[
			"tests/cases/compiler/erasableSyntaxOnly.ts",
			[
				"// @erasableSyntaxOnly: true",
				"// @filename: index.ts",
				"enum E {}",
				"const value: number = 1;",
				"// @filename: types.d.ts",
				"declare const ignored: number;",
				"// @filename: esm.mts",
				"export const accepted: number = 1;",
				"",
			].join("\n"),
		],
		[
			"tests/baselines/reference/erasableSyntaxOnly.errors.txt",
			"index.ts(1,6): error TS1294: This syntax is not allowed.\n",
		],
		[
			"tests/cases/compiler/erasableSyntaxOnly2.ts",
			"// @filename: index.ts\nlet first = <unknown\nlet second = <unknown\n",
		],
		[
			"tests/baselines/reference/erasableSyntaxOnly2.errors.txt",
			[
				"index.ts(1,13): error TS1294: This syntax is not allowed.",
				"index.ts(1,21): error TS1005: '>' expected.",
				"index.ts(2,14): error TS1294: This syntax is not allowed.",
				"",
			].join("\n"),
		],
		["tests/cases/compiler/erasableSyntaxOnlyDeclaration.ts", "declare const value: number;\n"],
	]);
}

function typescriptProject(targetRoot) {
	return {
		id: "typescript-fixture",
		sourceExclusions: [
			{
				path: "tests/cases/compiler/erasableSyntaxOnlyDeclaration.ts",
				reason: "declaration files are outside the runtime API",
			},
		],
		targetRoot,
	};
}

async function createTypeScriptRepository(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), "syntaxase-upstream-root-"));
	const checkout = await mkdtemp(path.join(os.tmpdir(), "syntaxase-upstream-git-"));
	t.after(() =>
		Promise.all([rm(root, { force: true, recursive: true }), rm(checkout, { force: true, recursive: true })]),
	);

	const sources = syntheticTypeScriptSources();
	for (const [sourcePath, content] of sources) {
		const filePath = path.join(checkout, sourcePath);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content);
	}
	await execFileAsync("git", ["init", "--quiet"], { cwd: checkout });
	await execFileAsync("git", ["add", "."], { cwd: checkout });
	await execFileAsync(
		"git",
		[
			"-c",
			"user.name=Syntaxase Tests",
			"-c",
			"user.email=tests@invalid.example",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		],
		{ cwd: checkout },
	);
	const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
	const commit = stdout.trim();
	const targetRootRelative = "test/integration/cases/upstream/typescript-fixture";
	const targetRoot = path.join(root, targetRootRelative);
	const configPath = path.join(root, "test/integration/upstream/config.json");
	await mkdir(path.dirname(configPath), { recursive: true });
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				version: 3,
				projects: [
					{
						...typescriptProject(targetRootRelative),
						adapter: "typescript-erasable",
						blockers: [],
						commit,
						exclusions: [],
						operation: "stripTypes",
						repository: "https://example.invalid/typescript.git",
						version: "fixture",
					},
				],
			},
			null,
			"\t",
		)}\n`,
	);

	return {
		configPath,
		root,
		targetRoot,
		syncOptions(write) {
			return {
				checkouts: new Map([["typescript-fixture", checkout]]),
				configPath,
				log: () => {},
				root,
				write,
			};
		},
	};
}
