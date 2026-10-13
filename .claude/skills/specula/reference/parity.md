# Parity: replaying recorded behaviour

```
node src/parity.ts --target <name> --base-url <http://host:port> [--label rebuild|baseline|...] [--flow <flow>] [--original] [--dry-run] [--skip-app-waits] [--timeout-ms 10000]
```

`--dry-run` prints the summary without writing files (used by `npm run demo`).
`--skip-app-waits` drops pauses recorded as `pauseReason: "app-wait"` (the
original restarting itself), for an instance that never does.

`--original` is for the baseline run against a local copy of the original. It
is the only mode that reads `target.json`: the original's real API prefix may
contain the brand name, which `spec/` neutralizes, and its responses are
neutralized the same way before comparing.

Writes `parity/report.{md,json}` for the default label `rebuild`, otherwise
`parity/<label>.{md,json}`. Exit code 1 only when the instance never answered.

## Replay

The runner reads only `spec/`: `flows/index.json` carries the order, the API
prefix, the volatile keys and the constant client headers, so it works without
`target.json`.

- Flows run in `spec/flows/index.json` order against one instance; `--flow`
  runs the suite up to and including that flow.
- Test account: `SPECULA_USERNAME`, `SPECULA_PASSWORD`, `SPECULA_EMAIL`,
  or random values per run (`parity-<hex>`), so reruns on the same instance
  still start with an empty account. Redacted placeholders in bodies, path
  parameters and query values become these credentials (`secret` or a
  password-like key → password, `email` or a mail-like key → email, other
  `pii` → username). `<redacted:email:N>` is another person's address: the
  runner sends `parity-<hex>-N@example.test`, the same one for the same N.
- Headers: `flows/index.json` `headers` (custom headers the client sent with
  every request, such as `X-Requested-With`) go on every request.
- Bindings: `bind` JSON paths store response values (`$.items[2].id`, or
  `$.items[?title="Fix the tap"].id` for the element with that field, so a list
  that comes back in another order still binds the right record); `{ "var" }` path
  parameters and `{ "$var" }` body values (also inside JSON Patch `value`s) use
  them, and `{ "$template" }` query values fill `{{var:name}}` and
  `{{now:<seconds>:<format>}}` (replay time plus the recorded offset). A step
  whose variable was never bound fails as "not run".
- Auth: a response field recorded as `<redacted:jwt>`, or as
  `<redacted:secret>` / `<redacted:token>` under a plain token key (`token`,
  `access_token`, `sessionToken`), becomes the bearer token for later
  `auth: "bearer"` steps. Cookies follow `Set-Cookie` with `Path`,
  `Max-Age` and `Expires`, and are sent on every matching request, like a
  browser. A token the step binds explicitly (for a `tokenHeaders` header)
  never becomes the bearer; `tokenHeaders` send it in its own header.
- Realtime: a flow's `send` steps go over one WebSocket per flow, opened at
  the flow's first `send` (and again where the client opened a new socket,
  `reconnect: true`), with the browser's cookies. A redacted token in a sent
  message is the current bearer. Every server push the recording expects
  (`receive` on the step it followed) is one behaviour: after the flow's last
  step, plus up to 2 s, it passes when an unused pushed message of the same
  kind (`action`, `type`, `event` or `op`) compares like a response body
  (rules below). The first clean match wins, so pushes may arrive in any order;
  extra pushes are ignored.
- GraphQL: a step is one HTTP request, so a batch of operations is one
  behaviour; the report names the operations (`mutation pages.create (POST
  /graphql)`).
- Once the instance has answered, a refused or dropped connection is retried
  for up to 30 s (an app that restarts itself after setup).

## Pass rule per step

1. Status code equals the recording.
2. Content type equals (parameters ignored), unless the response is empty
   and nothing was recorded for it.
