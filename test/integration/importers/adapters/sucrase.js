import { evaluateStatic, parseTypeScriptModule, validateSourceCensus } from "./ast.js";

export const adapterVersion = 2;

const sourceSpecifications = new Map([
	[
		"test/typescript-test.ts",
		{
			category: "typescript",
			helpers: new Set([
				"assertResult",
				"assertTypeScriptESMResult",
				"assertTypeScriptImportResult",
				"assertTypeScriptResult",
			]),
		},
	],
	[
		"test/types-test.ts",
		{
			category: "typescript-flow-common",
			helpers: new Set(["assertTypeScriptAndFlowExpectations", "assertTypeScriptAndFlowResult"]),
		},
	],
	[
		"test/jsx-test.ts",
		{
			category: "jsx",
			helpers: new Set(["assertJSXResult", "assertResult", "throws"]),
		},
	],
]);

const knownOptionKeys = new Set([
	"disableESTransforms",
	"filePath",
	"injectCreateRequireForImportRequire",
	"jsxFragmentPragma",
	"jsxImportSource",
	"jsxPragma",
	"jsxRuntime",
	"keepUnusedImports",
	"production",
	"transforms",
]);
const knownTransforms = new Set(["imports", "jsx", "typescript"]);

const jsxExpectationModes = new Map([
	["expectedClassicDevESMResult", "classic-development-esm"],
	["expectedClassicProdESMResult", "classic-production-esm"],
	["expectedClassicDevCJSResult", "classic-development-cjs"],
	["expectedClassicProdCJSResult", "classic-production-cjs"],
	["expectedAutomaticDevESMResult", "automatic-development-esm"],
	["expectedAutomaticProdESMResult", "automatic-production-esm"],
	["expectedAutomaticDevCJSResult", "automatic-development-cjs"],
	["expectedAutomaticProdCJSResult", "automatic-production-cjs"],
]);

const jsxEsmModePreference = [
	"automatic-production-esm",
	"automatic-development-esm",
	"classic-production-esm",
	"classic-development-esm",
	"preserve-esm",
];

export async function discoverSucrase({ project, readText, listFiles }) {
	void project;
	if (typeof readText !== "function") {
		throw new TypeError("Sucrase discovery requires readText(path)");
	}
	if (typeof listFiles !== "function") {
		throw new TypeError("Sucrase discovery requires listFiles()");
	}

	const listedFiles = await listFiles("test");
	const availableFiles = normalizeListedFiles(listedFiles);
	const sourceCensus = validateSourceCensus({
		isTestSource: (sourcePath) => sourcePath.startsWith("test/") && sourcePath.endsWith("-test.ts"),
		knownSourcePaths: new Set(sourceSpecifications.keys()),
		project,
		sourcePaths: [...availableFiles],
	});
	const candidates = [];

	for (const [sourcePath, specification] of sourceSpecifications) {
		if (!availableFiles.has(sourcePath)) {
			throw new Error(`Sucrase ${sourcePath} is missing from the pinned tree`);
		}

		const sourceText = await readText(sourcePath);
		if (typeof sourceText !== "string") {
			throw new TypeError(`readText(${JSON.stringify(sourcePath)}) must return a string`);
		}

		const ast = parseTestModule(sourceText, sourcePath);
		const tests = collectTests(ast, sourcePath);
		for (const test of tests) {
			const invocations = collectCandidateInvocations(test.callback, specification);
			if (invocations.length === 0) {
				throw new Error(`${formatTest(test, sourcePath)} has no recognized Sucrase input assertion`);
			}

			for (let index = 0; index < invocations.length; index += 1) {
				const invocation = invocations[index];
				const candidate = buildCandidate({
					invocation,
					invocationIndex: index + 1,
					sourcePath,
					specification,
					test,
				});
				candidates.push(candidate);
			}
		}
	}

	const stats = summarizeCandidates(candidates);
	stats.sourceCensus = sourceCensus;
	return { candidates, stats };
}

