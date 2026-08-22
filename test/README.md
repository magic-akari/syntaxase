# Test architecture

The suite is intentionally split by ownership and failure speed. A normal test
run is read-only: it never downloads upstream repositories and never rewrites a
committed result.

```text
test/
  smoke/                 public entry-point health
  unit/                  project-owned module invariants
    type-contracts/      compile-only boundary contracts
  integration/
    cases/manual/        minimal project-owned behavior cases
    cases/upstream/      generated inputs from pinned projects
    importers/           upstream discovery and planning
  tooling/               tests for fixture and importer infrastructure
```

## Layer responsibilities

Smoke tests prove only that the built package exports the supported API and
that one `stripTypes` call and one runtime/JSX `transform` call produce
parseable JavaScript. They must remain small enough to diagnose a broken build
or public entry point immediately.

Unit tests sit at project-owned module boundaries. Each test owns one invariant;
overlapping examples should be consolidated into a table or replaced by the
stronger boundary assertion. Compile-only tests under `unit/type-contracts/`
protect ownership and phase types without adding runtime cases.

Integration tests invoke only this checkout's public API. They cover the small
manual set and every selected upstream workload using committed inputs and
results. Exact output is appropriate here because layout is part of the product
contract.

Tooling tests exercise import planning, fixture updating, fail-closed discovery,
and a temporary pinned Git repository. They do not add product behavior
coverage.

Performance tests live under `benchmark/`, outside the correctness suite. See
[benchmark/README.md](../benchmark/README.md).

## Integration fixture contract

Every case directory contains:

- exactly one input: `input.ts`, `input.tsx`, `input.cts`, or `input.mts`;
- one `case.json` containing the public operation, options, ownership, and
  provenance;
- exactly one result: `output.js`, `error.txt`, or `blocker.json`.

There are no derived whitespace views or separate origin/options sidecars.
Whitespace becomes visible only in a failing assertion, keeping the repository
source of truth singular.

`output.js` is compared byte-for-byte. For `stripTypes`, the harness also
asserts the public width and physical-line-terminator invariants.

`error.txt` is deliberately human-readable and stable:

```text
SyntaxError: message
```

It contains no stack or machine-specific path. The runner reads it only as the
committed expected result; there is no JSON error object to reconstruct later.

`blocker.json` is the one machine-readable outcome. Blocker policy lives in
`case.json.blocker`; `blocker.json` records the currently observed output or
error. A changed observation fails instead of being silently refreshed. When
the actual result reaches the blocker's declared resolution kind, the test
reports XPASS and the blocker must be removed deliberately.

For an unconfigured `input.tsx`, the harness applies the effective public option
`{ jsx: true }`. `stripTypes` cases cannot declare transform options.

## Manual cases

Manual fixtures are reserved for product-owned decisions or regressions that
are not represented cleanly upstream. Each `case.json` must provide a unique
`invariant` and a `whyManual` explanation. The harness rejects duplicate manual
invariants and duplicate effective public invocations across the entire
integration tree.

The manual set is expected to remain small. Prefer a focused unit invariant for
an internal boundary and a pinned upstream case for compatibility behavior.

## Upstream cases

`integration/upstream/config.json` pins repository, version, commit, operation,
scope exclusions, and blockers for:

- Sucrase's supported TypeScript and JSX tests;
- ts-blank-space's string-to-string fixtures and tests;
- TypeScript's official `erasableSyntaxOnly` compiler cases.

The TypeScript adapter uses the compiler harness's `@filename` virtual file as
its case boundary. It never slices one virtual file by statement or diagnostic
line. At the pinned TypeScript 7.0.2 commit this yields four runtime-source
workloads; declaration virtual files remain outside the single-source runtime
API.

Adapters inventory their selected upstream surface and fail when a new test
shape is not imported or explicitly classified. Durable out-of-scope suites use
`sourceExclusions`; temporary dependency or product gaps remain executable
`blockers`.

Planning deduplicates an exact workload by:

```text
public operation + canonical effective options + input bytes
```

All identities and origins are merged into the retained case. Deduplication is
also enforced across projects and manual fixtures, so execution count reflects
unique public calls rather than upstream naming.

Generated `CATALOG.json` files record the pinned inventory, merged provenance,
content fingerprints, and importer implementation hash. Normal CI validates
them without an upstream checkout.

## Syncing pinned inputs

The importer requires clean checkouts at the exact configured commits. It is
read-only unless `--write` is explicit:

```sh
npm run fixtures:sync -- \
  --checkout sucrase-3.35.1=/path/to/sucrase \
  --checkout ts-blank-space-0.9.0=/path/to/ts-blank-space \
  --checkout typescript-7.0.2=/path/to/TypeScript
```

Add `--write` to replace generated inputs, case metadata, and catalogs. The
importer never writes integration results and never executes an upstream
transformer.

## Reviewing local results

Result changes are always explicit. Update all cases or named case IDs:

```sh
npm run fixtures:update -- --all
npm run fixtures:update -- --case manual/transform/example
```

Then review the complete diff under `test/integration/cases/`. A blocker
observation cannot be updated by this command; it requires a manual review.

Verify committed results without writing:

```sh
npm run fixtures:verify
npm test
```

`npm test` runs smoke, unit, integration, and tooling layers. The fixture
verification command additionally proves that the explicit updater would make
no changes.
