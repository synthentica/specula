// capture: records one user flow from a running Chrome tab over CDP.
//
//   node src/capture.ts --target vikunja --flow create-task [--cdp http://127.0.0.1:9222 | --auto-connect]
//                       [--page-url-match localhost:3456] [--duration 120]
//
// SPECULA_CAPTURE_PASSWORD (optional, never written) names the test account's password, so a different
// value typed into a password field (a wrong-password attempt) keeps a distinct placeholder.
//
// Each view the flow shows is also described once it settles (layout boxes and computed styles, no text or
// images) in <flow>.ui.json, which infer-ui turns into the UI spec.
//
// Runs until SIGINT/SIGTERM, --duration seconds, or the tab closes. Everything is
// redacted in memory; nothing is written if the final leak scan finds a secret.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { CdpConnection, pickPageTarget, resolveBrowserWsUrl } from './lib/cdp.ts';
import type { ActionTarget, AuthFacts, CaptureEvent, Har, HarEntry, HarHeader, Initiator, ScriptRecord, StackFrame } from './lib/har.ts';
import { ACTION_BINDING, PAGE_RECORDER_SOURCE, RUNTIME_PROBE_SOURCE } from './lib/page-recorder.ts';
import { UI_PROBE_SOURCE, type UiSnapshot } from './lib/ui-probe.ts';
import { describeJwt, looksLikeJwt, Redactor } from './lib/redact.ts';
import { ensureDir, loadTarget, printSummary, targetOrigins, validateFlowName } from './lib/target.ts';

const BODY_RESOURCE_TYPES = new Set(['XHR', 'Fetch', 'Document', 'EventSource', 'Other', 'Preflight']);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_WS_PAYLOAD = 64 * 1024;
const TEXTUAL_MIME = /json|text|xml|javascript|html|x-www-form-urlencoded|graphql/i;

interface RawRequest {
  requestId: string;
  entryId: string;
  wallTimeMs: number;
  monoTs: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  postDataMime?: string;
  resourceType: string;
  initiator?: Initiator;
  extraRequestHeaders?: Record<string, string>;
  response?: {
    status: number;
    statusText: string;
    protocol?: string;
    headers: Record<string, string>;
    mimeType: string;
  };
  extraResponseHeaders?: Record<string, string>;
  endMonoTs?: number;
  encodedDataLength?: number;
  body?: { text: string; base64: boolean };
  bodyOmitted?: string;
  failed?: string;
  /** XHR/Fetch body read while the response was held: a fallback for when the page navigates before the body can be read. */
  heldBody?: { body: string; base64Encoded: boolean };
}

const { values: args } = parseArgs({
  options: {
    target: { type: 'string' },
    flow: { type: 'string' },
    cdp: { type: 'string' },
    'auto-connect': { type: 'boolean', default: false },
    'user-data-dir': { type: 'string' },
    'page-url-match': { type: 'string' },
    duration: { type: 'string' },
  },
});

if (!args.target || !args.flow) {
  process.stderr.write('Usage: node src/capture.ts --target <name> --flow <kebab-name> [--cdp URL | --auto-connect] [--page-url-match S] [--duration SEC]\n');
  process.exit(2);
}

const flow = validateFlowName(args.flow);
const { config, paths } = await loadTarget(args.target);
const targetOrigin = new URL(config.origin).origin;
const apiOrigins = targetOrigins(config);

const wsUrl = await resolveBrowserWsUrl({ cdpUrl: args.cdp, autoConnect: args['auto-connect'], userDataDir: args['user-data-dir'] });
const cdp = await CdpConnection.connect(wsUrl);
const pageTarget = await pickPageTarget(cdp, args['page-url-match'] ?? new URL(config.origin).host);
const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
const send = <T = any>(method: string, params: Record<string, unknown> = {}) => cdp.send<T>(method, params, sessionId);

// ---- state -----------------------------------------------------------------

const requests = new Map<string, RawRequest>();
const finished: RawRequest[] = [];
const events: CaptureEvent[] = [];
const pendingWork = new Set<Promise<unknown>>();
const scripts = new Map<string, { scriptId: string; url: string; sourceMapURL?: string; length: number }>();
const wsUrls = new Map<string, string>();
let actionSeq = 0;
let redirectSeq = 0;

