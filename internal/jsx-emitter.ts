import type {
	JSXAttributeValue,
	JSXElement,
	JSXElementName,
	JSXFragment,
	JSXMemberExpression,
	JSXOpeningElement,
	Node,
} from "@yuku-parser/wasm";
import { syntaxErrorAt } from "./errors.ts";
import { isIdentifierName, isIdentifierReference } from "./identifiers.ts";
import { jsStringLiteral } from "./js-string.ts";
import { jsxConfigRuntimeIdentifierNames, type ResolvedJSXConfig } from "./jsx-config.ts";
import { isIntrinsicJsxName } from "./jsx-names.ts";
import { decodeJsxEntities } from "./jsx-entities.ts";
import {
	claimSuffixedRuntimeName,
	reserveRuntimeName,
	runtimeNameIsUsed,
	type RuntimeNameAllocator,
} from "./runtime-name-allocator.ts";
import {
	appendGenerated,
	appendOriginal,
	appendEditFragment,
	createEditFragment,
	finishEditFragment,
	generatedEditFragment,
	recordEditFragmentLineHead,
	type EditFragment,
} from "./edit-fragment.ts";
import type { SourceLayout } from "./source-layout.ts";
import { sourceCommentsInRange, type SourceFile } from "./source-file.ts";

type AutomaticJSXConfig = Extract<ResolvedJSXConfig, { runtime: "automatic" }>;
type ClassicJSXConfig = Extract<ResolvedJSXConfig, { runtime: "classic" }>;
type LoweredJSXConfig = AutomaticJSXConfig | ClassicJSXConfig;

export type LowerableJsxNode = JSXElement | JSXFragment;

export interface RuntimeImport {
	readonly imported: string;
	readonly local: string;
	readonly source: string;
}

interface EmittedAttribute {
	content: EditFragment;
	isKey: boolean;
	isSpread: boolean;
	keyValue: EditFragment | null;
}

interface EmittedAttributes {
	entries: EmittedAttribute[];
	hasKeyAfterSpread: boolean;
	key: EditFragment | null;
	trailingComments: string;
}

interface EmittedChild {
	content: EditFragment;
	isSpread: boolean;
}

interface EmittedChildren {
	commentsAfterProperties: string;
	values: EmittedChild[];
}

interface JsxEmitterState {
	readonly baseCode: string;
	readonly sourceFile: SourceFile;
	readonly config: LoweredJSXConfig;
	readonly jsxLineHeads: Set<number>;
	readonly jsxNodes: LowerableJsxNode[];
	readonly runtimeNames: RuntimeNameAllocator;
	readonly runtimeImports: Map<string, RuntimeImport>;
}

const jsxEmitterState: unique symbol = Symbol("JsxEmitterState");

export interface JsxEmitterContext {
	readonly [jsxEmitterState]: JsxEmitterState;
}

export function createJsxEmitter(
	baseCode: string,
	sourceFile: SourceFile,
	config: LoweredJSXConfig,
	runtimeNames: RuntimeNameAllocator,
	jsxNodes: readonly LowerableJsxNode[],
): JsxEmitterContext {
	const orderedJsxNodes = [...jsxNodes].sort(compareJsxNodeOrder);
	for (const name of jsxConfigRuntimeIdentifierNames(config)) {
		reserveRuntimeName(runtimeNames, name);
	}
	return {
		[jsxEmitterState]: {
			baseCode,
			sourceFile,
			config,
			jsxLineHeads: collectJsxLineHeads(sourceFile.layout, orderedJsxNodes),
			jsxNodes: orderedJsxNodes,
			runtimeNames,
			runtimeImports: new Map(),
		},
	};
}

export function jsxEmitterNodes(context: JsxEmitterContext): readonly LowerableJsxNode[] {
	return context[jsxEmitterState].jsxNodes;
}

export function outermostJsxNodes(context: JsxEmitterContext): LowerableJsxNode[] {
	const state = context[jsxEmitterState];
	return outermostNodesWithin(state.jsxNodes, 0, state.baseCode.length);
}

export function jsxRuntimeImports(context: JsxEmitterContext): RuntimeImport[] {
	const state = context[jsxEmitterState];
	return [...state.runtimeImports.values()].sort(compareRuntimeImports);
}