function normalizeListedFiles(files) {
	if (!Array.isArray(files)) {
		throw new TypeError("listFiles() must return an array of paths");
	}

	const normalized = new Set();
	for (const file of files) {
		if (typeof file !== "string") {
			throw new TypeError("listFiles() paths must be strings");
		}

		let path = file;
		while (path.startsWith("./")) {
			path = path.slice(2);
		}
		if (!path.includes("/")) {
			path = `test/${path}`;
		}
		normalized.add(path);
	}
	return normalized;
}

function parseTestModule(sourceText, sourcePath) {
	return parseTypeScriptModule(sourceText, sourcePath);
}

function collectTests(ast, sourcePath) {
	const tests = [];
	visitTestContainers(ast, [], tests, sourcePath);
	return tests;
}

function visitTestContainers(node, suite, tests, sourcePath) {
	if (!isNode(node)) {
		return;
	}

	if (node.type === "CallExpression") {
		const calleeName = getCalleeName(node.callee);
		if (calleeName === "describe") {
			const title = readStaticString(node.arguments[0], `${sourcePath} describe title`).value;
			const callback = readTestCallback(node.arguments[1], `${sourcePath} describe ${JSON.stringify(title)}`);
			visitTestContainers(callback.body, [...suite, title], tests, sourcePath);
			return;
		}

		const status = statusForTestCallee(calleeName);
		if (status !== null) {
			const title = readStaticString(node.arguments[0], `${sourcePath} test title`).value;
			const callback = readTestCallback(node.arguments[1], `${sourcePath} test ${JSON.stringify(title)}`);
			tests.push({ callback, loc: node.loc, status, suite, title });
			return;
		}
	}

	forEachChild(node, (child) => visitTestContainers(child, suite, tests, sourcePath));
}

function statusForTestCallee(calleeName) {
	if (calleeName === "it" || calleeName === "test" || calleeName === "it.only" || calleeName === "test.only") {
		return "active";
	}
	if (calleeName === "it.skip" || calleeName === "test.skip") {
		return "skip";
	}
	return null;
}

function readTestCallback(node, context) {
	if (node?.type !== "ArrowFunctionExpression" && node?.type !== "FunctionExpression") {
		throw new Error(`${context} must use a static function callback`);
	}
	return node;
}

function collectCandidateInvocations(callback, specification) {
	const invocations = [];
	visit(callback.body);
	return invocations;

	function visit(node) {
		if (!isNode(node)) {
			return;
		}

		if (node.type === "CallExpression") {
			const helper = getCalleeName(node.callee);
			if (specification.helpers.has(helper)) {
				invocations.push({ helper, node });
				return;
			}
		}

		forEachChild(node, visit);
	}
}

function buildCandidate({ invocation, invocationIndex, sourcePath, specification, test }) {
	const context = `${formatTest(test, sourcePath)} invocation ${invocationIndex}`;
	const interpretation = interpretInvocation(invocation, sourcePath, specification.category, context);
	const input = readStaticString(interpretation.inputNode, `${context} input`);
	const upstreamOptions = interpretation.upstreamOptions;
	const customJsxPragma =
		Object.hasOwn(upstreamOptions, "jsxPragma") || Object.hasOwn(upstreamOptions, "jsxFragmentPragma");
	const jsx = interpretation.jsx;
	const selectsJsxMode = jsx && sourcePath === "test/jsx-test.ts";
	const selectedMode = selectsJsxMode
		? selectJsxEsmMode(interpretation.availableModes, upstreamOptions, context)
		: undefined;
	const options = {
		jsx: selectsJsxMode
			? jsxOptionForMode(selectedMode, upstreamOptions, context)
			: jsx
				? jsxOptionForExplicitOptions(upstreamOptions, context)
				: false,
	};
	return {
		api: "syntaxase",
		availableModes: interpretation.availableModes,
		category: interpretation.category,
		extraction: input.extraction,
		features: { customJsxPragma },
		helper: invocation.helper,
		input: input.value,
		inputFile: jsx ? "input.tsx" : "input.ts",
		invocation: invocationIndex,
		options,
		...(jsx ? { requires: { jsx: true } } : {}),
		sourcePath,
		sourceRange: {
			endLine: input.loc.end.line,
			startLine: input.loc.start.line,
		},
		status: test.status,
		suite: [...test.suite],
		title: test.title,
		...(selectsJsxMode ? { modeSelection: "jsx-expectation", selectedMode } : {}),
	};
}

