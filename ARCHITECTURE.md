# Architecture

Syntaxase is a single parse followed by two edit phases:

```text
source text
  -> SourceFile (AST + token index + comments + physical-line layout)
  -> one shared AST traversal
       -> fixed-width type erasure
       -> runtime feature, JSX, and identifier collection
  -> seal fixed edits
  -> runtime feature lowerers
  -> render EditTree
  -> JavaScript string
```

`index.ts` owns this sequence. There are no reusable parser objects, result
wrappers, filename-dependent transforms, source-map output, or post-render
validation passes.

## Source model

`parser.ts` creates one `SourceFile`. It owns the source text, Acorn AST,
comments, an opaque token index, and one physical-line layout shared with the
EditTree and JSX emitter. Raw tokens have no second owner. Comment and JSX range
queries binary-search their already source-ordered parser data rather than
building feature-local indexes. `SourceFile` does not precompute a semantic
graph or retain a second node index.

`internal/ast.ts` exposes only shared parser-node identity and the typed task
nodes used across module boundaries. Each feature owns a compile-time-only view
of the additional parser fields it consumes. `internal/ast-walker.ts` discovers
enumerable node-shaped children from the trusted, acyclic parser AST, so neither
the shared node type nor structural recursion duplicates the parser's complete
schema. Feature visitors select only the node types they consume. One walk can
drive multiple visitors, and each visitor prunes its own view of a subtree
without suppressing the others. Context ancestors are ephemeral traversal
state; feature collectors retain only the context required by their typed tasks.
A `stripTypes` call installs only the type-erasure visitor. A `transform` call
installs type erasure, runtime feature collection, and conservative identifier
collection on the same structural walk.

The parser AST remains the syntax authority. Syntax whose AST discriminant
guarantees a token uses a required token locator and reports an internal parser
invariant when that token is absent. Optional token locators are reserved for
syntax whose absence is valid. Feature code may not guess a missing AST
relationship or compensate for unsupported parser syntax. Parser gaps belong in
the upstream blocker inventory.

## Lowering boundaries

- `internal/type-eraser.ts` owns all fixed-width TypeScript edits, including the
  fixed-width portions of enum, namespace, and parameter-property syntax.
- `internal/runtime-transformer.ts` owns only the static node-type router,
  source-ordered task dispatch, and automatic JSX import placement.
- `internal/runtime/enum.ts`, `namespace.ts`, `parameter-properties.ts`, and
  `import-equals.ts` each own collection rules, typed task data, and generated
  JavaScript for one runtime feature. They deliberately compose with the fixed
  edits above rather than editing the same source range twice.
- `internal/jsx-emitter.ts` owns JSX classification and emission; the runtime
  collector supplies the nodes found by the shared structural walk.
- `internal/source-file.ts` owns shared source, token, and comment services.
  Feature modules do not keep private comment-ownership sets.
- `internal/namespace-semantics.ts` memoizes only the runtime-state fact consumed
  by namespace lowering, using weak AST-node keys instead of a general semantic
  model.

`import x = require("x")` intentionally lowers to `import.sync`, while qualified
import aliases lower to `const` aliases. This is product behavior rather than an
upstream compatibility patch.

## One edit owner

`EditTree<"fixed" | "runtime">` is the only aggregate transformation state.
Its materialized phase marker rejects wrong-phase calls from JavaScript as well
as TypeScript, and sealing closes the fixed builder against later writes or
double sealing. `sealFixedEdits` does not create a parallel edit plan: it
snapshots normalized fixed edits into the separately owned runtime phase.
`baseCode` is materialized lazily only when runtime lowering needs it.

Feature emitters can build an `EditFragment` containing generated text and
references to original source spans. A fragment is content owned by an EditTree
replacement, not another edit plan. Completed fragments are opaque and can only
come from fragment builders and factories. Original spans allow nested lowerers
to compose without diffing generated strings; enum, JSX, and identifier edits
can therefore form one nested replacement tree without calling across feature
boundaries. The private renderer receives final normalized range/point edits and
materializes them in one linear pass. It has no `EditProgram`, mutable renderer
state, final provenance output, or source-map data.

Runtime replacements are sorted into a containment forest. Composition streams
that forest directly into one final fragment builder: every node scans only its
own fragment, child boundaries advance monotonically through retained source
spans, and line heads are projected once. Nested children are never folded into
repeatedly copied intermediate fragment arrays.

## Trusted invariants

Correctness is established by construction and tests, not by an extra
production verification pass:

1. Every edit uses UTF-16 offsets in the original source.
2. Fixed erasure preserves width and physical line terminators.
3. Sealing fixed edits preserves every original offset for runtime lowerers.
4. A fixed substitution is one of the syntax-safety code units represented by
   `FixedSubstitution`.
5. Runtime replacement ranges are disjoint or properly nested; retained source
   spans stay ordered and inside their containing range, every nested boundary
   is represented by parent provenance, and fragment line heads are recorded in
   output order.
6. Feature lowerers exclusively own their generated JavaScript. Fixed-width
   portions of runtime syntax remain owned by the type eraser, and all edits use
   original coordinates.
7. Runtime name allocation starts from parser identifiers and never falls back
   to token-string guessing.
8. Rendering is deterministic and does not mutate the EditTree.

Compile-only contracts under `test/unit/type-contracts` protect phase and feature
boundaries. `test/unit/ast-walker.test.js` protects independent visitor pruning and
context snapshots.
`test/unit/edit-tree.test.js` protects edit composition and layout. The complete
integration tree protects exact output, including invisible whitespace. New internal
validation loops are not a substitute for these contracts.

Feature tasks retain only the facts their lowerer consumes, never walker context
snapshots. Namespace bindings are created idempotently, so lowering does not rely
on incidental task order.

## Change placement

Add erasable syntax only to the fixed phase. Add runtime syntax to a focused
feature lowerer. Put shared syntax classification in a shared module only when
multiple consumers need it. Do not precompute semantic data without a concrete
feature consumer. Edit composition and physical-line layout belong below all
feature code. Do not add generic AST reflection, parser workarounds, token
fallbacks, or feature-local source/comment state outside these owners.
