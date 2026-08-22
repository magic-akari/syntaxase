import {
	addFixedBlank,
	addFixedSubstitution,
	addRuntimeReplacement,
	createEditTree,
	sealFixedEdits,
} from "../../../internal/edit-tree.ts";

const fixedTree = createEditTree("value");
addFixedBlank(fixedTree, 0, 1);
addFixedSubstitution(fixedTree, 1, ";");

// @ts-expect-error Runtime edits cannot be added before fixed edits are sealed.
addRuntimeReplacement(fixedTree, 0, 1, "V");

const runtimeTree = sealFixedEdits(fixedTree);
addRuntimeReplacement(runtimeTree, 0, 1, "V");

// @ts-expect-error Fixed edits cannot be added to a runtime tree.
addFixedBlank(runtimeTree, 0, 1);

// @ts-expect-error Fixed substitutions are restricted to one supported code unit.
addFixedSubstitution(fixedTree, 0, "value");