const track = <T>(promise: Promise<T>): Promise<T> => {
  pendingWork.add(promise);
  promise.finally(() => pendingWork.delete(promise)).catch(() => {});
  return promise;
};
const isOurs = (sid: string | undefined) => sid === sessionId;

function convertInitiator(raw: any): Initiator | undefined {
  if (!raw) return undefined;
  const initiator: Initiator = { type: raw.type, url: raw.url, lineNumber: raw.lineNumber, columnNumber: raw.columnNumber };
  const groups: Initiator['stack'] = [];
  for (let stack = raw.stack; stack; stack = stack.parent) {
    const frames: StackFrame[] = (stack.callFrames ?? []).map((f: any) => ({
      functionName: f.functionName ?? '',
      url: f.url ?? '',
      lineNumber: f.lineNumber ?? 0,
      columnNumber: f.columnNumber ?? 0,
    }));
    groups.push({ description: stack.description, frames });
  }
  if (groups.length) initiator.stack = groups;
  return initiator;
}

function headerMap(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = String(v);
  return out;
}

function finalize(rec: RawRequest): void {
  requests.delete(rec.requestId);
  finished.push(rec);
}

// ---- network ---------------------------------------------------------------

cdp.on('Network.requestWillBeSent', (p, sid) => {
  if (!isOurs(sid)) return;
  if (/^(data|blob|chrome-extension|devtools):/.test(p.request.url)) return;
  const previous = requests.get(p.requestId);
  if (previous && p.redirectResponse) {
    previous.response = {
      status: p.redirectResponse.status,
      statusText: p.redirectResponse.statusText,
      protocol: p.redirectResponse.protocol,
      headers: headerMap(p.redirectResponse.headers),
      mimeType: p.redirectResponse.mimeType ?? '',
    };
    previous.endMonoTs = p.timestamp;
    previous.entryId = `${previous.requestId}:redirect${++redirectSeq}`;
    finalize(previous);
  }
  const rec: RawRequest = {
    requestId: p.requestId,
    entryId: p.requestId,
    wallTimeMs: Math.round(p.wallTime * 1000),
    monoTs: p.timestamp,
    method: p.request.method,
    url: p.request.url,
    headers: headerMap(p.request.headers),
    resourceType: p.type ?? 'Other',
    initiator: convertInitiator(p.initiator),
  };
  if (p.request.postData !== undefined) {
    rec.postData = p.request.postData;
  } else if (p.request.postDataEntries?.length) {
    rec.postData = p.request.postDataEntries.map((e: { bytes?: string }) => Buffer.from(e.bytes ?? '', 'base64').toString('utf8')).join('');
  } else if (p.request.hasPostData) {
    track(
      send<{ postData: string }>('Network.getRequestPostData', { requestId: p.requestId })
        .then((r) => (rec.postData = r.postData))
        .catch(() => (rec.bodyOmitted = 'request body unavailable')),
    );
  }
  rec.postDataMime = rec.headers['Content-Type'] ?? rec.headers['content-type'];
  const early = earlyExtraHeaders.get(p.requestId);
  if (early) {
    rec.extraRequestHeaders = early;
    earlyExtraHeaders.delete(p.requestId);
  }
  requests.set(p.requestId, rec);
});

// Chrome may emit the ExtraInfo event (raw headers incl. Cookie and Origin) before requestWillBeSent.
const earlyExtraHeaders = new Map<string, Record<string, string>>();
cdp.on('Network.requestWillBeSentExtraInfo', (p, sid) => {
  if (!isOurs(sid)) return;
  const rec = requests.get(p.requestId);
  if (rec && !rec.extraRequestHeaders) rec.extraRequestHeaders = headerMap(p.headers);
  else if (!rec) earlyExtraHeaders.set(p.requestId, headerMap(p.headers));
});

cdp.on('Network.responseReceived', (p, sid) => {
  if (!isOurs(sid)) return;
  const rec = requests.get(p.requestId);
  if (!rec) return;
  rec.response = {
    status: p.response.status,
    statusText: p.response.statusText,
    protocol: p.response.protocol,
    headers: headerMap(p.response.headers),
    mimeType: p.response.mimeType ?? '',
  };
  if (p.type) rec.resourceType = p.type;
});

