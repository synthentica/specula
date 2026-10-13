// fingerprint: stack, third parties, auth model, realtime, feature flags, routes and
// API paths found in bundles. Every finding carries evidence.
//
//   node src/fingerprint.ts --target vikunja
//
// Writes analysis/fingerprint.json.

import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { entryRef, type Flow, loadFlows } from './lib/captures.ts';
import type { HarEntry } from './lib/har.ts';
import { graphqlLabel, graphqlRequests } from './lib/graphql.ts';
import { shapeOf, templatePath } from './lib/paths.ts';
import { ensureDir, isTargetOrigin, loadTarget, printSummary } from './lib/target.ts';

interface Evidence {
  ref: string;
  detail: string;
}
interface Finding {
  claim: string;
  value: unknown;
  confidence: 'high' | 'medium' | 'low';
  evidence: Evidence[];
}

const { values: args } = parseArgs({ options: { target: { type: 'string' } } });
if (!args.target) {
  process.stderr.write('Usage: node src/fingerprint.ts --target <name>\n');
  process.exit(2);
}
const { config, paths } = await loadTarget(args.target);
const flows = await loadFlows(paths);
const apiPrefix = config.apiPrefix ?? '';

const allEntries: { flow: Flow; entry: HarEntry; index: number; ref: string }[] = flows.flatMap((flow) =>
  flow.har.log.entries.map((entry, index) => ({ flow, entry, index, ref: entryRef(flow.name, index) })),
);
const apiEntries = allEntries.filter(({ entry }) => isTargetOrigin(entry.request.url, config) && new URL(entry.request.url).pathname.startsWith(apiPrefix || '/'));
const header = (headers: { name: string; value: string }[], name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value;
const parseJson = (text: string | undefined): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
// GraphQL requests share one URL, so the operation names are part of the endpoint (`POST /graphql (mutation authentication.login)`).
const endpointOf = (entry: HarEntry) => {
  const op = graphqlLabel(entry.request.postData?.text);
  return `${entry.request.method} ${templatePath(new URL(entry.request.url).pathname)}${op ? ` (${op})` : ''}`;
};

// ---- bundles -----------------------------------------------------------------

const bundles: { file: string; text: string }[] = [];
if (existsSync(paths.sources)) {
  for (const file of (await readdir(paths.sources)).filter((f) => f.endsWith('.js'))) {
    bundles.push({ file: `capture/sources/${file}`, text: await readFile(join(paths.sources, file), 'utf8') });
  }
}
function findInBundles(pattern: RegExp, limit = 3): Evidence[] {
  const hits: Evidence[] = [];
  for (const { file, text } of bundles) {
    const match = pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length;
    hits.push({ ref: `${file}:${line}`, detail: JSON.stringify(text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30)) });
    if (hits.length >= limit) break;
  }
  return hits;
}

// ---- frontend stack ------------------------------------------------------------

