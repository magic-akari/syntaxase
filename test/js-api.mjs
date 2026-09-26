import assert from "node:assert/strict";
import vm from "node:vm";

export function runApiTests({ stripTypes, transform }, label) {
	assert.equal(transform(""), "");
	assert.equal(transform("const answer: number = 42;\n"), "const answer         = 42;\n");
	assert.equal(
		stripTypes("export type Answer = number;\nexport const answer = 42;\n"),
		";                           \nexport const answer = 42;\n",
	);
	assert.equal(
		stripTypes("const element = <Component<Type> value={input as Type} />;\n", { lang: "tsx" }),
		"const element = <Component       value={input        } />;\n",
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
			"[_jsxDEV(A, {}, void 0, false), _jsxDEV(B, {}, void 0, false)]}, " +
			"void 0, true);\n" +
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

	const classic = { jsx: { runtime: "classic" } };
	const React = { createElement: (_tag, _props, ...children) => children };
	for (const [source, expected] of [
		["<div>a&#10;b</div>", ["a\nb"]],
		["<div>&#32;&#10;&#32;</div>", [" \n "]],
		["<div>\n  first\n  second\n</div>", ["first second"]],
		["<div>&#9;&#13;{42}&#32;</div>", ["\t\r", 42, " "]],
	]) {
		const actual = vm.runInNewContext(transform(source, classic), { React });
		assert.deepEqual(actual, expected);
	}
	const devCode = transform("function f(undefined: any) { return <div />; } f(123);", {
		jsx: { runtime: "automatic", development: true },
	});
	const devExecutable = devCode.replace(/^import .* from "react\/jsx-dev-runtime";\n?/m, "");
	assert.equal(vm.runInNewContext(devExecutable, { _jsxDEV: (_tag, _props, key) => key }), undefined);

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
	assert.throws(() => stripTypes("", { lang: "jsx" }), {
		name: "TypeError",
		message: 'stripTypes options.lang must be "ts" or "tsx"',
	});
	assert.throws(() => stripTypes("", { unknown: true }), {
		name: "TypeError",
		message: "stripTypes options contains unknown option unknown",
	});

	console.log(`${label} API tests passed`);
}
