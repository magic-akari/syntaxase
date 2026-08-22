import path from "node:path";

import {
	StaticEvaluationError,
	collectAst,
	createAstIndex,
	evaluateStatic,
	parseTypeScriptModule,
	validateSourceCensus,
	walkAst,
} from "./ast.js";

const fixtureDirectory = "tests/fixture/cases";
export const adapterVersion = 1;

const unitSuites = [
	{ name: "valid", path: "tests/valid.test.ts" },
	{ name: "errors", path: "tests/errors.test.ts" },
];

export async function discoverTsBlankSpace({ project, readText, listFiles }) {
	void project;
	if (typeof readText !== "function" || typeof listFiles !== "function") {
		throw new TypeError("ts-blank-space discovery requires readText and listFiles functions");
	}

	const candidates = [];
	const listed = await listFiles("tests");
	if (!Array.isArray(listed)) {
		throw new TypeError("listFiles must return an array of repository-relative paths");
	}
	const listedTestFiles = listed.map(normalizeRepositoryPath);
	const sourceCensus = validateSourceCensus({
		isTestSource: (sourcePath) => sourcePath.startsWith("tests/") && sourcePath.endsWith(".test.ts"),
		knownSourcePaths: new Set(unitSuites.map((suite) => suite.path)),
		project,
		sourcePaths: listedTestFiles,
	});
	const fixturePaths = discoverFixturePaths(listedTestFiles);
	for (const sourcePath of fixturePaths) {
		const input = await readText(sourcePath);
		candidates.push({
			api: "tsBlankSpace",
			extraction: ["whole-file"],
			input,
			inputFile: "input.ts",
			invocation: 1,
			sourcePath,
			sourceRange: wholeFileRange(input),
			suite: ["fixture"],
			title: `fixture: ${path.posix.basename(sourcePath)}`,
		});
	}

	for (const suite of unitSuites) {
		const sourceText = await readText(suite.path);
		candidates.push(...discoverUnitSuite(sourceText, suite));
	}

	const resolved = candidates.filter((candidate) => candidate.input !== null).length;
	const unresolved = candidates.length - resolved;
	return {
		candidates,
		stats: {
			resolved,
			sourceCensus,
			suites: {
				errors: candidates.filter((candidate) => candidate.suite[0] === "errors").length,
				fixture: candidates.filter((candidate) => candidate.suite[0] === "fixture").length,
				valid: candidates.filter((candidate) => candidate.suite[0] === "valid").length,
			},
			total: candidates.length,
			tsx: candidates.filter((candidate) => candidate.scriptKind === "TSX").length,
			unresolved,
		},
	};
}

function discoverFixturePaths(listed) {
	const prefix = `${fixtureDirectory}/`;
	return listed
		.map((sourcePath) => (sourcePath.includes("/") ? sourcePath : `${prefix}${sourcePath}`))
		.filter((sourcePath) => sourcePath.startsWith(prefix) && sourcePath.endsWith(".ts"))
		.filter((sourcePath) => !sourcePath.slice(prefix.length).includes("/"))
		.sort();
}

function discoverUnitSuite(sourceText, suite) {
	const ast = parseTypeScriptModule(sourceText, suite.path);
	const index = createAstIndex(ast);
	const imports = discoverImports(ast);
	if (imports.it === null || imports.tsBlankSpace === null) {
		throw new Error(`${suite.path} does not import the expected node:test and ts-blank-space bindings`);
	}
	const testCalls = collectAst(ast, (node) => isIdentifierCall(node, imports.it));
	const candidates = [];

	for (const testCall of testCalls) {
		if (isFixtureDispatchTest(testCall, imports.testFixture)) {
			continue;
		}
		const discovered = discoverTestCall(testCall, suite, index, imports);
		if (discovered.length === 0) {
			const unresolved = createUnresolvedTestCandidate(testCall, suite, index);
			unresolved.invocation = 1;
			delete unresolved._order;
			candidates.push(unresolved);
			continue;
		}
		candidates.push(...discovered);
	}

	return candidates;
}

