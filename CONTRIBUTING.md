# Contributing to Syntaxase

Syntaxase is implemented in Zig on Yuku's native parser, AST, token stream, and
walker. Native Zig, Node-API, and WebAssembly use the same transform pipeline.

## Requirements

- [mise](https://mise.jdx.dev/) 2026.7.7 or newer
- A locally installed Chrome for the browser benchmark

Install the complete pinned toolchain and project dependencies:

```sh
mise install
mise run install
```

The repository configuration owns the Node.js, Zig, dprint, and `napi-zig`
versions. npm installs dprint's pinned WebAssembly plugins and JavaScript runtime
dependencies through mise dependency tasks. `mise` owns every development,
test, benchmark, and release entry point. Run `mise tasks` to list them.

## Architecture

Yuku owns parsing, the native AST, UTF-8 source spans, tokens, comments,
diagnostics, and general traversal. Syntaxase works directly on those native
structures; it does not convert to ESTree or serialize an intermediate AST.

The transform pipeline is linear:

1. Parse the source once with Yuku.
2. Walk native nodes to collect type erasures and runtime lowering tasks.
3. Use parser-authoritative tokens for punctuation and edit boundaries.
4. Seal fixed-width edits in original UTF-8 coordinates.
5. Lower runtime TypeScript and JSX into original-span fragments.
6. Render once from the original source.

Internal coordinates are UTF-8 byte offsets. Fixed type erasure preserves the
JavaScript UTF-16 width and physical line layout of the source. Runtime
lowering therefore keeps original spans instead of applying AST offsets to an
intermediate string.

Each public transform uses a scratch arena for the Yuku tree, edit plans,
runtime tasks, fragments, and generated intermediate text. Final code and
copied diagnostics use the caller allocator and outlive the scratch arena.

Yuku diagnostics accompany recovery output. Syntaxase does not add a second
semantic rejection policy.

## Build

Build the native command-line verification shell:

```sh
mise run build
```

Transform standard input:

```sh
printf 'const answer: number = 42;\n' | mise run run
```

The library API in `src/root.zig` is authoritative; the CLI is only a thin
stdin/stdout shell.

Build and test the current platform's Node-API package:

```sh
mise run test:napi
```

## Tests

Run the native, Node-API, and publishable WebAssembly correctness layers:

```sh
mise run test
```

The release-facing layers can also run independently:

```sh
mise run test:zig
mise run test:napi
mise run test:wasm-package
```

To validate the disposable WebAssembly staging output without updating the
publishable package, run:

```sh
mise run test:wasm
```

- Module-level tests live beside their Zig implementation.
- `test/smoke.zig` exercises the public native API.
- `test/integration.zig` checks the committed fixture corpus byte for byte.
- `test/js-api.mjs` defines the shared JavaScript API contract.
- `test/napi.mjs` and `test/wasm.mjs` run that contract against each boundary.

### Integration fixtures

Each directory under `test/integration/cases` contains one `case.json`, one
input, and optionally one committed `output.js`:

```text
case.json
input.ts | input.tsx | input.mts | input.cts
output.js
```

An `output.js` is compared byte for byte. A case without one must declare a
recovery expectation and may record a current Yuku blocker. Recovery cases
exercise diagnostic transport without snapshotting Yuku's wording.

Manual fixtures must name one unique invariant and explain why upstream
coverage is insufficient. Upstream fixtures retain their exact origin,
revision, license, and provenance. Do not remove fixture `LICENSE` or
`PROVENANCE.md` files.

## Node-API

The npm packages follow Yuku's split Node-API/WebAssembly topology. The
Node-API package uses the `napi-zig` main-package/platform-package layout:

```text
npm/syntaxase/
├── index.js
├── index.d.ts
├── binding.js
├── options.js
└── @syntaxase/
    └── binding-<platform>/
        └── package.json
```

`src/ffi/napi.zig` is a thin binding over the shared normalized transform.
`index.js` owns the public `transform` and `stripTypes` API, while generated
`binding.js` selects the installed platform package.

Build only the current platform during development:

```sh
mise run build:local
```

Build every supported platform before publishing:

```sh
mise run build:npm
```

The platform `.node` files are derived artifacts and are not committed. An
Android build additionally requires an Android NDK or a Zig libc file.

## WebAssembly

The WebAssembly package is independent of the Node-API main package and its
platform bindings:

```text
npm/syntaxase-wasm/
├── index.js
├── index.d.ts
├── options.js
└── wasm.js
```

Refresh the publishable synchronous inline WebAssembly package:

```sh
mise run build:wasm
```

Build the same package into the disposable Zig staging directory:

```sh
mise run build:wasm-stage
```

The staged output is installed under `zig-out/wasm`:

```text
index.js
index.d.ts
options.js
wasm.js
```

`wasm.js` contains only the generated Base64 byte module. `index.js`
constructs `WebAssembly.Module` and `WebAssembly.Instance` synchronously, with
no top-level await. The freestanding ABI accepts one contiguous UTF-8 input and
returns one length-prefixed UTF-8 string.

Like Yuku's generated `.wasm` package files, `wasm.js` is a derived release
artifact and is not committed. The publishing CI must run
`mise run build:wasm` before packing `syntaxase-wasm`; packing a clean checkout
directly is not a supported release path.

`src/js/options.js` and `src/js/index.d.ts` are the canonical shared JavaScript
sources. `mise run sync:js` updates their generated copies in both npm
packages; do not edit those copies directly.

The JavaScript API intentionally returns only strings. Yuku recovery
diagnostics remain available through the native Zig API; hard allocation or
internal failures throw at the JavaScript boundary.

## Benchmarks

Install the isolated benchmark dependencies without downloading a browser,
then prepare the pinned corpora:

```sh
mise run bench:prepare
```

Run the native comparison with Oxc:

```sh
mise run bench:native
```

Run the real-browser WebAssembly comparison:

```sh
mise run bench:wasm
```

The browser lane compares Syntaxase with the official Oxc browser package,
Babel, Sucrase, and ts-blank-space where their behavior is comparable.

Gungraun is a separate longitudinal benchmark for Syntaxase itself. Save a
local instruction-count baseline before changing a performance path:

```sh
mise run bench:callgrind:baseline
```

Then compare the working tree against that saved baseline:

```sh
mise run bench:callgrind
```

The benchmark only runs Syntaxase. It loads each corpus before entering the
exported strip function, disables branch and cache simulation, and reports
Callgrind `Ir`. It requires Linux, Valgrind, and `gungraun-runner` 0.19.4.
Treat `Ir` as the primary metric; branch and cache simulation are intentionally
disabled. Pull requests run the base and merge revisions in the same Linux CI
job with the same toolchain and benchmark harness.

Initialization, dependency loading, input I/O, option construction, and warmup
are outside timed regions. Encoding, linear-memory copies, transformation, and
decoding remain inside each timed public WebAssembly call.

Benchmarks are evidence rather than CI thresholds. Compare performance-path
changes with a baseline from the same machine, using identical toolchains,
dependencies, benchmark code, and corpora. A separate worktree keeps the two
builds independent:

```sh
git worktree add ../syntaxase-baseline <baseline-ref>
(cd ../syntaxase-baseline && mise install && mise run bench:prepare)
```

Prepare the current worktree as described above, then alternate current and
baseline runs to reduce thermal and execution-order bias:

```sh
for tree in . ../syntaxase-baseline . ../syntaxase-baseline; do
	(cd "$tree" && mise run bench:native)
done
```

Use `bench:wasm` in the same sequence for WebAssembly changes. Compare the
Syntaxase measurements from each run, record the machine and toolchain, and do
not mix results if the benchmark harness or corpus changed between worktrees.
Remove the baseline when finished with
`git worktree remove ../syntaxase-baseline`.

## Code conventions

- Use `snake_case` for internal Zig functions and methods. The public
  `stripTypes` name intentionally matches the JavaScript API.
- Keep computations linear and ownership explicit.
- Prefer architectural fixes over syntax-specific workarounds.
- Preserve Yuku's native AST and final token stream as the parser boundary.
- Keep source edits in original UTF-8 coordinates.
- Add focused module tests for stable invariants and integration fixtures for
  public output behavior.
- Run `mise run check` and the relevant benchmark before submitting
  a performance-sensitive change.
