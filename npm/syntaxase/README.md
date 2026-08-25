# Syntaxase

Lightning-fast type stripping and JSX lowering.

Named like an enzyme, Syntaxase removes erasable TypeScript syntax and lowers
supported TypeScript and JSX runtime constructs.

## Install

```sh
npm install syntaxase
```

## Usage

```js
import { stripTypes, transform } from "syntaxase";

const stripped = stripTypes(`
interface User { name: string }
const user: User = { name: "Ada" };
`);

const strippedTsx = stripTypes(`const view = <Card<User> user={user as User} />;`, { lang: "tsx" });

const transformed = transform(`const view: JSX.Element = <h1>Hello</h1>;`, { jsx: true });
```

## TypeScript syntax

`stripTypes` erases fixed-width TypeScript syntax while preserving source
length and line layout. Use it with source accepted by TypeScript's
[`erasableSyntaxOnly`](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html)
option. It does not validate that constraint: runtime TypeScript constructs such
as enums may remain unchanged or lose TypeScript-only modifiers without gaining
the JavaScript code needed to preserve their semantics.

By default, `stripTypes` parses TypeScript without JSX. Pass `{ lang: "tsx" }`
to strip TypeScript syntax from TSX while leaving JSX unchanged.

`transform` additionally lowers supported runtime TypeScript constructs and,
when enabled, JSX.

## JSX options

| `options.jsx`              | Behavior                                          | Defaults and supported fields                                   |
| -------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| omitted or `false`         | Parse TypeScript without JSX                      | None                                                            |
| `true`                     | Lower JSX with the automatic production runtime   | `importSource: "react"`                                         |
| `{ runtime: "automatic" }` | Lower JSX with the automatic runtime              | `development: false`, `importSource: "react"`                   |
| `{ runtime: "classic" }`   | Lower JSX to factory calls without adding imports | `pragma: "React.createElement"`, `pragmaFrag: "React.Fragment"` |
| `{ runtime: "preserve" }`  | Parse JSX and leave it in the output              | No additional fields                                            |

Automatic development mode imports `jsxDEV` from
`<importSource>/jsx-dev-runtime`; production mode imports `jsx` and `jsxs` from
`<importSource>/jsx-runtime`. The default therefore requires React's JSX runtime
to be installed. Set `importSource` for another compatible runtime.

`development` is supported only by the automatic runtime. `pragma` and
`pragmaFrag` are supported only by the classic runtime.

## Diagnostics and errors

The JavaScript API returns transformed strings only. Parser recovery diagnostics
are not exposed, so malformed input can still produce output. Use a TypeScript
checker or another parser when validation is required. Invalid API arguments and
internal transform failures throw.