// A full navigation right after an API call (save, then redirect) discards the body before
// Network.getResponseBody can read it. XHR/Fetch responses are therefore held for a moment at the
// response stage, read, and released unchanged; nothing is modified or sent to the server.
cdp.on('Fetch.requestPaused', (p, sid) => {
  if (!isOurs(sid)) return;
  const release = () => send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  const status = p.responseStatusCode ?? 0;
  if (status >= 300 && status < 400) {
    void release();
    return;
  }
  track(
    send<{ body: string; base64Encoded: boolean }>('Fetch.getResponseBody', { requestId: p.requestId })
      .then((r) => {
        const rec = requests.get(p.networkId);
        if (rec && r.body.length <= MAX_BODY_BYTES * 1.4) rec.heldBody = r;
      })
      .catch(() => {})
      .finally(release),
  );
});

cdp.on('Network.responseReceivedExtraInfo', (p, sid) => {
  if (!isOurs(sid)) return;
  const rec = requests.get(p.requestId);
  if (rec) rec.extraResponseHeaders = headerMap(p.headers);
});

cdp.on('Network.loadingFinished', (p, sid) => {
  if (!isOurs(sid)) return;
  const rec = requests.get(p.requestId);
  if (!rec) return;
  rec.endMonoTs = p.timestamp;
  rec.encodedDataLength = p.encodedDataLength;
  const mime = rec.response?.mimeType ?? '';
  const wantBody = BODY_RESOURCE_TYPES.has(rec.resourceType) && rec.method !== 'OPTIONS';
  if (!wantBody) {
    finalize(rec);
    return;
  }
  if ((p.encodedDataLength ?? 0) > MAX_BODY_BYTES) {
    rec.bodyOmitted = `body larger than ${MAX_BODY_BYTES} bytes`;
    finalize(rec);
    return;
  }
  track(
    send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: p.requestId })
      .catch((e) => {
        if (rec.heldBody) return rec.heldBody;
        throw e;
      })
      .then((r) => {
        if (r.base64Encoded && TEXTUAL_MIME.test(mime)) rec.body = { text: Buffer.from(r.body, 'base64').toString('utf8'), base64: false };
        else if (r.base64Encoded) rec.bodyOmitted = `binary body (${mime || 'unknown type'}) omitted: cannot be redacted`;
        else rec.body = { text: r.body, base64: false };
      })
      .catch(() => (rec.bodyOmitted = 'response body unavailable'))
      .finally(() => finalize(rec)),
  );
});

cdp.on('Network.loadingFailed', (p, sid) => {
  if (!isOurs(sid)) return;
  const rec = requests.get(p.requestId);
  if (!rec) return;
  rec.endMonoTs = p.timestamp;
  rec.failed = p.canceled ? 'canceled' : p.blockedReason ? `blocked: ${p.blockedReason}` : p.errorText;
  finalize(rec);
});

cdp.on('Network.webSocketCreated', (p, sid) => {
  if (!isOurs(sid)) return;
  wsUrls.set(p.requestId, p.url);
  events.push({ t: Date.now(), type: 'ws-open', requestId: p.requestId, url: p.url });
});

const onFrame = (direction: 'sent' | 'received') => (p: any, sid: string | undefined) => {
  if (!isOurs(sid)) return;
  const payload: string = p.response?.payloadData ?? '';
  const opcode: number = p.response?.opcode ?? 1;
  const binary = opcode === 2;
  events.push({
    t: Date.now(),
    type: 'ws-frame',
    requestId: p.requestId,
    direction,
    opcode,
    payload: binary ? `<binary frame, ${payload.length} base64 chars omitted>` : payload.slice(0, MAX_WS_PAYLOAD),
    ...(payload.length > MAX_WS_PAYLOAD && !binary ? { truncated: true } : {}),
  });
};
cdp.on('Network.webSocketFrameSent', onFrame('sent'));
cdp.on('Network.webSocketFrameReceived', onFrame('received'));
cdp.on('Network.webSocketClosed', (p, sid) => {
  if (isOurs(sid)) events.push({ t: Date.now(), type: 'ws-close', requestId: p.requestId });
});
cdp.on('Network.eventSourceMessageReceived', (p, sid) => {
  if (isOurs(sid)) events.push({ t: Date.now(), type: 'sse', requestId: p.requestId, eventName: p.eventName, data: String(p.data).slice(0, MAX_WS_PAYLOAD) });
});