function emitJsxExpression(context: JsxEmitterContext, node: Node): EditFragment {
	if (isJsxNode(node)) {
		return emitJsx(context, node);
	}

	const state = context[jsxEmitterState];
	const candidates = outermostNodesWithin(state.jsxNodes, node.start, node.end);
	const nested: LowerableJsxNode[] = [];
	for (const candidate of candidates) {
		nested.push(candidate);
	}
	if (nested.length === 0) {
		return emitPlainRange(context, node.start, node.end);
	}

	const result = createEditFragment();
	let cursor = node.start;
	for (const child of nested) {
		appendEditFragment(result, emitPlainRange(context, cursor, child.start));
		appendEditFragment(result, emitJsx(context, child));
		cursor = child.end;
	}
	appendEditFragment(result, emitPlainRange(context, cursor, node.end));
	return finishEditFragment(result);
}

export function emitJsx(context: JsxEmitterContext, node: LowerableJsxNode): EditFragment {
	const config = context[jsxEmitterState].config;
	if (config.runtime === "classic") {
		return emitClassic(context, node, config);
	}
	return emitAutomatic(context, node, config);
}

function emitPlainRange(_context: JsxEmitterContext, start: number, end: number): EditFragment {
	const result = createEditFragment();
	appendOriginal(result, start, end);
	return finishEditFragment(result);
}

function emitSingleExpression(context: JsxEmitterContext, node: Node): EditFragment {
	const content = emitJsxExpression(context, node);
	if (node.type !== "SequenceExpression") {
		return content;
	}
	const result = createEditFragment();
	appendGenerated(result, "(");
	appendEditFragment(result, content);
	appendGenerated(result, ")");
	return finishEditFragment(result);
}

function emitClassic(context: JsxEmitterContext, node: LowerableJsxNode, config: ClassicJSXConfig): EditFragment {
	const state = context[jsxEmitterState];
	const children = emitChildren(context, node);
	if (node.type === "JSXFragment") {
		const type = generatedEditFragment(config.pragmaFrag);
		const properties = emitClassicProperties([], children.commentsAfterProperties);
		return emitCreateElement(
			node,
			state.jsxLineHeads.has(node.start),
			config.pragma,
			type,
			properties,
			children.values,
		);
	}
	const opening = node.openingElement;
	const type = emitElementType(opening.name, state.baseCode);
	const attributes = emitAttributes(context, opening);
	const trailingComments = `${attributes.trailingComments}${children.commentsAfterProperties}`;
	const properties = emitClassicProperties(attributes.entries, trailingComments);
	return emitCreateElement(
		node,
		state.jsxLineHeads.has(node.start),
		config.pragma,
		type,
		properties,
		children.values,
	);
}

function emitAutomatic(context: JsxEmitterContext, node: LowerableJsxNode, config: AutomaticJSXConfig): EditFragment {
	const state = context[jsxEmitterState];
	const children = emitChildren(context, node);
	if (node.type === "JSXFragment") {
		const fragmentHelper = automaticHelper(context, config, "Fragment");
		const type = generatedEditFragment(fragmentHelper);
		const properties = emitAutomaticProperties([], children, "");
		return emitAutomaticCall(context, node, type, properties, null, children, config);
	}
	const opening = node.openingElement;
	const type = emitElementType(opening.name, state.baseCode);
	const attributes = emitAttributes(context, opening);
	if (attributes.hasKeyAfterSpread) {
		const trailingComments = `${attributes.trailingComments}${children.commentsAfterProperties}`;
		const properties = emitClassicProperties(attributes.entries, trailingComments);
		const createElement = automaticHelper(context, config, "createElement", config.importSource);
		return emitCreateElement(
			node,
			state.jsxLineHeads.has(node.start),
			createElement,
			type,
			properties,
			children.values,
		);
	}

	const propertyAttributes: EmittedAttribute[] = [];
	for (const entry of attributes.entries) {
		if (!entry.isKey) {
			propertyAttributes.push(entry);
		}
	}
	const properties = emitAutomaticProperties(propertyAttributes, children, attributes.trailingComments);
	return emitAutomaticCall(context, node, type, properties, attributes.key, children, config);
}

