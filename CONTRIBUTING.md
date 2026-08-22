# Contributing to syntaxase

## Setup and verification

The package and test suite target Node.js 20 and newer. Correctness CI exercises
both the minimum supported major and the current development major.

```sh
npm install
npm run build
npm run typecheck
npm run typecheck:test
npm test
```

`npm run build` emits JavaScript beside the TypeScript sources and declarations
under `types/`. Compiler source maps and declaration maps are intentionally not
generated or published. Do not edit generated JavaScript or declarations by
hand.

Format source and documentation with:

```sh
npm exec -- dprint fmt
npm exec -- dprint check
```

## Architecture rules

The pipeline is:

```text
parse SourceFile once
  -> one shared AST traversal
       -> erase fixed-width TypeScript
       -> collect runtime features and names when transforming
  -> seal EditTree fixed phase
  -> lower runtime features
  -> render JavaScript
```

- `parser.ts` creates the parser-owned `SourceFile`.
- `internal/source-file.ts` owns source, the opaque token index, comments, and
  the shared physical-line layout.
- `internal/ast.ts` types shared node identity and cross-module task nodes;
  feature modules own zero-runtime structural views, while
  `internal/ast-walker.ts` owns automatic structural recursion.
- `internal/type-eraser.ts` owns position-preserving erasure.
- `internal/runtime-transformer.ts` only routes syntax nodes and dispatches
  source-ordered feature tasks.
- `internal/runtime/` owns collection, typed tasks, and lowering for enum,
  namespace, parameter-property, and import-equals syntax.
- `internal/jsx-emitter.ts` owns JSX lowering.
- `internal/edit-tree.ts` owns all edits and phase transitions.

Add syntax to the fixed phase only when erasure preserves UTF-16 width and every
physical line terminator. Runtime syntax belongs in one complete feature
lowerer. Shared classifications belong in a shared module, not as duplicated
feature tests. Do not build a semantic model until a concrete lowering consumes
it.

Treat the configured parser as authoritative. Do not preprocess source, patch
dependency behavior, reflectively walk the AST in a feature, or add token
fallbacks for a parser gap. Use required token locators when an AST discriminant
proves the token exists, and optional locators only when absence is valid. Record
a dependency blocker for missing parser syntax. Internal invariants are
protected with type contracts, focused invariant tests, and integration cases rather
than production validation passes.

## Tests

The suite has four correctness layers:

- `test/smoke/`: three fast public-entry health checks.
- `test/unit/`: project-owned module invariants and compile-only type contracts.
- `test/integration/`: exact public behavior over minimal manual cases and
  pinned upstream inputs.
- `test/tooling/`: fixture and importer infrastructure.

Run integration tests without rewriting results:

```sh
npm run test:integration
```

Only update results for an intentional product behavior change, and always make
the scope explicit:

```sh
npm run fixtures:update -- --all
git diff -- test/integration/cases
```

Preserve existing integration output during unrelated architectural work.
Review every output, error, blocker, metadata, and catalog change before
committing. See [test/README.md](test/README.md) for ownership, import, and result
rules.

## Before submitting

- Keep the change within one architectural owner.
- Add the smallest test that protects the complete behavior class.
- Run `npm test` and `npm exec -- dprint check`.
- Review generated package artifacts and integration fixture diffs.
- Update public and architecture documentation when their contracts change.
