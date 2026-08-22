import { walkAst } from "./internal/ast-walker.ts";
import { createEditTree, renderEditTree, sealFixedEdits } from "./internal/edit-tree.ts";
import { resolveJSXConfig, type JSXConfig } from "./internal/jsx-config.ts";
import {
	createRuntimeFeatureCollection,
	lowerRuntimeFeatures,
	runtimeFeatureVisitors,
} from "./internal/runtime-transformer.ts";
import { createTypeEraser } from "./internal/type-eraser.ts";
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
	const visitors = [createTypeEraser(sourceFile, editTree, "transform"), ...runtimeFeatureVisitors(runtimeFeatures)];
	walkAst(sourceFile.ast, visitors);
	const runtimeTree = sealFixedEdits(editTree);
	lowerRuntimeFeatures(sourceFile, runtimeTree, runtimeFeatures);
	return renderEditTree(runtimeTree);
}

/** Erase only fixed-width TypeScript syntax while preserving source length and line layout. */
export function stripTypes(sourceText: string): string {
	assertSourceText(sourceText);
	const sourceFile = parseTypeScript(sourceText, false);
	const editTree = createEditTree(sourceText, sourceFile.layout);
	walkAst(sourceFile.ast, [createTypeEraser(sourceFile, editTree, "strip")]);
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