function emitAutomaticCall(
	context: JsxEmitterContext,
	node: Node,
	type: EditFragment,
	properties: EditFragment,
	key: EditFragment | null,
	children: EmittedChildren,
	config: AutomaticJSXConfig,
): EditFragment {
	const state = context[jsxEmitterState];
	const result = createEditFragment();
	if (state.jsxLineHeads.has(node.start)) {
		recordEditFragmentLineHead(result, node.start);
	}

	let staticChildren = children.values.length > 1;
	for (const child of children.values) {
		staticChildren ||= child.isSpread;
	}
	if (config.development) {
		const jsxDev = automaticHelper(context, config, "jsxDEV");
		appendGenerated(result, `${jsxDev}(`);
		appendEditFragment(result, type);
		appendGenerated(result, ", ");
		appendEditFragment(result, properties);
		appendGenerated(result, ", ");
		appendEditFragment(result, key ?? generatedEditFragment("undefined"));
		appendGenerated(result, `, ${String(staticChildren)})`);
		return finishEditFragment(result);
	}

	const imported = staticChildren ? "jsxs" : "jsx";
	const jsx = automaticHelper(context, config, imported);
	appendGenerated(result, `${jsx}(`);
	appendEditFragment(result, type);
	appendGenerated(result, ", ");
	appendEditFragment(result, properties);
	if (key !== null) {
		appendGenerated(result, ", ");
		appendEditFragment(result, key);
	}
	appendGenerated(result, ")");
	return finishEditFragment(result);
}

function automaticHelper(
	context: JsxEmitterContext,
	config: AutomaticJSXConfig,
	imported: string,
	source?: string,
): string {
	const state = context[jsxEmitterState];
	const runtimeSource = source ?? automaticRuntimeSource(config);
	const key = `${runtimeSource}\0${imported}`;
	const existing = state.runtimeImports.get(key);
	if (existing !== undefined) {
		return existing.local;
	}

	const baseName = `_${imported}`;
	let local = baseName;
	if (runtimeNameIsUsed(state.runtimeNames, local)) {
		local = claimSuffixedRuntimeName(state.runtimeNames, baseName, 2);
	} else {
		reserveRuntimeName(state.runtimeNames, local);
	}
	state.runtimeImports.set(key, { imported, local, source: runtimeSource });
	return local;
}

function automaticRuntimeSource(config: AutomaticJSXConfig): string {
	const suffix = config.development ? "jsx-dev-runtime" : "jsx-runtime";
	return `${config.importSource}/${suffix}`;
}

function emitAttributes(context: JsxEmitterContext, opening: JSXOpeningElement): EmittedAttributes {
	const state = context[jsxEmitterState];
	const attributes = opening.attributes ?? [];
	const entries: EmittedAttribute[] = [];
	const name = opening.name;
	let cursor = name.end;
	let hasSpread = false;
	let hasKeyAfterSpread = false;
	let key: EditFragment | null = null;

	for (const attribute of attributes) {
		const leadingComments = commentsBetween(context, cursor, attribute.start);
		if (attribute.type === "JSXSpreadAttribute") {
			const argument = attribute.argument;
			const insideLeading = commentsBetween(context, attribute.start, argument.start);
			const insideTrailing = commentsBetween(context, argument.end, attribute.end);
			const property = createEditFragment();
			appendGenerated(property, `${leadingComments}...${insideLeading}`);
			appendEditFragment(property, emitSingleExpression(context, argument));
			appendGenerated(property, insideTrailing);
			entries.push({
				content: finishEditFragment(property),
				isKey: false,
				isSpread: true,
				keyValue: null,
			});
			hasSpread = true;
			cursor = attribute.end;
			continue;
		}
		const attributeName = jsxNameText(attribute.name, state.baseCode);
		const value = emitAttributeValue(context, attribute.value);
		const property = createEditFragment();
		appendGenerated(property, `${leadingComments}${jsStringLiteral(attributeName)}: `);
		appendEditFragment(property, value);
		const isKey = attributeName === "key";
		let keyValue: EditFragment | null = null;
		if (isKey) {
			const keyReplacement = createEditFragment();
			appendGenerated(keyReplacement, leadingComments);
			appendEditFragment(keyReplacement, value);
			keyValue = finishEditFragment(keyReplacement);
		}
		entries.push({ content: finishEditFragment(property), isKey, isSpread: false, keyValue });
		if (isKey) {
			key = keyValue;
			hasKeyAfterSpread ||= hasSpread;
		}
		cursor = attribute.end;
	}

	return {
		entries,
		hasKeyAfterSpread,
		key,
		trailingComments: commentsBetween(context, cursor, opening.end),
	};
}

