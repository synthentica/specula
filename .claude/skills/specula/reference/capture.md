# Capture reference

## Connecting to Chrome

chrome-devtools-mcp drives the browser; `src/capture.ts` attaches to the same
Chrome as a second CDP client and records what the MCP tools do not expose
(initiator stacks, WebSocket frames, user actions with timestamps).

### Mode A: dedicated debug profile (default)

Chrome only allows `--remote-debugging-port` with a non-default user data
directory, so your personal profile is never exposed.

macOS:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.specula/chrome-profile"
```

`.mcp.json` already points chrome-devtools-mcp at `http://127.0.0.1:9222`.
Capture: `--cdp http://127.0.0.1:9222`.

### Mode B: your own Chrome profile (Chrome ≥ 144)

1. Open `chrome://inspect/#remote-debugging` and allow incoming connections.
2. Replace `--browser-url=...` with `--autoConnect` in `.mcp.json`.
3. Capture with `--auto-connect` (reads `DevToolsActivePort` from Chrome's
   default user data directory; override with `--user-data-dir`).

Chrome asks for permission on every new debugging connection, so expect one
prompt for the MCP server and one per capture run. The agent can see every open
window of that profile: close unrelated tabs first.

## Running a capture

```bash
node src/capture.ts --target <name> --flow <flow> --cdp http://127.0.0.1:9222 \
  [--page-url-match <substring>] [--duration <seconds>]
```

- Attaches to the first tab whose URL contains `--page-url-match` (default: the
  host of `target.json` `origin`).
- Stops on SIGINT/SIGTERM, after `--duration`, or when the tab closes.
- Exit codes: 0 ok, 2 usage error, 3 leak scan failed (nothing written).
- Requests made by service workers or other tabs are not recorded.
- XHR/Fetch responses are held for a moment at the response stage (CDP
  `Fetch`), read and released unchanged, so a body survives when the page
  navigates right after the call (save, then redirect). Nothing is modified or
  sent to the server.

## Output files

| File | Content |
|---|---|
| `<flow>.har` | HAR 1.2. Extensions: `_requestId`, `_resourceType`, `_wallTimeMs`, `_initiator` (type, url, line, and `stack`: sync frames first, then async parents such as `await`), `_failed`. Binary bodies are omitted with a `comment`. |
| `<flow>.events.jsonl` | One JSON per line, `t` = wall-clock ms: `action` (`kind` click/input/change/submit/key, `target` {tag, role, name, id, testId, selector}, input `valueInfo` = type + length only), `navigation`, `ws-open`, `ws-frame`, `ws-close`, `sse`, `capture-start`, `capture-stop`. |
| `<flow>.auth.json` | Facts, never values: Authorization schemes and decoded JWT header/claim names/lifetime, cookie names sent and set (with attributes), CSRF header names, token fields in JSON responses. |
| `<flow>.scripts.json` | Scripts seen: URL, first-party flag, `callsTarget` for a CDN script that sent requests to the target, sha256, saved file, source map URL/file. |
| `<flow>.runtime.json` | Read-only page probe at stop: framework markers, non-standard globals, storage key names. |
| `<flow>.ui.json` | How each view looked: a read-only probe runs 1.5 s after the last navigation or action, and at stop. Per view (consecutive snapshots of one URL keep the last): viewport, page colours and font, layout regions (top bar, sidebar, main, footer, dialog) with boxes and styles, components (buttons, inputs, cards, board columns, tabs, badges, avatars, headings, tables...) with boxes and computed styles, and weighted usage of colours, fonts, sizes, radii, shadows and spacing. No text, attribute values, class names or image sources. |
| `sources/` | First-party scripts and CDN scripts that sent requests to the target (`name.<sha8>.js`), their public source maps (loaded from the script's own origin, as DevTools does), `index.json`. Shared by all flows. |

## Redaction

- Headers: `Cookie`, `Set-Cookie`, `Authorization` (scheme kept), `X-CSRF-*`,
  `X-XSRF-*`, API-key headers, plus `target.json` `redact.headers`.
- JSON/form fields whose key looks like a secret (`password`, `*token*`,
  `*secret*`, `*session*`, `api_key`, `otp`, …) plus `redact.keys`. Only string
  values are replaced; booleans and numbers stay (e.g. `totp_enabled: true`).
- Anywhere: JWT-shaped strings, emails, every secret value learned from headers
  or token fields, and `redact.values` (for example the test account name).
- Set `SPECULA_CAPTURE_PASSWORD` to the test account's password when a flow
  types a wrong password on purpose. It is only held in memory: a password
  field with that value becomes `<redacted:secret>`, any other value
  `<redacted:secret:other>`, so the replay can send a wrong password there.
  It also fails the leak scan if it appears anywhere in the output (camelCase
  fields such as `adminPassword` count as password fields).
- Set `SPECULA_CAPTURE_EMAIL` to the test account's email when a flow
  creates other users. The account's address becomes `<redacted:email>`, every
  other address `<redacted:email:2>`, `<redacted:email:3>`, ... (one number per
  address within a capture run), so a replay can tell the people apart.
- For a flow about token expiry, run the local original with a short token
  lifetime and stay idle longer than it; `auth.json` keeps the shortest
  lifetime seen.
- URL query parameters with secret-like names.
- A final scan of every output file aborts the write if anything still matches.

## target.json

```json
{
  "name": "vikunja",
  "origin": "http://localhost:3456",
  "apiPrefix": "/api/v2",
  "redact": { "values": ["wp-tester"] },
  "volatile": { "keys": ["id", "created", "updated"] }
}
```

`apiPrefix: ""` means "the whole origin": every JSON exchange counts as API.
Use it for an app whose API is a single GraphQL endpoint (`/graphql`) next to
other JSON endpoints (a setup form). `brand` lists names infer-api replaces in
`spec/` (any case); include spellings that appear in URLs (`wikijs`).

`apiOrigins` lists further origins that serve the app's own API when it is not
on `origin`, for example a hosted app at `https://app.example.com` that calls
`https://api.example.com`. Their requests count as first-party API for
infer-api, fingerprint and correlate. Leave out hosts that only track usage of
the app itself.

`flowOrder` lists flows that replay first, in that order; the rest follow in
recording order. Use it when a flow recorded later must run first, typically
`["sign-in"]` when the session existed before the first capture.
