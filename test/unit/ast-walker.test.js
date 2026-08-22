import assert from "node:assert/strict";
import test from "node:test";

import { createAstVisitor, snapshotNodeContext, walkAst } from "../../internal/ast-walker.js";
import { parseTypeScript } from "../../parser.js";

test("AST visitors prune independently", () => {
	const sourceFile = parseTypeScript("interface Hidden { member: Type; }\nconst visible = () => value;\n", false);
	const runtimeNames = new Set();
	const visibleNames = new Set();

	const visibleVisitor = createAstVisitor(visibleNames, (node, _context, names) => {
		if (node.type === "TSInterfaceDeclaration") {
			return false;
		}
		if (node.type === "Identifier") {
			names.add(node.name);
		}
	});
	const nameVisitor = createAstVisitor(runtimeNames, (node, _context, names) => {
		if (node.type !== "Identifier") {
			return;
		}
		names.add(node.name);
	});

	walkAst(sourceFile.ast, [visibleVisitor, nameVisitor]);

	assert.deepEqual([...visibleNames].sort(), ["value", "visible"]);
	assert.deepEqual([...runtimeNames].sort(), ["Hidden", "Type", "member", "value", "visible"]);
});

test("retained AST contexts are detached snapshots", () => {
	const sourceFile = parseTypeScript("const visible = () => value;\n", false);
	let valueContext = null;
	const visitor = createAstVisitor(undefined, (node, context) => {
		if (node.type === "Identifier" && node.name === "value") {
			valueContext = snapshotNodeContext(context);
		}
	});

	walkAst(sourceFile.ast, [visitor]);

	assert.ok(valueContext);
	assert.equal(valueContext.parent.type, "ArrowFunctionExpression");
	assert.equal(valueContext.key, "body");
	assert.deepEqual(
		valueContext.ancestors.map((ancestor) => ancestor.type),
		["Program", "VariableDeclaration", "VariableDeclarator", "ArrowFunctionExpression"],
	);
});

test("AST traversal discovers children without a node-type registry", () => {
	const sourceFile = parseTypeScript("const value = source;\n", false);
	const wrapper = {
		type: "FutureParserNode",
		start: 0,
		end: sourceFile.text.length,
		payload: sourceFile.ast,
	};
	const names = new Set();

	walkAst(wrapper, [
		createAstVisitor(names, (node, _context, collected) => {
			if (node.type === "Identifier") {
				collected.add(node.name);
			}
		}),
	]);

	assert.deepEqual([...names].sort(), ["source", "value"]);
});
