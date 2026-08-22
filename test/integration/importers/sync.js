import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { adapterVersion as sucraseAdapterVersion, discoverSucrase } from "./adapters/sucrase.js";
import { adapterVersion as tsBlankSpaceAdapterVersion, discoverTsBlankSpace } from "./adapters/ts-blank-space.js";
import {
	adapterVersion as typescriptErasableAdapterVersion,
	discoverTypeScriptErasable,
} from "./adapters/typescript-erasable.js";
import { planWorkloads } from "./planner.js";

const execFileAsync = promisify(execFile);
const defaultRoot = fileURLToPath(new URL("../../..", import.meta.url));
const defaultConfigPath = fileURLToPath(new URL("../upstream/config.json", import.meta.url));
const integrationUpstreamRoot = "test/integration/cases/upstream";
const inputFileNames = new Set(["input.cts", "input.mts", "input.ts", "input.tsx"]);
const managedFileNames = new Set(["CATALOG.json", "case.json", "input.ts", "input.tsx", "input.cts", "input.mts"]);
const reviewedFileNames = new Set(["blocker.json", "error.txt", "output.js"]);
const targetRootMetadataFileNames = new Set(["LICENSE", "PROVENANCE.md"]);
const gitEnvironment = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };

const adapters = new Map([
	[
		"sucrase",
		{
			discover: discoverSucrase,
			implementationHash: hashImplementation([
				new URL("./sync.js", import.meta.url),
				new URL("./planner.js", import.meta.url),
				new URL("./adapters/ast.js", import.meta.url),
				new URL("./adapters/sucrase.js", import.meta.url),
			]),
			version: sucraseAdapterVersion,
		},
	],
	[
		"ts-blank-space",
		{
			discover: discoverTsBlankSpace,
			implementationHash: hashImplementation([
				new URL("./sync.js", import.meta.url),
				new URL("./planner.js", import.meta.url),
				new URL("./adapters/ast.js", import.meta.url),
				new URL("./adapters/ts-blank-space.js", import.meta.url),
			]),
			version: tsBlankSpaceAdapterVersion,
		},
	],
	[
		"typescript-erasable",
		{
			discover: discoverTypeScriptErasable,
			implementationHash: hashImplementation([
				new URL("./sync.js", import.meta.url),
				new URL("./planner.js", import.meta.url),
				new URL("./adapters/ast.js", import.meta.url),
				new URL("./adapters/typescript-erasable.js", import.meta.url),
			]),
			version: typescriptErasableAdapterVersion,
		},
	],
]);

export async function syncUpstreamFixtures({
	root = defaultRoot,
	configPath = defaultConfigPath,
	checkouts,
	write = false,
	log = () => {},
} = {}) {
	if (!(checkouts instanceof Map)) {
		throw new TypeError("checkouts must be a Map of upstream project id to local checkout");
	}

	const rootPath = await realpath(root);
	const configuration = await readConfiguration(resolveConfigurationPath(rootPath, configPath));
	validateCheckoutKeys(configuration.projects, checkouts);

	const expectedFiles = [];
	const expectedCaseDirectories = new Map();
	const projectResults = [];

	for (const project of configuration.projects) {
		const checkoutPath = await validateCheckout(project, checkouts.get(project.id));
		const tree = await readGitTree(checkoutPath, project);
		const adapter = adapters.get(project.adapter);
		const discovery = await adapter.discover({
			listFiles: (prefix) => listTreeFiles(tree, prefix, project.id),
			project,
			readText: (sourcePath) => readTreeFile(checkoutPath, tree, sourcePath, project.id),
		});
		const generated = buildProject(project, adapter, discovery, rootPath);

		expectedFiles.push(...generated.expectedFiles);
		expectedCaseDirectories.set(project.id, generated.expectedCaseDirectories);
		projectResults.push(generated.result);
	}

	const orphanProblems = [];
	for (const project of configuration.projects) {
		const targetRoot = resolveProjectTargetRoot(rootPath, project);
		await assertNoSymlinkComponents(rootPath, targetRoot, `${project.id} targetRoot`);
		const projectExpected = new Set(
			expectedFiles.filter((file) => file.projectId === project.id).map((file) => file.path),
		);
		const caseDirectories = expectedCaseDirectories.get(project.id);
		orphanProblems.push(...(await findOrphans(rootPath, targetRoot, projectExpected, caseDirectories)));
	}
	if (orphanProblems.length > 0) {
		throw new Error(formatProblems("Orphaned generated upstream fixture data", orphanProblems));
	}

	const changes = [];
	for (const expectedFile of expectedFiles) {
		await assertNoSymlinkComponents(rootPath, expectedFile.path, expectedFile.label);
		const reason = await compareFile(expectedFile.path, expectedFile.content);
		if (reason !== null) {
			changes.push({ ...expectedFile, reason });
		}
	}

	if (!write && changes.length > 0) {
		const problems = changes.map((change) => `${change.relativePath} (${change.reason})`);
		throw new Error(
			`${formatProblems("Upstream fixture drift detected", problems)}\nRun again with --write after review.`,
		);
	}
	if (write) {
		for (const change of changes) {
			await writeFileAtomically(rootPath, change.path, change.content, change.label);
			log(`wrote ${change.relativePath}`);
		}
	}

	const summary = summarizeProjects(projectResults);
	log(
		`${write ? "updated" : "checked"} ${summary.included} imported inputs ` +
			`(${summary.blocked} blocked, ${summary.discovered} discovered, ${summary.excluded} excluded)`,
	);
	return { changes, projects: projectResults, summary };
}

