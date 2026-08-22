import type { Node } from "@yuku-parser/wasm";
import type { WalkContext } from "yuku-ast";
import {
	createJsxEmitter,
	emitJsx,
	isJsxNode,
	jsxEmitterNodes,
	jsxRuntimeImports,
	outermostJsxNodes,
	type LowerableJsxNode,
	type RuntimeImport,
} from "./jsx-emitter.ts";
import { jsStringLiteral } from "./js-string.ts";
import type { ResolvedJSXConfig } from "./jsx-config.ts";
import { createRuntimeNameAllocator, type RuntimeNameAllocator } from "./runtime-name-allocator.ts";
import type { SourceFile } from "./source-file.ts";
import { collectEnumFeature, lowerEnum, type EnumFeatureTask } from "./runtime/enum.ts";
import {
	collectImportEqualsFeature,
	lowerImportEquals,
	type ImportEqualsFeatureTask,
} from "./runtime/import-equals.ts";
import {
	collectNamespaceDeclarationFeature,
	collectNamespaceExportFeature,
	createNamespaceLowerer,
	lowerNamespaceFeature,
	type NamespaceFeatureTask,
	type NamespaceLowerer,
} from "./runtime/namespace.ts";
import {
	collectParameterPropertiesFeature,
	lowerParameterProperties,
	type ParameterPropertiesFeatureTask,
} from "./runtime/parameter-properties.ts";
import { addGeneratedEndLines, addRuntimeReplacement, editTreeSource, type EditTree } from "./edit-tree.ts";

export interface RuntimeTransformOptions {
	jsx: ResolvedJSXConfig | null;
}

type LoweredJSXConfig = Extract<ResolvedJSXConfig, { runtime: "automatic" | "classic" }>;

interface RuntimeWalkState {
	readonly baseCode: string;
	readonly edits: EditTree<"runtime">;
	readonly namespaceLowerer: NamespaceLowerer;
	readonly sourceFile: SourceFile;
	readonly runtimeNames: RuntimeNameAllocator;
}

type RuntimeFeatureTask =
	| EnumFeatureTask
	| ImportEqualsFeatureTask
	| NamespaceFeatureTask
	| ParameterPropertiesFeatureTask;

export interface RuntimeFeatureCollection {
	readonly collectJsx: boolean;
	readonly features: RuntimeFeatureTask[];
	readonly identifierNames: Set<string>;
	readonly jsxConfig: LoweredJSXConfig | null;
	readonly jsxNodes: LowerableJsxNode[];
}

export function createRuntimeFeatureCollection(options: RuntimeTransformOptions): RuntimeFeatureCollection {
	const jsxConfig = options.jsx?.runtime === "automatic" || options.jsx?.runtime === "classic" ? options.jsx : null;
	return {
		collectJsx: jsxConfig !== null,
		features: [],
		identifierNames: new Set(),
		jsxConfig,
		jsxNodes: [],
	};
}

export function lowerRuntimeFeatures(
	sourceFile: SourceFile,
	edits: EditTree<"runtime">,
	collection: RuntimeFeatureCollection,
): void {
	const jsxConfig = collection.jsxConfig;
	const hasLowerableJsx = jsxConfig !== null && collection.jsxNodes.length > 0;
	if (collection.features.length === 0 && !hasLowerableJsx) {
		return;
	}

	const { source, baseCode } = editTreeSource(edits);
	const runtimeNames = createRuntimeNameAllocator(collection.identifierNames);
	const jsxEmitter =
		!hasLowerableJsx || jsxConfig === null
			? null
			: createJsxEmitter(baseCode, sourceFile, jsxConfig, runtimeNames, collection.jsxNodes);
	const namespaceLowerer = createNamespaceLowerer({ baseCode, edits, runtimeNames, source, sourceFile });
	const state: RuntimeWalkState = {
		baseCode,
		edits,
		namespaceLowerer,
		sourceFile,
		runtimeNames,
	};
	for (const feature of collection.features) {
		lowerRuntimeFeature(feature, state);
	}

	if (jsxEmitter === null || jsxEmitterNodes(jsxEmitter).length === 0) {
		return;
	}

	for (const node of outermostJsxNodes(jsxEmitter)) {
		addRuntimeReplacement(edits, node.start, node.end, emitJsx(jsxEmitter, node));
	}

	appendJsxRuntimeImports(edits, jsxRuntimeImports(jsxEmitter));
}

export function collectRuntimeFeatureNode(
	node: Node,
	context: WalkContext,
	collection: RuntimeFeatureCollection,
): boolean | void {
	if (node.type === "Identifier" || node.type === "JSXIdentifier") {
		collection.identifierNames.add(node.name);
	}
	if (collection.collectJsx && isJsxNode(node)) {
		collection.jsxNodes.push(node);
	}
	if ((node.type === "ClassDeclaration" || node.type === "FunctionDeclaration") && node.declare === true) {
		return false;
	}
	switch (node.type) {
		case "TSEnumDeclaration": {
			const task = collectEnumFeature(node);
			if (task !== null) {
				collection.features.push(task);
			}
			return;
		}
		case "TSImportEqualsDeclaration": {
			const task = collectImportEqualsFeature(node, context.parent, context.ancestors());
			if (task !== null) {
				collection.features.push(task);
			}
			return false;
		}
		case "TSModuleDeclaration": {
			const task = collectNamespaceDeclarationFeature(node, context.parent, context.ancestors());
			if (task === null) {
				return false;
			}
			collection.features.push(task);
			return;
		}
		case "ExportAllDeclaration":
		case "ExportDefaultDeclaration":
		case "ExportNamedDeclaration": {
			const task = collectNamespaceExportFeature(node, context.ancestors());
			if (task !== null) {
				collection.features.push(task);
			}
			return;
		}
		case "MethodDefinition": {
			const task = collectParameterPropertiesFeature(node, context.parent);
			if (task !== null) {
				collection.features.push(task);
			}
			return;
		}
		default:
			return;
	}
}

function lowerRuntimeFeature(task: RuntimeFeatureTask, state: RuntimeWalkState): void {
	switch (task.kind) {
		case "enum":
			lowerEnum(task, {
				baseCode: state.baseCode,
				edits: state.edits,
				runtimeNames: state.runtimeNames,
				sourceFile: state.sourceFile,
			});
			return;
		case "import-equals":
			lowerImportEquals(task, state.sourceFile, state.edits);
			return;
		case "namespace":
			lowerNamespaceFeature(state.namespaceLowerer, task);
			return;
		case "parameter-properties":
			lowerParameterProperties(task, state.edits);
			return;
	}
}

function appendJsxRuntimeImports(edits: EditTree<"runtime">, imports: readonly RuntimeImport[]): void {
	if (imports.length === 0) {
		return;
	}

	const importsBySource = new Map<string, RuntimeImport[]>();
	for (const runtimeImport of imports) {
		const group = importsBySource.get(runtimeImport.source);
		if (group === undefined) {
			importsBySource.set(runtimeImport.source, [runtimeImport]);
		} else {
			group.push(runtimeImport);
		}
	}
	const declarations = [...importsBySource].map(([moduleSource, specifiers]) => {
		const bindings = specifiers.map((specifier) => `${specifier.imported} as ${specifier.local}`).join(", ");
		return `import { ${bindings} } from ${jsStringLiteral(moduleSource)};`;
	});
	addGeneratedEndLines(edits, declarations);
}
