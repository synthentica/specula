# Build: a rebuild from spec/ only

## Isolation

The builder (a fresh Claude Code or Codex session, or a subagent) reads only:

- `targets/<name>/spec/` (SPEC.md first, then openapi.yaml, realtime.json, flows/;
  UI.md and ui/ for the look),
- `src/parity.ts`, `src/visual.ts` and the reports they generate for the rebuild.

It never reads `capture/`, `analysis/`, `parity/baseline*`, `target.json`
(it names the brand; the checker does not need it), the original's
source code or documentation, and never sends requests to the original. When
the spec is ambiguous it picks a behaviour and records the choice in
`rebuild/README.md`. Gaps found this way are spec gaps: fix them in the
pipeline (more flows, better inference or SPEC.md), not by peeking.

## Content rules

- No brand names, logos, icons, images or text content from the original: own
  product name, own UI wording, own artwork.
- The look follows `spec/UI.md`: the same regions (top bar, sidebar, main area)
  at the same size, the same kinds of components where the spec has them, and
  the design tokens (colours, font family and sizes, radii, shadows, spacing).
  Name the spec's font family in CSS with system fallbacks; never load font
  files or other assets from the original.
- `rebuild/views.json` maps every view in `spec/ui/views.json` to a rebuild route
  and says how to sign in (`{ "login": { "path": "/#/signin", "user": "username" },
  "views": { "board": "/#/projects/{projectId}/board" } }`). UI labels in `flows/*.json`
  (`action.target.name`) describe the original and are not reused.
- Default records (seeded projects, bucket titles, server messages) get the
  builder's own wording; parity does not compare such strings.

## Default stack (Vikunja target)

- Node ≥ 22.18 built-ins only, no npm dependencies: `node:http`, `node:sqlite`
  (`DatabaseSync`), `node:crypto` (HS256 JWT, scrypt), a minimal RFC 6455
  WebSocket on the `upgrade` event.
- Framework-free TypeScript frontend served as JavaScript through
  `stripTypeScriptTypes` from `node:module`; erasable syntax only.
- `PORT` and `DB_PATH` (`:memory:` for a fresh instance) environment variables;
  entry point `rebuild/server.ts`; `rebuild/tsconfig.json` that type-checks.

## Done when

The rebuild starts on a fresh database, the UI's core flow works in a browser
(sign up, project, task, edit, done, comment, label, search, log out/in), and
`parity` has been iterated until the score stops rising, and `visual` has been
iterated the same way without lowering parity.
