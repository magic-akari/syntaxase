import { walk } from "yuku-ast";
import { createEditTree, renderEditTree, sealFixedEdits } from "./internal/edit-tree.ts";
import { resolveJSXConfig, type JSXConfig } from "./internal/jsx-config.ts";
import {
	createRuntimeFeatureCollection,
	collectRuntimeFeatureNode,
	lowerRuntimeFeatures,
} from "./internal/runtime-transformer.ts";
import { createTypeEraser, eraseTypeScriptNode } from "./internal/type-eraser.ts";
import { parseTypeScript } from "./parser.ts";

export interface TransformOptions {
	jsx?: boolean | JSXConfig;
}

export type { JSXConfig, JSXRuntime } from "./internal/jsx-config.ts";

/** Transform erasable TypeScript and supported runtime TypeScript/JSX syntax to JavaScript. */
export function transform(sourceText: string, options: TransformOptions = {}): string {
	assertSourceText(sourceText);
	assertOptions(options);
	const jsx = resolveJSXConfig(options.jsx);
	const sourceFile = parseTypeScript(sourceText, jsx !== null);
	const editTree = createEditTree(sourceText, sourceFile.layout);
	const runtimeFeatures = createRuntimeFeatureCollection({ jsx });
	const typeEraser = createTypeEraser(sourceFile, editTree, "transform");
	walk(sourceFile.ast, {
		enter(node, context) {
			const eraseDescendants = eraseTypeScriptNode(node, context, typeEraser);
			const collectDescendants = collectRuntimeFeatureNode(node, context, runtimeFeatures);
			if (eraseDescendants === false || collectDescendants === false) {
				context.skip();
			}
		},
	});
	const runtimeTree = sealFixedEdits(editTree);
	lowerRuntimeFeatures(sourceFile, runtimeTree, runtimeFeatures);
	return renderEditTree(runtimeTree);
}

/** Erase only fixed-width TypeScript syntax while preserving source length and line layout. */
export function stripTypes(sourceText: string): string {
	assertSourceText(sourceText);
	const sourceFile = parseTypeScript(sourceText, false);
	const editTree = createEditTree(sourceText, sourceFile.layout);
	const typeEraser = createTypeEraser(sourceFile, editTree, "strip");
	walk(sourceFile.ast, {
		enter(node, context) {
			if (eraseTypeScriptNode(node, context, typeEraser) === false) {
				context.skip();
			}
		},
	});
	const runtimeTree = sealFixedEdits(editTree);
	return renderEditTree(runtimeTree);
}

function assertOptions(options: unknown): asserts options is TransformOptions {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		throw new TypeError("transform options must be an object");
	}
	for (const key of Reflect.ownKeys(options)) {
		if (key !== "jsx") {
			throw new TypeError(`transform options contains unknown option ${String(key)}`);
		}
	}
}

function assertSourceText(sourceText: unknown): asserts sourceText is string {
	if (typeof sourceText !== "string") {
		throw new TypeError("sourceText must be a string");
	}
}
