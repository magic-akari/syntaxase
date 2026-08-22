import assert from "node:assert/strict";
import test from "node:test";

import {
	appendGenerated,
	appendOriginal,
	createEditFragment,
	finishEditFragment,
	recordEditFragmentLineHead,
	editFragmentText,
} from "../../internal/edit-fragment.js";
import {
	addFixedBlank,
	addFixedSubstitution,
	addRuntimeInsertion,
	addRuntimeReplacement,
	createEditTree,
	sealFixedEdits,
	renderEditTree,
} from "../../internal/edit-tree.js";

function createRuntimeTree(source) {
	return sealFixedEdits(createEditTree(source));
}

test("EditTree normalizes its supported fixed-edit conflicts before materialization", () => {
	const blankFirst = createEditTree("abcdef");
	addFixedBlank(blankFirst, 0, 5);
	addFixedSubstitution(blankFirst, 2, ";");

	const substitutionFirst = createEditTree("abcdef");
	addFixedSubstitution(substitutionFirst, 2, ";");
	addFixedBlank(substitutionFirst, 0, 5);

	assert.equal(renderEditTree(sealFixedEdits(blankFirst)), "  ;  f");
	assert.equal(renderEditTree(sealFixedEdits(substitutionFirst)), "  ;  f");

	const mergedBlanks = createEditTree("abcdef");
	addFixedBlank(mergedBlanks, 0, 4);
	addFixedBlank(mergedBlanks, 2, 5);
	assert.equal(renderEditTree(sealFixedEdits(mergedBlanks)), "     f");

	const duplicateSubstitution = createEditTree("abc");
	addFixedSubstitution(duplicateSubstitution, 1, ";");
	addFixedSubstitution(duplicateSubstitution, 1, ";");
	assert.equal(renderEditTree(sealFixedEdits(duplicateSubstitution)), "a;c");
});

test("fixed blanking preserves untouched code units and blanks every source range in place", () => {
	const sources = ["a\r\nb\nc", "\talpha\u2028beta\u2029", "😀 type\rvalue", "plain"];
	for (const source of sources) {
		for (let start = 0; start <= source.length; start += 1) {
			for (let end = start; end <= source.length; end += 1) {
				const fixed = createEditTree(source);
				addFixedBlank(fixed, start, end);
				const result = renderEditTree(sealFixedEdits(fixed));
				assert.equal(result.length, source.length);
				for (let offset = 0; offset < source.length; offset += 1) {
					const sourceCodeUnit = source.charAt(offset);
					const insideBlank = start <= offset && offset < end;
					const preservedInsideBlank = sourceCodeUnit === "\t" || /[\r\n\u2028\u2029]/u.test(sourceCodeUnit);
					const expected = insideBlank && !preservedInsideBlank ? " " : sourceCodeUnit;
					assert.equal(
						result.charAt(offset),
						expected,
						`${JSON.stringify(source)} [${start}, ${end}) @ ${offset}`,
					);
				}
			}
		}
	}
});

test("EditTree rejects ambiguous edit ownership", () => {
	const conflictingFixedSubstitutions = () => {
		const tree = createEditTree("abc");
		addFixedSubstitution(tree, 1, ";");
		addFixedSubstitution(tree, 1, "(");
		sealFixedEdits(tree);
	};
	const crossingRuntimeRanges = () => {
		const tree = createRuntimeTree("abcdef");
		addRuntimeReplacement(tree, 0, 4, "left");
		addRuntimeReplacement(tree, 2, 6, "right");
		renderEditTree(tree);
	};
	const duplicateRuntimeRanges = () => {
		const tree = createRuntimeTree("abcdef");
		addRuntimeReplacement(tree, 0, 4, "left");
		addRuntimeReplacement(tree, 0, 4, "right");
		renderEditTree(tree);
	};
	const missingNestedBoundary = () => {
		const tree = createRuntimeTree("abcdef");
		addRuntimeReplacement(tree, 0, 6, "parent");
		addRuntimeReplacement(tree, 2, 4, "child");
		renderEditTree(tree);
	};

	const cases = [
		["fixed substitutions", conflictingFixedSubstitutions, /Fixed substitutions at offset 1 conflict/u],
		["crossing runtime ranges", crossingRuntimeRanges, /\[0, 4\) conflicts with \[2, 6\)/u],
		["duplicate runtime ranges", duplicateRuntimeRanges, /\[0, 4\) conflicts with \[0, 4\)/u],
		["missing nested provenance", missingNestedBoundary, /boundary 2 is absent from its parent fragment/u],
	];
	for (const [name, run, expectedMessage] of cases) {
		assert.throws(run, expectedMessage, name);
	}
});

