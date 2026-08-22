import { isNode as isAstNode, type AstNode, type TsModuleDeclaration } from "./ast.ts";

interface NamespaceSemanticNode extends AstNode {
	readonly body?: NamespaceSemanticNode | readonly NamespaceSemanticNode[] | null;
	readonly declaration?: NamespaceSemanticNode | null;
	readonly declare?: boolean;
	readonly exportKind?: "type" | "value";
	readonly importKind?: "type" | "value";
	readonly isExport?: boolean;
	readonly isTypeOnly?: boolean;
}

const moduleRuntimeState = new WeakMap<AstNode, boolean>();

export function isTypeOnlyModule(node: AstNode): boolean {
	if ((node as NamespaceSemanticNode).declare === true) {
		return true;
	}
	const cached = moduleRuntimeState.get(node);
	if (cached !== undefined) {
		return !cached;
	}
	const hasRuntimeState = moduleHasRuntimeState(node as NamespaceSemanticNode);
	moduleRuntimeState.set(node, hasRuntimeState);
	return !hasRuntimeState;
}

export function nearestRuntimeNamespace(ancestors: readonly AstNode[]): TsModuleDeclaration | null {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!;
		if (ancestor.type === "TSModuleDeclaration" && !isTypeOnlyModule(ancestor)) {
			return ancestor as TsModuleDeclaration;
		}
	}
	return null;
}

export function isTypeOnlyNamespaceExportDeclaration(node: AstNode): boolean {
	return (
		node.type === "TSInterfaceDeclaration" ||
		node.type === "TSTypeAliasDeclaration" ||
		node.type === "TSDeclareFunction" ||
		(node.type === "TSModuleDeclaration" && isTypeOnlyModule(node)) ||
		(node as NamespaceSemanticNode).declare === true
	);
}

export function isSupportedRuntimeNamespaceExportDeclaration(node: AstNode): boolean {
	if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration" || node.type === "TSEnumDeclaration") {
		return (node as NamespaceSemanticNode).declare !== true;
	}
	return node.type === "TSModuleDeclaration" && !isTypeOnlyModule(node);
}

function moduleHasRuntimeState(node: NamespaceSemanticNode): boolean {
	const body = node.body;
	if (!isAstNode(body)) {
		return true;
	}
	if (body.type === "TSModuleDeclaration") {
		return !isTypeOnlyModule(body);
	}
	if (body.type !== "TSModuleBlock" || !Array.isArray(body.body)) {
		return true;
	}
	return body.body.some((statement) => isAstNode(statement) && namespaceStatementHasRuntimeState(statement));
}

function namespaceStatementHasRuntimeState(node: NamespaceSemanticNode): boolean {
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
	if (isAstNode(declaration)) {
		return namespaceStatementHasRuntimeState(declaration);
	}
	return node.exportKind !== "type";
}

function isNonInstantiatingNamespaceImport(node: AstNode): boolean {
	if (node.type !== "TSImportEqualsDeclaration") {
		return false;
	}
	if ((node as NamespaceSemanticNode).importKind === "type" || (node as NamespaceSemanticNode).isTypeOnly === true) {
		return true;
	}

	// A namespace-local import alias does not create an exported value on its
	// own. If every other element in the namespace is type-only, the namespace
	// has no runtime instantiation and the alias disappears with that scope.
	// `export import` is different: it contributes a runtime property and must
	// keep the namespace instantiated.
	return (node as NamespaceSemanticNode).isExport !== true;
}
