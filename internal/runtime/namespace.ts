import type {
	ExportAllDeclaration,
	ExportDefaultDeclaration,
	ExportNamedDeclaration,
	Node,
	Program,
	ProgramStatement,
	TSModuleBlock,
	TSModuleDeclaration,
} from "@yuku-parser/wasm";
import { walk, type WalkContext } from "yuku-ast";
import { syntaxErrorAt } from "../errors.ts";
import {
	isTypeOnlyModule,
	isTypeOnlyNamespaceExportDeclaration,
	nearestRuntimeNamespace,
} from "../namespace-semantics.ts";
import {
	appendGenerated,
	appendOriginal,
	createEditFragment,
	finishEditFragment,
	recordEditFragmentLineHead,
} from "../edit-fragment.ts";
import { claimRuntimeReceiverName, type RuntimeNameAllocator } from "../runtime-name-allocator.ts";
import { addRuntimeInsertion, addRuntimeReplacement, type EditTree } from "../edit-tree.ts";
import { sourceCommentsInRange, type SourceFile } from "../source-file.ts";
import { equalWidthVarPrefix } from "./source-text.ts";

interface NamespaceRuntimeBinding {
	readonly publicName: string;
	readonly receiverName: string;
}

interface NamespaceLowererData {
	readonly baseCode: string;
	readonly bindings: Map<TSModuleDeclaration, NamespaceRuntimeBinding>;
	readonly edits: EditTree<"runtime">;
	readonly runtimeNames: RuntimeNameAllocator;
	readonly source: string;
	readonly sourceFile: SourceFile;
	readonly validatedScopes: Set<NamespaceScope>;
}

type NamespaceExportNode = ExportAllDeclaration | ExportDefaultDeclaration | ExportNamedDeclaration;
type NamespaceScope = Program | TSModuleBlock;

const namespaceLowererData: unique symbol = Symbol("NamespaceLowererData");

export interface NamespaceLowerer {
	readonly [namespaceLowererData]: NamespaceLowererData;
}

export interface NamespaceLowererContext {
	readonly baseCode: string;
	readonly edits: EditTree<"runtime">;
	readonly runtimeNames: RuntimeNameAllocator;
	readonly source: string;
	readonly sourceFile: SourceFile;
}

interface NamespaceDeclarationTask {
	readonly kind: "namespace";
	readonly operation: "declaration";
	readonly exportOwner: TSModuleDeclaration | null;
	readonly node: TSModuleDeclaration;
	readonly scope: NamespaceScope | null;
}

interface NamespaceExportTask {
	readonly kind: "namespace";
	readonly operation: "export";
	readonly node: NamespaceExportNode;
	readonly owner: TSModuleDeclaration;
}

export type NamespaceFeatureTask = NamespaceDeclarationTask | NamespaceExportTask;

export function createNamespaceLowerer(context: NamespaceLowererContext): NamespaceLowerer {
	return {
		[namespaceLowererData]: {
			...context,
			bindings: new Map(),
			validatedScopes: new Set(),
		},
	};
}

export function collectNamespaceDeclarationFeature(
	node: TSModuleDeclaration,
	parent: Node | null,
	ancestors: readonly Node[],
): NamespaceFeatureTask | null {
	if (isTypeOnlyModule(node)) {
		return null;
	}
	const parentNamespace = nearestRuntimeNamespace(ancestors);
	return {
		kind: "namespace",
		operation: "declaration",
		exportOwner: parent?.type === "ExportNamedDeclaration" ? parentNamespace : null,
		node,
		scope: declarationScope(parent, ancestors),
	};
}

export function collectNamespaceExportFeature(
	node: NamespaceExportNode,
	ancestors: readonly Node[],
): NamespaceFeatureTask | null {
	const owner = nearestRuntimeNamespace(ancestors);
	if (owner === null) {
		return null;
	}
	return {
		kind: "namespace",
		operation: "export",
		node,
		owner,
	};
}