const frontend: Finding[] = [];
const runtimes = flows.filter((f) => f.runtime).map((f) => ({ flow: f.name, runtime: f.runtime! }));
const markerNames = ['ember', 'vue', 'react', 'next', 'nuxt', 'angular', 'svelte', 'remix'] as const;
const bundleSignatures: Record<string, RegExp> = {
  ember: /ember-source|Ember\.VERSION|define\("@ember\//,
  vue: /__VUE_OPTIONS_API__|__vue_app__|createApp\b/,
  react: /react\.production|__SECRET_INTERNALS_DO_NOT_USE|react-dom/,
  next: /__NEXT_DATA__|next\/dist/,
  nuxt: /__NUXT__/,
  angular: /ɵcmp|ng-version/,
  svelte: /svelte/,
  remix: /__remixContext/,
};
for (const marker of markerNames) {
  const seen = runtimes.filter((r) => r.runtime.markers?.[marker]);
  // Captures made before a marker existed still show the framework in their bundles.
  const bundleOnly = !seen.length && marker === 'ember' ? findInBundles(bundleSignatures[marker]!, 1) : [];
  if (bundleOnly.length) {
    frontend.push({ claim: `Frontend framework: ${marker}`, value: { framework: marker }, confidence: 'medium', evidence: bundleOnly });
    continue;
  }
  if (!seen.length) continue;
  const version = seen.map((r) => r.runtime.markers[`${marker}Version`]).find(Boolean);
  frontend.push({
    claim: `Frontend framework: ${marker}`,
    value: { framework: marker, version },
    confidence: 'high',
    evidence: [
      ...seen.slice(0, 2).map((r) => ({ ref: `capture/${r.flow}.runtime.json`, detail: `markers.${marker}=true${version ? `, version ${version}` : ''}` })),
      ...findInBundles(bundleSignatures[marker]!, 1),
    ],
  });
}
// Turbopack (Next.js) also preloads modules and hashes chunk names, so it is checked first and rules Vite out.
const turbopackSignature = findInBundles(/TURBOPACK|__turbopack_/, 1);
if (turbopackSignature.length) frontend.push({ claim: 'Build tool: Turbopack', value: { tool: 'turbopack' }, confidence: 'high', evidence: turbopackSignature });
const viteChunks = flows.flatMap((f) => f.scripts).filter((s) => s.firstParty && /-[A-Za-z0-9_-]{8}\.js$/.test(new URL(s.url).pathname));
const viteSignature = findInBundles(/__vite__mapDeps|__vitePreload|modulepreload/, 1);
if (!turbopackSignature.length && (viteSignature.length || viteChunks.length > 5)) {
  frontend.push({
    claim: 'Build tool: Vite (Rollup chunking)',
    value: { tool: 'vite', chunks: new Set(viteChunks.map((s) => s.url)).size },
    confidence: viteSignature.length ? 'high' : 'medium',
    evidence: [...viteSignature, ...(viteChunks[0] ? [{ ref: 'capture/sources/index.json', detail: `chunk names like ${new URL(viteChunks[0].url).pathname}` }] : [])],
  });
}
const webpackSignature = findInBundles(/__webpack_require__|webpackChunk/, 1);
if (webpackSignature.length) frontend.push({ claim: 'Build tool: webpack', value: { tool: 'webpack' }, confidence: 'high', evidence: webpackSignature });

const LIBRARIES: [string, RegExp][] = [
  ['vue-router', /vue-router|RouterView|createWebHistory/],
  ['pinia', /\bpinia\b|defineStore/],
  ['@tanstack/query', /QueryClient|tanstack|useQuery/],
  ['axios', /\baxios\b/],
  ['tiptap / ProseMirror', /tiptap|ProseMirror/],
  ['vue-i18n', /vue-i18n|createI18n/],
  ['i18next', /i18next/],
  ['dayjs', /\bdayjs\b/],
  ['date-fns', /date-fns/],
  ['workbox (service worker)', /workbox/],
  ['@sentry/browser', /@sentry|sentry\.io/],
  ['floating-ui', /floating-ui|computePosition/],
  ['dompurify', /DOMPurify/],
  ['zod', /\bzod\b|ZodError/],
];
const libraries = LIBRARIES.flatMap(([name, pattern]) => {
  const evidence = findInBundles(pattern, 1);
  return evidence.length ? [{ claim: `Library: ${name}`, value: name, confidence: 'medium' as const, evidence }] : [];
});

// ---- backend & API style -------------------------------------------------------

const backend: Finding[] = [];
const serverHeaders = new Map<string, Evidence>();
for (const { entry, ref } of apiEntries) {
  for (const name of ['server', 'x-powered-by', 'via']) {
    const value = header(entry.response.headers, name);
    if (value && !serverHeaders.has(`${name}: ${value}`)) serverHeaders.set(`${name}: ${value}`, { ref, detail: `${name}: ${value}` });
  }
}
if (serverHeaders.size) backend.push({ claim: 'Server identification headers', value: [...serverHeaders.keys()], confidence: 'medium', evidence: [...serverHeaders.values()] });
else backend.push({ claim: 'No server identification headers on API responses', value: null, confidence: 'medium', evidence: apiEntries[0] ? [{ ref: apiEntries[0].ref, detail: 'no Server / X-Powered-By header' }] : [] });

const customHeaders = new Map<string, Evidence>();
for (const { entry, ref } of apiEntries) {
  for (const h of entry.response.headers) {
    const lower = h.name.toLowerCase();
    if (lower.startsWith('x-') && !customHeaders.has(lower)) customHeaders.set(lower, { ref, detail: `${h.name}: ${h.value.slice(0, 60)}` });
  }
}
if (customHeaders.size) backend.push({ claim: 'Custom response headers (e.g. pagination metadata)', value: [...customHeaders.keys()].sort(), confidence: 'high', evidence: [...customHeaders.values()].slice(0, 6) });

const jsonPatch = apiEntries.find(({ entry }) => {
  const body = parseJson(entry.request.postData?.text);
  return entry.request.method === 'PATCH' && Array.isArray(body) && body.every((op) => op && typeof op === 'object' && 'op' in op && 'path' in op);
});
if (jsonPatch) backend.push({ claim: 'Partial updates use JSON Patch (RFC 6902 style op/path/value arrays)', value: endpointOf(jsonPatch.entry), confidence: 'high', evidence: [{ ref: jsonPatch.ref, detail: (jsonPatch.entry.request.postData?.text ?? '').slice(0, 120) }] });

const errorShapes = new Map<string, Evidence>();
for (const { entry, ref } of apiEntries) {
  if (entry.response.status < 400) continue;
  const body = parseJson(entry.response.content.text);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const shape = Object.keys(body).sort().join(',');
    if (!errorShapes.has(shape)) errorShapes.set(shape, { ref, detail: `${entry.response.status} {${shape}}` });
  }
}
if (errorShapes.size) backend.push({ claim: 'Error response body shapes', value: [...errorShapes.keys()].map((k) => `{${k}}`), confidence: 'medium', evidence: [...errorShapes.values()] });