function discoverImports(ast) {
	const imports = {
		blankSourceFile: null,
		it: null,
		testFixture: null,
		tsBlankSpace: null,
	};
	for (const statement of ast.body) {
		if (statement.type !== "ImportDeclaration" || typeof statement.source?.value !== "string") {
			continue;
		}
		if (statement.source.value === "node:test") {
			for (const specifier of statement.specifiers) {
				if (specifier.type === "ImportSpecifier" && importedName(specifier) === "it") {
					imports.it = specifier.local.name;
				}
			}
			continue;
		}
		if (statement.source.value.endsWith("/src/index.ts")) {
			for (const specifier of statement.specifiers) {
				if (specifier.type === "ImportDefaultSpecifier") {
					imports.tsBlankSpace = specifier.local.name;
				}
				if (specifier.type === "ImportSpecifier" && importedName(specifier) === "blankSourceFile") {
					imports.blankSourceFile = specifier.local.name;
				}
			}
			continue;
		}
		if (statement.source.value.endsWith("/fixture/helpers.js")) {
			for (const specifier of statement.specifiers) {
				if (specifier.type === "ImportSpecifier" && importedName(specifier) === "testFixture") {
					imports.testFixture = specifier.local.name;
				}
			}
		}
	}
	return imports;
}

function discoverTestCall(testCall, suite, index, imports) {
	const callback = testCall.arguments[1];
	if (!isFunction(callback)) {
		return [];
	}
	const titleResult = tryEvaluate(testCall.arguments[0], index, new Map());
	if (!titleResult.ok || typeof titleResult.value !== "string") {
		return [
			createUnresolvedCandidate({
				api: "tsBlankSpace",
				message: titleResult.message ?? "Test title is not a static string",
				node: testCall,
				suite,
				title: "<unresolved test title>",
			}),
		];
	}

	const helpers = discoverForwardingHelpers(callback, imports.tsBlankSpace);
	const helperFunctions = new Set([...helpers.values()].map((helper) => helper.function));
	const calls = collectAst(
		callback.body,
		(node) => {
			if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") {
				return false;
			}
			return (
				node.callee.name === imports.tsBlankSpace ||
				node.callee.name === imports.blankSourceFile ||
				helpers.has(node.callee.name)
			);
		},
		{
			skip(node) {
				return helperFunctions.has(node);
			},
		},
	);

	const discovered = [];
	for (const call of calls) {
		const environments = environmentsForCall(call, callback, index);
		for (const environment of environments) {
			if (call.callee.name === imports.blankSourceFile) {
				discovered.push(discoverBlankSourceFileCall(call, suite, titleResult.value, index, environment));
				continue;
			}
			if (call.callee.name === imports.tsBlankSpace) {
				discovered.push(
					discoverInputCall(call, suite, titleResult.value, index, environment, {
						api: "tsBlankSpace",
					}),
				);
				continue;
			}
			const helper = helpers.get(call.callee.name);
			discovered.push(
				discoverInputCall(call, suite, titleResult.value, index, environment, {
					api: "tsBlankSpace",
					extractionSuffix: [`forwarded-by:${call.callee.name}`],
					inputArgument: helper.inputParameter,
					variantArgument: helper.contextParameter,
				}),
			);
		}
	}

	discovered.sort(compareDiscoveredCalls);
	for (let index = 0; index < discovered.length; index += 1) {
		discovered[index].invocation = index + 1;
		delete discovered[index]._order;
	}
	return discovered;
}

function discoverForwardingHelpers(callback, tsBlankSpaceName) {
	const helpers = new Map();
	for (const statement of callback.body.body ?? []) {
		if (statement.type !== "VariableDeclaration") {
			continue;
		}
		for (const declaration of statement.declarations) {
			if (declaration.id?.type !== "Identifier" || !isFunction(declaration.init)) {
				continue;
			}
			const apiCalls = collectAst(declaration.init.body, (node) => isIdentifierCall(node, tsBlankSpaceName));
			if (apiCalls.length !== 1) {
				continue;
			}
			const forwarded = apiCalls[0].arguments[0];
			if (forwarded?.type !== "Identifier") {
				continue;
			}
			const inputParameter = declaration.init.params.findIndex(
				(parameter) => parameter.type === "Identifier" && parameter.name === forwarded.name,
			);
			if (inputParameter < 0) {
				continue;
			}
			helpers.set(declaration.id.name, {
				contextParameter: declaration.init.params.length > inputParameter + 1 ? inputParameter + 1 : null,
				function: declaration.init,
				inputParameter,
			});
		}
	}
	return helpers;
}

function environmentsForCall(call, callback, index) {
	let current = call;
	while (current !== null && current !== callback) {
		if (current.type === "ForOfStatement") {
			return expandForOfEnvironments(current, index);
		}
		current = index.parentOf(current);
	}
	return [{ bindings: new Map(), order: 0 }];
}