function selectJsxEsmMode(availableModes, upstreamOptions, context) {
	for (const mode of jsxEsmModePreference) {
		if (availableModes.includes(mode) && isModeCompatibleWithOptions(mode, upstreamOptions, context)) {
			return mode;
		}
	}
	return undefined;
}

function isModeCompatibleWithOptions(mode, upstreamOptions, context) {
	if (Object.hasOwn(upstreamOptions, "jsxRuntime")) {
		const runtime = upstreamOptions.jsxRuntime;
		if (runtime !== "automatic" && runtime !== "classic" && runtime !== "preserve") {
			throw new Error(`${context} has unsupported jsxRuntime ${JSON.stringify(runtime)}`);
		}
		if (runtime === "preserve" ? mode !== "preserve-esm" : !mode.startsWith(`${runtime}-`)) {
			return false;
		}
	}
	if (Object.hasOwn(upstreamOptions, "production")) {
		if (typeof upstreamOptions.production !== "boolean") {
			throw new Error(`${context} production must be a static boolean`);
		}
		if (mode !== "preserve-esm") {
			const expectedEnvironment = upstreamOptions.production ? "-production-" : "-development-";
			if (!mode.includes(expectedEnvironment)) {
				return false;
			}
		}
	}
	const hasPragma =
		Object.hasOwn(upstreamOptions, "jsxPragma") || Object.hasOwn(upstreamOptions, "jsxFragmentPragma");
	if (hasPragma && !mode.startsWith("classic-")) {
		return false;
	}
	if (Object.hasOwn(upstreamOptions, "jsxImportSource") && !mode.startsWith("automatic-")) {
		return false;
	}
	return true;
}

function jsxOptionForMode(mode, upstreamOptions, context) {
	if (mode === undefined) {
		return true;
	}

	if (mode === "preserve-esm") {
		return { runtime: "preserve" };
	}

	const automatic = mode.startsWith("automatic-");
	const classic = mode.startsWith("classic-");
	if (!automatic && !classic) {
		throw new Error(`${context} selected unsupported JSX mode ${mode}`);
	}

	const development = mode.includes("-development-");
	const config = {
		development,
		runtime: automatic ? "automatic" : "classic",
	};
	if (automatic && Object.hasOwn(upstreamOptions, "jsxImportSource")) {
		assertStaticNonEmptyString(upstreamOptions.jsxImportSource, `${context} jsxImportSource`);
		config.importSource = upstreamOptions.jsxImportSource;
	}
	if (classic && Object.hasOwn(upstreamOptions, "jsxPragma")) {
		assertStaticNonEmptyString(upstreamOptions.jsxPragma, `${context} jsxPragma`);
		config.pragma = upstreamOptions.jsxPragma;
	}
	if (classic && Object.hasOwn(upstreamOptions, "jsxFragmentPragma")) {
		assertStaticNonEmptyString(upstreamOptions.jsxFragmentPragma, `${context} jsxFragmentPragma`);
		config.pragmaFrag = upstreamOptions.jsxFragmentPragma;
	}

	const defaultAutomatic = automatic && !development && Object.keys(config).length === 2;
	return defaultAutomatic ? true : config;
}

function jsxOptionForExplicitOptions(upstreamOptions, context) {
	const runtime = upstreamOptions.jsxRuntime ?? "classic";
	if (runtime === "preserve") {
		return jsxOptionForMode("preserve-esm", upstreamOptions, context);
	}
	if (runtime !== "automatic" && runtime !== "classic") {
		throw new Error(`${context} has unsupported jsxRuntime ${JSON.stringify(runtime)}`);
	}
	const environment = upstreamOptions.production === true ? "production" : "development";
	return jsxOptionForMode(`${runtime}-${environment}-esm`, upstreamOptions, context);
}

