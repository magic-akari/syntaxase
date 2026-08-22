# syntaxase

Fast, layout-conscious TypeScript and JSX lowering for modern ESM toolchains.

Syntaxase parses each source string once, erases TypeScript syntax, and lowers the
small set of TypeScript and JSX constructs that require JavaScript output. It
returns JavaScript directly; it does not produce source maps, filename-derived
metadata, or React `displayName` assignments.

## Installation

```sh
npm install syntaxase
```

## API

### `stripTypes(sourceText)`

Use `stripTypes` when the input contains only erasable TypeScript syntax:

```js
import { stripTypes } from "syntaxase";

const code = stripTypes("export const answer: number = 42;\n");
```

The returned string has the same UTF-16 width and physical line terminators as
the input. Syntax that needs runtime JavaScript, such as enums, instantiated
namespaces, parameter properties, and import assignments, is rejected.

### `transform(sourceText, options?)`

Use `transform` when runtime lowering or JSX is required:

```js
import { transform } from "syntaxase";

const code = transform(`
	export enum Status {
		Ready,
		Done,
	}
`);
```

The result is a string. Runtime output is placed on or around the original
physical source lines whenever the lowering permits it, so existing line-based
diagnostics remain useful without generating a source map.

Import assignments keep the project-specific ESM behavior:

```ts
import dependency = require("dependency");
```

becomes:

```js
const dependency = import.sync("dependency");
```

Qualified aliases such as `import value = Namespace.value` become ordinary
`const` aliases.

## JSX

`jsx: true` selects the automatic production runtime:

```js
const code = transform("export const View = () => <main />;", { jsx: true });
```

The JSX configuration is discriminated by runtime:

```ts
interface TransformOptions {
	jsx?: boolean | JSXConfig;
}

type JSXConfig =
	| {
			runtime?: "automatic";
			development?: boolean;
			importSource?: string;
	  }
	| {
			runtime: "classic";
			development?: boolean;
			pragma?: string;
			pragmaFrag?: string;
	  }
	| {
			runtime: "preserve";
	  };
```

```js
const development = transform(source, {
	jsx: { development: true },
});

const preact = transform(source, {
	jsx: { importSource: "preact" },
});

const classic = transform(source, {
	jsx: {
		runtime: "classic",
		pragma: "h",
		pragmaFrag: "Fragment",
	},
});

const preserved = transform(source, {
	jsx: { runtime: "preserve" },
});
```

For the automatic runtime, `development` selects `jsxDEV` and the package's
`jsx-dev-runtime`. Classic configuration may carry the same field, but Syntaxase
does not read it and produces identical classic output for either value. It does
not implement the legacy classic `__source`/`__self` transform, so no source
filename option is needed.

## Product boundary

Syntaxase parses with Yuku WASM and consumes the native Yuku AST through
`yuku-ast`; it does not normalize the tree into another parser's shape.
Syntaxase preserves modern JavaScript and ESM syntax. It does not patch parser
dependencies, emulate unrelated Babel/Sucrase transforms, provide compatibility
aliases for pre-release APIs, infer React display names, or generate source
maps. Unsupported parser syntax is tracked as an upstream dependency blocker
instead of being recovered with token-level guesses.

## Acknowledgements

Special thanks to [Sucrase](https://github.com/alangpierce/sucrase) and
[ts-blank-space](https://github.com/bloomberg/ts-blank-space) for the ideas that
inspired Syntaxase; to [Yuku](https://github.com/yuku-toolchain/yuku) for serving
as the project's foundation; and to
[@sveltejs/acorn-typescript](https://github.com/sveltejs/acorn-typescript), which
powered the original prototype.
