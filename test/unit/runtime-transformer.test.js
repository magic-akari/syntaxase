import assert from "node:assert/strict";
import test from "node:test";

import { transform } from "../../index.js";
import { walkAst } from "../../internal/ast-walker.js";
import { createEditTree, renderEditTree, sealFixedEdits } from "../../internal/edit-tree.js";
import {
	createRuntimeFeatureCollection,
	lowerRuntimeFeatures,
	runtimeFeatureVisitors,
} from "../../internal/runtime-transformer.js";
import { createTypeEraser } from "../../internal/type-eraser.js";
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
	const visitors = [createTypeEraser(sourceFile, fixedTree, "transform"), ...runtimeFeatureVisitors(runtimeFeatures)];
	walkAst(sourceFile.ast, visitors);
	runtimeFeatures.features.reverse();
	const runtimeTree = sealFixedEdits(fixedTree);
	lowerRuntimeFeatures(sourceFile, runtimeTree, runtimeFeatures);
	return renderEditTree(runtimeTree);
}
