import assert from "node:assert/strict";
import test from "node:test";
import { walk } from "yuku-ast";
import { parseTypeScript } from "../../parser.js";

test("Yuku AST visitors use native typed traversal and pruning", () => {
	const sourceFile = parseTypeScript("interface Hidden { member: Type; }\nconst visible = () => value;\n", false);
	const visibleNames = new Set();

	walk(sourceFile.ast, {
		TSInterfaceDeclaration(_node, context) {
			context.skip();
		},
		Identifier(node) {
			visibleNames.add(node.name);
		},
	});

	assert.deepEqual([...visibleNames].sort(), ["value", "visible"]);
});

test("Yuku walk contexts expose native parent, key, and ancestors", () => {
	const sourceFile = parseTypeScript("const visible = () => value;\n", false);
	let valueContext = null;
	walk(sourceFile.ast, {
		Identifier(node, context) {
			if (node.name !== "value") {
				return;
			}
			valueContext = {
				parent: context.parent,
				key: context.key,
				ancestors: context.ancestors(),
			};
		},
	});

	assert.ok(valueContext);
	assert.equal(valueContext.parent.type, "ArrowFunctionExpression");
	assert.equal(valueContext.key, "body");
	assert.deepEqual(
		valueContext.ancestors.map((ancestor) => ancestor.type),
		["Program", "VariableDeclaration", "VariableDeclarator", "ArrowFunctionExpression"],
	);
});