function expandForOfEnvironments(statement, index) {
	const iterableResult = tryEvaluate(statement.right, index, new Map());
	if (!iterableResult.ok || !Array.isArray(iterableResult.value)) {
		return [
			{
				bindings: new Map(),
				error: iterableResult.message ?? "for...of source is not a static array",
				order: 0,
			},
		];
	}
	if (statement.left.type !== "VariableDeclaration" || statement.left.declarations.length !== 1) {
		return [{ bindings: new Map(), error: "Unsupported for...of binding", order: 0 }];
	}
	const pattern = statement.left.declarations[0].id;
	return iterableResult.value.map((value, order) => {
		const bindings = new Map();
		try {
			bindPattern(pattern, value, bindings);
			return { bindings, order };
		} catch (error) {
			return { bindings, error: error.message, order };
		}
	});
}

function bindPattern(pattern, value, bindings) {
	if (pattern.type === "Identifier") {
		bindings.set(pattern.name, value);
		return;
	}
	if (pattern.type !== "ObjectPattern" || value === null || typeof value !== "object") {
		throw new Error(`Unsupported static binding pattern ${pattern.type}`);
	}
	for (const property of pattern.properties) {
		if (property.type !== "Property" || property.computed || property.kind !== "init") {
			throw new Error("Unsupported property in static object binding");
		}
		const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
		bindPattern(property.value, value[key], bindings);
	}
}

function discoverInputCall(
	call,
	suite,
	title,
	index,
	environment,
	{ api, extractionSuffix = [], inputArgument = 0, variantArgument = null },
) {
	const inputNode = call.arguments[inputArgument];
	if (environment.error !== undefined) {
		return createUnresolvedCandidate({ api, message: environment.error, node: inputNode ?? call, suite, title });
	}
	const inputResult = tryEvaluate(inputNode, index, environment.bindings);
	if (!inputResult.ok || typeof inputResult.value !== "string") {
		return createUnresolvedCandidate({
			api,
			message: inputResult.message ?? "Input did not evaluate to a string",
			node: inputNode ?? call,
			suite,
			title,
		});
	}
	let variant = nearestLabel(call, index);
	if (variantArgument !== null && call.arguments[variantArgument] !== undefined) {
		const variantResult = tryEvaluate(call.arguments[variantArgument], index, environment.bindings);
		if (!variantResult.ok || typeof variantResult.value !== "string") {
			return createUnresolvedCandidate({
				api,
				message: variantResult.message ?? "Helper context did not evaluate to a string",
				node: call.arguments[variantArgument],
				suite,
				title,
			});
		}
		variant = variantResult.value;
	}
	return {
		_order: call.start * 1_000 + environment.order,
		api,
		extraction: ["call-argument", ...inputResult.extraction, ...extractionSuffix],
		input: inputResult.value,
		inputFile: "input.ts",
		invocation: 0,
		sourcePath: suite.path,
		sourceRange: rangeOf(inputNode ?? call),
		suite: [suite.name],
		title,
		...(variant === null ? {} : { variant }),
	};
}

function discoverBlankSourceFileCall(call, suite, title, index, environment) {
	const sourceFileResult = resolveExpression(call.arguments[0], index);
	const sourceFileCall = sourceFileResult.node;
	if (!isCreateSourceFileCall(sourceFileCall)) {
		return createUnresolvedCandidate({
			api: "blankSourceFile",
			message: "blankSourceFile input is not a static ts.createSourceFile call",
			node: call.arguments[0] ?? call,
			suite,
			title,
		});
	}
	const inputNode = sourceFileCall.arguments[1];
	const inputResult = tryEvaluate(inputNode, index, environment.bindings);
	const scriptKind = memberPropertyName(sourceFileCall.arguments[4]);
	if (!inputResult.ok || typeof inputResult.value !== "string" || scriptKind === null) {
		return createUnresolvedCandidate({
			api: "blankSourceFile",
			message: inputResult.message ?? "Unable to statically resolve blankSourceFile input or ScriptKind",
			node: inputNode ?? sourceFileCall,
			suite,
			title,
		});
	}
	return {
		_order: call.start * 1_000,
		api: "blankSourceFile",
		extraction: ["ts.createSourceFile", ...sourceFileResult.extraction, ...inputResult.extraction],
		input: inputResult.value,
		inputFile: scriptKind === "TSX" ? "input.tsx" : "input.ts",
		invocation: 0,
		...(scriptKind === "TSX" ? { requires: { jsx: true } } : {}),
		scriptKind,
		sourcePath: suite.path,
		sourceRange: rangeOf(inputNode),
		suite: [suite.name],
		title,
	};
}