test("EditTree phase handles reject operations after their phase", () => {
	const fixed = createEditTree("abc");
	const runtime = sealFixedEdits(fixed);
	const cases = [
		["double sealing", () => sealFixedEdits(fixed), /sealed fixed tree/u],
		["fixed edit through sealed handle", () => addFixedBlank(fixed, 0, 1), /sealed fixed tree/u],
		["fixed edit through runtime handle", () => addFixedBlank(runtime, 0, 1), /fixed edit.*runtime tree/u],
	];

	for (const [name, run, expectedMessage] of cases) {
		assert.throws(run, expectedMessage, name);
	}
});

test("EditTree rejects invalid fixed and runtime ranges", () => {
	const invalidFixed = createEditTree("abc");
	assert.throws(() => addFixedBlank(invalidFixed, 2, 1), /range \[2, 1\)/u);

	const runtime = createRuntimeTree("abc");
	assert.throws(() => addRuntimeReplacement(runtime, 2, 1, "x"), /range \[2, 1\)/u);
	assert.throws(() => addRuntimeReplacement(runtime, 0, 4, "x"), /source length 3/u);
});

test("inline runtime replacements reuse their source lines", () => {
	const source = "import external = require('pkg');\nimport internal = Namespace.value;\n";
	const firstEnd = source.indexOf("\n");
	const secondStart = firstEnd + 1;
	const secondEnd = source.indexOf("\n", secondStart);
	const tree = createRuntimeTree(source);
	addRuntimeReplacement(tree, 0, firstEnd, "const  external = import.sync('pkg');");
	addRuntimeReplacement(tree, secondStart, secondEnd, "const  internal = Namespace.value;");

	const result = renderEditTree(tree);

	assert.equal(result, "const  external = import.sync('pkg');\nconst  internal = Namespace.value;\n");
});

test("runtime replacements that add physical lines keep the whole-line fallback", () => {
	const source = "value();\n";
	const sourceEnd = source.indexOf("\n");
	const tree = createRuntimeTree(source);
	addRuntimeReplacement(tree, 0, sourceEnd, "first();\nsecond();");

	const result = renderEditTree(tree);
	assert.equal(result, "first();\nsecond();\n        \n");
});

test("line-head alignment preserves horizontal tabs", () => {
	const source = "head\n\tvalue\n";
	const replacement = createEditFragment();
	recordEditFragmentLineHead(replacement, 0);
	appendGenerated(replacement, "first");
	recordEditFragmentLineHead(replacement, source.indexOf("value"));
	appendGenerated(replacement, "second");

	const lineHeadPlan = createRuntimeTree(source);
	addRuntimeReplacement(lineHeadPlan, 0, source.lastIndexOf("\n"), finishEditFragment(replacement));
	assert.equal(renderEditTree(lineHeadPlan), "first\n\tsecond\n");
});

test("only the first generated fragment claims one source line", () => {
	const source = "enum E { A }\n";
	const replacement = createEditFragment();
	recordEditFragmentLineHead(replacement, 0);
	appendGenerated(replacement, "var  E;(function(E){");
	recordEditFragmentLineHead(replacement, source.indexOf("A"));
	appendGenerated(replacement, 'const A = 0;E[E["A"]=A]="A";');
	recordEditFragmentLineHead(replacement, source.indexOf("}"));
	appendGenerated(replacement, "})(E||(E={}));");

	const tree = createRuntimeTree(source);
	addRuntimeReplacement(tree, 0, source.indexOf("\n"), finishEditFragment(replacement));
	const result = renderEditTree(tree);

	assert.equal(result, 'var  E;(function(E){const A = 0;E[E["A"]=A]="A";})(E||(E={}));\n');
});

test("edit tree instances remain isolated", () => {
	const leftFixed = createEditTree("abc\ndef\n");
	const rightFixed = createEditTree("uvwxyz");

	addFixedBlank(leftFixed, 0, 1);
	addFixedSubstitution(rightFixed, 1, ";");
	const left = sealFixedEdits(leftFixed);
	const right = sealFixedEdits(rightFixed);
	addRuntimeInsertion(left, 3, "!");

	assert.equal(renderEditTree(left), " bc!\ndef\n");
	assert.equal(renderEditTree(right), "u;wxyz");
});

test("rendering an edit tree does not mutate it", () => {
	const tree = createRuntimeTree("abc");
	addRuntimeInsertion(tree, 1, "!");

	const first = renderEditTree(tree);
	const second = renderEditTree(tree);

	assert.equal(second, first);
});

