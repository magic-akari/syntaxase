import { readFileSync } from "node:fs";

const benchmarkPackage = readJson(new URL("./package.json", import.meta.url));
const syntaxasePackage = readJson(new URL("../package.json", import.meta.url));

export const COMPARISON_IMPLEMENTATIONS = [
	{
		id: "syntaxase",
		label: "Syntaxase",
		lanes: ["erase", "typescript", "tsx"],
		packages: { syntaxase: syntaxasePackage.version },
	},
	{
		id: "ts-blank-space",
		label: "ts-blank-space",
		lanes: ["erase"],
		packages: packageVersions("ts-blank-space"),
	},
	{
		id: "sucrase",
		label: "Sucrase",
		lanes: ["typescript", "tsx"],
		packages: packageVersions("sucrase"),
	},
	{
		id: "babel",
		label: "Babel",
		lanes: ["typescript", "tsx"],
		packages: packageVersions(
			"@babel/core",
			"@babel/plugin-transform-react-jsx",
			"@babel/plugin-transform-typescript",
		),
	},
	{
		id: "oxc",
		label: "OXC",
		lanes: ["typescript", "tsx"],
		packages: packageVersions("oxc-transform"),
	},
];

export const COMPARISON_EXCLUSIONS = {
	"typescript-parser": {
		sucrase: "Sucrase 3.35.1 rejects a valid generic-arrow comparison in this pinned TypeScript source.",
	},
};

export function comparisonLane(corpus) {
	if (corpus.operation === "stripTypes") {
		return "erase";
	}
	return corpus.jsx ? "tsx" : "typescript";
}

export function implementationsForCorpus(corpus) {
	const lane = comparisonLane(corpus);
	const exclusions = COMPARISON_EXCLUSIONS[corpus.id] ?? {};
	return COMPARISON_IMPLEMENTATIONS.filter((implementation) => {
		return implementation.lanes.includes(lane) && exclusions[implementation.id] === undefined;
	});
}

export async function createComparisonExecutor(implementationId, corpus, source) {
	switch (implementationId) {
		case "syntaxase":
			return createSyntaxaseExecutor(corpus, source);
		case "ts-blank-space":
			return createTsBlankSpaceExecutor(source);
		case "sucrase":
			return createSucraseExecutor(corpus, source);
		case "babel":
			return createBabelExecutor(corpus, source);
		case "oxc":
			return createOxcExecutor(corpus, source);
		default:
			throw new TypeError(`Unknown comparison implementation ${implementationId}`);
	}
}

async function createSyntaxaseExecutor(corpus, source) {
	const syntaxase = await import(new URL("../index.js", import.meta.url));
	const execute =
		corpus.operation === "stripTypes"
			? () => syntaxase.stripTypes(source)
			: () => syntaxase.transform(source, { jsx: corpus.jsx });
	return { execute, inspect: execute };
}

async function createTsBlankSpaceExecutor(source) {
	const { default: tsBlankSpace } = await import("ts-blank-space");
	const execute = () => tsBlankSpace(source);
	return { execute, inspect: execute };
}

async function createSucraseExecutor(corpus, source) {
	const { transform } = await import("sucrase");
	const transforms = corpus.jsx ? ["typescript", "jsx"] : ["typescript"];
	const options = {
		disableESTransforms: true,
		jsxRuntime: "automatic",
		production: true,
		transforms,
	};
	const execute = () => transform(source, options).code;
	return { execute, inspect: execute };
}

async function createBabelExecutor(corpus, source) {
	const [{ transformSync }, { default: transformReactJsx }, { default: transformTypeScript }] = await Promise.all([
		import("@babel/core"),
		import("@babel/plugin-transform-react-jsx"),
		import("@babel/plugin-transform-typescript"),
	]);
	const plugins = [
		[
			transformTypeScript,
			{
				allExtensions: true,
				allowDeclareFields: true,
				allowNamespaces: true,
				isTSX: corpus.jsx,
			},
		],
	];
	if (corpus.jsx) {
		plugins.push([transformReactJsx, { runtime: "automatic" }]);
	}
	const options = {
		ast: false,
		babelrc: false,
		code: true,
		comments: true,
		compact: false,
		configFile: false,
		filename: corpus.jsx ? "input.tsx" : "input.ts",
		plugins,
		sourceMaps: false,
	};
	const execute = () => transformSync(source, options)?.code;
	const inspect = () => {
		const code = execute();
		if (code === undefined) {
			throw new Error("Babel returned no generated code");
		}
		return code;
	};
	return { execute, inspect };
}

async function createOxcExecutor(corpus, source) {
	const { transformSync } = await import("oxc-transform");
	const fileName = corpus.jsx ? "input.tsx" : "input.ts";
	const options = {
		jsx: corpus.jsx ? { runtime: "automatic" } : undefined,
		lang: corpus.jsx ? "tsx" : "ts",
		sourcemap: false,
		sourceType: "module",
		target: "esnext",
		typescript: { allowNamespaces: true },
	};
	const run = () => transformSync(fileName, source, options);
	const execute = () => run().code;
	const inspect = () => {
		const result = run();
		if (result.errors.length > 0) {
			const messages = result.errors.map((error) => error.message).join("; ");
			throw new Error(`OXC reported transformation errors: ${messages}`);
		}
		return result.code;
	};
	return { execute, inspect };
}

function packageVersions(...names) {
	return Object.fromEntries(names.map((name) => [name, benchmarkPackage.dependencies[name]]));
}

function readJson(url) {
	return JSON.parse(readFileSync(url, "utf8"));
}