// ---- page, actions, scripts ------------------------------------------------

cdp.on('Page.frameNavigated', (p, sid) => {
  if (isOurs(sid) && !p.frame.parentId) {
    events.push({ t: Date.now(), type: 'navigation', url: p.frame.url, sameDocument: false });
    scheduleUiSnapshot();
  }
});
cdp.on('Page.navigatedWithinDocument', (p, sid) => {
  if (isOurs(sid)) {
    events.push({ t: Date.now(), type: 'navigation', url: p.url, sameDocument: true });
    scheduleUiSnapshot();
  }
});
cdp.on('Runtime.bindingCalled', (p, sid) => {
  if (!isOurs(sid) || p.name !== ACTION_BINDING) return;
  try {
    const a = JSON.parse(p.payload) as { kind: string; t: number; target: ActionTarget; url: string; key?: string; valueInfo?: { type: string; length: number } };
    scheduleUiSnapshot();
    events.push({ t: a.t, type: 'action', id: `a${++actionSeq}`, kind: a.kind, target: a.target, url: a.url, ...(a.key ? { key: a.key } : {}), ...(a.valueInfo ? { valueInfo: a.valueInfo } : {}) });
  } catch {
    // Malformed payload from the page: ignore.
  }
});
cdp.on('Debugger.scriptParsed', (p, sid) => {
  if (!isOurs(sid) || !/^https?:/.test(p.url ?? '')) return;
  scripts.set(p.scriptId, { scriptId: p.scriptId, url: p.url, sourceMapURL: p.sourceMapURL || undefined, length: p.length ?? 0 });
});

// ---- UI snapshots ------------------------------------------------------------
// A view is described once nothing has happened for UI_QUIET_MS after a navigation or action. Consecutive
// snapshots of the same URL replace each other, so each visit to a view keeps its settled state.

const UI_QUIET_MS = 1500;
const MAX_UI_SNAPSHOTS = 40;
const uiSnapshots: { t: number; afterAction?: string; snapshot: UiSnapshot }[] = [];
let uiTimer: NodeJS.Timeout | undefined;
function scheduleUiSnapshot(): void {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => void takeUiSnapshot(), UI_QUIET_MS);
}
async function takeUiSnapshot(): Promise<void> {
  if (cdp.closed) return;
  const snapshot = await track(send<{ result: { value: UiSnapshot } }>('Runtime.evaluate', { expression: UI_PROBE_SOURCE, returnByValue: true }))
    .then((r) => r.result.value)
    .catch(() => undefined);
  if (!snapshot?.regions) return;
  const entry = { t: Date.now(), ...(actionSeq ? { afterAction: `a${actionSeq}` } : {}), snapshot };
  if (uiSnapshots.at(-1)?.snapshot.url === snapshot.url) uiSnapshots[uiSnapshots.length - 1] = entry;
  else if (uiSnapshots.length < MAX_UI_SNAPSHOTS) uiSnapshots.push(entry);
}

let stopping = false;
let resolveStop!: (reason: string) => void;
const stopped = new Promise<string>((resolve) => (resolveStop = resolve));
const requestStop = (reason: string) => {
  if (!stopping) {
    stopping = true;
    resolveStop(reason);
  }
};
cdp.on('Target.detachedFromTarget', (p) => {
  if (p.sessionId === sessionId) requestStop('tab closed or detached');
});
cdp.onClose(() => requestStop('browser connection closed'));

