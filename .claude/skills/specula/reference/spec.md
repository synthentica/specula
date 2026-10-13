# Spec: infer-api, flows, SPEC.md

```
node src/infer-api.ts --target <name>
node src/infer-api.ts --target <name> diff --against <reference.json>
```

## What infer-api reads

First-party Fetch/XHR exchanges under `target.json` `apiPrefix` from every
`capture/<flow>.har`, plus `analysis/correlation.json` (to attach the user action
to each step) when it exists.

## openapi.yaml / openapi.json (OpenAPI 3.1)

- Paths are templated from concrete URLs: numeric ids, UUIDs and hashes become
  `{resourceId}` named after the preceding segment (`/projects/2` →
  `/projects/{projectId}`).
- Schemas are merged from every observed sample: `required` lists keys present
  in all samples, `format` is set for date-time/date/uuid/uri, nullable fields
  get `type: [x, "null"]`, `x-observed-values` lists up to 5 values seen (not an
  enum), redacted values carry `x-redacted`. Keys in `target.json`
  `volatile.keys` never get observed values.
- Structurally similar response objects merge into named components (by
  resource name, the response's `$schema` name, or key overlap ≥ 0.5).
  Pagination envelopes (one array next to scalar metadata) stay inline with
  `items` pointing at the component.
- Security schemes: `bearerAuth` when requests carried a bearer token,
  `cookie_<name>` for cookies the requests sent.
- `x-specula-samples`, `x-specula-flows` and, for JSON Patch,
  `x-specula-patch-paths` record the evidence behind each operation.

## flows/<flow>.json

```json
{ "name": "edit-task", "order": 4, "description": "",
  "steps": [ { "action": { "kind": "click", "target": { ... } } | null,
    "request": { "operationId": "...", "method": "PATCH", "path": "/tasks/{taskId}",
      "pathParams": { "taskId": { "var": "task74" } }, "query": [["expand", "buckets"]],
      "body": { "label_id": { "$var": "label115" } }, "contentType": "application/json",
      "auth": "bearer" | "cookie" | "none",
      "expect": { "status": 200, "contentType": "application/json",
        "schema": "#/components/schemas/Task", "envelope": "items", "body": { ... } },
      "source": "capture/edit-task.har#entries[23]",
      "bind": { "task90": "$.id" } } } ] }
```

- `bind` names values in a response for later steps; `{ "var" }` in path
  parameters and `{ "$var" }` in bodies use them. Bindings carry across flows:
  `flows/index.json` gives the replay order on one fresh instance.
- A value is bound only to an earlier id of the same kind: the id's entity
  comes from its key (`project_id` → project), the array or object it sits in
  (`views[0].id` → view), or the endpoint for `$.id` (`POST /labels` → label).
  Among matches, a direct `$.id` beats a list position, then the most recent
  response wins. Ids that match nothing stay literal values. A UUID or random
  string id is unique on its own, so when no id of the same kind matches it may
  bind across kinds (a template listed as `template`, opened as a board), and
  anywhere in a body (`cardOrder: [...]`, a top-level `[userId]` list).
- Ids are positive integers, UUIDs, long hex strings (24-hex ObjectIds) or
  random base32 strings (20-32 lowercase letters and digits, at least two of
  each) or random base62 slugs (10-32 characters with at least two digits,
  two capitals and two lowercase letters, so camelCase words do not match).
  A slug under `slug` (`share_slug`, `shareSlug`) binds like an id, so a path
  such as `/share/{shareId}` replays the slug the instance just created. A bare `id` in a request body binds through the object it sits in
  (`{ "posts": [ { "id" } ] }` → post), and lists of ids (`postIds: [...]`)
  bind item by item.
- A binding into a list element uses a field that tells the element apart
  instead of its position, `$.views[?view_kind="kanban"].id`, when one exists:
  text the client itself sent earlier (a title the user typed) or a machine
  value (`kanban`, `card`). The original's own prose (a default view's name) is
  never used, since a rebuild words it differently.
- Volatile strings the client echoes back (an `updated_at` used for optimistic
  locking) bind to the latest response that held the same value under the same
  key on the same entity, so a replay sends the new instance's value.
- Query values that embed ids or "now"-derived times become `{ "$template" }`
  strings: `id:{{var:post12}}`, `created_at:<='{{now:0:sql}}'`. `now` tokens keep
  the recorded offset from the request time (within 31 days) and its format
  (`iso`, `iso-s`, `sql`).
- Objects keyed by record ids (`{ "<id>": {...} }`) get `x-keys: record-id` and
  one `additionalProperties` schema instead of a property per id.
- A time the client sends under its own name (`checkoutDate`) binds to an
  earlier volatile time with the same value on the same entity (`updatedAt`).