3. Every key in the recorded JSON body exists with the same JSON type; a
   recorded `null` accepts any value; arrays of objects must have the same
   length (a list recorded empty must stay empty when records come back in
   it), arrays of plain values (configuration lists) need not; items are
   compared pairwise. When pairwise fails and the recorded list is not sorted
   by any field (rows in storage order, keyed by random ids), it passes if
   every recorded item matches a different returned item. A list sorted by a
   number or time, or by text with at least three distinct values, keeps its
   order. Objects keyed by record ids compare entry count and
   values in order, since ids differ per instance. Extra keys are fine.
4. Values are compared only where the recording makes them meaningful: strings
   the client sent earlier in the run, fields the current request set (object
   fields, bulk items, JSON Patch ops), and counts (`total`, `totalHits`,
   `pagesTotal`, `total_pages`, ...). A string that a recorded
   response had already shown before the client sent it back is the server's
   own data (seed text the client round-trips) and is not compared. Keys in `target.json`
   `volatile.keys`, `$schema`, date-times, URLs and redacted values are never
   compared.
5. Booleans always have the recorded value: they are state (`done`,
   `published`, feature switches), never ids or clocks. In an error response
   (status 400 or higher) numbers do too, since error codes are a contract the
   client reads. The same holds inside a GraphQL result with top-level
   `errors`, and inside an in-band failure object (`{ succeeded: false,
   errorCode: 1002 }`) of a 200 response; there a string `code` must match
   too.

A step with `pauseMs` waits that long before its request: the recording was idle
for at least the shortest token lifetime there, so what followed may depend on
expiry (`token-lifetime`), or the app itself waited (`app-wait`). Other idle
time is skipped. `<redacted:secret:other>` is replayed as a
password that is not the account's.

## Reading the report

`parity/report.md` starts with "Passes N/M recorded behaviours", then a table
per flow and, for every failing step, the diffs and the recorded HAR entry
(`source`); a failing pushed message reads `receive <kind> on <channel>
(after <step>)`. A baseline run against the original should pass everything; if
not, fix the flows or the checker before judging the rebuild.

## Visual check (how the views look)

```sh
node src/visual.ts --target <name> --base-url <rebuild> [--label rebuild] [--view <name>] [--screenshots <dir>] [--cdp URL]
node src/visual.ts --target <name> --base-url <original> --original   # reference views of a local copy
```

It replays the flows on the fresh instance first (`parity.ts --dry-run`, up to the
views' `seedFlow`), so both sides show the same records; signs in through the
app's own form with the replay's test account (it types into the text or email
field just before the password field and the password, presses Enter, and
leaves the field); opens each view and
reads a UI snapshot: layout boxes and computed styles, never text or images.
Chrome is started headless with a throwaway profile (`CHROME_PATH`, or a usual
install path), or `--cdp` opens a tab in a Chrome you already run.

Routes fill `{param}` from the path parameters the replay used last
(`{projectId}`: the project the flows last touched), named as in the API, or
from `--param name=value`. They come from:

- the original: `target.json` `ui` (outside `spec/`, it may name the brand):
  `{ "login": { "path": "/login", "user": "username" }, "seedFlow": "kanban",
  "views": { "board": "/projects/{projectId}/{viewId}" } }`. `login.value` fixes
  the sign-in name when the flows used a literal one (`"owner"`); `dismiss` lists
  CSS selectors clicked away before each snapshot (a "what's new" banner). `--original` writes
  `capture/ui/<view>.json`; then run `infer-ui`. Only against a local copy you
  started yourself. For a hosted service, use the snapshots `capture` took
  while you recorded.
- the rebuild: `rebuild/views.json`, same shape, mapping every view in
  `spec/ui/views.json` to the rebuild's own route.

Score per view, 0–100: layout 40 % (regions at the same place, components in
the same area of the first screen), components 30 % (count, typical size,
background, text colour, radius, shadow, border, font size and weight, text
transform) and style 30 % (page background, main text colour, accent, surface,
font family, base font size, radius). `parity/visual.md` lists the largest
differences per view in words. Screenshots (`--screenshots`) are for people;
never put screenshots of the original where a builder can read them.
