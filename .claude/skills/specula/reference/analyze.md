# Analyze: correlate, fingerprint, report

All three read `capture/` and write `analysis/`. They never contact the target.

## correlate

```
node src/correlate.ts --target <name> [--flow <flow>] [--window-ms 1500]
```

- Triggers are recorded actions (click, submit, change, debounced input, special
  keys) and full navigations. A request belongs to the latest trigger before it,
  within `--window-ms` (input actions get 500 ms of slack because they are
  debounced).
- Confidence: **high** when a script issued the request (initiator stack
  present) within 1 s of the trigger, **medium** when it falls inside the
  window, **low** when nothing triggered it.
- Code locations per request: `callSite` (frame that issued the request),
  `origin` (first frame outside shared chunks, usually the feature code),
  `component` (UI component name found on the async chain), each resolved
  through public source maps when the app ships them. CDN scripts that sent
  requests to the target (`callsTarget`) count as app code.
- `sourceChain` (only with a source map): the app's own original files and
  lines along the causal chain, innermost first, without `node_modules`. The
  report shows it instead of minified locations, and lists bundles whose
  declared map the server does not serve.
- Requests with no trigger are `background`, tagged `page-load`, `startup`,
  `periodic`, `auth-refresh` or `background`.
- GraphQL requests share one URL, so their endpoint carries the operation names:
  `POST /graphql (mutation pages.create)` (a batch lists every operation).

## fingerprint

```
node src/fingerprint.ts --target <name>
```

Every finding is `{ claim, value, confidence, evidence: [{ ref, detail }] }` where
`ref` is `capture/<flow>.har#entries[i]`, `capture/<flow>.events.jsonl:<line>` or
`capture/sources/<file>:<line>`. Sections: frontend, libraries, backend (headers,
JSON Patch, error shapes, CORS), thirdParties, auth (bearer/JWT claims, cookies
and who sets them, credential/refresh/logout endpoints, storage keys), realtime
(WebSocket/SSE message kinds), flags (feature switches from config responses),
routes (client routes in bundles, visited or not), apiPathsInCode (API paths in
bundles, observed or not).

## report

```
node src/report.ts --target <name>
```

Renders `analysis/REPORT.md`: stack, backend, authentication, realtime, feature
switches, third parties, GraphQL operations (when `spec/graphql.json` exists:
calls, flows, top-level errors and in-band failures with their codes), per-flow
"action → requests → code" tables, routes,
API paths seen only in code, and **Not determined**, the list of things the
traffic could not show. SPEC.md cites this report so a rebuild knows what is
observed and what is a guess.