export async function validateGeneratedCatalogs({ root = defaultRoot, configPath = defaultConfigPath } = {}) {
	const rootPath = await realpath(root);
	const configuration = await readConfiguration(resolveConfigurationPath(rootPath, configPath));
	let caseCount = 0;
	let blockedCount = 0;
	let excludedCount = 0;

	for (const project of configuration.projects) {
		const adapter = adapters.get(project.adapter);
		const targetRoot = resolveProjectTargetRoot(rootPath, project);
		const catalogPath = path.join(targetRoot, "CATALOG.json");
		await assertNoSymlinkComponents(rootPath, targetRoot, `${project.id} targetRoot`);
		const catalog = await readJsonFile(catalogPath, `${project.id} catalog`);
		validateCatalogHeader(catalog, project, adapter);

		const expectedFiles = new Set([catalogPath]);
		const expectedCaseDirectories = new Set();
		const seenTargets = new Set();
		const seenIdentities = new Set();
		for (const catalogCase of catalog.cases) {
			validateCatalogCase(catalogCase, project);
			for (const identity of catalogCase.identities) {
				const identityText = stableStringify(identity);
				if (seenIdentities.has(identityText)) {
					throw new Error(`${project.id} catalog contains a duplicate case identity`);
				}
				seenIdentities.add(identityText);
			}

			const targetDirectory = resolveWithin(rootPath, catalogCase.target, `${project.id} catalog target`);
			assertInside(targetRoot, targetDirectory, `${project.id} catalog target`);
			if (targetDirectory === targetRoot || seenTargets.has(targetDirectory)) {
				throw new Error(`${project.id} catalog contains a duplicate or root-level target`);
			}
			seenTargets.add(targetDirectory);
			expectedCaseDirectories.add(targetDirectory);

			const inputPath = path.join(targetDirectory, catalogCase.inputFile);
			await assertNoSymlinkComponents(rootPath, inputPath, `${project.id} catalog input`);
			const input = await readRequiredFile(inputPath, `${project.id} catalog input`);
			if (sha256(input) !== catalogCase.inputSha256) {
				throw new Error(`${relativeToRoot(rootPath, inputPath)} does not match its catalog hash`);
			}
			expectedFiles.add(inputPath);

			const casePath = path.join(targetDirectory, "case.json");
			const caseMetadata = {
				schema: 1,
				kind: "upstream",
				operation: project.operation,
				oracle: catalogCase.oracle,
				origins: catalogCase.origins,
				...(catalogCase.options === undefined ? {} : { options: catalogCase.options }),
				...(catalogCase.blocker === undefined ? {} : { blocker: catalogCase.blocker }),
			};
			await assertExpectedContent(rootPath, casePath, formatJson(caseMetadata));
			expectedFiles.add(casePath);
			if (catalogCase.blocker !== undefined) {
				blockedCount += 1;
			}
		}
		for (const exclusion of catalog.excluded) {
			if (
				!isRecord(exclusion) ||
				!isRecord(exclusion.identity) ||
				typeof exclusion.reason !== "string" ||
				(exclusion.kind !== "policy" && exclusion.kind !== "configured")
			) {
				throw new Error(`${project.id} catalog contains an invalid excluded entry`);
			}
			validateIdentity(exclusion.identity, project);
			const identityText = stableStringify(exclusion.identity);
			if (seenIdentities.has(identityText)) {
				throw new Error(`${project.id} catalog repeats an included or excluded identity`);
			}
			seenIdentities.add(identityText);
		}

		if (catalog.summary.included !== catalog.cases.length) {
			throw new Error(`${project.id} catalog summary.included does not match its cases`);
		}
		const projectBlockedCount = catalog.cases.filter((catalogCase) => catalogCase.blocker !== undefined).length;
		if (catalog.summary.blocked !== projectBlockedCount) {
			throw new Error(`${project.id} catalog summary.blocked does not match its cases`);
		}
		if (catalog.summary.excluded !== catalog.excluded.length) {
			throw new Error(`${project.id} catalog summary.excluded does not match its exclusions`);
		}
		const selectedCount = catalog.cases.reduce((count, catalogCase) => count + catalogCase.identities.length, 0);
		if (catalog.summary.selected !== selectedCount) {
			throw new Error(`${project.id} catalog summary.selected is inconsistent`);
		}
		if (catalog.summary.deduplicated !== selectedCount - catalog.cases.length) {
			throw new Error(`${project.id} catalog summary.deduplicated is inconsistent`);
		}
		if (catalog.summary.discovered !== selectedCount + catalog.excluded.length) {
			throw new Error(`${project.id} catalog summary.discovered is inconsistent`);
		}

		const orphanProblems = await findOrphans(rootPath, targetRoot, expectedFiles, expectedCaseDirectories);
		if (orphanProblems.length > 0) {
			throw new Error(formatProblems("Repository upstream catalog drift", orphanProblems));
		}

		caseCount += catalog.cases.length;
		excludedCount += catalog.excluded.length;
	}

	return {
		blocked: blockedCount,
		cases: caseCount,
		excluded: excludedCount,
		projects: configuration.projects.length,
	};
}