await send('Network.enable', { maxPostDataSize: 1024 * 1024 });
await send('Fetch.enable', { patterns: ['XHR', 'Fetch'].map((resourceType) => ({ urlPattern: '*', resourceType, requestStage: 'Response' })) });
await send('Page.enable');
await send('Runtime.enable');
await send('Debugger.enable');
await send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 });
await send('Runtime.addBinding', { name: ACTION_BINDING });
await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_RECORDER_SOURCE });
await send('Runtime.evaluate', { expression: PAGE_RECORDER_SOURCE });
const { frameTree } = await send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree');
events.push({ t: Date.now(), type: 'capture-start', url: frameTree.frame.url });

process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));
if (args.duration) setTimeout(() => requestStop('duration elapsed'), Number(args.duration) * 1000).unref();

process.stderr.write(`specula capture: recording "${flow}" on ${pageTarget.url} (stop with Ctrl+C)\n`);
const stopReason = await stopped;
process.stderr.write(`specula capture: stopping (${stopReason}), collecting pending data...\n`);

// ---- collect after stop ----------------------------------------------------

let runtime: unknown;
let scriptRecords: ScriptRecord[] = [];
if (!cdp.closed) {
  clearTimeout(uiTimer);
  await takeUiSnapshot();
  await send('Fetch.disable').catch(() => {});
  events.push({ t: Date.now(), type: 'capture-stop', url: frameTree.frame.url });
  runtime = await send<{ result: { value: unknown } }>('Runtime.evaluate', { expression: RUNTIME_PROBE_SOURCE, returnByValue: true })
    .then((r) => r.result.value)
    .catch(() => undefined);
  await Promise.race([Promise.allSettled([...pendingWork]), new Promise((r) => setTimeout(r, 10_000))]);
  scriptRecords = await collectScripts(frameTree.frame.id);
  await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
}
for (const rec of requests.values()) {
  rec.failed ??= 'still pending when capture stopped';
  finished.push(rec);
}
cdp.close();
finished.sort((a, b) => a.monoTs - b.monoTs);

async function collectScripts(frameId: string): Promise<ScriptRecord[]> {
  await ensureDir(paths.sources);
  const indexFile = join(paths.sources, 'index.json');
  const index: Record<string, ScriptRecord> = existsSync(indexFile) ? JSON.parse(await readFile(indexFile, 'utf8')) : {};
  const records: ScriptRecord[] = [];
  const seen = new Set<string>();
  const callers = scriptsCallingTarget();
  // Newest first: after a reload the earlier script ids of the same URL no longer have a source.
  for (const script of [...scripts.values()].reverse()) {
    if (seen.has(script.url)) continue;
    const firstParty = new URL(script.url).origin === targetOrigin;
    const callsTarget = !firstParty && callers.has(script.url);
    if (!firstParty && !callsTarget) {
      seen.add(script.url);
      records.push({ url: script.url, sha256: '', file: '', length: script.length, firstParty, sourceMapUrl: script.sourceMapURL });
      continue;
    }
    const source = await send<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId: script.scriptId }).catch(() => undefined);
    if (!source) continue;
    seen.add(script.url);
    const sha256 = createHash('sha256').update(source.scriptSource).digest('hex');
    const name = basename(new URL(script.url).pathname).replace(/[^\w.-]/g, '_').replace(/\.m?js$/, '') || 'script';
    const file = `${name}.${sha256.slice(0, 8)}.js`;
    if (!existsSync(join(paths.sources, file))) await writeFile(join(paths.sources, file), source.scriptSource);
    const record: ScriptRecord = { url: script.url, sha256, file, length: source.scriptSource.length, firstParty, ...(callsTarget ? { callsTarget } : {}) };
    if (script.sourceMapURL) {
      record.sourceMapUrl = script.sourceMapURL.startsWith('data:') ? 'data:(inline)' : new URL(script.sourceMapURL, script.url).toString();
      const map = await loadSourceMap(script.sourceMapURL, script.url, frameId);
      if (map) {
        const mapFile = `${file}.map`;
        await writeFile(join(paths.sources, mapFile), map);
        record.sourceMapFile = mapFile;
      }
    }
    index[script.url] = record;
    records.push(record);
  }
  await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  return records;
}

/**
 * Third-party scripts that issued a request to the target: the app's own code served from a CDN
 * (Ghost's sign-up widget, for example). They are kept like first-party scripts.
 */