- WebSocket frames join their flow. A message the client sent is a step of its
  own, `{ "action": null, "send": { "channel": "/ws", "message": {...} } }`
  (`reconnect: true` on the first message of a second socket in the flow); a
  message the server pushed is listed under the latest step before it,
  `"receive": [ { "channel", "kind", "message", "source" } ]`, where `kind` is
  the message's `action`, `type`, `event` or `op`.
- A token the client received in a response and then sent in a custom header
  (a share link's `X-App-Share-Token`) is bound from that response
  (`bind: { appShareToken12: "$.token" }`) and the step carries
  `tokenHeaders: { "x-app-share-token": { "var": "appShareToken12" } }`.
- `flows/index.json` order: `target.json` `flowOrder` first, then recording
  order.
- `flows/index.json` `headers`: custom request headers the client sent with
  the same value on every API request (`X-Requested-With`), minus browser
  headers, secrets and any header naming the brand.
  Zero-date sentinels (before 1971) never bind.
- A 204's content type is not recorded.
- A step gets `pauseMs` with `pauseReason: "token-lifetime"` when the recording
  was idle before it for at least the shortest JWT lifetime seen in that flow
  (`auth.json`), and `pauseReason: "app-wait"` (capped at 20 s) when a page
  load came 5 s or more after a write with no user action in between: the app
  itself waited, for example a setup wizard that restarts the server. The
  runner waits there.
- Redacted placeholders (`<redacted:pii>`, `<redacted:secret>`, ...) are filled
  by the parity runner from the test account's environment variables.

## GraphQL

A JSON body of `{ query, variables, operationName }` objects (or an array of
them, as batching clients send) is read as GraphQL, with a small built-in
reader (`src/lib/graphql.ts`, no dependency):

- `spec/graphql.json` lists each operation once: its name (the client's
  `operationName`, else `<type> <root fields>`, where a namespace root without
  arguments is joined with its only child: `mutation pages.create`), call
  count, flows, the exact documents sent (whitespace-normalized), variable and
  result shapes, top-level `errors` (message, `extensions.code`, path) and
  in-band failures (result objects with a false `succeeded`/`success`/`ok`).
- Flow steps carry `request.graphql: ["mutation pages.create", ...]`, one per
  batched operation, and no `expect.schema` (the shapes are in graphql.json).
- A variable binds by the entity of the field that takes it
  (`pages { single(id: $id) }` → page). Response ids are collected under
  `data`; wrapper fields (`single`, `list`, `create`, `update`, `results`,
  `nodes`, `edges`, ...) keep their parent's entity.

## SPEC.md

Written by Claude from REPORT.md and the generated files, in neutral words (no
brand, no product copy). Sections: files, scope (build / observed-not-built),
API conventions, authentication, data model, behaviour per operation with
`flows/<flow>.json` step references, realtime, not determined, how parity is
checked (behaviour, and the look via UI.md). Mark each claim observed or inferred.

## UI spec: infer-ui

`node src/infer-ui.ts --target <name>` reads `capture/ui/<view>.json` (named views
from `visual.ts --original`) and, for routes not named there, the last snapshot
per route in `capture/<flow>.ui.json`. It writes:

- `ui/tokens.json`: `color` (page, surface, text, textMuted, accent, border,
  topbar, sidebar, palette with what each colour is used for), `font` (family,
  heading family, base size, sizes, weights), `radius`, `shadow` (card, control),
  `spacing`.
- `ui/views.json`: per view its original route (ids as `{param}`), `seedFlow`,
  viewport, page style, regions with boxes, and components grouped by kind with
  count, variants, median size, typical style and up to 40 boxes on the first screen.
- `UI.md`: the same as tables, plus how the look is checked.

Snapshots never hold text or images, so the UI spec carries structure and style
only; brand names are still neutralized like everywhere in `spec/`. A rebuild
keeps its own name, wording and artwork.

## Brand names

`target.json` `brand: ["Name"]` makes infer-api replace those names (any case)
with `app`/`App` in every key and value it writes to `spec/`, including cookie
names, the API prefix and `$schema` URLs. URLs whose host carries the brand
become `https://example.invalid/...`. The rebuild only reads `spec/`.

## diff

Compares `spec/openapi.json` with a reference OpenAPI 3.x or Swagger 2.0 JSON by
`METHOD + path shape` and writes `analysis/spec-vs-source.md`: operation
precision, share of the real API exercised, response field recall/precision
(envelope items compared as `items[].field`), type agreement, request body and
query parameter recall, and unexercised operations by tag. Use it only to
evaluate the pipeline; never put the reference into `spec/`.
