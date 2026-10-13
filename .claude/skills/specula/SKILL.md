---
name: specula
description: Understand how a web app's features work and how its views are laid out by observing it in Chrome, write a build-ready spec (API + UI), rebuild it, and prove parity by replaying recorded flows plus a visual check. Use when asked to capture, analyze, spec, rebuild, or parity-test a web/SaaS app (a "target").
---

# specula

Pipeline: **capture → analyze → spec → build → parity**. Every target lives in
`targets/<name>/` with `target.json` and the folders `capture/`, `analysis/`,
`spec/`, `rebuild/`, `parity/`. Helpers are `node src/<helper>.ts --target <name> ...`
and always end with one JSON summary line on stdout.

## Rules (always)

- **Passive observation only.** Record what the browser receives with the user's
  own account. No probing the server, no fuzzing, no auth bypass, no requests
  the app itself would not make. Parity replays go only to instances you run
  yourself: the rebuild, or a local copy of the original as a baseline.
- **Redaction before disk.** `capture` redacts cookies, tokens, passwords, emails
  and `target.json` `redact.values` in memory and refuses to write if its leak
  scan finds anything. Never copy raw values out of the browser into files yourself.
- **Rebuilds never copy** brand names, logos, icons, images or text content. They may follow the
  original's layout and style (regions, components, colours, fonts, spacing) as `spec/UI.md` describes it.
- Do not initialize git or suggest version control. Leave no temp/debug files.
- Ask the user before architecture changes, data-model changes or new
  dependencies beyond Node 22, TypeScript, chrome-devtools-mcp and
  `@jridgewell/trace-mapping`.

## 0. Preconditions

1. `node --version` is ≥ 22.18 and `npm install` has been run.
2. Chrome is reachable: chrome-devtools-mcp `list_pages` works (config in
   `.mcp.json` for Claude Code, `.codex/config.toml` for Codex). See [reference/capture.md](reference/capture.md) for the two
   supported connection modes.
3. The target app is running and `targets/<name>/target.json` exists.

## 1. Capture

For each user flow (kebab-case name, one feature per flow):

1. Navigate the tab to the app with chrome-devtools-mcp.
2. Start the recorder in the background:
   `node src/capture.ts --target <name> --flow <flow> --cdp http://127.0.0.1:9222`
   and wait for `recording` on stderr.
3. Perform the flow with chrome-devtools-mcp (`take_snapshot`, `click`, `fill`,
   `type_text`, `press_key`), or let the user click through it themselves.
4. Stop the recorder with SIGINT and check its summary (`ok: true`).

Outputs in `capture/`: `<flow>.har` (with `_initiator` stacks),
`<flow>.events.jsonl` (actions, navigations, WebSocket/SSE frames),
`<flow>.auth.json`, `<flow>.scripts.json`, `<flow>.runtime.json`,
`<flow>.ui.json` (each view the flow showed, described once it settled: layout
regions, components and computed styles, no text or images), and
`sources/` (first-party bundles, CDN scripts that call the target, and public source maps). Details:
[reference/capture.md](reference/capture.md).

## 2. Analyze

1. `node src/correlate.ts --target <name>` links every user action to the
   requests it caused and to the code that issued them → `analysis/correlation.json`.
2. `node src/fingerprint.ts --target <name>` collects stack, backend style,
   auth model, realtime channels, feature switches, third parties and routes,
   each with evidence → `analysis/fingerprint.json`.
3. `node src/report.ts --target <name>` renders `analysis/REPORT.md`.

Read REPORT.md before moving on: check that each feature row points at the
requests you expect, and read the "Not determined" section. If a flow is
missing or a feature is unclear, capture another flow rather than guessing.
Details: [reference/analyze.md](reference/analyze.md).

## 3. Spec

1. `node src/infer-api.ts --target <name>` writes `spec/openapi.yaml` (+ `.json`,
   OpenAPI 3.1), `spec/realtime.json`, `spec/graphql.json` when seen, and
   `spec/flows/<flow>.json` with `spec/flows/index.json` (the parity suite).
2. Write `spec/SPEC.md` yourself from REPORT.md and the spec files: scope
   (build / observed-not-built), API conventions, auth, data model, behaviour
   per operation with `flows/<flow>.json` step references, realtime, "Not
   determined", and how parity is checked. Mark observed vs. inferred.
3. `node src/infer-ui.ts --target <name>` writes the UI spec: `spec/ui/tokens.json`
   (colours, fonts, sizes, radii, shadows, spacing), `spec/ui/views.json` (per view:
   regions and components with positions and typical style) and `spec/UI.md`.
   Views come from the capture's `<flow>.ui.json`, or, when a local copy of the
   original runs, from named views: add `ui` to `target.json` (sign-in path and
   view routes, see [reference/parity.md](reference/parity.md)) and run
   `node src/visual.ts --target <name> --base-url <original> --original` first.
4. `spec/` is all a rebuild sees, so it must not contain brand names or
   product copy: list brand names in `target.json` `brand` (infer-api replaces
   them with "app"), and write SPEC.md in neutral words. Check with
   `grep -ri <brand> targets/<name>/spec`.
5. Optional evaluation, when the real API description is available:
   `node src/infer-api.ts --target <name> diff --against <openapi-or-swagger.json>`
   → `analysis/spec-vs-source.md`. Keep that reference file outside `spec/`.

Details: [reference/spec.md](reference/spec.md).

## 4. Build

Start a fresh session or subagent whose only input is `spec/` (plus the parity
and visual tools). It builds `rebuild/` with the API from SPEC.md and the look
from UI.md, maps each UI view to its own route in `rebuild/views.json`, and must not read `capture/`, `analysis/`, the
original's source or docs, or send requests to the original. Rules and the
default stack: [reference/build.md](reference/build.md).

## 5. Parity

1. Baseline (when the original runs locally): start it fresh, then
   `node src/parity.ts --target <name> --base-url <original> --label baseline --original`.
   It should pass everything; a failure there is a bug in the flows or the
   checker, not in the rebuild.
2. Start the rebuild on a fresh database and run
   `node src/parity.ts --target <name> --base-url <rebuild>` → `parity/report.md`
   ("passes N/M recorded behaviours") and `parity/report.json`.
3. Iterate rebuild → parity → fix until the score stops rising. Report the
   score per round and what still fails.
4. Visual check on a fresh rebuild:
   `node src/visual.ts --target <name> --base-url <rebuild> [--screenshots <dir>]`
   → `parity/visual.md` ("looks N/100 like the UI spec", per view: layout,
   components, style and the largest differences). It replays the flows, signs in
   through the rebuild's own form and opens each view from `rebuild/views.json`.
   Reported separately: restyling must never lower behavioural parity.

Details: [reference/parity.md](reference/parity.md).