function buildProject(project, adapter, discovery, rootPath) {
	const adapterVersion = adapter.version;
	if (!isRecord(discovery) || !Array.isArray(discovery.candidates)) {
		throw new Error(`${project.id} adapter returned an invalid discovery result`);
	}
	const targetRoot = resolveProjectTargetRoot(rootPath, project);
	const identities = new Set();
	const targets = new Set();
	const selected = [];
	const excluded = [];
	for (const candidate of discovery.candidates) {
		validateCandidate(candidate, project);
	}
	const explicitExclusions = resolveExplicitExclusions(project, discovery.candidates);
	const explicitBlockers = resolveExplicitBlockers(project, discovery.candidates);

	for (const candidate of discovery.candidates) {
		const identity = createIdentity(project.adapter, candidate);
		const identityText = stableStringify(identity);
		if (identities.has(identityText)) {
			throw new Error(`${project.id} discovered duplicate identity ${describeIdentity(identity)}`);
		}
		identities.add(identityText);

		const automaticReason = automaticExclusionReason(project, candidate);
		const explicitReason = explicitExclusions.get(candidate);
		const blocker = explicitBlockers.get(candidate);
		if (automaticReason !== null && explicitReason !== undefined) {
			throw new Error(
				`${project.id} explicitly excludes ${describeIdentity(identity)}, but it is already excluded: ${automaticReason}`,
			);
		}
		if (blocker !== undefined && (automaticReason !== null || explicitReason !== undefined)) {
			throw new Error(`${project.id} configures ${describeIdentity(identity)} as both blocked and excluded`);
		}
		const reason = automaticReason ?? explicitReason ?? null;
		if (reason !== null) {
			excluded.push(createExcludedCatalogEntry(candidate, identity, reason, explicitReason !== undefined));
			continue;
		}
		const expectedApi =
			project.adapter === "sucrase"
				? "syntaxase"
				: project.adapter === "ts-blank-space"
					? "tsBlankSpace"
					: "stripTypes";
		if (candidate.api !== expectedApi) {
			throw new Error(`${project.id} candidate api ${candidate.api} does not match ${project.operation}`);
		}
		if (candidate.input === null || candidate.unresolved !== undefined) {
			const detail = candidate.unresolved ?? "input could not be statically extracted";
			throw new Error(`${project.id} has an unresolved included test ${describeIdentity(identity)}: ${detail}`);
		}

		const target = createTarget(project, candidate, identity);
		const targetDirectory = resolveWithin(rootPath, target, `${project.id} generated target`);
		assertInside(targetRoot, targetDirectory, `${project.id} generated target`);
		if (targets.has(targetDirectory)) {
			throw new Error(`${project.id} generated duplicate target ${target}`);
		}
		targets.add(targetDirectory);
		selected.push(
			createSelectedCase(project, adapterVersion, candidate, identity, target, targetDirectory, blocker),
		);
	}

	selected.sort((left, right) => compareCodeUnits(stableStringify(left.identity), stableStringify(right.identity)));
	excluded.sort((left, right) => compareCodeUnits(stableStringify(left.identity), stableStringify(right.identity)));
	const workloads = planWorkloads(project.operation, selected);

	const summary = {
		blocked: workloads.filter((item) => item.blocker !== undefined).length,
		deduplicated: selected.length - workloads.length,
		discovered: discovery.candidates.length,
		excluded: excluded.length,
		included: workloads.length,
		selected: selected.length,
	};
	const catalog = {
		schema: 3,
		project: {
			commit: project.commit,
			id: project.id,
			repository: project.repository,
			version: project.version,
		},
		adapter: `${project.adapter}@${adapterVersion}`,
		implementationHash: adapter.implementationHash,
		configHash: projectConfigHash(project, adapter),
		discoveryStats: discovery.stats ?? {},
		summary,
		cases: workloads.map((item) => item.catalogCase),
		excluded,
	};

	const expectedFiles = [];
	const catalogPath = path.join(targetRoot, "CATALOG.json");
	expectedFiles.push(createExpectedFile(rootPath, project.id, catalogPath, formatJson(catalog), "catalog"));
	const expectedCaseDirectories = new Set();
	for (const item of workloads) {
		expectedCaseDirectories.add(item.targetDirectory);
		expectedFiles.push(
			createExpectedFile(
				rootPath,
				project.id,
				path.join(item.targetDirectory, item.candidate.inputFile),
				item.candidate.input,
				`${project.id} input`,
			),
			createExpectedFile(
				rootPath,
				project.id,
				path.join(item.targetDirectory, "case.json"),
				formatJson(createCaseMetadata(project, item)),
				`${project.id} case metadata`,
			),
		);
	}

	return {
		expectedCaseDirectories,
		expectedFiles,
		result: { id: project.id, ...summary },
	};
}

function createSelectedCase(project, adapterVersion, candidate, identity, target, targetDirectory, blocker) {
	const options = normalizePublicOptions(candidate);
	const origin = {
		schema: 2,
		upstream: {
			commit: project.commit,
			id: project.id,
			repository: project.repository,
			version: project.version,
		},
		adapter: `${project.adapter}@${adapterVersion}`,
		source: {
			endLine: candidate.sourceRange.endLine,
			path: candidate.sourcePath,
			startLine: candidate.sourceRange.startLine,
		},
		test: {
			api: candidate.api,
			invocation: candidate.invocation,
			suite: [...candidate.suite],
			title: candidate.title,
			...(candidate.variant === undefined ? {} : { variant: candidate.variant }),
		},
		extraction: [...candidate.extraction],
	};
	return {
		blocker,
		candidate,
		identity,
		options,
		oracle: oracleForCandidate(project, candidate, origin),
		origin,
		target,
		targetDirectory,
	};
}

function createCaseMetadata(project, item) {
	return {
		schema: 1,
		kind: "upstream",
		operation: project.operation,
		oracle: item.oracle,
		origins: item.origins,
		...(item.options === undefined ? {} : { options: item.options }),
		...(item.blocker === undefined ? {} : { blocker: item.blocker }),
	};
}

function oracleForCandidate(project, candidate, origin) {
	if (project.adapter === "sucrase") {
		return "input";
	}
	if (project.adapter === "typescript-erasable") {
		return candidate.oracle;
	}
	return origin.test.suite[0] === "errors" ? "reject" : "accept";
}

function createExcludedCatalogEntry(candidate, identity, reason, explicit) {
	return {
		identity,
		reason,
		kind: explicit ? "configured" : "policy",
		source: {
			endLine: candidate.sourceRange?.endLine ?? null,
			path: candidate.sourcePath ?? null,
			startLine: candidate.sourceRange?.startLine ?? null,
		},
		metadata: {
			...(candidate.availableModes === undefined ? {} : { availableModes: candidate.availableModes }),
			...(candidate.category === undefined ? {} : { category: candidate.category }),
			...(candidate.features === undefined ? {} : { features: candidate.features }),
			...(candidate.modeSelection === undefined ? {} : { modeSelection: candidate.modeSelection }),
			...(candidate.requires === undefined ? {} : { requires: candidate.requires }),
			...(candidate.selectedMode === undefined ? {} : { selectedMode: candidate.selectedMode }),
			...(candidate.status === undefined ? {} : { status: candidate.status }),
		},
	};
}

function createIdentity(adapter, candidate) {
	return {
		adapter,
		sourcePath: candidate.sourcePath,
		suite: [...candidate.suite],
		title: candidate.title,
		variant: candidate.variant ?? null,
		invocation: candidate.invocation,
		api: candidate.api,
	};
}

function createTarget(project, candidate, identity) {
	const readable = candidate.variant === undefined ? candidate.title : `${candidate.title}-${candidate.variant}`;
	const slug = slugify(readable);
	const hash = sha256(stableStringify(identity)).slice(0, 10);
	const lane = project.operation === "stripTypes" ? "strip-types" : "transform";
	return path.posix.join(project.targetRoot, lane, `${slug}--${hash}`);
}

