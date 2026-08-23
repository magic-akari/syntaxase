import assert from "node:assert/strict";

export function runApiTests({ stripTypes, transform }, label) {
	assert.equal(transform(""), "");
	assert.equal(transform("const answer: number = 42;\n"), "const answer         = 42;\n");
	assert.equal(
		stripTypes("export type Answer = number;\nexport const answer = 42;\n"),
		"                            \nexport const answer = 42;\n",
	);
	assert.equal(transform('const 名称: string = "🙂";\n'), 'const 名称         = "🙂";\n');
	assert.equal(typeof transform("const value: = 1;\n"), "string");

	assert.equal(
		transform("const element = <div />;\n", { jsx: true }),
		'const element = _jsx("div", {});\n' + 'import { jsx as _jsx } from "react/jsx-runtime";\n',
	);
	assert.equal(
		transform("const element = <div><A /><B /></div>;\n", {
			jsx: {
				runtime: "automatic",
				development: true,
				importSource: "preact",
			},
		}),
		'const element = _jsxDEV("div", {"children": ' +
			"[_jsxDEV(A, {}, undefined, false), _jsxDEV(B, {}, undefined, false)]}, " +
			"undefined, true);\n" +
			'import { jsxDEV as _jsxDEV } from "preact/jsx-dev-runtime";\n',
	);
	assert.equal(
		transform("const element = <UI.Box />;\n", {
			jsx: { runtime: "classic", pragma: "h", pragmaFrag: "Fragment" },
		}),
		"const element = h(UI.Box, null);\n",
	);
	assert.equal(
		transform("const element = <div />;\n", { jsx: { runtime: "preserve" } }),
		"const element = <div />;\n",
	);

	const largeSource = "const value: number = 1;\n".repeat(5_000);
	const largeOutput = "const value         = 1;\n".repeat(5_000);
	for (let index = 0; index < 8; index += 1) {
		assert.equal(transform(largeSource), largeOutput);
	}

	assert.throws(() => transform(null), {
		name: "TypeError",
		message: "sourceText must be a string",
	});
	assert.throws(() => transform("", { unknown: true }), {
		name: "TypeError",
		message: "transform options contains unknown option unknown",
	});
	assert.throws(() => transform("", { jsx: { runtime: "classic", development: true } }), {
		name: "TypeError",
		message: "transform options.jsx.development is not supported with classic runtime",
	});
	assert.throws(() => transform("", { jsx: { runtime: "preserve", development: true } }), {
		name: "TypeError",
		message: "transform options.jsx.development is not supported with preserve runtime",
	});

	console.log(`${label} API tests passed`);
}
