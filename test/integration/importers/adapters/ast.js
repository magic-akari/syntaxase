import { tsPlugin } from "@sveltejs/acorn-typescript";
import { Parser } from "acorn";

const TypeScriptParser = Parser.extend(tsPlugin());

export class StaticEvaluationError extends Error {
	constructor(message, node) {
		super(message);
		this.name = "StaticEvaluationError";
		this.node = node;
	}
}

export function parseTypeScriptModule(sourceText, sourcePath) {
	try {
		return TypeScriptParser.parse(sourceText, {
			ecmaVersion: "latest",
			locations: true,
			sourceFile: sourcePath,
			sourceType: "module",
		});
	} catch (error) {
		throw new SyntaxError(`Unable to parse upstream test ${sourcePath}: ${error.message}`, { cause: error });
	}
}

export function createAstIndex(ast) {
	const parents = new Map();
	const variableDeclarations = [];

	walkAst(ast, (node, parent) => {
		if (parent !== null) {
			parents.set(node, parent);
		}
		if (
			node.type === "VariableDeclarator" &&
			node.id?.type === "Identifier" &&
			node.init !== null &&
			parent?.type === "VariableDeclaration" &&
			parent.kind === "const"
		) {
			variableDeclarations.push(node);
		}
	});

	return {
		parentOf(node) {
			return parents.get(node) ?? null;
		},
		resolveVariable(name, beforeOffset) {
			let result = null;
			for (const declaration of variableDeclarations) {
				if (declaration.start >= beforeOffset || declaration.id.name !== name) {
					continue;
				}
				if (result === null || declaration.start > result.start) {
					result = declaration;
				}
			}
			return result;
		},
	};
}

export function walkAst(root, visit, { skip } = {}) {
	function walk(node, parent) {
		if (!isNode(node)) {
			return;
		}
		visit(node, parent);
		if (skip?.(node, parent) === true) {
			return;
		}

		for (const [key, value] of Object.entries(node)) {
			if (key === "loc" || key === "start" || key === "end") {
				continue;
			}
			if (Array.isArray(value)) {
				for (const child of value) {
					walk(child, node);
				}
				continue;
			}
			walk(value, node);
		}
	}

	walk(root, null);
}

export function collectAst(root, predicate, options) {
	const nodes = [];
	walkAst(
		root,
		(node, parent) => {
			if (predicate(node, parent)) {
				nodes.push(node);
			}
		},
		options,
	);
	return nodes;
}

export function validateSourceCensus({ project, sourcePaths, knownSourcePaths, isTestSource }) {
	if (!Array.isArray(sourcePaths) || !(knownSourcePaths instanceof Set) || typeof isTestSource !== "function") {
		throw new TypeError("Source census requires sourcePaths, knownSourcePaths, and isTestSource");
	}
	const testSourcePaths = new Set(sourcePaths.filter(isTestSource));
	const excludedSourcePaths = new Map();
	for (const exclusion of project.sourceExclusions ?? []) {
		if (!testSourcePaths.has(exclusion.path)) {
			throw new Error(`${project.id} source exclusion does not match a test source: ${exclusion.path}`);
		}
		if (knownSourcePaths.has(exclusion.path)) {
			throw new Error(
				`${project.id} source exclusion redundantly excludes an imported source: ${exclusion.path}`,
			);
		}
		if (excludedSourcePaths.has(exclusion.path)) {
			throw new Error(`${project.id} has duplicate source exclusion ${exclusion.path}`);
		}
		excludedSourcePaths.set(exclusion.path, exclusion.reason);
	}

	for (const sourcePath of knownSourcePaths) {
		if (!testSourcePaths.has(sourcePath)) {
			throw new Error(`${project.id} expected test source is missing from the pinned tree: ${sourcePath}`);
		}
	}
	for (const sourcePath of testSourcePaths) {
		if (!knownSourcePaths.has(sourcePath) && !excludedSourcePaths.has(sourcePath)) {
			throw new Error(
				`${project.id} has an unclassified test source ${sourcePath}; import it or add justified sourceExclusions metadata`,
			);
		}
	}

	return {
		excluded: [...excludedSourcePaths].map(([sourcePath, reason]) => ({ path: sourcePath, reason })),
		imported: [...knownSourcePaths].sort(compareCodeUnits),
		total: testSourcePaths.size,
	};
}