function slugify(value) {
	const normalized = value.normalize("NFKD").toLowerCase();
	const slug = normalized
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 72)
		.replace(/-+$/g, "");
	return slug.length === 0 ? "case" : slug;
}

function normalizePublicOptions(candidate) {
	if (candidate.options === undefined) {
		return undefined;
	}
	if (!isRecord(candidate.options)) {
		throw new Error(`${candidate.title} adapter options must be an object`);
	}
	const options = { ...candidate.options };
	if (Object.hasOwn(options, "jsx")) {
		const expectedJsx = candidate.inputFile === "input.tsx";
		if (typeof options.jsx === "boolean") {
			if (options.jsx !== expectedJsx) {
				throw new Error(`${candidate.title} adapter jsx option disagrees with ${candidate.inputFile}`);
			}
			delete options.jsx;
		} else if (!expectedJsx || !isRecord(options.jsx)) {
			throw new Error(`${candidate.title} adapter jsx option disagrees with ${candidate.inputFile}`);
		}
	}
	return Object.keys(options).length === 0 ? undefined : options;
}

function automaticExclusionReason(project, candidate) {
	if (project.policy?.activeOnly === true && candidate.status !== undefined && candidate.status !== "active") {
		return `test status is ${candidate.status}`;
	}
	if (project.capabilities?.jsx === false && candidate.requires?.jsx === true) {
		return "adapter target does not support JSX";
	}
	if (candidate.modeSelection === "jsx-expectation" && candidate.selectedMode === undefined) {
		return "does not provide a supported ESM JSX mode";
	}
	if (project.policy?.customJsxPragma === false && candidate.features?.customJsxPragma === true) {
		return "uses a custom JSX pragma";
	}
	return null;
}

function resolveExplicitExclusions(project, candidates) {
	return resolveExactMatches(project, candidates, project.exclusions, "exclusion", (exclusion) => exclusion.reason);
}

function resolveExplicitBlockers(project, candidates) {
	return resolveExactMatches(project, candidates, project.blockers, "blocker", normalizeBlocker);
}

function resolveExactMatches(project, candidates, configurations, label, selectValue) {
	const result = new Map();
	for (let index = 0; index < configurations.length; index += 1) {
		const configuration = configurations[index];
		const matches = candidates.filter((candidate) => matchesSubset(candidate, configuration.match));
		if (matches.length !== 1) {
			throw new Error(
				`${project.id} ${label} ${index + 1} matched ${matches.length} tests; every ${label} must match exactly one`,
			);
		}
		if (result.has(matches[0])) {
			throw new Error(`${project.id} has multiple ${label}s for the same discovered test`);
		}
		result.set(matches[0], selectValue(configuration));
	}
	return result;
}

function normalizeBlocker(blocker) {
	return {
		dependency: blocker.dependency,
		expected: blocker.expected,
		...(blocker.issue === undefined ? {} : { issue: blocker.issue }),
		...(blocker.pullRequest === undefined ? {} : { pullRequest: blocker.pullRequest }),
		...(blocker.reason === undefined ? {} : { reason: blocker.reason }),
	};
}

function matchesSubset(value, subset) {
	if (Array.isArray(subset)) {
		if (!Array.isArray(value) || value.length !== subset.length) {
			return false;
		}
		return subset.every((item, index) => matchesSubset(value[index], item));
	}
	if (isRecord(subset)) {
		if (!isRecord(value)) {
			return false;
		}
		return Object.entries(subset).every(
			([key, item]) => Object.hasOwn(value, key) && matchesSubset(value[key], item),
		);
	}
	return Object.is(value, subset);
}

function validateCandidate(candidate, project) {
	if (!isRecord(candidate)) {
		throw new Error(`${project.id} adapter returned a non-object candidate`);
	}
	if (candidate.input !== null && typeof candidate.input !== "string") {
		throw new Error(`${project.id} candidate input must be a string or null`);
	}
	if (!inputFileNames.has(candidate.inputFile)) {
		throw new Error(`${project.id} candidate inputFile must be a supported TypeScript input name`);
	}
	if (typeof candidate.sourcePath !== "string" || candidate.sourcePath.length === 0) {
		throw new Error(`${project.id} candidate sourcePath must be a non-empty string`);
	}
	assertSafeRepositoryPath(candidate.sourcePath, `${project.id} candidate sourcePath`);
	if (!Array.isArray(candidate.suite) || candidate.suite.some((item) => typeof item !== "string")) {
		throw new Error(`${project.id} candidate suite must be an array of strings`);
	}
	if (typeof candidate.title !== "string" || candidate.title.length === 0) {
		throw new Error(`${project.id} candidate title must be a non-empty string`);
	}
	if (!Number.isInteger(candidate.invocation) || candidate.invocation < 1) {
		throw new Error(`${project.id} candidate invocation must be a positive integer`);
	}
	if (typeof candidate.api !== "string" || candidate.api.length === 0) {
		throw new Error(`${project.id} candidate api must be a non-empty string`);
	}
	if (!isRecord(candidate.sourceRange)) {
		throw new Error(`${project.id} candidate sourceRange must be an object`);
	}
	for (const field of ["startLine", "endLine"]) {
		if (!Number.isInteger(candidate.sourceRange[field]) || candidate.sourceRange[field] < 1) {
			throw new Error(`${project.id} candidate sourceRange.${field} must be positive`);
		}
	}
	if (candidate.sourceRange.endLine < candidate.sourceRange.startLine) {
		throw new Error(`${project.id} candidate sourceRange is reversed`);
	}
	if (!Array.isArray(candidate.extraction) || candidate.extraction.some((item) => typeof item !== "string")) {
		throw new Error(`${project.id} candidate extraction must be an array of strings`);
	}
	if (candidate.modeSelection !== undefined && candidate.modeSelection !== "jsx-expectation") {
		throw new Error(`${project.id} candidate has unknown modeSelection ${candidate.modeSelection}`);
	}
	if (candidate.selectedMode !== undefined && typeof candidate.selectedMode !== "string") {
		throw new Error(`${project.id} candidate selectedMode must be a string`);
	}
	if (candidate.oracle !== undefined && candidate.oracle !== "accept" && candidate.oracle !== "reject") {
		throw new Error(`${project.id} candidate oracle must be accept or reject`);
	}
}

