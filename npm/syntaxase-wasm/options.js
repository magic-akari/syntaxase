// Canonical option normalization shared by all JavaScript package boundaries.
const MODE_TRANSFORM = 0;
const MODE_AUTOMATIC = 1;
const MODE_AUTOMATIC_DEVELOPMENT = 2;
const MODE_CLASSIC = 3;
const MODE_PRESERVE = 4;
export const MODE_STRIP_TYPES = 5;

const IDENTIFIER_NAME = /^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u;
const RESERVED_IDENTIFIER_REFERENCES = new Set([
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
]);
const JSX_CONFIG_KEYS = new Set(["runtime", "development", "importSource", "pragma", "pragmaFrag"]);
const JSX_RUNTIMES = new Set(["automatic", "classic", "preserve"]);

export function assertSourceText(sourceText) {
	if (typeof sourceText !== "string") {
		throw new TypeError("sourceText must be a string");
	}
}

export function resolveTransformOptions(options) {
	assertOptions(options);
	return resolveJSXConfig(options.jsx);
}

function assertOptions(options) {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		throw new TypeError("transform options must be an object");
	}
	for (const key of Reflect.ownKeys(options)) {
		if (key !== "jsx") {
			throw new TypeError(`transform options contains unknown option ${String(key)}`);
		}
	}
}

function resolveJSXConfig(value) {
	if (value === undefined || value === false) {
		return { mode: MODE_TRANSFORM, first: "", second: "" };
	}
	if (value === true) {
		return { mode: MODE_AUTOMATIC, first: "react", second: "" };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("transform options.jsx must be a boolean or an object");
	}

	assertKnownJSXKeys(value);
	const runtime = readRuntime(value);
	const importSource = readString(value, "importSource");
	const pragma = readMemberExpression(value, "pragma");
	const pragmaFrag = readMemberExpression(value, "pragmaFrag");

	if (runtime === "automatic") {
		const development = readBoolean(value, "development", false);
		assertAbsent(value, "pragma", runtime);
		assertAbsent(value, "pragmaFrag", runtime);
		return {
			mode: development ? MODE_AUTOMATIC_DEVELOPMENT : MODE_AUTOMATIC,
			first: importSource ?? "react",
			second: "",
		};
	}
	if (runtime === "classic") {
		assertAbsent(value, "development", runtime);
		assertAbsent(value, "importSource", runtime);
		return {
			mode: MODE_CLASSIC,
			first: pragma ?? "React.createElement",
			second: pragmaFrag ?? "React.Fragment",
		};
	}

	assertAbsent(value, "development", runtime);
	assertAbsent(value, "importSource", runtime);
	assertAbsent(value, "pragma", runtime);
	assertAbsent(value, "pragmaFrag", runtime);
	return { mode: MODE_PRESERVE, first: "", second: "" };
}

function assertKnownJSXKeys(config) {
	for (const key of Reflect.ownKeys(config)) {
		if (typeof key !== "string" || !JSX_CONFIG_KEYS.has(key)) {
			throw new TypeError(`transform options.jsx contains unknown option ${String(key)}`);
		}
	}
}

function readRuntime(config) {
	if (!Object.hasOwn(config, "runtime")) return "automatic";
	const runtime = config.runtime;
	if (typeof runtime !== "string" || !JSX_RUNTIMES.has(runtime)) {
		throw new TypeError('transform options.jsx.runtime must be "automatic", "classic", or "preserve"');
	}
	return runtime;
}

function readBoolean(config, key, defaultValue) {
	if (!Object.hasOwn(config, key)) return defaultValue;
	const value = config[key];
	if (typeof value !== "boolean") {
		throw new TypeError(`transform options.jsx.${key} must be a boolean`);
	}
	return value;
}

function readString(config, key) {
	if (!Object.hasOwn(config, key)) return undefined;
	const value = config[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`transform options.jsx.${key} must be a non-empty string`);
	}
	return value;
}

function readMemberExpression(config, key) {
	if (!Object.hasOwn(config, key)) return undefined;
	const value = config[key];
	if (typeof value !== "string" || !isDottedMemberExpression(value)) {
		throw new TypeError(`transform options.jsx.${key} must be an identifier or dotted member expression`);
	}
	return value;
}

function isDottedMemberExpression(value) {
	const segments = value.split(".");
	const root = segments[0];
	if (root === undefined || !isIdentifierReference(root)) return false;
	return segments.every((segment) => IDENTIFIER_NAME.test(segment));
}

function isIdentifierReference(value) {
	return IDENTIFIER_NAME.test(value) && !RESERVED_IDENTIFIER_REFERENCES.has(value);
}

function assertAbsent(config, key, runtime) {
	if (Object.hasOwn(config, key)) {
		throw new TypeError(`transform options.jsx.${String(key)} is not supported with ${runtime} runtime`);
	}
}