function assertStaticNonEmptyString(value, context) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${context} must be a static non-empty string`);
	}
}

function interpretInvocation(invocation, sourcePath, category, context) {
	const { helper, node } = invocation;

	if (sourcePath === "test/typescript-test.ts") {
		return interpretTypeScriptInvocation(helper, node, category, context);
	}
	if (sourcePath === "test/types-test.ts") {
		return interpretSharedTypeInvocation(helper, node, category, context);
	}
	if (sourcePath === "test/jsx-test.ts") {
		return interpretJsxInvocation(helper, node, category, context);
	}
	if (sourcePath === "test/react-display-name-test.ts") {
		return interpretDisplayNameInvocation(helper, node, category, context);
	}

	throw new Error(`${context} belongs to an unsupported Sucrase source`);
}

function interpretTypeScriptInvocation(helper, node, category, context) {
	if (helper === "assertTypeScriptResult") {
		assertArgumentCount(node, 2, 3, context);
		const override = readOptions(node.arguments[2], `${context} options`);
		const upstreamOptions = { transforms: ["jsx", "imports", "typescript"], ...override };
		return interpretationForOptions(node.arguments[0], category, upstreamOptions, context);
	}

	if (helper === "assertTypeScriptESMResult") {
		assertArgumentCount(node, 2, 3, context);
		const override = readOptions(node.arguments[2], `${context} options`);
		const upstreamOptions = { transforms: ["jsx", "typescript"], ...override };
		return interpretationForOptions(node.arguments[0], category, upstreamOptions, context);
	}

	if (helper === "assertTypeScriptImportResult") {
		assertArgumentCount(node, 2, 2, context);
		const expectations = readObjectProperties(node.arguments[1], `${context} expectations`);
		assertExactKeys(
			expectations,
			new Set(["expectedCJSResult", "expectedESMResult", "options"]),
			new Set(["expectedCJSResult", "expectedESMResult"]),
			`${context} expectations`,
		);
		const override = readOptions(expectations.get("options"), `${context} options`);
		const upstreamOptions = { transforms: ["jsx", "typescript"], ...override };
		const interpretation = interpretationForOptions(node.arguments[0], category, upstreamOptions, context);
		interpretation.availableModes = modesForImportPair(upstreamOptions, context);
		return interpretation;
	}

	if (helper === "assertResult") {
		assertArgumentCount(node, 3, 3, context);
		const upstreamOptions = readOptions(node.arguments[2], `${context} options`, { required: true });
		return interpretationForOptions(node.arguments[0], category, upstreamOptions, context);
	}

	throw new Error(`${context} uses unsupported TypeScript helper ${helper}`);
}

function interpretSharedTypeInvocation(helper, node, category, context) {
	if (helper !== "assertTypeScriptAndFlowResult" && helper !== "assertTypeScriptAndFlowExpectations") {
		throw new Error(`${context} uses unsupported shared-type helper ${helper}`);
	}
	assertArgumentCount(node, 2, 2, context);
	const upstreamOptions = { transforms: ["jsx", "imports", "typescript"] };
	return interpretationForOptions(node.arguments[0], category, upstreamOptions, context);
}

function interpretJsxInvocation(helper, node, category, context) {
	if (helper === "assertJSXResult") {
		assertArgumentCount(node, 2, 3, context);
		const expectationProperties = readObjectProperties(node.arguments[1], `${context} expectations`);
		const availableModes = [];
		for (const key of expectationProperties.keys()) {
			const mode = jsxExpectationModes.get(key);
			if (mode === undefined) {
				throw new Error(`${context} has unknown JSX expectation ${key}`);
			}
			availableModes.push(mode);
		}
		if (availableModes.length === 0) {
			throw new Error(`${context} has no JSX expectation modes`);
		}

		const upstreamOptions = readOptions(node.arguments[2], `${context} options`);
		return {
			availableModes,
			category,
			inputNode: node.arguments[0],
			jsx: true,
			upstreamOptions,
		};
	}

	if (helper === "assertResult") {
		assertArgumentCount(node, 3, 3, context);
		const upstreamOptions = readOptions(node.arguments[2], `${context} options`, { required: true });
		return interpretationForOptions(node.arguments[0], "jsx-direct", upstreamOptions, context);
	}

	if (helper === "throws") {
		assertArgumentCount(node, 1, 1, context);
		const transformCall = readThrownTransformCall(node.arguments[0], context);
		assertArgumentCount(transformCall, 2, 2, `${context} transform`);
		const upstreamOptions = readOptions(transformCall.arguments[1], `${context} transform options`, {
			required: true,
		});
		return interpretationForOptions(transformCall.arguments[0], "jsx-error", upstreamOptions, context);
	}

	throw new Error(`${context} uses unsupported JSX helper ${helper}`);
}

function interpretDisplayNameInvocation(helper, node, category, context) {
	if (helper !== "assertResult") {
		throw new Error(`${context} uses unsupported display-name helper ${helper}`);
	}
	assertArgumentCount(node, 2, 3, context);
	const override = readOptions(node.arguments[2], `${context} options`);
	const upstreamOptions = { transforms: ["jsx", "imports"], ...override };
	return interpretationForOptions(node.arguments[0], category, upstreamOptions, context);
}

function interpretationForOptions(inputNode, category, upstreamOptions, context) {
	const transforms = upstreamOptions.transforms;
	if (!Array.isArray(transforms) || transforms.some((transform) => typeof transform !== "string")) {
		throw new Error(`${context} transforms must be a static string array`);
	}
	for (const transform of transforms) {
		if (!knownTransforms.has(transform)) {
			throw new Error(`${context} has unsupported transform ${transform}`);
		}
	}

	const jsx = transforms.includes("jsx");
	return {
		availableModes: [modeForOptions(upstreamOptions, context)],
		category,
		inputNode,
		jsx,
		upstreamOptions,
	};
}

function modesForImportPair(options, context) {
	const esmOptions = { ...options, transforms: options.transforms.filter((transform) => transform !== "imports") };
	const cjsOptions = { ...options, transforms: [...esmOptions.transforms, "imports"] };
	return [modeForOptions(cjsOptions, context), modeForOptions(esmOptions, context)];
}

function modeForOptions(options, context) {
	const transforms = options.transforms;
	if (!Array.isArray(transforms)) {
		throw new Error(`${context} does not declare transforms`);
	}

	const moduleKind = transforms.includes("imports") ? "cjs" : "esm";
	if (!transforms.includes("jsx")) {
		return `typescript-${moduleKind}`;
	}

	const runtime = options.jsxRuntime ?? "classic";
	if (runtime === "preserve") {
		return `preserve-${moduleKind}`;
	}
	if (runtime !== "classic" && runtime !== "automatic") {
		throw new Error(`${context} has unsupported jsxRuntime ${JSON.stringify(runtime)}`);
	}

	const environment = options.production === true ? "production" : "development";
	return `${runtime}-${environment}-${moduleKind}`;
}

function readThrownTransformCall(callback, context) {
	if (callback?.type !== "ArrowFunctionExpression" && callback?.type !== "FunctionExpression") {
		throw new Error(`${context} throws callback must be a function`);
	}

	let expression = callback.body;
	if (expression.type === "BlockStatement") {
		if (expression.body.length !== 1 || expression.body[0].type !== "ExpressionStatement") {
			throw new Error(`${context} throws callback must contain one transform call`);
		}
		expression = expression.body[0].expression;
	}

	if (expression.type !== "CallExpression" || getCalleeName(expression.callee) !== "transform") {
		throw new Error(`${context} throws callback must directly call transform`);
	}
	return expression;
}

function readOptions(node, context, { required = false } = {}) {
	if (node === undefined) {
		if (required) {
			throw new Error(`${context} is required`);
		}
		return {};
	}

	const properties = readObjectProperties(node, context);
	const options = {};
	for (const [key, valueNode] of properties) {
		if (!knownOptionKeys.has(key)) {
			throw new Error(`${context} has unknown option ${key}`);
		}
		options[key] = readStaticValue(valueNode, `${context}.${key}`);
	}
	return options;
}

function readObjectProperties(node, context) {
	if (node?.type !== "ObjectExpression") {
		throw new Error(`${context} must be an object literal`);
	}

	const properties = new Map();
	for (const property of node.properties) {
		if (property.type !== "Property" || property.kind !== "init" || property.computed || property.method) {
			throw new Error(`${context} must contain only static properties`);
		}
		const key = readPropertyKey(property.key, context);
		if (properties.has(key)) {
			throw new Error(`${context} contains duplicate property ${key}`);
		}
		properties.set(key, property.value);
	}
	return properties;
}

function readPropertyKey(node, context) {
	if (node.type === "Identifier") {
		return node.name;
	}
	if (node.type === "Literal" && typeof node.value === "string") {
		return node.value;
	}
	throw new Error(`${context} has a non-static property key`);
}

function readStaticValue(node, context) {
	if (node?.type === "Literal") {
		if (
			node.value === null ||
			typeof node.value === "string" ||
			typeof node.value === "number" ||
			typeof node.value === "boolean"
		) {
			return node.value;
		}
		throw new Error(`${context} has an unsupported literal value`);
	}

	if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
		return readStaticString(node, context).value;
	}

	if (node?.type === "ArrayExpression") {
		const values = [];
		for (const element of node.elements) {
			if (element === null || element.type === "SpreadElement") {
				throw new Error(`${context} must not contain array holes or spreads`);
			}
			values.push(readStaticValue(element, `${context}[]`));
		}
		return values;
	}

	throw new Error(`${context} is not statically evaluable`);
}

function readStaticString(node, context) {
	if (node?.type !== "Literal" && node?.type !== "TemplateLiteral") {
		throw new Error(`${context} must be a string literal or a template literal`);
	}
	if (node.type === "TemplateLiteral" && node.expressions.length !== 0) {
		throw new Error(`${context} must not contain template substitutions`);
	}

	const result = evaluateStatic(node);
	if (typeof result.value !== "string") {
		throw new Error(`${context} must evaluate to a string`);
	}
	return { extraction: result.extraction, loc: node.loc, value: result.value };
}

function assertExactKeys(properties, allowed, required, context) {
	for (const key of properties.keys()) {
		if (!allowed.has(key)) {
			throw new Error(`${context} has unknown property ${key}`);
		}
	}
	for (const key of required) {
		if (!properties.has(key)) {
			throw new Error(`${context} is missing ${key}`);
		}
	}
}

function assertArgumentCount(node, minimum, maximum, context) {
	if (node.arguments.length < minimum || node.arguments.length > maximum) {
		throw new Error(`${context} expected ${minimum}-${maximum} arguments, received ${node.arguments.length}`);
	}
}

function getCalleeName(node) {
	if (node?.type === "Identifier") {
		return node.name;
	}
	if (node?.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
		const object = getCalleeName(node.object);
		return object === null ? null : `${object}.${node.property.name}`;
	}
	return null;
}

function isNode(value) {
	return value !== null && typeof value === "object" && typeof value.type === "string";
}

function forEachChild(node, callback) {
	for (const [key, value] of Object.entries(node)) {
		if (key === "loc" || key === "start" || key === "end" || key === "type") {
			continue;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				if (isNode(item)) {
					callback(item);
				}
			}
		} else if (isNode(value)) {
			callback(value);
		}
	}
}

function formatTest(test, sourcePath) {
	const hierarchy = [...test.suite, test.title].map((title) => JSON.stringify(title)).join(" > ");
	return `${sourcePath}:${test.loc.start.line} ${hierarchy}`;
}

function summarizeCandidates(candidates) {
	const byCategory = {};
	const bySource = {};
	let active = 0;
	let skipped = 0;

	for (const candidate of candidates) {
		byCategory[candidate.category] = (byCategory[candidate.category] ?? 0) + 1;
		bySource[candidate.sourcePath] = (bySource[candidate.sourcePath] ?? 0) + 1;
		if (candidate.status === "active") {
			active += 1;
		} else {
			skipped += 1;
		}
	}

	return {
		active,
		byCategory,
		bySource,
		discovered: candidates.length,
		resolved: candidates.length,
		skipped,
		total: candidates.length,
		unresolved: 0,
	};
}