async function readConfiguration(configPath) {
	const configuration = await readJsonFile(configPath, "upstream config");
	if (!isRecord(configuration) || configuration.version !== 3 || !Array.isArray(configuration.projects)) {
		throw new Error(`${configPath} must contain version 3 and a projects array`);
	}
	assertKnownKeys(configuration, ["projects", "version"], "upstream config");
	if (configuration.projects.length === 0) {
		throw new Error("Upstream config must contain at least one project");
	}

	const ids = new Set();
	const roots = new Set();
	for (const project of configuration.projects) {
		validateProject(project);
		if (ids.has(project.id)) {
			throw new Error(`Duplicate upstream project id ${project.id}`);
		}
		if (roots.has(project.targetRoot)) {
			throw new Error(`Duplicate upstream targetRoot ${project.targetRoot}`);
		}
		for (const existingRoot of roots) {
			if (
				project.targetRoot.startsWith(`${existingRoot}/`) ||
				existingRoot.startsWith(`${project.targetRoot}/`)
			) {
				throw new Error(`Overlapping upstream targetRoots ${existingRoot} and ${project.targetRoot}`);
			}
		}
		ids.add(project.id);
		roots.add(project.targetRoot);
	}
	return configuration;
}

function validateProject(project) {
	if (!isRecord(project)) {
		throw new Error("Every upstream project must be an object");
	}
	assertKnownKeys(
		project,
		[
			"adapter",
			"blockers",
			"capabilities",
			"commit",
			"exclusions",
			"id",
			"operation",
			"policy",
			"repository",
			"sourceExclusions",
			"targetRoot",
			"version",
		],
		"upstream project",
	);
	for (const field of ["adapter", "commit", "id", "operation", "repository", "targetRoot", "version"]) {
		if (typeof project[field] !== "string" || project[field].length === 0) {
			throw new Error(`Upstream project ${field} must be a non-empty string`);
		}
	}
	if (!adapters.has(project.adapter)) {
		throw new Error(`${project.id} uses unknown adapter ${project.adapter}`);
	}
	const expectedOperation = project.adapter === "sucrase" ? "transform" : "stripTypes";
	if (project.operation !== expectedOperation) {
		throw new Error(`${project.id} adapter ${project.adapter} requires operation ${expectedOperation}`);
	}
	if (!/^[0-9a-f]{40}$/i.test(project.commit)) {
		throw new Error(`${project.id} commit must be a full 40-character Git object id`);
	}
	if (project.operation !== "transform" && project.operation !== "stripTypes") {
		throw new Error(`${project.id} operation must be transform or stripTypes`);
	}
	assertSafeRepositoryPath(project.targetRoot, `${project.id} targetRoot`);
	if (!project.targetRoot.startsWith(`${integrationUpstreamRoot}/`)) {
		throw new Error(`${project.id} targetRoot must be below ${integrationUpstreamRoot}`);
	}
	if (project.capabilities !== undefined && !isRecord(project.capabilities)) {
		throw new Error(`${project.id} capabilities must be an object`);
	}
	if (project.capabilities !== undefined) {
		assertKnownKeys(project.capabilities, ["jsx"], `${project.id} capabilities`);
		if (project.capabilities.jsx !== undefined && typeof project.capabilities.jsx !== "boolean") {
			throw new Error(`${project.id} capabilities.jsx must be a boolean`);
		}
	}
	if (project.policy !== undefined && !isRecord(project.policy)) {
		throw new Error(`${project.id} policy must be an object`);
	}
	if (project.policy !== undefined) {
		assertKnownKeys(project.policy, ["activeOnly", "customJsxPragma"], `${project.id} policy`);
		for (const field of ["activeOnly", "customJsxPragma"]) {
			if (project.policy[field] !== undefined && typeof project.policy[field] !== "boolean") {
				throw new Error(`${project.id} policy.${field} must be a boolean`);
			}
		}
	}
	if (!Array.isArray(project.exclusions)) {
		throw new Error(`${project.id} exclusions must be an array`);
	}
	if (!Array.isArray(project.blockers)) {
		throw new Error(`${project.id} blockers must be an array`);
	}
	if (project.sourceExclusions !== undefined && !Array.isArray(project.sourceExclusions)) {
		throw new Error(`${project.id} sourceExclusions must be an array`);
	}
	for (const exclusion of project.sourceExclusions ?? []) {
		if (!isRecord(exclusion)) {
			throw new Error(`${project.id} sourceExclusions must be objects`);
		}
		assertKnownKeys(exclusion, ["path", "reason"], `${project.id} source exclusion`);
		assertSafeRepositoryPath(exclusion.path, `${project.id} source exclusion path`);
		if (typeof exclusion.reason !== "string" || exclusion.reason.length === 0) {
			throw new Error(`${project.id} source exclusion reason must be a non-empty string`);
		}
	}
	for (const exclusion of project.exclusions) {
		if (!isRecord(exclusion)) {
			throw new Error(`${project.id} exclusions must be objects`);
		}
		assertKnownKeys(exclusion, ["match", "reason"], `${project.id} exclusion`);
		if (!isRecord(exclusion.match) || Object.keys(exclusion.match).length === 0) {
			throw new Error(`${project.id} exclusion.match must be a non-empty metadata object`);
		}
		if (typeof exclusion.reason !== "string" || exclusion.reason.length === 0) {
			throw new Error(`${project.id} exclusion.reason must be a non-empty string`);
		}
	}
	for (const blocker of project.blockers) {
		if (!isRecord(blocker)) {
			throw new Error(`${project.id} blockers must be objects`);
		}
		assertKnownKeys(
			blocker,
			["dependency", "expected", "issue", "match", "pullRequest", "reason"],
			`${project.id} blocker`,
		);
		if (!isRecord(blocker.match) || Object.keys(blocker.match).length === 0) {
			throw new Error(`${project.id} blocker.match must be a non-empty metadata object`);
		}
		if (typeof blocker.dependency !== "string" || blocker.dependency.length === 0) {
			throw new Error(`${project.id} blocker.dependency must be a non-empty string`);
		}
		if (blocker.expected !== "error" && blocker.expected !== "output") {
			throw new Error(`${project.id} blocker.expected must be error or output`);
		}
		if (blocker.issue === undefined && blocker.reason === undefined) {
			throw new Error(`${project.id} blocker must have an issue or reason`);
		}
		if (blocker.issue !== undefined && (typeof blocker.issue !== "string" || !isHttpUrl(blocker.issue))) {
			throw new Error(`${project.id} blocker.issue must be an HTTP URL`);
		}
		if (blocker.reason !== undefined && (typeof blocker.reason !== "string" || blocker.reason.length === 0)) {
			throw new Error(`${project.id} blocker.reason must be a non-empty string`);
		}
		if (
			blocker.pullRequest !== undefined &&
			(typeof blocker.pullRequest !== "string" || !isHttpUrl(blocker.pullRequest))
		) {
			throw new Error(`${project.id} blocker.pullRequest must be an HTTP URL`);
		}
	}
}

