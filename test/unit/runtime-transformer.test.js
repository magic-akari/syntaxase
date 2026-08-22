import assert from "node:assert/strict";
import test from "node:test";
import { walk } from "yuku-ast";

import { transform } from "../../index.js";
import { createEditTree, renderEditTree, sealFixedEdits } from "../../internal/edit-tree.js";
import {
	createRuntimeFeatureCollection,
	collectRuntimeFeatureNode,
	lowerRuntimeFeatures,
} from "../../internal/runtime-transformer.js";
import { createTypeEraser, eraseTypeScriptNode } from "../../internal/type-eraser.js";
import { parseTypeScript } from "../../parser.js";

test("namespace lowering does not depend on feature task order", () => {
	const source = [
		"const N1 = 2;",
		"namespace N {",
		"\texport namespace N {",
		"\t\texport function inner(): number { return 1; }",
		"\t}",
		"\texport function after(): number { return N1; }",
		"}",
		"export const observed = [N.N.inner(), N.after()];",
		"",
	].join("\n");

	assert.equal(transformWithReversedRuntimeFeatures(source), transform(source));
});

function transformWithReversedRuntimeFeatures(source) {
	const sourceFile = parseTypeScript(source, false);
	const fixedTree = createEditTree(source, sourceFile.layout);
	const runtimeFeatures = createRuntimeFeatureCollection({ jsx: null });
	const typeEraser = createTypeEraser(sourceFile, fixedTree, "transform");
	walk(sourceFile.ast, {
		enter(node, context) {
			const eraseDescendants = eraseTypeScriptNode(node, context, typeEraser);
			const collectDescendants = collectRuntimeFeatureNode(node, context, runtimeFeatures);
			if (eraseDescendants === false || collectDescendants === false) {
				context.skip();
			}
		},
	});
	runtimeFeatures.features.reverse();
	const runtimeTree = sealFixedEdits(fixedTree);
	lowerRuntimeFeatures(sourceFile, runtimeTree, runtimeFeatures);
	return renderEditTree(runtimeTree);
}