const cors = apiEntries.find(({ entry }) => header(entry.response.headers, 'access-control-allow-origin'));
if (cors) backend.push({ claim: 'CORS headers present on API', value: header(cors.entry.response.headers, 'access-control-allow-origin'), confidence: 'high', evidence: [{ ref: cors.ref, detail: 'Access-Control-Allow-Origin' }] });

// ---- third parties -----------------------------------------------------------

const THIRD_PARTY_CATEGORIES: [RegExp, string][] = [
  [/google-analytics|googletagmanager|plausible|matomo|segment|mixpanel|amplitude|hotjar|clarity\.ms|posthog|heap/i, 'analytics'],
  [/sentry|bugsnag|rollbar|datadog|newrelic|logrocket/i, 'error tracking / monitoring'],
  [/stripe|paddle|braintree|paypal/i, 'payments'],
  [/intercom|crisp|zendesk|drift|hubspot/i, 'support / chat'],
  [/auth0|okta|clerk|firebaseapp|supabase|cognito|accounts\.google/i, 'authentication'],
  [/launchdarkly|unleash|growthbook|flagsmith|split\.io|optimizely|statsig/i, 'feature flags'],
  [/fonts\.googleapis|fonts\.gstatic|typekit|cdnjs|jsdelivr|unpkg|cloudflare/i, 'CDN / fonts'],
  [/gravatar|unsplash|cloudinary|imgix/i, 'images / media'],
];
const thirdParty = new Map<string, { category: string; evidence: Evidence[] }>();
for (const { entry, ref } of allEntries) {
  const url = new URL(entry.request.url);
  if (isTargetOrigin(url.href, config) || !/^https?:$/.test(url.protocol)) continue;
  const category = THIRD_PARTY_CATEGORIES.find(([pattern]) => pattern.test(url.host))?.[1] ?? 'unclassified';
  const item = thirdParty.get(url.host) ?? { category, evidence: [] };
  if (item.evidence.length < 2) item.evidence.push({ ref, detail: `${entry.request.method} ${url.host}${url.pathname.slice(0, 60)}` });
  thirdParty.set(url.host, item);
}
const thirdParties: Finding[] = [...thirdParty.entries()].map(([host, item]) => ({ claim: `Third-party host: ${host}`, value: { host, category: item.category }, confidence: 'high', evidence: item.evidence }));

// ---- auth model ----------------------------------------------------------------