function emitAttributeValue(context: JsxEmitterContext, value: JSXAttributeValue | null): EditFragment {
	if (value === null) {
		return generatedEditFragment("true");
	}
	const node = value;
	if (node.type === "Literal") {
		const text =
			typeof node.value === "string"
				? jsStringLiteral(normalizeJsxAttributeString(decodeJsxEntities(node.value)))
				: JSON.stringify(node.value);
		return generatedEditFragment(text);
	}
	if (node.type === "JSXExpressionContainer") {
		const expression = node.expression;
		if (expression.type === "JSXEmptyExpression") {
			return generatedEditFragment("undefined");
		}
		const leading = commentsBetween(context, node.start, expression.start);
		const trailing = commentsBetween(context, expression.end, node.end);
		const result = createEditFragment();
		appendGenerated(result, leading);
		appendEditFragment(result, emitSingleExpression(context, expression));
		appendGenerated(result, trailing);
		return finishEditFragment(result);
	}
	if (isJsxNode(node)) {
		return emitJsx(context, node);
	}
	return node;
}

function emitChildren(context: JsxEmitterContext, node: LowerableJsxNode): EmittedChildren {
	const state = context[jsxEmitterState];
	const children = node.children ?? [];
	const emitted: EmittedChild[] = [];
	let commentsAfterProperties = "";

	for (const child of children) {
		if (child.type === "JSXText") {
			const text = cleanJsxText(decodeJsxEntities(child.value));
			if (text !== "") {
				emitted.push({
					content: generatedEditFragment(jsStringLiteral(text)),
					isSpread: false,
				});
			}
			continue;
		}
		if (child.type === "JSXExpressionContainer") {
			const expression = child.expression;
			if (expression.type === "JSXEmptyExpression") {
				const comment = state.baseCode.slice(expression.start, expression.end);
				if (comment.trim() !== "") {
					if (emitted.length === 0) {
						commentsAfterProperties += comment;
					} else {
						const previous = emitted[emitted.length - 1]!;
						const content = createEditFragment();
						appendEditFragment(content, previous.content);
						appendGenerated(content, comment);
						emitted[emitted.length - 1] = {
							content: finishEditFragment(content),
							isSpread: previous.isSpread,
						};
					}
				}
			} else {
				emitted.push({
					content: emitChildExpression(context, child, expression),
					isSpread: false,
				});
			}
			continue;
		}
		if (child.type === "JSXSpreadChild") {
			const expression = child.expression;
			emitted.push({
				content: emitChildExpression(context, child, expression),
				isSpread: true,
			});
			continue;
		}
		if (isJsxNode(child)) {
			emitted.push({ content: emitJsx(context, child), isSpread: false });
			continue;
		}
		return child;
	}
	return { values: emitted, commentsAfterProperties };
}

function emitChildExpression(context: JsxEmitterContext, container: Node, expression: Node): EditFragment {
	const leading = commentsBetween(context, container.start, expression.start);
	const trailing = commentsBetween(context, expression.end, container.end);
	const result = createEditFragment();
	appendGenerated(result, leading);
	appendEditFragment(result, emitSingleExpression(context, expression));
	appendGenerated(result, trailing);
	return finishEditFragment(result);
}

function commentsBetween(context: JsxEmitterContext, start: number, end: number): string {
	const state = context[jsxEmitterState];
	return sourceCommentsInRange(state.sourceFile, start, end, false);
}

function emitClassicProperties(entries: readonly EmittedAttribute[], trailingComments: string): EditFragment {
	if (entries.length === 0) {
		return generatedEditFragment(`${trailingComments}null`);
	}
	const properties: EditFragment[] = [];
	for (const entry of entries) {
		properties.push(entry.content);
	}
	return emitObject(properties, trailingComments);
}