export function lowerNamespaceFeature(lowerer: NamespaceLowerer, task: NamespaceFeatureTask): void {
	if (task.operation === "declaration") {
		validateNamespaceScope(lowerer, task.scope);
		lowerNamespace(lowerer, task.node, task.exportOwner);
		return;
	}
	if (task.node.type === "ExportNamedDeclaration") {
		lowerNamespaceExport(lowerer, task.node, task.owner);
		return;
	}
	throw syntaxErrorAt(task.node, "This namespace export declaration is not supported");
}

function lowerNamespace(
	lowerer: NamespaceLowerer,
	node: TSModuleDeclaration,
	exportOwner: TSModuleDeclaration | null,
): void {
	const state = lowerer[namespaceLowererData];
	const body = node.body;
	if (body?.type !== "TSModuleBlock") {
		throw syntaxErrorAt(node, "Dotted runtime namespace declarations are not supported");
	}
	const binding = namespaceRuntimeBinding(node, state);
	const id = node.id;
	const headerComments = sourceCommentsInRange(state.sourceFile, node.start, body.start + 1);
	const header = createEditFragment();
	recordEditFragmentLineHead(header, node.start);
	appendGenerated(header, equalWidthVarPrefix(state.baseCode, node.start, id.start));
	appendOriginal(header, id.start, id.end);
	appendGenerated(header, `;(function(${binding.receiverName}){${headerComments}`);
	let argument = `${binding.publicName}||(${binding.publicName}={})`;
	if (exportOwner !== null) {
		const owner = namespaceRuntimeBinding(exportOwner, state).receiverName;
		argument = `${binding.publicName}=${owner}.${binding.publicName}||(${owner}.${binding.publicName}={})`;
	}
	const footer = `})(${argument});`;

	addRuntimeReplacement(state.edits, node.start, body.start + 1, finishEditFragment(header));
	addRuntimeReplacement(state.edits, body.end - 1, body.end, footer);
}

function lowerNamespaceExport(
	lowerer: NamespaceLowerer,
	node: ExportNamedDeclaration,
	owner: TSModuleDeclaration,
): void {
	if (node.exportKind === "type") {
		return;
	}
	const declaration = node.declaration;
	if (declaration === null) {
		throw syntaxErrorAt(node, "Namespace export lists are not supported");
	}
	if (isTypeOnlyNamespaceExportDeclaration(declaration) || declaration.type === "TSModuleDeclaration") {
		return;
	}
	if (
		declaration.type !== "FunctionDeclaration" &&
		declaration.type !== "ClassDeclaration" &&
		declaration.type !== "TSEnumDeclaration"
	) {
		throw syntaxErrorAt(declaration, "This namespace export declaration is not supported");
	}
	const id = declaration.id;
	if (id === null || id.type !== "Identifier") {
		throw syntaxErrorAt(declaration, "Namespace export declarations require an identifier");
	}
	const state = lowerer[namespaceLowererData];
	const namespaceIdentifier = namespaceRuntimeBinding(owner, state).receiverName;
	const exportedName = state.source.slice(id.start, id.end);
	addRuntimeInsertion(state.edits, declaration.end, `${namespaceIdentifier}.${exportedName}=${exportedName};`);
}

function validateNamespaceScope(lowerer: NamespaceLowerer, scope: NamespaceScope | null): void {
	const state = lowerer[namespaceLowererData];
	if (scope === null || state.validatedScopes.has(scope)) {
		return;
	}
	state.validatedScopes.add(scope);
	const namespaces = new Set<string>();
	const values = new Set<string>();
	const statements = scope.body;
	for (const statement of statements) {
		const declaration = namespaceScopeDeclaration(statement);
		if (declaration === null) {
			continue;
		}
		if (declaration.type === "TSModuleDeclaration") {
			if (isTypeOnlyModule(declaration)) {
				continue;
			}
			if (declaration.body?.type !== "TSModuleBlock") {
				throw syntaxErrorAt(declaration, "Dotted runtime namespace declarations are not supported");
			}
			const name = namespaceName(declaration);
			if (namespaces.has(name) || values.has(name)) {
				throw syntaxErrorAt(declaration, "Namespace declaration merging is not supported");
			}
			namespaces.add(name);
			continue;
		}
		const name = runtimeDeclarationName(declaration);
		if (name === null) {
			continue;
		}
		if (namespaces.has(name)) {
			throw syntaxErrorAt(declaration, "Namespace declaration merging is not supported");
		}
		values.add(name);
	}
}

