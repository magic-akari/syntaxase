# Syntaxase

Lightning-fast type stripping and JSX lowering.

Named like an enzyme, Syntaxase removes erasable TypeScript syntax and lowers supported TypeScript and JSX runtime constructs.

## Install

```sh
npm install syntaxase
```

For WebAssembly environments, install the separately published package:

```sh
npm install syntaxase-wasm
```

## Usage

```js
import { stripTypes, transform } from "syntaxase";

const stripped = stripTypes(`
interface User { name: string }
const user: User = { name: "Ada" };
`);

const strippedTsx = stripTypes(`const view = <Card<User> user={user as User} />;`, { lang: "tsx" });

const transformed = transform(`const view: JSX.Element = <h1>Hello</h1>;`, {
	jsx: true,
});
```

Use the same named exports from `syntaxase-wasm` when targeting WebAssembly.

## API notes

- `stripTypes` performs fixed-width erasure while preserving source length and line layout. Pass `{ lang: "tsx" }` to parse TSX while preserving JSX unchanged. Use it with source accepted by TypeScript's [`erasableSyntaxOnly`](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html) option.
- `transform` additionally lowers supported runtime TypeScript constructs and optional JSX. `{ jsx: true }` uses React's automatic production runtime.
- The JavaScript packages return strings, not parser diagnostics. Use a TypeScript checker or another parser when validation is required.

## Acknowledgements

Special thanks to [Sucrase](https://github.com/alangpierce/sucrase) and [ts-blank-space](https://github.com/bloomberg/ts-blank-space) for the ideas that inspired Syntaxase; to [Yuku](https://github.com/yuku-toolchain/yuku) for serving as the project's foundation; and to [@sveltejs/acorn-typescript](https://github.com/sveltejs/acorn-typescript), which powered the original prototype.

See the [`syntaxase` package documentation](npm/syntaxase/README.md) for all JSX options and defaults. See [CONTRIBUTING.md](CONTRIBUTING.md) to work on Syntaxase itself.
