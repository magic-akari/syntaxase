import type { Node, ProgramStatement, TSModuleDeclaration } from "@yuku-parser/wasm";

const moduleRuntimeState = new WeakMap<TSModuleDeclaration, boolean>();

export function isTypeOnlyModule(node: TSModuleDeclaration): boolean {
	if (node.declare) {
		return true;
	}
	const cached = moduleRuntimeState.get(node);
	if (cached !== undefined) {
		return !cached;
	}
	const hasRuntimeState = moduleHasRuntimeState(node);
	moduleRuntimeState.set(node, hasRuntimeState);
	return !hasRuntimeState;
}

export function nearestRuntimeNamespace(ancestors: readonly Node[]): TSModuleDeclaration | null {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!;
		if (ancestor.type === "TSModuleDeclaration" && !isTypeOnlyModule(ancestor)) {
			return ancestor;
		}
	}
	return null;
}

export function isTypeOnlyNamespaceExportDeclaration(node: Node): boolean {
	return (
		node.type === "TSInterfaceDeclaration" ||
		node.type === "TSTypeAliasDeclaration" ||
		node.type === "TSDeclareFunction" ||
		(node.type === "TSModuleDeclaration" && isTypeOnlyModule(node)) ||
		isDeclaredNode(node)
	);
}

export function isSupportedRuntimeNamespaceExportDeclaration(node: Node): boolean {
	if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration" || node.type === "TSEnumDeclaration") {
		return !node.declare;
	}
	return node.type === "TSModuleDeclaration" && !isTypeOnlyModule(node);
}

function moduleHasRuntimeState(node: TSModuleDeclaration): boolean {
	const body = node.body;
	if (body === undefined) {
		return true;
	}
	return body.body.some(namespaceStatementHasRuntimeState);
}

function namespaceStatementHasRuntimeState(node: ProgramStatement): boolean {
	if (
		node.type === "TSInterfaceDeclaration" ||
		node.type === "TSTypeAliasDeclaration" ||
		node.type === "TSNamespaceExportDeclaration"
	) {
		return false;
	}
	if (node.type === "TSImportEqualsDeclaration") {
		return !isNonInstantiatingNamespaceImport(node);
	}
	if (node.type === "TSModuleDeclaration") {
		return !isTypeOnlyModule(node);
	}
	if (node.type !== "ExportNamedDeclaration") {
		return true;
	}
	const declaration = node.declaration;
	if (declaration !== null) {
		if (declaration.type === "TSImportEqualsDeclaration") {
			return declaration.importKind !== "type";
		}
		return namespaceStatementHasRuntimeState(declaration);
	}
	return node.exportKind !== "type";
}

function isNonInstantiatingNamespaceImport(node: Extract<Node, { type: "TSImportEqualsDeclaration" }>): boolean {
	if (node.importKind === "type") {
		return true;
	}

	// A namespace-local import alias does not create an exported value on its
	// own. If every other element in the namespace is type-only, the namespace
	// has no runtime instantiation and the alias disappears with that scope.
	// Exported import-equals declarations are wrapped by ExportNamedDeclaration
	// and handled before reaching this local-alias branch.
	return true;
}

function isDeclaredNode(node: Node): boolean {
	switch (node.type) {
		case "ClassDeclaration":
		case "FunctionDeclaration":
		case "VariableDeclaration":
		case "TSDeclareFunction":
		case "TSInterfaceDeclaration":
		case "TSEnumDeclaration":
		case "TSModuleDeclaration":
			return node.declare === true;
		default:
			return false;
	}
}