function namespaceRuntimeBinding(node: TSModuleDeclaration, state: NamespaceLowererData): NamespaceRuntimeBinding {
	const existing = state.bindings.get(node);
	if (existing !== undefined) {
		return existing;
	}
	const publicName = namespaceName(node);
	const conflictsWithBody = node.body === undefined ? false : namespaceReceiverHasCaptureRisk(node.body, publicName);
	const receiverName = claimRuntimeReceiverName(
		state.runtimeNames,
		publicName,
		(name) => name === publicName && conflictsWithBody,
	);
	const binding = { publicName, receiverName };
	state.bindings.set(node, binding);
	return binding;
}

interface NamespaceReceiverRiskState {
	captureRisk: boolean;
	readonly publicName: string;
}

function namespaceReceiverHasCaptureRisk(body: TSModuleBlock, publicName: string): boolean {
	const risk: NamespaceReceiverRiskState = { captureRisk: false, publicName };
	walk(body, {
		enter(node, context) {
			const descend = collectNamespaceReceiverCaptureRisk(node, context, risk);
			if (descend === false) {
				context.skip();
			}
		},
	});
	return risk.captureRisk;
}

function collectNamespaceReceiverCaptureRisk(
	node: Node,
	_context: WalkContext,
	risk: NamespaceReceiverRiskState,
): boolean | void {
	if (
		isDeclaredNamespaceSyntax(node) ||
		node.type === "TSInterfaceDeclaration" ||
		node.type === "TSTypeAliasDeclaration" ||
		node.type === "TSNamespaceExportDeclaration" ||
		(node.type === "ExportNamedDeclaration" && node.exportKind === "type")
	) {
		return false;
	}
	if (node.type === "Identifier") {
		risk.captureRisk ||= node.name === risk.publicName;
		return;
	}

	let runtimeId: Node | null = null;
	switch (node.type) {
		case "FunctionDeclaration":
		case "ClassDeclaration":
		case "TSEnumDeclaration":
		case "FunctionExpression":
		case "ClassExpression":
			runtimeId = node.id;
			break;
		case "TSModuleDeclaration":
			runtimeId = isTypeOnlyModule(node) ? null : node.id;
			break;
		case "TSImportEqualsDeclaration":
			runtimeId = node.importKind === "type" ? null : node.id;
			break;
		case "ArrowFunctionExpression":
		case "TSDeclareFunction":
		case "StaticBlock":
			return false;
		default:
			return;
	}

	if (runtimeId?.type === "Identifier" && runtimeId.name === risk.publicName) {
		risk.captureRisk = true;
	}
	return false;
}

function namespaceName(node: TSModuleDeclaration): string {
	const id = node.id;
	if (id.type !== "Identifier") {
		throw syntaxErrorAt(node, "Runtime namespace names must be identifiers");
	}
	return id.name;
}

function declarationScope(parent: Node | null, ancestors: readonly Node[]): NamespaceScope | null {
	if (parent?.type === "Program" || parent?.type === "TSModuleBlock") {
		return parent;
	}
	if (parent?.type !== "ExportNamedDeclaration" && parent?.type !== "ExportDefaultDeclaration") {
		return null;
	}
	const scope = ancestors.at(-2);
	return scope?.type === "Program" || scope?.type === "TSModuleBlock" ? scope : null;
}

function namespaceScopeDeclaration(node: ProgramStatement): Node | null {
	if (node.type !== "ExportNamedDeclaration" && node.type !== "ExportDefaultDeclaration") {
		return node;
	}
	return node.declaration;
}

function runtimeDeclarationName(node: Node): string | null {
	if (
		node.type !== "FunctionDeclaration" &&
		node.type !== "ClassDeclaration" &&
		node.type !== "TSEnumDeclaration" &&
		node.type !== "TSDeclareFunction" &&
		node.type !== "TSImportEqualsDeclaration"
	) {
		return null;
	}
	const id = node.id;
	return id?.type === "Identifier" ? id.name : null;
}

function isDeclaredNamespaceSyntax(node: Node): boolean {
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