function validateCatalogHeader(catalog, project, adapter) {
	if (
		!isRecord(catalog) ||
		catalog.schema !== 3 ||
		!Array.isArray(catalog.cases) ||
		!Array.isArray(catalog.excluded)
	) {
		throw new Error(`${project.id} catalog must use schema 3 with cases and excluded arrays`);
	}
	if (catalog.adapter !== `${project.adapter}@${adapter.version}`) {
		throw new Error(`${project.id} catalog adapter is stale`);
	}
	if (catalog.implementationHash !== adapter.implementationHash) {
		throw new Error(`${project.id} catalog adapter implementation is stale`);
	}
	if (catalog.configHash !== projectConfigHash(project, adapter)) {
		throw new Error(`${project.id} catalog configHash is stale`);
	}
	if (
		!isRecord(catalog.project) ||
		stableStringify(catalog.project) !==
			stableStringify({
				commit: project.commit,
				id: project.id,
				repository: project.repository,
				version: project.version,
			})
	) {
		throw new Error(`${project.id} catalog project pin is stale`);
	}
	if (!isRecord(catalog.summary)) {
		throw new Error(`${project.id} catalog summary is missing`);
	}
}

function validateCatalogCase(catalogCase, project) {
	if (
		!isRecord(catalogCase) ||
		!Array.isArray(catalogCase.identities) ||
		catalogCase.identities.length === 0 ||
		!Array.isArray(catalogCase.origins) ||
		catalogCase.origins.length !== catalogCase.identities.length
	) {
		throw new Error(`${project.id} catalog contains an invalid case`);
	}
	for (const [index, identity] of catalogCase.identities.entries()) {
		validateIdentity(identity, project);
		validateCatalogOrigin(catalogCase.origins[index], identity, project);
	}
	const canonicalIdentity = catalogCase.identities[0];
	const targetCandidate = {
		title: canonicalIdentity.title,
		...(canonicalIdentity.variant === null ? {} : { variant: canonicalIdentity.variant }),
	};
	const expectedTarget = createTarget(project, targetCandidate, canonicalIdentity);
	if (catalogCase.target !== expectedTarget) {
		throw new Error(`${project.id} catalog case target is not derived from its identity`);
	}
	if (typeof catalogCase.target !== "string" || !catalogCase.target.startsWith(`${project.targetRoot}/`)) {
		throw new Error(`${project.id} catalog case target is outside targetRoot`);
	}
	if (!inputFileNames.has(catalogCase.inputFile) || !/^[0-9a-f]{64}$/.test(catalogCase.inputSha256)) {
		throw new Error(`${project.id} catalog case has invalid input metadata`);
	}
	if (!/^[0-9a-f]{64}$/.test(catalogCase.fingerprint)) {
		throw new Error(`${project.id} catalog case has invalid workload fingerprint`);
	}
	if (catalogCase.oracle !== "input" && catalogCase.oracle !== "accept" && catalogCase.oracle !== "reject") {
		throw new Error(`${project.id} catalog case has invalid oracle`);
	}
	if (catalogCase.options !== undefined && !isRecord(catalogCase.options)) {
		throw new Error(`${project.id} catalog case options must be an object`);
	}
	if (catalogCase.blocker !== undefined) {
		validateBlocker(catalogCase.blocker, `${project.id} catalog case blocker`);
	}
}

function validateBlocker(blocker, label) {
	if (!isRecord(blocker)) {
		throw new Error(`${label} must be an object`);
	}
	assertKnownKeys(blocker, ["dependency", "expected", "issue", "pullRequest", "reason"], label);
	if (typeof blocker.dependency !== "string" || blocker.dependency.length === 0) {
		throw new Error(`${label}.dependency must be a non-empty string`);
	}
	if (blocker.expected !== "error" && blocker.expected !== "output") {
		throw new Error(`${label}.expected must be error or output`);
	}
	if (blocker.issue === undefined && blocker.reason === undefined) {
		throw new Error(`${label} must have an issue or reason`);
	}
	if (blocker.issue !== undefined && (typeof blocker.issue !== "string" || !isHttpUrl(blocker.issue))) {
		throw new Error(`${label}.issue must be an HTTP URL`);
	}
	if (blocker.reason !== undefined && (typeof blocker.reason !== "string" || blocker.reason.length === 0)) {
		throw new Error(`${label}.reason must be a non-empty string`);
	}
	if (
		blocker.pullRequest !== undefined &&
		(typeof blocker.pullRequest !== "string" || !isHttpUrl(blocker.pullRequest))
	) {
		throw new Error(`${label}.pullRequest must be an HTTP URL`);
	}
}

function validateIdentity(identity, project) {
	if (
		identity.adapter !== project.adapter ||
		typeof identity.sourcePath !== "string" ||
		!Array.isArray(identity.suite) ||
		identity.suite.some((item) => typeof item !== "string") ||
		typeof identity.title !== "string" ||
		(identity.variant !== null && typeof identity.variant !== "string") ||
		!Number.isInteger(identity.invocation) ||
		identity.invocation < 1 ||
		typeof identity.api !== "string"
	) {
		throw new Error(`${project.id} catalog contains an invalid identity`);
	}
}

