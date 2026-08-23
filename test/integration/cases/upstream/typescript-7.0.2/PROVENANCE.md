# TypeScript 7.0.2 erasableSyntaxOnly inputs

- Parser oracle: `microsoft/typescript-go` 7.0.2
- Parser commit: `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`
- Fixture repository: <https://github.com/microsoft/TypeScript>
- Fixture commit: `4d4f005c8541e0255a9d8791205fdce326e462bc`
- Fixture cases: `tests/cases/compiler/erasableSyntaxOnly.ts` and
  `tests/cases/compiler/erasableSyntaxOnly2.ts`
- Classification source: the corresponding committed TypeScript `.errors.txt`
  baselines; each `@filename` virtual file forms one Syntaxase workload
- License: Apache-2.0

Declaration-file and JavaScript-only controls are outside the single-source
runtime API. Rejected virtual files exercise Yuku recovery without adopting the
TypeScript diagnostic text. TypeScript is not loaded by the integration runner.