const auth: Finding[] = [];
const bearer = flows.flatMap((f) => f.auth.authorization.map((a) => ({ flow: f.name, ...a })));
if (bearer.length) {
  const jwt = bearer.find((b) => b.jwt)?.jwt;
  auth.push({
    claim: `API requests authenticate with an Authorization: ${bearer[0]!.scheme} header${jwt ? ' carrying a JWT' : ''}`,
    value: { scheme: bearer[0]!.scheme, jwt },
    confidence: 'high',
    evidence: bearer.slice(0, 2).map((b) => ({ ref: `capture/${b.flow}.auth.json`, detail: `${b.count} requests, first ${entryRef(b.flow, b.firstEntry)}${b.jwt ? `, alg ${b.jwt.alg}, claims ${b.jwt.claimNames.join('/')}, lifetime ${b.jwt.lifetimeSec}s` : ''}` })),
  });
}
const cookieSets = flows.flatMap((f) => f.auth.cookiesSet.map((c) => ({ flow: f.name, ...c })));
const cookieNames = [...new Set(cookieSets.map((c) => c.name))];
for (const name of cookieNames) {
  const sets = cookieSets.filter((c) => c.name === name);
  const byEndpoint = new Map<string, { attributes: string[]; evidence: Evidence }>();
  for (const c of sets) {
    const entry = flows.find((f) => f.name === c.flow)!.har.log.entries[c.entry]!;
    const ep = endpointOf(entry);
    if (!byEndpoint.has(ep)) byEndpoint.set(ep, { attributes: c.attributes, evidence: { ref: entryRef(c.flow, c.entry), detail: `Set-Cookie ${name}; ${c.attributes.join('; ')}` } });
  }
  auth.push({
    claim: `Cookie "${name}" is set by ${[...byEndpoint.keys()].join(', ')}`,
    value: { name, setBy: Object.fromEntries([...byEndpoint].map(([ep, v]) => [ep, v.attributes])) },
    confidence: 'high',
    evidence: [...byEndpoint.values()].map((v) => v.evidence),
  });
}
/** The object a GraphQL operation returned: `data`, then down through single-key namespaces (`authentication.login`). */
function graphqlResult(result: unknown): unknown {
  let node = (result as { data?: unknown } | undefined)?.data;
  for (let i = 0; i < 3 && node && typeof node === 'object' && !Array.isArray(node); i++) {
    const keys = Object.keys(node).filter((k) => k !== '__typename');
    if (keys.length !== 1) break;
    node = (node as Record<string, unknown>)[keys[0]!];
  }
  return node;
}
const loginLike = apiEntries.filter(({ entry }) => /"(password|pass)"\s*:/.test(entry.request.postData?.text ?? '') || /\/(login|signin|register|signup)$/.test(new URL(entry.request.url).pathname));
for (const ep of new Set(loginLike.map(({ entry }) => endpointOf(entry)))) {
  const sample = loginLike.find(({ entry }) => endpointOf(entry) === ep)!;
  // GraphQL: the keys that matter are the variables and the fields under the operation's result.
  const requestJson = parseJson(sample.entry.request.postData?.text);
  const gql = graphqlRequests(requestJson);
  const responseJson = parseJson(sample.entry.response.content.text);
  const requestKeys = Object.keys((gql ? gql[0]?.variables : requestJson) ?? {});
  const responseKeys = Object.keys((gql ? graphqlResult(Array.isArray(responseJson) ? responseJson[0] : responseJson) : responseJson) ?? {});
  auth.push({
    claim: `Credential endpoint: ${ep}`,
    value: { endpoint: ep, status: sample.entry.response.status, responseKeys },
    confidence: 'high',
    evidence: [{ ref: sample.ref, detail: `request body keys: ${requestKeys.join(', ')}; response keys: ${responseKeys.join(', ')}` }],
  });
}
const refresh = apiEntries.filter(({ entry }) => /refresh/i.test(new URL(entry.request.url).pathname));
if (refresh.length) {
  const sample = refresh[0]!;
  const sentAuth = header(sample.entry.request.headers, 'authorization');
  const sentCookie = header(sample.entry.request.headers, 'cookie');
  auth.push({
    claim: `Token refresh: ${endpointOf(sample.entry)} (sends ${[sentAuth && 'Authorization', sentCookie && `cookie ${sentCookie.split('=')[0]}`].filter(Boolean).join(' + ') || 'no credentials'})`,
    value: { endpoint: endpointOf(sample.entry), observed: refresh.length, responseKeys: Object.keys((parseJson(sample.entry.response.content.text) as object) ?? {}) },
    confidence: 'high',
    evidence: refresh.slice(0, 3).map(({ ref, entry }) => ({ ref, detail: `${entry.response.status}, ${Math.round(entry.time)}ms` })),
  });
}
const logout = apiEntries.find(({ entry }) => /logout|signout/i.test(new URL(entry.request.url).pathname));
if (logout) auth.push({ claim: `Logout endpoint: ${endpointOf(logout.entry)}`, value: endpointOf(logout.entry), confidence: 'high', evidence: [{ ref: logout.ref, detail: `${logout.entry.response.status}` }] });
const unauthorized = apiEntries.filter(({ entry }) => entry.response.status === 401);
auth.push({
  claim: unauthorized.length ? `${unauthorized.length} request(s) got 401` : 'No 401 responses observed (the answer to an expired token was not seen)',
  value: unauthorized.length,
  confidence: 'medium',
  evidence: unauthorized.slice(0, 3).map(({ ref, entry }) => ({ ref, detail: endpointOf(entry) })),
});
const storage = runtimes.flatMap((r) => (r.runtime.storageKeys?.local ?? []).map((k: string) => ({ flow: r.flow, key: k })));
const tokenKeys = [...new Set(storage.filter((s) => /token|auth|jwt|session/i.test(s.key)).map((s) => s.key))];
if (tokenKeys.length) auth.push({ claim: `Client keeps auth state in localStorage keys: ${tokenKeys.join(', ')}`, value: tokenKeys, confidence: 'medium', evidence: [{ ref: `capture/${storage[0]!.flow}.runtime.json`, detail: 'storageKeys.local' }] });

