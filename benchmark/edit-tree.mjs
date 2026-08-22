import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(process.argv[2] ?? path.join(benchmarkDirectory, ".."));
const fragmentModule = await import(pathToFileURL(path.join(implementationRoot, "internal/edit-fragment.js")));
const treeModule = await import(pathToFileURL(path.join(implementationRoot, "internal/edit-tree.js")));
const { appendGenerated, appendOriginal, createEditFragment, finishEditFragment } = fragmentModule;
const { addRuntimeReplacement, createEditTree, renderEditTree, sealFixedEdits } = treeModule;

const CASES = [
	{
		name: "wide",
		create: () => createWideTree(512),
		iterations: 40,
	},
	{
		name: "deep",
		create: () => createDeepTree(256),
		iterations: 80,
	},
];

process.stdout.write(`${implementationRoot}\n`);
for (const benchmark of CASES) {
	const tree = benchmark.create();
	const checksum = renderEditTree(tree).length;
	for (let index = 0; index < 20; index += 1) {
		renderEditTree(tree);
	}

	const samples = [];
	for (let sample = 0; sample < 9; sample += 1) {
		globalThis.gc?.();
		const start = performance.now();
		for (let iteration = 0; iteration < benchmark.iterations; iteration += 1) {
			renderEditTree(tree);
		}
		const elapsed = performance.now() - start;
		samples.push((benchmark.iterations * 1_000) / elapsed);
	}
	samples.sort((left, right) => left - right);
	const median = samples[Math.floor(samples.length / 2)];
	process.stdout.write(`${benchmark.name}: ${median.toFixed(1)} renders/s (checksum ${checksum})\n`);
}

function createWideTree(childCount) {
	const source = "x".repeat(childCount * 2 + 1);
	const tree = sealFixedEdits(createEditTree(source));
	const parent = createEditFragment();
	appendGenerated(parent, "<");
	appendOriginal(parent, 0, source.length);
	appendGenerated(parent, ">");
	addRuntimeReplacement(tree, 0, source.length, finishEditFragment(parent));

	for (let index = 0; index < childCount; index += 1) {
		const start = index * 2 + 1;
		const child = createEditFragment();
		appendGenerated(child, "[");
		appendOriginal(child, start, start + 1);
		appendGenerated(child, "]");
		addRuntimeReplacement(tree, start, start + 1, finishEditFragment(child));
	}
	return tree;
}

function createDeepTree(depth) {
	const source = "x".repeat(depth * 2 + 1);
	const tree = sealFixedEdits(createEditTree(source));
	for (let level = 0; level < depth; level += 1) {
		const start = level;
		const end = source.length - level;
		const replacement = createEditFragment();
		appendGenerated(replacement, "<");
		appendOriginal(replacement, start, end);
		appendGenerated(replacement, ">");
		addRuntimeReplacement(tree, start, end, finishEditFragment(replacement));
	}
	return tree;
}
