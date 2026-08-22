# Performance tests

Performance is measured separately from correctness. These commands are
non-gating: they produce evidence for a change or release review, never a pass
threshold in `npm test`.

The repository has three focused measurements:

- `benchmark:regression` compares the current public API with another Syntaxase
  build, or records a single-build baseline;
- `benchmark:compare` compares equivalent public work across Syntaxase,
  ts-blank-space, Sucrase, Babel, and OXC;
- `benchmark:edit-tree` isolates wide and deeply nested EditTree composition.

## Reproducible inputs and tools

`corpus.mjs` pins every real-project source by repository commit, byte length,
and SHA-256. `benchmark:prepare` verifies cached inputs and downloads only a
missing pinned file. Timed workers never access the network.

External tools live in the private `benchmark/package.json` and are locked to
exact versions by `benchmark/package-lock.json`. They do not become product or
root development dependencies.

```sh
npm ci
npm ci --prefix benchmark --ignore-scripts
npm run benchmark:prepare
```

## Corpus and comparison lanes

| Case                | Lane       | Public work                          | Size      |
| ------------------- | ---------- | ------------------------------------ | --------- |
| `hono-types`        | erase      | TypeScript erasure                   | 76.1 KiB  |
| `vue-errors`        | TypeScript | TypeScript plus runtime lowering     | 8.2 KiB   |
| `typescript-binder` | TypeScript | TypeScript plus runtime lowering     | 189.9 KiB |
| `typescript-parser` | TypeScript | TypeScript plus runtime lowering     | 527.0 KiB |
| `react-router-tsx`  | TSX        | TypeScript and automatic-runtime JSX | 102.5 KiB |

The erase lane compares `stripTypes` with ts-blank-space. TypeScript and TSX
lanes compare `transform` with Sucrase, Babel, and OXC using modern-JavaScript
targets and no source maps. Sucrase 3.35.1 rejects valid syntax in the pinned
TypeScript parser corpus, so that single implementation/corpus pair is recorded
as an explicit exclusion instead of being timed on different input.

Each implementation's output is checked independently for determinism and
parseable JavaScript. Cross-tool byte equality is intentionally not required:
the tools make different formatting and lowering choices.

## Cross-tool comparison

```sh
npm run benchmark:compare
```

Limit an exploratory run to one or more pinned entries:

```sh
npm run benchmark:compare -- \
  --case hono-types \
  --case vue-errors
```

One cycle executes a complete rotation for each scenario, placing every
eligible implementation in every order position. Every implementation/corpus
measurement runs in a fresh worker. The summary uses same-rotation ratios paired
to Syntaxase, reports median and median absolute deviation per corpus, and has no
cross-corpus aggregate.

For a longer release measurement:

```sh
npm run benchmark:compare -- \
  --cycles 2 --samples 10 --sample-ms 200 --warmup-ms 1000
```

Pass `--json` for the environment, dependency-lock and Syntaxase runtime
fingerprints, execution orders, raw samples, per-corpus summaries, and
exclusions. Use npm's silent mode when stdout
must contain only JSON:

```sh
npm run --silent benchmark:compare -- --json > benchmark-results.json
```

## Syntaxase regression comparison

Record the current build:

```sh
npm run benchmark:regression
```

Compare independently built worktrees:

```sh
npm run benchmark:regression -- \
  --baseline /path/to/baseline/index.js \
  --candidate /path/to/candidate/index.js
```

Regression comparison requires exact output fingerprints because both targets
implement the same Syntaxase contract. It balances baseline/candidate AB and BA
order and reports a paired delta for each corpus without an aggregate score.
`npm run benchmark` is an alias for this regression lane.

## EditTree shapes

The focused structural benchmark exercises many sibling replacements in one
parent and one deeply nested replacement chain:

```sh
npm run benchmark:edit-tree
npm run benchmark:edit-tree -- /path/to/baseline
```

## Measurement boundary

Module loading, corpus I/O and verification, adapter option construction,
correctness preflight, warmup, initial forced garbage collection, and reporting
are outside timed regions. Each sample measures the complete synchronous public
transform call, including parsing, traversal, lowering, and rendering.

Outputs are generated twice before timing, parsed with Acorn, fingerprinted,
and generated once more afterward to detect state-dependent behavior. Every
result reports latency, throughput, and dispersion for its own corpus. Results
from different files are never collapsed into a synthetic score.
