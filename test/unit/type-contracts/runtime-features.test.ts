import {
	createRuntimeFeatureCollection,
	collectRuntimeFeatureNode,
	lowerRuntimeFeatures,
} from "../../../internal/runtime-transformer.ts";
import type { Node } from "@yuku-parser/wasm";
import type { WalkContext } from "yuku-ast";
import {
	lowerNamespaceFeature,
	type NamespaceFeatureTask,
	type NamespaceLowerer,
} from "../../../internal/runtime/namespace.ts";
import type { EditTree } from "../../../internal/edit-tree.ts";
import type { SourceFile } from "../../../internal/source-file.ts";

declare const namespaceTask: NamespaceFeatureTask;
declare const namespaceLowerer: NamespaceLowerer;
declare const editTree: EditTree<"runtime">;
declare const sourceFile: SourceFile;
declare const node: Node;
declare const walkContext: WalkContext;

lowerNamespaceFeature(namespaceLowerer, namespaceTask);

// @ts-expect-error Namespace tasks retain exact semantic facts, not traversal context snapshots.
namespaceTask.ancestors;

// @ts-expect-error Namespace lowering accepts only its opaque feature state, not the aggregate edit tree.
lowerNamespaceFeature(editTree, namespaceTask);

const features = createRuntimeFeatureCollection({ jsx: null });
collectRuntimeFeatureNode(node, walkContext, features);
lowerRuntimeFeatures(sourceFile, editTree, features);

// @ts-expect-error Runtime lowering consumes collected features, not transform options.
lowerRuntimeFeatures(sourceFile, editTree, { jsx: null });