test("sealing fixed edits creates an independently owned runtime snapshot", () => {
	const fixed = createEditTree("abc");
	addFixedBlank(fixed, 0, 1);
	const runtime = sealFixedEdits(fixed);
	addRuntimeReplacement(runtime, 2, 3, "C");

	assert.equal(renderEditTree(runtime), " bC");
});

test("finished replacements are detached snapshots", () => {
	const replacement = createEditFragment();
	appendOriginal(replacement, 0, 1);
	recordEditFragmentLineHead(replacement, 0);
	const first = finishEditFragment(replacement);

	appendOriginal(replacement, 1, 2);
	recordEditFragmentLineHead(replacement, 1);
	const second = finishEditFragment(replacement);

	assert.equal(editFragmentText(first, "abc"), "a");
	assert.equal(first.lineHeads.length, 1);
	assert.equal(editFragmentText(second, "abc"), "ab");
	assert.equal(second.lineHeads.length, 2);
});

test("original replacement text is resolved from its source span", () => {
	const replacement = createEditFragment();
	appendOriginal(replacement, 1, 2);
	const content = finishEditFragment(replacement);

	assert.equal(editFragmentText(content, "abc"), "b");
	assert.equal(editFragmentText(content, "aXc"), "X");
});

test("nested runtime replacements and insertions compose through original provenance", () => {
	const source = "outer(child)";
	const parent = createEditFragment();
	appendGenerated(parent, "<");
	appendOriginal(parent, 0, source.length);
	appendGenerated(parent, ">");
	const childStart = source.indexOf("child");
	const childEnd = childStart + "child".length;
	const child = createEditFragment();
	appendGenerated(child, "[");
	appendOriginal(child, childStart, childEnd);
	appendGenerated(child, "]");

	const tree = createRuntimeTree(source);
	addRuntimeReplacement(tree, 0, source.length, finishEditFragment(parent));
	addRuntimeReplacement(tree, childStart, childEnd, finishEditFragment(child));
	addRuntimeInsertion(tree, childStart + 2, "!");
	addRuntimeInsertion(tree, childStart + 2, "?");

	const result = renderEditTree(tree);
	assert.equal(result, "<outer([ch!?ild])>");
});

test("insertions at replacement boundaries retain registration order", () => {
	const boundaryPlan = createRuntimeTree("body");
	addRuntimeReplacement(boundaryPlan, 0, 4, "BODY");
	addRuntimeInsertion(boundaryPlan, 0, "a");
	addRuntimeInsertion(boundaryPlan, 0, "b");
	addRuntimeInsertion(boundaryPlan, 4, "c");
	addRuntimeInsertion(boundaryPlan, 4, "d");
	assert.equal(renderEditTree(boundaryPlan), "abBODYcd");
});

test("nested replacements project line heads from original source", () => {
	const multilineSource = "outer(\n  child\n)";
	const multilineChildStart = multilineSource.indexOf("child");
	const multilineChildEnd = multilineChildStart + "child".length;
	const multilineParent = createEditFragment();
	recordEditFragmentLineHead(multilineParent, 0);
	appendGenerated(multilineParent, "P(");
	appendOriginal(multilineParent, multilineChildStart, multilineChildEnd);
	recordEditFragmentLineHead(multilineParent, multilineSource.lastIndexOf(")"));
	appendGenerated(multilineParent, ")");
	const multilineChild = createEditFragment();
	recordEditFragmentLineHead(multilineChild, multilineChildStart);
	appendGenerated(multilineChild, "[child]");
	const multilinePlan = createRuntimeTree(multilineSource);
	addRuntimeReplacement(multilinePlan, 0, multilineSource.length, finishEditFragment(multilineParent));
	addRuntimeReplacement(multilinePlan, multilineChildStart, multilineChildEnd, finishEditFragment(multilineChild));
	assert.equal(renderEditTree(multilinePlan), "P(    \n  [child]\n)");
});

test("nested ranges replace generated gaps between retained source spans", () => {
	const source = "abcdef";
	const parent = createEditFragment();
	appendOriginal(parent, 0, 2);
	appendGenerated(parent, "--");
	appendOriginal(parent, 4, 6);
	const tree = createRuntimeTree(source);
	addRuntimeReplacement(tree, 0, source.length, finishEditFragment(parent));
	addRuntimeReplacement(tree, 2, 4, "X");

	assert.equal(renderEditTree(tree), "abXef ");
});