function scriptsCallingTarget(): Set<string> {
  const urls = new Set<string>();
  for (const rec of [...finished, ...requests.values()]) {
    if (!apiOrigins.has(new URL(rec.url).origin)) continue;
    for (const group of rec.initiator?.stack ?? []) for (const frame of group.frames) if (frame.url) urls.add(frame.url);
  }
  return urls;
}

/** Loads a source map the way DevTools does (Network.loadNetworkResource), only from the script's own origin. */
async function loadSourceMap(sourceMapURL: string, scriptUrl: string, frameId: string): Promise<string | undefined> {
  if (sourceMapURL.startsWith('data:')) {
    const comma = sourceMapURL.indexOf(',');
    const meta = sourceMapURL.slice(5, comma);
    const data = sourceMapURL.slice(comma + 1);
    return meta.includes('base64') ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data);
  }
  const url = new URL(sourceMapURL, scriptUrl);
  if (url.origin !== new URL(scriptUrl).origin) return undefined;
  const { resource } = await send<{ resource: { success: boolean; stream?: string } }>('Network.loadNetworkResource', {
    frameId,
    url: url.toString(),
    options: { disableCache: false, includeCredentials: false },
  }).catch(() => ({ resource: { success: false } as { success: boolean; stream?: string } }));
  if (!resource.success || !resource.stream) return undefined;
  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = await send<{ data: string; eof: boolean; base64Encoded?: boolean }>('IO.read', { handle: resource.stream, size: 1 << 20 });
    chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
    if (chunk.eof) break;
  }
  await send('IO.close', { handle: resource.stream }).catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

// ---- auth facts (from raw data, values never stored) -----------------------

/** Merges the regular and ExtraInfo header sets case-insensitively; ExtraInfo (raw, incl. cookies) wins. */
function mergeHeaders(base: Record<string, string> | undefined, extra: Record<string, string> | undefined): Record<string, string> {
  const byLower = new Map<string, [string, string]>();
  for (const source of [base ?? {}, extra ?? {}]) for (const [name, value] of Object.entries(source)) byLower.set(name.toLowerCase(), [name, value]);
  return Object.fromEntries(byLower.values());
}
function allRequestHeaders(rec: RawRequest): Record<string, string> {
  return mergeHeaders(rec.headers, rec.extraRequestHeaders);
}
function allResponseHeaders(rec: RawRequest): Record<string, string> {
  return mergeHeaders(rec.response?.headers, rec.extraResponseHeaders);
}

const auth: AuthFacts = { authorization: [], cookiesSent: [], cookiesSet: [], csrfHeaders: [], tokenFieldsInResponses: [] };
finished.forEach((rec, entry) => {
  for (const [name, value] of Object.entries(allRequestHeaders(rec))) {
    const lower = name.toLowerCase();
    if (lower === 'authorization') {
      const [scheme = '', credentials = ''] = value.split(/\s+/, 2);
      let fact = auth.authorization.find((a) => a.scheme.toLowerCase() === scheme.toLowerCase());
      if (!fact) auth.authorization.push((fact = { scheme, count: 0, firstEntry: entry }));
      fact.count++;
      if (looksLikeJwt(credentials)) {
        // Keep the shortest lifetime seen: a flow can span tokens issued under different settings.
        const jwt = describeJwt(credentials);
        if (!fact.jwt || (jwt?.lifetimeSec !== undefined && (fact.jwt.lifetimeSec === undefined || jwt.lifetimeSec < fact.jwt.lifetimeSec))) fact.jwt = jwt;
      }
    } else if (lower === 'cookie' && apiOrigins.has(new URL(rec.url).origin)) {
      for (const part of value.split(';')) {
        const cookieName = part.split('=')[0]?.trim();
        if (cookieName && !auth.cookiesSent.includes(cookieName)) auth.cookiesSent.push(cookieName);
      }
    } else if (/^x-(csrf|xsrf)/.test(lower) && !auth.csrfHeaders.includes(lower)) {
      auth.csrfHeaders.push(lower);
    }
  }
  for (const [name, value] of Object.entries(allResponseHeaders(rec))) {
    if (name.toLowerCase() !== 'set-cookie') continue;
    for (const line of value.split('\n')) {
      const [pair, ...attributes] = line.split(';');
      auth.cookiesSet.push({ name: pair?.split('=')[0]?.trim() ?? '', attributes: attributes.map((a) => a.trim().split('=')[0] ?? '').filter(Boolean), entry });
    }
  }
  if (rec.body && /json/i.test(rec.response?.mimeType ?? '')) {
    try {
      walkTokens(JSON.parse(rec.body.text), '$', entry);
    } catch {
      // Not valid JSON.
    }
  }
});