function emitAutomaticProperties(
	attributes: readonly EmittedAttribute[],
	children: EmittedChildren,
	trailingComments: string,
): EditFragment {
	const properties: EditFragment[] = [];
	for (const attribute of attributes) {
		properties.push(attribute.content);
	}
	if (children.values.length > 0) {
		const childProperty = createEditFragment();
		appendGenerated(
			childProperty,
			`${trailingComments}${children.commentsAfterProperties}${jsStringLiteral("children")}: `,
		);
		appendEditFragment(childProperty, emitAutomaticChildrenValue(children.values));
		properties.push(finishEditFragment(childProperty));
		return emitObject(properties, "");
	}
	return emitObject(properties, `${trailingComments}${children.commentsAfterProperties}`);
}

function emitAutomaticChildrenValue(children: readonly EmittedChild[]): EditFragment {
	if (children.length === 1 && children[0]!.isSpread === false) {
		return children[0]!.content;
	}

	const result = createEditFragment();
	appendGenerated(result, "[");
	for (let index = 0; index < children.length; index += 1) {
		if (index > 0) {
			appendGenerated(result, ", ");
		}
		const child = children[index]!;
		if (child.isSpread) {
			appendGenerated(result, "...");
		}
		appendEditFragment(result, child.content);
	}
	appendGenerated(result, "]");
	return finishEditFragment(result);
}

function emitObject(properties: readonly EditFragment[], trailingComments: string): EditFragment {
	const result = createEditFragment();
	appendGenerated(result, "{");
	for (let index = 0; index < properties.length; index += 1) {
		if (index > 0) {
			appendGenerated(result, ", ");
		}
		appendEditFragment(result, properties[index]!);
	}
	appendGenerated(result, trailingComments);
	appendGenerated(result, "}");
	return finishEditFragment(result);
}

function emitCreateElement(
	node: Node,
	isLineHead: boolean,
	factory: string,
	type: EditFragment,
	properties: EditFragment,
	children: readonly EmittedChild[],
): EditFragment {
	const result = createEditFragment();
	if (isLineHead) {
		recordEditFragmentLineHead(result, node.start);
	}
	appendGenerated(result, `${factory}(`);
	appendEditFragment(result, type);
	appendGenerated(result, ", ");
	appendEditFragment(result, properties);
	for (const child of children) {
		appendGenerated(result, ", ");
		if (child.isSpread) {
			appendGenerated(result, "...");
		}
		appendEditFragment(result, child.content);
	}
	appendGenerated(result, ")");
	return finishEditFragment(result);
}

function emitElementType(node: JSXElementName, source: string): EditFragment {
	if (node.type === "JSXIdentifier") {
		const name = node.name;
		if (name === "this") {
			return originalContent(node.start, node.end);
		}
		if (isIntrinsicJsxName(name)) {
			return emitStringElementType(name);
		}
		return originalContent(node.start, node.end);
	}
	if (node.type === "JSXMemberExpression") {
		return emitMemberElementType(node);
	}
	return emitStringElementType(jsxNameText(node, source));
}

function emitMemberElementType(node: JSXMemberExpression): EditFragment {
	const object = node.object;
	const property = node.property;
	const result = createEditFragment();

	if (object.type === "JSXMemberExpression") {
		appendEditFragment(result, emitMemberElementType(object));
	} else if (object.type === "JSXIdentifier") {
		const name = object.name;
		if (name !== "this" && !isIdentifierReference(name)) {
			throw syntaxErrorAt(object, "JSX member root must be a JavaScript identifier or this");
		}
		appendOriginal(result, object.start, object.end);
	} else {
		throw syntaxErrorAt(object, "JSX namespace names cannot be used as member roots");
	}

	if (!isIdentifierName(property.name)) {
		throw syntaxErrorAt(property, "JSX member property must be a JavaScript identifier name");
	}
	appendOriginal(result, object.end, node.end);
	return finishEditFragment(result);
}

function emitStringElementType(name: string): EditFragment {
	return generatedEditFragment(jsStringLiteral(name));
}

