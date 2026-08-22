import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { updateIntegrationFixtures } from "../integration/update-fixtures.js";

test("fixture updater creates exactly one reviewed result", async (t) => {
	const root = await createFixtureRoot(t);
	const caseDirectory = await createManualCase(root, "transform/basic", "const value: number = 1;\n");
	const silent = () => {};

	const updated = await updateIntegrationFixtures({ root, log: silent });
	assert.deepEqual(updated, { blockers: 0, cases: 1, deletions: 0, errors: 0, outputs: 1, writes: 1 });
	assert.deepEqual((await readdir(caseDirectory)).sort(), ["case.json", "input.ts", "output.js"]);
});

test("fixture updater check mode leaves a current result untouched", async (t) => {
	const root = await createFixtureRoot(t);
	await createManualCase(root, "transform/current", "const value: number = 1;\n");
	const silent = () => {};
	await updateIntegrationFixtures({ root, log: silent });

	const checked = await updateIntegrationFixtures({ root, check: true, log: silent });
	assert.deepEqual({ deletions: checked.deletions, writes: checked.writes }, { deletions: 0, writes: 0 });
});

test("fixture updater replaces a stale success with one human-readable error", async (t) => {
	const root = await createFixtureRoot(t);
	const caseDirectory = await createManualCase(root, "transform/transition", "const value: number = 1;\n");
	const silent = () => {};
	await updateIntegrationFixtures({ root, log: silent });

	await writeFile(path.join(caseDirectory, "input.ts"), "const : number = 1;\n");
	const updated = await updateIntegrationFixtures({ root, log: silent });

	assert.equal(updated.errors, 1);
	assert.equal(updated.deletions, 1);
	assert.deepEqual((await readdir(caseDirectory)).sort(), ["case.json", "error.txt", "input.ts"]);
	assert.match(await readFile(path.join(caseDirectory, "error.txt"), "utf8"), /^SyntaxError: .+\n$/u);
});

test("fixture updater refuses blocker observation drift", async (t) => {
	const { caseDirectory, root, silent } = await createBlockedFixture(t);

	await writeFile(path.join(caseDirectory, "input.ts"), "function broken(value number) {}\n");
	await assert.rejects(updateIntegrationFixtures({ root, check: true, log: silent }), /blocker observation changed/u);
});

test("fixture updater reports a resolved blocker as XPASS", async (t) => {
	const { caseDirectory, root, silent } = await createBlockedFixture(t);

	await writeFile(path.join(caseDirectory, "input.ts"), "function working(value: number) {}\n");
	await assert.rejects(updateIntegrationFixtures({ root, check: true, log: silent }), /XPASS: blocker resolved/u);
});

async function createBlockedFixture(t) {
	const root = await createFixtureRoot(t);
	const caseDirectory = await createManualCase(root, "transform/blocked", "function broken(: number) {}\n", {
		blocker: {
			dependency: "parser",
			expected: "output",
			reason: "test blocker",
		},
	});
	const silent = () => {};
	await updateIntegrationFixtures({ root, log: silent });
	assert.deepEqual((await readdir(caseDirectory)).sort(), ["blocker.json", "case.json", "input.ts"]);
	return { caseDirectory, root, silent };
}

async function createFixtureRoot(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), "syntaxase-integration-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	return root;
}

async function createManualCase(root, relativePath, source, extra = {}) {
	const directory = path.join(root, relativePath);
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, "input.ts"), source);
	await writeFile(
		path.join(directory, "case.json"),
		`${JSON.stringify(
			{
				schema: 1,
				kind: "manual",
				operation: "transform",
				invariant: `tooling.${relativePath.replaceAll("/", ".")}`,
				whyManual: "temporary tooling fixture",
				...extra,
			},
			null,
			"\t",
		)}\n`,
	);
	return directory;
}
