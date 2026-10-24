# Contributing

Thanks for taking a look. This is a small, dependency-free plugin; the rules below are mostly about
keeping its safety properties intact rather than about process.

## Before you start

- **License.** The project is released under [CC BY-NC-SA 4.0](<LICENSE>) — noncommercial, with
  attribution, and adaptations must stay under the same terms. By opening a pull request you agree
  that your contribution is licensed under those same terms. If you need commercial terms, ask the
  copyright holder first.
- **Security.** Do not open a public issue for a security problem. See [SECURITY.md](<SECURITY.md>).
- **Scope of changes.** Bug fixes, accuracy improvements to the recap output, and documentation
  corrections are all welcome. Changes that widen what the plugin can read are not — see the
  constraints below.

## Running the tests

From the repository root:

```sh
npm test          # runs: node --test
# or directly:
node --test
```

Expect a successful exit and `fail 0`; record the actual summary from the current revision and Node
version. Do not use a fixed test count as the acceptance criterion: default discovery may also count
support files such as [`test/helpers.mjs`](<test/helpers.mjs>), and new regression cases change totals.
A local test pass does not establish that a live profile has installed or reloaded these sources.

Do **not** pass a directory (`node --test test/`) — on Node 24 that fails with `MODULE_NOT_FOUND`;
the runner's default discovery is what works.

## Constraints that must not be weakened

These are the properties the plugin exists to provide. A pull request that weakens one of them will
be declined, however useful it looks otherwise.

1. **Data only through the official service.** Everything comes from `ctx.sessionQuery`. The plugin
   never locates, opens, or parses a session file on disk, so it takes no dependency on the on-disk
   log format. `grep -r "node:fs" lib/` must stay empty.

2. **Sanitize complete fields, then use one publication exit.** Redact before whitespace normalization,
   first-line selection, folding and snippets; `publish()` remains the final check. Historical output
   receives the data-only preamble, boundary neutralisation and a one-time token. Headings and errors
   must be safe too, including structured error values available to programmatic callers. Never reuse
   an untrusted index snippet if the complete source cannot be safely obtained.

3. **Scope is a security boundary, not a preference.** Recall is confined to the current workspace.
   There is deliberately no `scope`, `sessionIds`, or similar parameter; one that reached other
   directories would be a vulnerability, not a feature.

4. **Inspect input and output contracts separately.** Before changing a tool, use current DSH inspection
   and the resolved package documentation to verify its parameter schema and output definition.
   Do not assume they share the same dialect or guess supported constructs; keep the existing schema
   compatibility tests and verify loading against the intended host.

5. **Zero dependencies.** No runtime dependencies, no build step. Please do not add a package for
   something a few lines can do.

6. **New guarantees need a test that fails without them.** The tests are written so that removing a
   guarantee turns one red. If you add a guarantee, add the test that pins it.

## Style

- ESM, tabs for indentation, semicolons, `node:` prefixed imports.
- Comments explain *why* a thing is the way it is, especially where the host's behaviour forced a
  decision. Facts about the host's contract are worth a comment; restating the code is not.
- Keep the two tool descriptions short — they are resident in every request.

## Review checklist

- `node --test` is green.
- No secrets, credentials, machine paths, session identifiers, or other private data in the diff.
- No new dependency, no `node:fs`, no second path to the model.
- Any behaviour change is reflected in [README.md](<README.md>).