function originalContent(start: number, end: number): EditFragment {
	const result = createEditFragment();
	appendOriginal(result, start, end);
	return finishEditFragment(result);
}

function jsxNameText(node: JSXElementName, source: string): string {
	if (node.type === "JSXIdentifier") {
		return node.name;
	}
	if (node.type === "JSXNamespacedName") {
		const namespace = jsxNameText(node.namespace, source);
		const name = jsxNameText(node.name, source);
		return `${namespace}:${name}`;
	}
	return source.slice(node.start, node.end);
}

function cleanJsxText(value: string): string {
	const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	let lastNonEmptyLine = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]!.replaceAll("\t", " ").trim() !== "") {
			lastNonEmptyLine = index;
		}
	}

	let result = "";
	for (let index = 0; index < lines.length; index += 1) {
		let line = lines[index]!.replaceAll("\t", " ");
		if (index !== 0) {
			line = line.replace(/^ +/, "");
		}
		if (index !== lines.length - 1) {
			line = line.replace(/ +$/, "");
		}
		if (line !== "") {
			result += line;
			if (index !== lastNonEmptyLine) {
				result += " ";
			}
		}
	}
	return result;
}

function normalizeJsxAttributeString(value: string): string {
	let result = "";
	let cursor = 0;
	while (cursor < value.length) {
		const character = value[cursor]!;
		if (character !== "\n" || !isJavaScriptWhitespace(value[cursor + 1])) {
			result += character;
			cursor += 1;
			continue;
		}

		result += " ";
		cursor += 1;
		while (isJavaScriptWhitespace(value[cursor])) {
			cursor += 1;
		}
	}
	return result;
}

function isJavaScriptWhitespace(character: string | undefined): boolean {
	return character !== undefined && character.trim() === "";
}

function collectJsxLineHeads(lines: SourceLayout, nodes: readonly Node[]): Set<number> {
	const lineHeads = new Set<number>();
	let lineIndex = 0;
	let previousLine = -1;

	for (const node of nodes) {
		while (lineIndex + 1 < lines.length && node.start >= lines[lineIndex]!.end) {
			lineIndex += 1;
		}
		if (lineIndex === previousLine) {
			continue;
		}
		lineHeads.add(node.start);
		previousLine = lineIndex;
	}

	return lineHeads;
}

function outermostNodesWithin(nodes: readonly LowerableJsxNode[], start: number, end: number): LowerableJsxNode[] {
	const result: LowerableJsxNode[] = [];
	let coveredUntil = -1;
	for (let index = jsxNodeIndexAtOrAfter(nodes, start); index < nodes.length; index += 1) {
		const node = nodes[index]!;
		if (node.start >= end) {
			break;
		}
		if (node.end > end) {
			continue;
		}
		if (node.start < coveredUntil) {
			continue;
		}
		result.push(node);
		coveredUntil = node.end;
	}
	return result;
}

function jsxNodeIndexAtOrAfter(nodes: readonly LowerableJsxNode[], offset: number): number {
	let low = 0;
	let high = nodes.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (nodes[middle]!.start >= offset) {
			high = middle;
		} else {
			low = middle + 1;
		}
	}
	return low;
}

function compareJsxNodeOrder(left: Node, right: Node): number {
	return left.start - right.start || right.end - left.end;
}

function compareRuntimeImports(left: RuntimeImport, right: RuntimeImport): number {
	if (left.source !== right.source) {
		return compareCodeUnits(left.source, right.source);
	}
	const leftOrder = runtimeImportOrder(left.imported);
	const rightOrder = runtimeImportOrder(right.imported);
	return leftOrder - rightOrder || compareCodeUnits(left.imported, right.imported);
}

function runtimeImportOrder(imported: string): number {
	switch (imported) {
		case "jsx":
			return 0;
		case "jsxs":
			return 1;
		case "jsxDEV":
			return 2;
		case "Fragment":
			return 3;
		case "createElement":
			return 4;
		default:
			return Number.MAX_SAFE_INTEGER;
	}
}

function compareCodeUnits(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

export function isJsxNode(node: Node): node is LowerableJsxNode {
	return node.type === "JSXElement" || node.type === "JSXFragment";
}