function resolveExpression(node, index) {
	const extraction = [];
	let current = node;
	const seen = new Set();
	while (current?.type === "Identifier") {
		if (seen.has(current.name)) {
			return { extraction, node: current };
		}
		seen.add(current.name);
		const declaration = index.resolveVariable(current.name, current.start);
		if (declaration === null || declaration === undefined || declaration.init === null) {
			return { extraction, node: current };
		}
		extraction.push(`const:${current.name}`);
		current = declaration.init;
	}
	return { extraction, node: current };
}

function tryEvaluate(node, index, bindings) {
	try {
		return {
			ok: true,
			...evaluateStatic(node, {
				bindings,
				resolveVariable: (name, beforeOffset) => index.resolveVariable(name, beforeOffset),
			}),
		};
	} catch (error) {
		if (!(error instanceof StaticEvaluationError)) {
			throw error;
		}
		return { message: error.message, ok: false };
	}
}

function createUnresolvedTestCandidate(testCall, suite, index) {
	const titleResult = tryEvaluate(testCall.arguments[0], index, new Map());
	const title =
		titleResult.ok && typeof titleResult.value === "string" ? titleResult.value : "<unresolved test title>";
	return createUnresolvedCandidate({
		api: "tsBlankSpace",
		message: "No supported tsBlankSpace or blankSourceFile invocation found in test",
		node: testCall,
		suite,
		title,
	});
}

function createUnresolvedCandidate({ api, message, node, suite, title }) {
	return {
		_order: node.start * 1_000,
		api,
		extraction: [],
		input: null,
		inputFile: "input.ts",
		invocation: 0,
		sourcePath: suite.path,
		sourceRange: rangeOf(node),
		suite: [suite.name],
		title,
		unresolved: message,
	};
}

function isFixtureDispatchTest(testCall, testFixtureName) {
	const callback = testCall.arguments[1];
	if (!isFunction(callback)) {
		return false;
	}
	return collectAst(callback.body, (node) => isIdentifierCall(node, testFixtureName)).length > 0;
}

function nearestLabel(node, index) {
	let current = index.parentOf(node);
	while (current !== null) {
		if (current.type === "LabeledStatement" && current.label?.type === "Identifier") {
			return current.label.name;
		}
		if (
			current.type === "CallExpression" &&
			current.callee?.type === "Identifier" &&
			current.callee.name === "it"
		) {
			break;
		}
		current = index.parentOf(current);
	}
	return null;
}

function compareDiscoveredCalls(left, right) {
	return left._order - right._order;
}

function importedName(specifier) {
	return specifier.imported?.name ?? specifier.imported?.value ?? null;
}

function isIdentifierCall(node, name) {
	return (
		typeof name === "string" &&
		node.type === "CallExpression" &&
		node.callee?.type === "Identifier" &&
		node.callee.name === name
	);
}

function isFunction(node) {
	return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function isCreateSourceFileCall(node) {
	return node?.type === "CallExpression" && memberPropertyName(node.callee) === "createSourceFile";
}

function memberPropertyName(node) {
	if (node?.type !== "MemberExpression" || node.computed) {
		return null;
	}
	return node.property?.type === "Identifier" ? node.property.name : null;
}

function rangeOf(node) {
	return {
		endLine: node.loc.end.line,
		startLine: node.loc.start.line,
	};
}

function wholeFileRange(sourceText) {
	let line = 1;
	let offset = 0;
	while (offset < sourceText.length) {
		const character = sourceText.charCodeAt(offset);
		if (character === 0x0d) {
			line += 1;
			offset += sourceText.charCodeAt(offset + 1) === 0x0a ? 2 : 1;
			continue;
		}
		if (character === 0x0a || character === 0x2028 || character === 0x2029) {
			line += 1;
		}
		offset += 1;
	}
	return { endLine: line, startLine: 1 };
}

function normalizeRepositoryPath(sourcePath) {
	if (typeof sourcePath !== "string") {
		throw new TypeError("listFiles entries must be strings");
	}
	return sourcePath.split(path.sep).join("/");
}