function validateCatalogOrigin(origin, identity, project) {
	const expectedUpstream = {
		commit: project.commit,
		id: project.id,
		repository: project.repository,
		version: project.version,
	};
	const expectedTest = {
		api: identity.api,
		invocation: identity.invocation,
		suite: identity.suite,
		title: identity.title,
		...(identity.variant === null ? {} : { variant: identity.variant }),
	};
	if (
		origin.schema !== 2 ||
		origin.adapter !== `${project.adapter}@${adapters.get(project.adapter).version}` ||
		stableStringify(origin.upstream) !== stableStringify(expectedUpstream) ||
		stableStringify(origin.test) !== stableStringify(expectedTest) ||
		!isRecord(origin.source) ||
		origin.source.path !== identity.sourcePath ||
		!Number.isInteger(origin.source.startLine) ||
		!Number.isInteger(origin.source.endLine) ||
		origin.source.startLine < 1 ||
		origin.source.endLine < origin.source.startLine ||
		!Array.isArray(origin.extraction) ||
		origin.extraction.some((item) => typeof item !== "string")
	) {
		throw new Error(`${project.id} catalog case origin does not match its identity`);
	}
}

async function validateCheckout(project, configuredPath) {
	if (typeof configuredPath !== "string" || configuredPath.length === 0) {
		throw new Error(`Missing --checkout ${project.id}=/path`);
	}
	let checkoutPath;
	try {
		checkoutPath = await realpath(configuredPath);
	} catch (error) {
		throw new Error(`Unable to resolve checkout for ${project.id}: ${configuredPath}`, { cause: error });
	}
	const head = (await runGitText(checkoutPath, ["rev-parse", "HEAD"], project.id)).trim();
	if (head !== project.commit) {
		throw new Error(`${project.id} is at ${head}, expected ${project.commit}`);
	}
	const status = await runGitText(checkoutPath, ["status", "--porcelain", "--untracked-files=all"], project.id);
	if (status.length !== 0) {
		throw new Error(`${project.id} checkout has working tree changes`);
	}
	return checkoutPath;
}

function validateCheckoutKeys(projects, checkouts) {
	const ids = new Set(projects.map((project) => project.id));
	for (const id of checkouts.keys()) {
		if (!ids.has(id)) {
			throw new Error(`Checkout was provided for unknown upstream project ${id}`);
		}
	}
}

async function readGitTree(checkoutPath, project) {
	let stdout;
	try {
		({ stdout } = await execFileAsync("git", ["-C", checkoutPath, "ls-tree", "-r", "-z", project.commit], {
			encoding: "buffer",
			env: gitEnvironment,
			maxBuffer: 64 * 1024 * 1024,
		}));
	} catch (error) {
		throw new Error(`Unable to read the pinned Git tree for ${project.id}: ${error.message}`, { cause: error });
	}
	const tree = new Map();
	for (const rawEntry of stdout.toString("utf8").split("\0")) {
		if (rawEntry.length === 0) {
			continue;
		}
		const tab = rawEntry.indexOf("\t");
		const header = rawEntry.slice(0, tab).split(" ");
		const sourcePath = rawEntry.slice(tab + 1);
		if (tab < 0 || header.length !== 3) {
			throw new Error(`${project.id} returned an invalid ls-tree entry`);
		}
		tree.set(sourcePath, { mode: header[0], object: header[2], type: header[1] });
	}
	return tree;
}

function listTreeFiles(tree, prefix, projectId) {
	const normalized = normalizeTreePath(prefix, `${projectId} listFiles prefix`);
	const directoryPrefix = normalized.length === 0 ? "" : `${normalized}/`;
	return [...tree.keys()]
		.filter((sourcePath) => sourcePath === normalized || sourcePath.startsWith(directoryPrefix))
		.sort();
}