// ---- realtime ------------------------------------------------------------------

const realtime: Finding[] = [];
const sockets = new Map<string, { flows: Set<string>; messages: Map<string, { direction: string; count: number; keys: Set<string>; ref: string }> }>();
for (const flow of flows) {
  const urls = new Map<string, string>();
  for (const event of flow.events) {
    if (event.type === 'ws-open') urls.set(event.requestId, event.url);
  }
  for (const [line, event] of flow.events.entries()) {
    if (event.type !== 'ws-frame') continue;
    const url = urls.get(event.requestId) ?? flow.har.log.entries.find((e) => e._requestId === event.requestId)?.request.url ?? 'unknown socket';
    const socket = sockets.get(url) ?? { flows: new Set(), messages: new Map() };
    sockets.set(url, socket);
    socket.flows.add(flow.name);
    const payload = parseJson(event.payload) as Record<string, unknown> | undefined;
    const kind = payload && typeof payload === 'object' ? String(payload.action ?? payload.type ?? payload.event ?? payload.op ?? '(untyped)') : '(non-JSON)';
    const key = `${event.direction} ${kind}`;
    const message = socket.messages.get(key) ?? { direction: event.direction, count: 0, keys: new Set<string>(), ref: `capture/${flow.name}.events.jsonl:${line + 1}` };
    message.count++;
    if (payload && typeof payload === 'object') Object.keys(payload).forEach((k) => message.keys.add(k));
    socket.messages.set(key, message);
  }
}
for (const [url, socket] of sockets) {
  const subscribed = flows.flatMap((f) => f.events).flatMap((e) => {
    const p = e.type === 'ws-frame' ? (parseJson(e.payload) as Record<string, unknown> | undefined) : undefined;
    return p && p.action === 'subscribe' && typeof p.event === 'string' ? [p.event] : [];
  });
  realtime.push({
    claim: `WebSocket ${url.replace(/^wss?:\/\/[^/]+/, '')}`,
    value: {
      url,
      messages: [...socket.messages.entries()].map(([key, m]) => ({ message: key, count: m.count, keys: [...m.keys] })),
      ...(subscribed.length ? { subscribedEvents: [...new Set(subscribed)] } : {}),
    },
    confidence: 'high',
    evidence: [...socket.messages.values()].slice(0, 4).map((m) => ({ ref: m.ref, detail: `${m.direction} keys: ${[...m.keys].join(', ')}` })),
  });
}
const sse = allEntries.filter(({ entry }) => /event-stream/.test(entry.response.content.mimeType));
if (sse.length) realtime.push({ claim: 'Server-Sent Events stream', value: sse.map(({ entry }) => endpointOf(entry)), confidence: 'high', evidence: sse.slice(0, 2).map(({ ref }) => ({ ref, detail: 'text/event-stream' })) });
if (!sockets.size && !sse.length) realtime.push({ claim: 'No realtime channel observed', value: null, confidence: 'medium', evidence: [] });

// ---- feature flags -------------------------------------------------------------