export function evaluateStatic(node, { bindings = new Map(), resolveVariable } = {}) {
	const extraction = [];
	const value = evaluate(node, bindings, extraction, resolveVariable);
	return { extraction, value };
}

function evaluate(node, bindings, extraction, resolveVariable) {
	if (!isNode(node)) {
		throw new StaticEvaluationError("Missing static expression", node);
	}

	if (node.type === "Literal") {
		if (
			typeof node.value !== "string" &&
			typeof node.value !== "number" &&
			typeof node.value !== "boolean" &&
			node.value !== null
		) {
			throw new StaticEvaluationError(`Unsupported literal value ${String(node.value)}`, node);
		}
		extraction.push("literal");
		return node.value;
	}

	if (node.type === "TemplateLiteral") {
		let result = node.quasis[0]?.value.cooked;
		if (typeof result !== "string") {
			throw new StaticEvaluationError("Template literal has no cooked value", node);
		}
		extraction.push(node.expressions.length === 0 ? "template-literal" : "static-template-literal");
		for (let index = 0; index < node.expressions.length; index += 1) {
			const expression = evaluate(node.expressions[index], bindings, extraction, resolveVariable);
			const quasi = node.quasis[index + 1]?.value.cooked;
			if (typeof quasi !== "string") {
				throw new StaticEvaluationError("Template literal has no cooked value", node);
			}
			result += String(expression);
			result += quasi;
		}
		return result;
	}

	if (node.type === "Identifier") {
		if (bindings.has(node.name)) {
			extraction.push(`binding:${node.name}`);
			return bindings.get(node.name);
		}
		const declaration = resolveVariable?.(node.name, node.start) ?? null;
		if (declaration === null || declaration.init === null) {
			throw new StaticEvaluationError(`Unresolved identifier ${node.name}`, node);
		}
		extraction.push(`const:${node.name}`);
		return evaluate(declaration.init, bindings, extraction, resolveVariable);
	}

	if (node.type === "ArrayExpression") {
		extraction.push("static-array");
		const result = [];
		for (const element of node.elements) {
			if (element === null || element.type === "SpreadElement") {
				throw new StaticEvaluationError("Sparse and spread arrays are not statically supported", node);
			}
			result.push(evaluate(element, bindings, extraction, resolveVariable));
		}
		return result;
	}

	if (node.type === "ObjectExpression") {
		extraction.push("static-object");
		const result = Object.create(null);
		for (const property of node.properties) {
			if (property.type !== "Property" || property.kind !== "init" || property.computed || property.method) {
				throw new StaticEvaluationError("Only static object properties are supported", property);
			}
			const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
			if (typeof key !== "string" && typeof key !== "number") {
				throw new StaticEvaluationError("Unsupported static object key", property.key);
			}
			result[key] = evaluate(property.value, bindings, extraction, resolveVariable);
		}
		return result;
	}

	if (isStaticJoinCall(node)) {
		extraction.push("Array.join");
		const values = evaluate(node.callee.object, bindings, extraction, resolveVariable);
		if (!Array.isArray(values)) {
			throw new StaticEvaluationError("Array.join receiver is not a static array", node.callee.object);
		}
		if (node.arguments.length > 1 || node.arguments[0]?.type === "SpreadElement") {
			throw new StaticEvaluationError("Unsupported Array.join arguments", node);
		}
		const separator =
			node.arguments.length === 0 ? "," : evaluate(node.arguments[0], bindings, extraction, resolveVariable);
		return values.join(String(separator));
	}

	throw new StaticEvaluationError(`Unsupported static expression ${node.type}`, node);
}

function isStaticJoinCall(node) {
	return (
		node.type === "CallExpression" &&
		node.optional !== true &&
		node.callee?.type === "MemberExpression" &&
		node.callee.computed === false &&
		node.callee.optional !== true &&
		node.callee.property?.type === "Identifier" &&
		node.callee.property.name === "join"
	);
}

function compareCodeUnits(left, right) {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

function isNode(value) {
	return value !== null && typeof value === "object" && typeof value.type === "string";
}
