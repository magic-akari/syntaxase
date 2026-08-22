import type { ExportNamedDeclaration, Node, TSImportEqualsDeclaration } from "@yuku-parser/wasm";
import {
	appendGenerated,
	appendOriginal,
	createEditFragment,
	finishEditFragment,
	type EditFragment,
} from "../edit-fragment.ts";
import { sourceCommentsInRange, type SourceFile } from "../source-file.ts";
import { addRuntimeReplacement, type EditTree } from "../edit-tree.ts";
import { syntaxErrorAt } from "../errors.ts";
import { nearestRuntimeNamespace } from "../namespace-semantics.ts";

export interface ImportEqualsFeatureTask {
	readonly kind: "import-equals";
	readonly node: TSImportEqualsDeclaration;
	readonly exportWrapper: ExportNamedDeclaration | null;
	readonly exportedFromNamespace: boolean;
}

export function collectImportEqualsFeature(
	node: TSImportEqualsDeclaration,
	parent: Node | null,
	ancestors: readonly Node[],
): ImportEqualsFeatureTask | null {
	if (node.importKind === "type") {
		return null;
	}
	const exportWrapper = parent?.type === "ExportNamedDeclaration" && parent.declaration === node ? parent : null;
	return {
		kind: "import-equals",
		node,
		exportWrapper,
		exportedFromNamespace: exportWrapper !== null && nearestRuntimeNamespace(ancestors) !== null,
	};
}

export function lowerImportEquals(
	task: ImportEqualsFeatureTask,
	sourceFile: SourceFile,
	edits: EditTree<"runtime">,
): void {
	const node = task.node;
	if (task.exportedFromNamespace) {
		throw syntaxErrorAt(node, "Exported namespace import aliases are not supported");
	}
	const replacement = emitImportEquals(task, sourceFile);
	const replacementNode = task.exportWrapper ?? node;
	addRuntimeReplacement(edits, replacementNode.start, replacementNode.end, replacement);
}

function emitImportEquals(task: ImportEqualsFeatureTask, sourceFile: SourceFile): EditFragment {
	const node = task.node;
	const id = node.id;
	const moduleReference = node.moduleReference;
	const sourceStart = task.exportWrapper?.start ?? node.start;
	const beforeNameComments = sourceCommentsInRange(sourceFile, sourceStart, id.start);
	const comments = sourceCommentsInRange(sourceFile, id.end, moduleReference.start);
	const trailingComments = sourceCommentsInRange(sourceFile, moduleReference.end, node.end);
	const prefix = task.exportWrapper === null ? "" : "export ";
	const result = createEditFragment();
	appendGenerated(result, `${beforeNameComments}${prefix}const  `);
	appendOriginal(result, id.start, id.end);
	appendGenerated(result, ` = ${comments}`);
	if (moduleReference.type === "TSExternalModuleReference") {
		const requireEnd = moduleReference.start + "require".length;
		appendGenerated(result, "import.sync");
		appendOriginal(result, requireEnd, moduleReference.end);
	} else {
		appendOriginal(result, moduleReference.start, moduleReference.end);
	}
	appendGenerated(result, `${trailingComments};`);
	return finishEditFragment(result);
}