const flags: Finding[] = [];
const flagSources = new Map<string, { ref: string; flags: Record<string, boolean> }>();
for (const { entry, ref } of apiEntries) {
  if (entry.request.method !== 'GET') continue;
  const body = parseJson(entry.response.content.text);
  const collect = (value: unknown, prefix: string, out: Record<string, boolean>) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'boolean' && /enabled|feature|flag|allow/i.test(k)) out[prefix + k] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v)) collect(v, `${prefix}${k}.`, out);
    }
  };
  const found: Record<string, boolean> = {};
  collect(body, '', found);
  if (Object.keys(found).length >= 3 && !flagSources.has(endpointOf(entry))) flagSources.set(endpointOf(entry), { ref, flags: found });
}
for (const [endpoint, source] of flagSources) {
  flags.push({ claim: `Server-provided feature switches in ${endpoint}`, value: source.flags, confidence: 'high', evidence: [{ ref: source.ref, detail: `${Object.keys(source.flags).length} boolean switches` }] });
}
const FLAG_SDKS: [string, RegExp][] = [
  ['LaunchDarkly', /launchdarkly/i],
  ['Unleash', /unleash/i],
  ['GrowthBook', /growthbook/i],
  ['PostHog feature flags', /posthog/i],
  ['Flagsmith', /flagsmith/i],
  ['Statsig', /statsig/i],
];
for (const [name, pattern] of FLAG_SDKS) {
  const evidence = findInBundles(pattern, 1);
  if (evidence.length) flags.push({ claim: `Feature flag SDK in bundle: ${name}`, value: name, confidence: 'medium', evidence });
}

// ---- routes and API paths in bundles -------------------------------------------

const ROUTE_PATTERN = /path:\s*["'`](\/[^"'`\s]*)["'`]/g;
const routeMap = new Map<string, Evidence>();
for (const { file, text } of bundles) {
  for (const match of text.matchAll(ROUTE_PATTERN)) {
    const route = match[1]!;
    if (routeMap.has(route) || /\.(js|css|svg|png|json)$/.test(route)) continue;
    const near = text.slice(match.index, match.index + 200).match(/name:\s*["'`]([\w.:-]+)["'`]/);
    routeMap.set(route, { ref: `${file}:${text.slice(0, match.index).split('\n').length}`, detail: near ? `name ${near[1]}` : '' });
  }
}
const visited = new Set(flows.flatMap((f) => f.events).flatMap((e) => (e.type === 'navigation' || e.type === 'action' ? [shapeOf(new URL(e.url).pathname)] : [])));
const routes = [...routeMap.entries()].map(([route, evidence]) => ({ route, name: evidence.detail.replace(/^name /, '') || undefined, visited: visited.has(shapeOf(route)), ref: evidence.ref }));

const observedShapes = new Set(apiEntries.map(({ entry }) => shapeOf(new URL(entry.request.url).pathname.slice(apiPrefix.length))));
const API_STRING = /["'`](\/[a-z][a-z0-9_-]*(?:\/(?:[a-z0-9_.-]+|\{[A-Za-z_]\w*\}|\$\{[^}`]{1,40}\}|:[A-Za-z_]\w*))*\/?)["'`]/g;
const apiStrings = new Map<string, { observed: boolean; ref: string }>();
const routeShapes = new Set([...routeMap.keys()].map(shapeOf));
for (const { file, text } of bundles) {
  for (const match of text.matchAll(API_STRING)) {
    const literal = match[1]!;
    const shape = shapeOf(literal);
    if (apiStrings.has(shape) || routeShapes.has(shape) || shape.length < 3 || /\.(js|css|svg|png|jpe?g|webp|json|ico|woff2?|html)$/.test(shape)) continue;
    if (!/[{}]|\//.test(shape.slice(1)) && !observedShapes.has(shape)) continue; // single bare segment: too ambiguous unless observed
    apiStrings.set(shape, { observed: observedShapes.has(shape), ref: `${file}:${text.slice(0, match.index).split('\n').length}` });
  }
}
const codePaths = [...apiStrings.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => a.path.localeCompare(b.path));

// ---- output ----------------------------------------------------------------------

const fingerprint = {
  generatedBy: 'specula fingerprint',
  target: config.name,
  flows: flows.map((f) => f.name),
  frontend,
  libraries,
  backend,
  thirdParties,
  auth,
  realtime,
  flags,
  routes,
  apiPathsInCode: {
    note: 'String literals in first-party bundles shaped like API paths. "observed" = also seen in recorded traffic (after removing apiPrefix). Unobserved ones are candidates, not facts.',
    paths: codePaths,
  },
};
await ensureDir(paths.analysis);
await writeFile(join(paths.analysis, 'fingerprint.json'), `${JSON.stringify(fingerprint, null, 2)}\n`);
printSummary({
  ok: true,
  frontend: frontend.map((f) => f.claim),
  libraries: libraries.length,
  thirdParties: thirdParties.length,
  authFindings: auth.length,
  realtime: realtime.map((r) => r.claim),
  flagSources: flags.length,
  routes: routes.length,
  apiPathsInCode: codePaths.length,
  apiPathsObserved: codePaths.filter((p) => p.observed).length,
  file: 'analysis/fingerprint.json',
});