function walkTokens(value: unknown, path: string, entry: number): void {
  if (Array.isArray(value)) value.slice(0, 5).forEach((v, i) => walkTokens(v, `${path}[${i}]`, entry));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && /token|jwt|access|refresh|session/i.test(key) && child.length >= 16) {
        auth.tokenFieldsInResponses.push({ entry, path: `${path}.${key}`, kind: looksLikeJwt(child) ? 'jwt' : 'opaque' });
      } else walkTokens(child, `${path}.${key}`, entry);
    }
  }
}

// ---- redaction -------------------------------------------------------------

const redactor = new Redactor({ extraHeaders: config.redact?.headers, extraKeys: config.redact?.keys, values: config.redact?.values, accountSecret: process.env.SPECULA_CAPTURE_PASSWORD, accountEmail: process.env.SPECULA_CAPTURE_EMAIL });

// Pass 1: learn every secret first, so a token seen late is also scrubbed where it appeared early.
for (const rec of finished) {
  redactor.learnFromUrl(rec.url);
  for (const [name, value] of Object.entries(allRequestHeaders(rec))) redactor.learnFromHeader(name, value);
  for (const [name, value] of Object.entries(allResponseHeaders(rec))) redactor.learnFromHeader(name, value);
  for (const text of [rec.postData, rec.body?.text]) {
    if (!text) continue;
    try {
      redactor.learnFromJson(JSON.parse(text));
    } catch {
      redactor.learnFromJson(text);
    }
  }
}
for (const event of events) {
  if (event.type === 'ws-frame' || event.type === 'sse') {
    const text = event.type === 'ws-frame' ? event.payload : event.data;
    try {
      redactor.learnFromJson(JSON.parse(text));
    } catch {
      redactor.learnFromJson(text);
    }
  }
}

// Pass 2: build redacted outputs.
const toHarHeaders = (headers: Record<string, string>): HarHeader[] =>
  Object.entries(headers).flatMap(([name, value]) =>
    name.toLowerCase() === 'set-cookie'
      ? value.split('\n').map((line) => ({ name, value: redactor.header(name, line) }))
      : [{ name, value: redactor.header(name, value) }],
  );

const entries: HarEntry[] = finished.map((rec) => {
  const url = redactor.url(rec.url);
  const parsed = new URL(url.startsWith('data:') ? 'http://invalid/' : url);
  const time = rec.endMonoTs ? Math.max(0, Math.round((rec.endMonoTs - rec.monoTs) * 1000)) : -1;
  const mime = rec.response?.mimeType ?? '';
  const entry: HarEntry = {
    startedDateTime: new Date(rec.wallTimeMs).toISOString(),
    time,
    request: {
      method: rec.method,
      url,
      httpVersion: rec.response?.protocol ?? 'http/1.1',
      headers: toHarHeaders(allRequestHeaders(rec)),
      queryString: [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value })),
      cookies: [],
      headersSize: -1,
      bodySize: rec.postData ? Buffer.byteLength(rec.postData) : 0,
    },
    response: {
      status: rec.response?.status ?? 0,
      statusText: rec.response?.statusText ?? '',
      httpVersion: rec.response?.protocol ?? 'http/1.1',
      headers: toHarHeaders(allResponseHeaders(rec)),
      cookies: [],
      content: {
        size: rec.body ? Buffer.byteLength(rec.body.text) : (rec.encodedDataLength ?? 0),
        mimeType: mime,
        ...(rec.body ? { text: redactor.body(rec.body.text, mime) } : {}),
        ...(rec.bodyOmitted ? { comment: rec.bodyOmitted } : {}),
      },
      redirectURL: redactor.url(allResponseHeaders(rec).location ?? allResponseHeaders(rec).Location ?? ''),
      headersSize: -1,
      bodySize: rec.encodedDataLength ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    _requestId: rec.entryId,
    _resourceType: rec.resourceType,
    _wallTimeMs: rec.wallTimeMs,
  };
  if (rec.postData !== undefined) entry.request.postData = { mimeType: rec.postDataMime ?? '', text: redactor.body(rec.postData, rec.postDataMime ?? '') };
  if (rec.initiator) entry._initiator = { ...rec.initiator, url: rec.initiator.url ? redactor.url(rec.initiator.url) : undefined };
  if (rec.failed) entry._failed = rec.failed;
  return entry;
});

