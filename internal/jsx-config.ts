import { isIdentifierName, isIdentifierReference } from "./identifiers.ts";

export type JSXRuntime = "automatic" | "classic" | "preserve";

export type JSXConfig =
	| {
			runtime?: "automatic";
			development?: boolean;
			importSource?: string;
			pragma?: never;
			pragmaFrag?: never;
	  }
	| {
			runtime: "classic";
			development?: boolean;
			importSource?: never;
			pragma?: string;
			pragmaFrag?: string;
	  }
	| {
			runtime: "preserve";
			development?: never;
			importSource?: never;
			pragma?: never;
			pragmaFrag?: never;
	  };

export type ResolvedJSXConfig =
	| {
			runtime: "automatic";
			development: boolean;
			importSource: string;
	  }
	| {
			runtime: "classic";
			pragma: string;
			pragmaFrag: string;
	  }
	| { runtime: "preserve" };

export function jsxConfigRuntimeIdentifierNames(config: ResolvedJSXConfig): readonly string[] {
	if (config.runtime !== "classic") {
		return [];
	}
	return [memberExpressionRoot(config.pragma), memberExpressionRoot(config.pragmaFrag)];
}

const JSX_CONFIG_KEYS: ReadonlySet<string> = new Set([
	"runtime",
	"development",
	"importSource",
	"pragma",
	"pragmaFrag",
]);
const JSX_RUNTIMES: ReadonlySet<JSXRuntime> = new Set(["automatic", "classic", "preserve"]);

export function resolveJSXConfig(value: boolean | JSXConfig | undefined): ResolvedJSXConfig | null {
	if (value === undefined || value === false) {
		return null;
	}
	if (value === true) {
		return automaticConfig(false, "react");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("transform options.jsx must be a boolean or an object");
	}

	assertKnownKeys(value);
	const runtime = readRuntime(value);
	const importSource = readString(value, "importSource");
	const pragma = readMemberExpression(value, "pragma");
	const pragmaFrag = readMemberExpression(value, "pragmaFrag");

	if (runtime === "automatic") {
		const development = readBoolean(value, "development", false);
		assertAbsent(value, "pragma", runtime);
		assertAbsent(value, "pragmaFrag", runtime);
		return automaticConfig(development, importSource ?? "react");
	}
	if (runtime === "classic") {
		assertAbsent(value, "importSource", runtime);
		return {
			runtime,
			pragma: pragma ?? "React.createElement",
			pragmaFrag: pragmaFrag ?? "React.Fragment",
		};
	}

	assertAbsent(value, "development", runtime);
	assertAbsent(value, "importSource", runtime);
	assertAbsent(value, "pragma", runtime);
	assertAbsent(value, "pragmaFrag", runtime);
	return { runtime };
}

function automaticConfig(development: boolean, importSource: string): ResolvedJSXConfig {
	return {
		runtime: "automatic",
		development,
		importSource,
	};
}

function assertKnownKeys(config: JSXConfig): void {
	for (const key of Reflect.ownKeys(config)) {
		if (typeof key !== "string" || !JSX_CONFIG_KEYS.has(key)) {
			throw new TypeError(`transform options.jsx contains unknown option ${String(key)}`);
		}
	}
}

function readRuntime(config: JSXConfig): JSXRuntime {
	if (!Object.hasOwn(config, "runtime")) {
		return "automatic";
	}
	const runtime = config.runtime;
	if (typeof runtime !== "string" || !JSX_RUNTIMES.has(runtime as JSXRuntime)) {
		throw new TypeError('transform options.jsx.runtime must be "automatic", "classic", or "preserve"');
	}
	return runtime as JSXRuntime;
}

function readBoolean(config: JSXConfig, key: "development", defaultValue: boolean): boolean {
	if (!Object.hasOwn(config, key)) {
		return defaultValue;
	}
	const value = config[key];
	if (typeof value !== "boolean") {
		throw new TypeError(`transform options.jsx.${key} must be a boolean`);
	}
	return value;
}

function readString(config: JSXConfig, key: "importSource"): string | undefined {
	if (!Object.hasOwn(config, key)) {
		return undefined;
	}
	const value = config[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`transform options.jsx.${key} must be a non-empty string`);
	}
	return value;
}

function readMemberExpression(config: JSXConfig, key: "pragma" | "pragmaFrag"): string | undefined {
	if (!Object.hasOwn(config, key)) {
		return undefined;
	}
	const value = config[key];
	if (typeof value !== "string" || !isDottedMemberExpression(value)) {
		throw new TypeError(`transform options.jsx.${key} must be an identifier or dotted member expression`);
	}
	return value;
}

function isDottedMemberExpression(value: string): boolean {
	const segments = value.split(".");
	const root = segments[0];
	if (root === undefined || !isIdentifierReference(root)) {
		return false;
	}
	return segments.every((segment) => isIdentifierName(segment));
}

function memberExpressionRoot(value: string): string {
	const dot = value.indexOf(".");
	return dot === -1 ? value : value.slice(0, dot);
}

function assertAbsent(config: JSXConfig, key: keyof JSXConfig, runtime: JSXRuntime): void {
	if (Object.hasOwn(config, key)) {
		throw new TypeError(`transform options.jsx.${String(key)} is not supported with ${runtime} runtime`);
	}
}
