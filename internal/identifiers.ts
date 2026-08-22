const IDENTIFIER_NAME = /^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u;

const RESERVED_IDENTIFIER_REFERENCES: ReadonlySet<string> = new Set([
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

const STRICT_BINDING_RESTRICTED_NAMES: ReadonlySet<string> = new Set(["arguments", "eval"]);

export function isIdentifierName(value: string): boolean {
	return IDENTIFIER_NAME.test(value);
}

export function isIdentifierReference(value: string): boolean {
	return isIdentifierName(value) && !RESERVED_IDENTIFIER_REFERENCES.has(value);
}

export function isStrictBindingIdentifier(value: string): boolean {
	return isIdentifierReference(value) && !STRICT_BINDING_RESTRICTED_NAMES.has(value);
}
