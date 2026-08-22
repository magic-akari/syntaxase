import { type AstNode, type TsImportEqualsDeclaration } from "../ast.ts";
import {
	appendGenerated,
	appendOriginal,
	createEditFragment,
	finishEditFragment,
	type EditFragment,
} from "../edit-fragment.ts";
import { sourceCommentsInRange, type SourceFile } from "../source-file.ts";
import { requireTokenByText } from "../token-index.ts";
import { addRuntimeReplacement, type EditTree } from "../edit-tree.ts";
import { syntaxErrorAt } from "../errors.ts";
import { nearestRuntimeNamespace } from "../namespace-semantics.ts";

export interface ImportEqualsFeatureTask {
	readonly kind: "import-equals";
	readonly node: TsImportEqualsDeclaration;
	readonly exportedFromNamespace: boolean;
}

export function collectImportEqualsFeature(
	node: TsImportEqualsDeclaration,
	ancestors: readonly AstNode[],
): ImportEqualsFeatureTask | null {
	if (node.importKind === "type") {
		return null;
	}
	return {
		kind: "import-equals",
		node,
		exportedFromNamespace: node.isExport === true && nearestRuntimeNamespace(ancestors) !== null,
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
	const replacement = emitImportEquals(node, sourceFile);
	addRuntimeReplacement(edits, node.start, node.end, replacement);
}

function emitImportEquals(node: TsImportEqualsDeclaration, sourceFile: SourceFile): EditFragment {
	const id = node.id;
	const moduleReference = node.moduleReference;
	const beforeNameComments = sourceCommentsInRange(sourceFile, node.start, id.start);
	const comments = sourceCommentsInRange(sourceFile, id.end, moduleReference.start);
	const trailingComments = sourceCommentsInRange(sourceFile, moduleReference.end, node.end);
	const prefix = node.isExport === true ? "export " : "";
	const result = createEditFragment();
	appendGenerated(result, `${beforeNameComments}${prefix}const  `);
	appendOriginal(result, id.start, id.end);
	appendGenerated(result, ` = ${comments}`);
	if (moduleReference.type === "TSExternalModuleReference") {
		const requireToken = requireTokenByText(
			sourceFile.tokenIndex,
			moduleReference.start,
			moduleReference.end,
			"require",
		);
		appendGenerated(result, "import.sync");
		appendOriginal(result, requireToken.end, moduleReference.end);
	} else {
		appendOriginal(result, moduleReference.start, moduleReference.end);
	}
	appendGenerated(result, `${trailingComments};`);
	return finishEditFragment(result);
}