async function readTreeFile(checkoutPath, tree, sourcePath, projectId) {
	const normalized = normalizeTreePath(sourcePath, `${projectId} source path`);
	const entry = tree.get(normalized);
	if (entry === undefined || entry.type !== "blob" || entry.mode === "120000") {
		throw new Error(`${projectId} source must be a regular tracked file at the pinned commit: ${normalized}`);
	}
	try {
		const { stdout } = await execFileAsync("git", ["-C", checkoutPath, "cat-file", "blob", entry.object], {
			encoding: "utf8",
			env: gitEnvironment,
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout;
	} catch (error) {
		throw new Error(`${projectId} could not read pinned source ${normalized}`, { cause: error });
	}
}

function normalizeTreePath(value, label) {
	if (typeof value !== "string") {
		throw new TypeError(`${label} must be a string`);
	}
	let normalized = value;
	while (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	assertSafeRepositoryPath(normalized, label, true);
	return normalized;
}

async function runGitText(checkoutPath, arguments_, projectId) {
	try {
		const { stdout } = await execFileAsync("git", ["-C", checkoutPath, ...arguments_], {
			encoding: "utf8",
			env: gitEnvironment,
			maxBuffer: 4 * 1024 * 1024,
		});
		return stdout;
	} catch (error) {
		throw new Error(`Unable to inspect ${projectId} checkout with Git: ${error.message}`, { cause: error });
	}
}

async function findOrphans(rootPath, targetRoot, expectedFiles, expectedCaseDirectories) {
	if (!(await fileExists(targetRoot))) {
		return [];
	}
	const files = await collectFilesRejectingSymlinks(targetRoot);
	const problems = [];
	for (const filePath of files) {
		const fileName = path.basename(filePath);
		if (expectedFiles.has(filePath)) {
			continue;
		}
		if (path.dirname(filePath) === targetRoot && targetRootMetadataFileNames.has(fileName)) {
			continue;
		}
		if (managedFileNames.has(fileName)) {
			problems.push(`${relativeToRoot(rootPath, filePath)} is not declared by the generated catalog`);
			continue;
		}
		if (reviewedFileNames.has(fileName) && expectedCaseDirectories.has(path.dirname(filePath))) {
			continue;
		}
		const description = reviewedFileNames.has(fileName) ? "belongs to an orphaned reviewed case" : "is not managed";
		problems.push(`${relativeToRoot(rootPath, filePath)} ${description}`);
	}
	return problems;
}

async function collectFilesRejectingSymlinks(directory, files = []) {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(`Generated upstream fixture tree contains a symbolic link: ${entryPath}`);
		}
		if (entry.isDirectory()) {
			await collectFilesRejectingSymlinks(entryPath, files);
		} else if (entry.isFile()) {
			files.push(entryPath);
		}
	}
	return files;
}

async function assertNoSymlinkComponents(rootPath, candidate, label) {
	assertInside(rootPath, candidate, label, true);
	const relative = path.relative(rootPath, candidate);
	const components = relative.split(path.sep).filter((component) => component.length > 0);
	let current = rootPath;
	let missingParent = false;
	for (const component of components) {
		current = path.join(current, component);
		if (missingParent) {
			continue;
		}
		let stats;
		try {
			stats = await lstat(current);
		} catch (error) {
			if (error.code === "ENOENT") {
				missingParent = true;
				continue;
			}
			throw error;
		}
		if (stats.isSymbolicLink()) {
			throw new Error(`${label} contains a symbolic link: ${relativeToRoot(rootPath, current)}`);
		}
	}
}

async function writeFileAtomically(rootPath, filePath, content, label) {
	await assertNoSymlinkComponents(rootPath, filePath, label);
	await mkdir(path.dirname(filePath), { recursive: true });
	await assertNoSymlinkComponents(rootPath, filePath, label);
	const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
		await rename(temporaryPath, filePath);
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

async function compareFile(filePath, expected) {
	let actual;
	try {
		actual = await readFile(filePath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") {
			return "missing";
		}
		throw error;
	}
	return actual === expected ? null : "content differs";
}

async function assertExpectedContent(rootPath, filePath, expected) {
	await assertNoSymlinkComponents(rootPath, filePath, relativeToRoot(rootPath, filePath));
	const reason = await compareFile(filePath, expected);
	if (reason !== null) {
		throw new Error(`${relativeToRoot(rootPath, filePath)} ${reason}`);
	}
}

async function readJsonFile(filePath, label) {
	const text = await readRequiredFile(filePath, label);
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} contains invalid JSON: ${error.message}`, { cause: error });
	}
}

async function readRequiredFile(filePath, label) {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		throw new Error(`Unable to read ${label}: ${error.message}`, { cause: error });
	}
}

async function fileExists(filePath) {
	try {
		await access(filePath, fsConstants.F_OK);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

function isHttpUrl(value) {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
	} catch {
		return false;
	}
}

function createExpectedFile(rootPath, projectId, filePath, content, label) {
	return {
		content,
		label,
		path: filePath,
		projectId,
		relativePath: relativeToRoot(rootPath, filePath),
	};
}

function resolveConfigurationPath(rootPath, configPath) {
	return path.isAbsolute(configPath) ? configPath : path.resolve(rootPath, configPath);
}

function resolveProjectTargetRoot(rootPath, project) {
	const targetRoot = resolveWithin(rootPath, project.targetRoot, `${project.id} targetRoot`);
	const allowedRoot = resolveWithin(rootPath, integrationUpstreamRoot, "integration upstream root");
	assertInside(allowedRoot, targetRoot, `${project.id} targetRoot`);
	return targetRoot;
}

function resolveWithin(rootPath, relativePath, label) {
	assertSafeRepositoryPath(relativePath, label);
	const resolved = path.resolve(rootPath, relativePath);
	assertInside(rootPath, resolved, label, true);
	return resolved;
}

function assertSafeRepositoryPath(value, label, allowEmpty = false) {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new Error(`${label} must be a ${allowEmpty ? "string" : "non-empty string"}`);
	}
	if (value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
		throw new Error(`${label} must be a relative repository path`);
	}
	const normalized = path.posix.normalize(value);
	if (normalized === ".." || normalized.startsWith("../") || normalized !== value) {
		throw new Error(`${label} is not a normalized repository path`);
	}
}

function assertInside(parent, candidate, label, allowEqual = false) {
	const relative = path.relative(parent, candidate);
	const inside =
		relative.length === 0
			? allowEqual
			: !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
	if (!inside) {
		throw new Error(`${label} escapes ${parent}`);
	}
}

function relativeToRoot(rootPath, filePath) {
	return path.relative(rootPath, filePath).split(path.sep).join("/");
}

function projectConfigHash(project, adapter) {
	return sha256(
		stableStringify({
			adapterVersion: adapter.version,
			implementationHash: adapter.implementationHash,
			project,
		}),
	);
}

function hashImplementation(urls) {
	const hash = createHash("sha256");
	for (let index = 0; index < urls.length; index += 1) {
		const source = readFileSync(urls[index], "utf8").replaceAll("\r\n", "\n");
		hash.update(String(index));
		hash.update("\0");
		hash.update(source);
		hash.update("\0");
	}
	return hash.digest("hex");
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
	return JSON.stringify(canonicalize(value));
}

function compareCodeUnits(left, right) {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

function canonicalize(value) {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (isRecord(value)) {
		const output = {};
		for (const key of Object.keys(value).sort()) {
			output[key] = canonicalize(value[key]);
		}
		return output;
	}
	return value;
}

function formatJson(value) {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value, keys, label) {
	const known = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) {
			throw new Error(`${label} has unknown key ${key}`);
		}
	}
}

function describeIdentity(identity) {
	const suite = identity.suite.length === 0 ? "" : `${identity.suite.join(" > ")} > `;
	const variant = identity.variant === null ? "" : ` [${identity.variant}]`;
	return `${identity.sourcePath}: ${suite}${identity.title}${variant} #${identity.invocation}`;
}

function summarizeProjects(projects) {
	return projects.reduce(
		(summary, project) => ({
			blocked: summary.blocked + project.blocked,
			discovered: summary.discovered + project.discovered,
			excluded: summary.excluded + project.excluded,
			included: summary.included + project.included,
		}),
		{ blocked: 0, discovered: 0, excluded: 0, included: 0 },
	);
}

function formatProblems(title, problems) {
	const visible = problems.slice(0, 30);
	const remaining = problems.length - visible.length;
	const suffix = remaining === 0 ? "" : `\n  … and ${remaining} more`;
	return `${title}:\n  ${visible.join("\n  ")}${suffix}`;
}
