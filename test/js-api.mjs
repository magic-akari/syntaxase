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

	for (const [source, expected] of [
		["function f(){return <number>\n42;} f();", 42],
		["try {throw <number>\n42;} catch(e) {e;}", 42],
		["const f=()=> <any>{value:1}; f().value;", 1],
		["<any>function() {};", undefined],
		["const f=()=> <any><any>{value:2}; f().value;", 2],
		["enum E {A=<number>1} E.A;", 1],
		["const C=<any>class {constructor(public value:number){}}; new C(3).value;", 3],
		["function f(){return <number> /* comment */\r\n42;} f();", 42],
	]) {
		const actual = vm.runInNewContext(transform(source));
		if (expected === undefined) assert.equal(typeof actual, "function", source);
		else assert.equal(actual, expected, source);
	}

	for (const source of [
		"const x = <number>3;",
		"const x = <number>\n3;",
		"const x = <any>{value:1};",
		"function f(){return <number>3;}",
		"const f=()=> <number>3;",
		"const x=(<number>\n3);",
	]) {
		assert.equal(transform(source), stripTypes(source), source);
	}
	for (const [source, expected] of [
		["function f(){return <any><number>\n42;} f();", 42],
		["function f(){return <number>\n40+2;} f();", 42],
		["function* f(){yield <number>\n42;} f().next().value;", 42],
		["const f=()=> <any>{value:2}.value; f();", 2],
		["<any>function(){return 3;}();", 3],
		["<any>class {};", "function"],
	]) {
		const actual = vm.runInNewContext(transform(source));
		assert.equal(expected === "function" ? typeof actual : actual, expected, source);
	}

	for (const [source, expected] of [
		["let E = 7; { enum E { A = 1 } } E;", 7],
		[
			"const values: any[] = []; for (let i = 0; i < 2; i++) { enum E { A = i } values.push(E); } [values[0] === values[1], values[0].A, values[1].A];",
			[false, 0, 1],
		],
		["{ enum E { A = 1 } enum E { B = 2 } [E.A, E.B]; }", [1, 2]],
		["enum E { A = 1 } { enum E { A = 2 } } E.A;", 1],
		["class C {} namespace C { export function f() { return 1; } } C.f();", 1],
		["function C() {} namespace C { export function f() { return 2; } } C.f();", 2],
		["enum E { A = 1 } namespace E { export function f() { return E.A; } } E.f();", 1],
		["namespace N { export class C {} export namespace C { export function f() { return 3; } } } N.C.f();", 3],
		["function f() { enum E { A = 1 } enum E { B = 2 } return E; } f() === f();", false],
	]) {
		const actual = vm.runInNewContext(transform(source));
		assert.equal(JSON.stringify(actual), JSON.stringify(expected), source);
	}

	for (const [source, expected] of [
		["namespace A.B { export function f() { return 1; } } A.B.f();", 1],
		["namespace A.B.C { export function f() { return 2; } } A.B.C.f();", 2],
		[
			"namespace A.B { export function f() { return 1; } } namespace A.B { export function g() { return 2; } } [A.B.f(), A.B.g()];",
			[1, 2],
		],
		[
			"namespace A.B { export function f() { return 1; } } namespace A { export namespace B { export function g() { return 2; } } } [A.B.f(), A.B.g()];",
			[1, 2],
		],
		["namespace N { export namespace A.B { export function f() { return 3; } } } N.A.B.f();", 3],
		["namespace A.A { export function f() { return 4; } } A.A.f();", 4],
		["class A {} namespace A.B { export function f() { return 5; } } A.B.f();", 5],
		["namespace A.B { export class B {} } typeof A.B.B;", "function"],
	]) {
		assert.equal(JSON.stringify(vm.runInNewContext(transform(source))), JSON.stringify(expected), source);
	}

	for (const [source, expected] of [
		['enum E { A="A", B=A } [E.A,E.B];', ["A", "A"]],
		['enum E { A=("A"), B=(A) } [E.A,E.B];', ["A", "A"]],
		['enum E { A="A" } enum E { B=A } [E.A,E.B];', ["A", "A"]],
		["enum E { A=1 } enum E { B=A+1 } E.B;", 2],
		["enum E { A=1 } enum E { B={A}.A+1 } E.B;", 2],
		['enum E { A="A" } enum E { B=`${A}` } [E.A,E.B];', ["A", "A"]],
		["enum E { A=1 } enum E { B=A+1, C=(()=>{var A=4;return A})() } [E.B,E.C];", [2, 4]],
		['enum E { A="A" } enum F { A="A", B=E.A } [F.A,F.B];', ["A", "A"]],
		['enum E { A="A" + "", B=A } [E.A,E.B];', ["A", "A"]],
		["enum E { A=`A`, B=A } [E.A,E.B];", ["A", "A"]],
		['const value="A"; enum E { A=value, B=A } [E.A,E.B];', ["A", "A"]],
		["enum E { A=1 } enum E { B=((A:number)=>A)(3) } E.B;", 3],
		["enum E { A=1 } enum E { B=(()=>{var A=4;return A})() } E.B;", 4],
		["enum E { A=1 } enum E { B=(()=>{const A=5;return A})() } E.B;", 5],
		["enum E { A=1 } enum E { B=(({A}:{A:number})=>A)({A:6}) } E.B;", 6],
		["enum E { A=1 } enum E { B=(():number=>{return {A}.A+1})() } E.B;", 2],
		["enum E { A=1 } enum E { B=(()=>{enum F{C=A+1};return F.C})() } E.B;", 2],
		["enum E { A=1 } { enum E { A=3 } enum E { B=A+1 } E.B; }", 4],
		["let calls=0; function get(){calls++;return 9;} enum E { A=get() } [calls,E.A,E[9]];", [1, 9, "A"]],
		['enum E { A="A" } function f(){const E={A:2};enum F{B=E.A}return [F.B,(F as any)[2]];} f();', [2, "B"]],
		['enum E { "A B" = ("text") } E["A B"];', "text"],
	]) {
		assert.equal(JSON.stringify(vm.runInNewContext(transform(source))), JSON.stringify(expected), source);
	}

	for (const source of [
		"enum E { A=1 } enum E { B=((E:any)=>A)(null) } E.B;",
		"enum E { A=1, B=(()=>{const E=0;enum F{C=A};return F.C})() } E.B;",
	]) {
		assert.equal(vm.runInNewContext(transform(source)), 1);
	}

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