const redactedEvents: CaptureEvent[] = events
  // Stable sort keeps arrival order for events that share a millisecond.
  .sort((a, b) => a.t - b.t)
  .map((event) => {
    switch (event.type) {
      case 'action':
        return {
          ...event,
          url: redactor.url(event.url),
          target: {
            ...event.target,
            ...(event.target.name ? { name: redactor.string(event.target.name) } : {}),
            ...(event.target.href ? { href: redactor.string(event.target.href) } : {}),
          },
        };
      case 'navigation':
      case 'capture-start':
      case 'capture-stop':
        return { ...event, url: redactor.url(event.url) };
      case 'ws-open':
        return { ...event, url: redactor.url(event.url) };
      case 'ws-frame':
        return { ...event, payload: redactor.body(event.payload, 'application/json') };
      case 'sse':
        return { ...event, data: redactor.body(event.data, 'application/json') };
      default:
        return event;
    }
  });

const har: Har = {
  log: {
    version: '1.2',
    creator: { name: 'specula', version: '0.1.0' },
    pages: [],
    entries,
    comment: `flow=${flow}; redacted by specula; stop=${stopReason}`,
  },
};

const outputs: Record<string, string> = {
  [`${flow}.har`]: `${JSON.stringify(har, null, 2)}\n`,
  [`${flow}.events.jsonl`]: redactedEvents.map((e) => JSON.stringify(e)).join('\n') + '\n',
  [`${flow}.auth.json`]: `${JSON.stringify(auth, null, 2)}\n`,
  [`${flow}.scripts.json`]: `${JSON.stringify(scriptRecords, null, 2)}\n`,
  [`${flow}.ui.json`]: `${JSON.stringify({ flow, snapshots: uiSnapshots.map((s) => ({ ...s, snapshot: { ...s.snapshot, url: redactor.url(s.snapshot.url) } })) }, null, 1)}\n`,
  [`${flow}.runtime.json`]: `${JSON.stringify(runtime ? JSON.parse(redactor.body(JSON.stringify(runtime), 'application/json')) : null, null, 2)}\n`,
};

// Final leak scan: refuse to write anything if a secret slipped through.
const leaks = Object.entries(outputs).flatMap(([file, text]) => redactor.findLeaks(text).map((leak) => ({ file, ...leak })));
if (leaks.length) {
  process.stderr.write(`specula capture: refusing to write, ${leaks.length} possible leak(s) found:\n`);
  for (const leak of leaks.slice(0, 20)) process.stderr.write(`  ${leak.file} @${leak.offset}: ${leak.kind}\n`);
  printSummary({ ok: false, flow, reason: 'leak-scan-failed', leaks: leaks.length });
  process.exit(3);
}

await ensureDir(paths.capture);
for (const [file, text] of Object.entries(outputs)) await writeFile(join(paths.capture, file), text);

printSummary({
  ok: true,
  flow,
  stopReason,
  entries: entries.length,
  actions: redactedEvents.filter((e) => e.type === 'action').length,
  wsFrames: redactedEvents.filter((e) => e.type === 'ws-frame').length,
  scripts: scriptRecords.length,
  sourceMaps: scriptRecords.filter((s) => s.sourceMapFile).length,
  uiSnapshots: uiSnapshots.length,
  files: Object.keys(outputs).map((f) => `capture/${f}`),
});
process.exit(0);
