# Sucrase 3.35.1

- Repository: <https://github.com/alangpierce/sucrase>
- Version: 3.35.1
- Commit: `280ee202e73b18e396069782bd41e1eaaccbf620`
- License: MIT

The fixture tree is a reviewed snapshot of applicable active TypeScript and JSX
tests in the pinned Git tree. Inputs preserve the exact cooked strings passed to
Sucrase's test helpers. Each `case.json` records its upstream source range and
invocation metadata.

Committed `output.js` files are Syntaxase decisions, not Sucrase output.
Upstream-rejected inputs are retained as recovery workloads without an error
text contract. Normal tests do not execute Sucrase or access the network.
