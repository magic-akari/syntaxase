# ts-blank-space 0.9.0

- Package: `ts-blank-space@0.9.0`
- Repository: <https://github.com/bloomberg/ts-blank-space>
- Commit: `74579cee118bb5f257fab7372f869cc107032316`
- License: Apache-2.0
- Imported source: pinned repository fixtures and unit tests

The `strip-types/` tree is a reviewed snapshot of applicable fixtures and test
inputs in the pinned Git tree. The sole TSX-only API case is outside
`stripTypes`'s contract. Each `case.json` records its upstream source range and
invocation metadata.

Committed `output.js` files are Syntaxase decisions. Rejected inputs exercise
Yuku recovery without adopting ts-blank-space's diagnostic policy. Normal tests
do not execute ts-blank-space or access the network.
