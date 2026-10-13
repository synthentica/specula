// Replays spec/flows/*.json (in index order) against a running instance and scores how many recorded
// behaviours it reproduces. Writes parity/report.{md,json} (label "rebuild") or parity/<label>.{md,json}.
//
//   node src/parity.ts --target <name> --base-url http://localhost:4456 [--label rebuild] [--flow <flow>] [--dry-run] [--skip-app-waits]
//
// --dry-run scores and prints the summary without writing parity/ files (used by src/demo.ts).
// --emit-state <file> writes the test account and the last value of every path parameter after the replay
// (`{"params": {"projectId": 2}}`), so the visual check can open the views the flows left behind.
// --skip-app-waits drops recorded pauses where the original app itself waited (pauseReason "app-wait").
//
// --original marks a baseline run against a local copy of the original. Only then does the runner read
// target.json: spec/ names the brand "app", so the original's prefix comes from there and its responses
// are neutralized the same way before comparing.
//
// Realtime: a flow's `send` steps go over a WebSocket the runner opens for that flow, and each pushed message
// the recording expects (`receive`) is one more behaviour, matched among the messages the socket received.
//
// Test account: SPECULA_USERNAME / SPECULA_PASSWORD / SPECULA_EMAIL, or random values per run.
// Replays only the requests the recorded app made, to an instance you run yourself (the rebuild, or a
// local copy of the original as a baseline).

import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { neutralizer } from './lib/brand.ts';
import { ensureDir, loadTarget, printSummary, targetPaths } from './lib/target.ts';

const { values: args } = parseArgs({
  options: { target: { type: 'string' }, 'base-url': { type: 'string' }, label: { type: 'string', default: 'rebuild' }, flow: { type: 'string' }, original: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, 'emit-state': { type: 'string' }, 'skip-app-waits': { type: 'boolean', default: false }, 'timeout-ms': { type: 'string', default: '10000' } },
});
if (!args.target || !args['base-url']) {
  process.stderr.write('Usage: node src/parity.ts --target <name> --base-url <http://host:port> [--label rebuild] [--flow <flow>] [--dry-run] [--skip-app-waits]\n');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(args.label!)) throw new Error('--label must be kebab-case');
const paths = targetPaths(args.target);
// Replay settings come from spec/ (written by infer-api), so the checker never needs target.json,
// which a rebuild must not see (it names the original's brand).
const settings = JSON.parse(await readFile(join(paths.flows, 'index.json'), 'utf8')) as { order: string[]; apiPrefix?: string; volatileKeys?: string[]; headers?: Record<string, string> };
const baseUrl = new URL(args['base-url']);
const original = args.original ? (await loadTarget(args.target)).config : undefined;
const apiPrefix = original ? original.apiPrefix ?? '' : settings.apiPrefix ?? '';
const neutral = neutralizer(original?.brand);
const timeoutMs = Number(args['timeout-ms']);

// ---- spec ---------------------------------------------------------------------------

interface Receive {
  channel: string;
  kind: string;
  message: unknown;
  source: string;
}
interface Step {
  action: { kind: string; target?: { name?: string } } | null;
  pauseMs?: number;
  pauseReason?: 'token-lifetime' | 'app-wait';
  /** A message the client sent on a WebSocket (no HTTP request). `reconnect`: the client had opened a new socket. */
  send?: { channel: string; reconnect?: boolean; message: unknown };
  /** Messages the server pushed after this step. */
  receive?: Receive[];
  request?: {
    operationId: string;
    /** GraphQL operations in the body, in batch order. */
    graphql?: string[];
    method: string;
    path: string;
    pathParams?: Record<string, { var: string } | { value: string | number }>;
    query?: [string, string | { $template: string }][];
    body?: unknown;
    contentType?: string;
    auth: 'bearer' | 'cookie' | 'none';
    /** Headers that carry a token bound from an earlier response (`x-app-share-token`). */
    tokenHeaders?: Record<string, { var: string }>;
    expect: { status: number; contentType: string; body?: unknown };
    source: string;
    bind?: Record<string, string>;
  };
}
interface FlowSpec {
  name: string;
  steps: Step[];
}

const index = settings;
const order = args.flow ? index.order.slice(0, index.order.indexOf(args.flow) + 1) : index.order;
if (args.flow && !index.order.includes(args.flow)) throw new Error(`Unknown flow ${args.flow}`);
const flows: FlowSpec[] = await Promise.all(order.map(async (name) => JSON.parse(await readFile(join(paths.flows, `${name}.json`), 'utf8')) as FlowSpec));

// ---- test account and placeholders ---------------------------------------------------

const suffix = randomBytes(3).toString('hex');
const account = {
  username: process.env.SPECULA_USERNAME ?? `parity-${suffix}`,
  password: process.env.SPECULA_PASSWORD ?? `Parity-${randomBytes(6).toString('hex')}`,
  email: process.env.SPECULA_EMAIL ?? `parity-${suffix}@example.test`,
};
const PLACEHOLDER = /^<redacted:(\w+)(?::(other|\d+))?>$/;
// <redacted:secret:other> is a password the recording shows was not the account's (a wrong-password attempt).
// <redacted:email:N> is another person's address (a user the flow created): one stable address per N.
const otherSecret = `Other-${randomBytes(6).toString('hex')}`;

function credentialFor(kind: string, key?: string, variant?: string): string | undefined {
  if (variant === 'other') return otherSecret;
  if (variant && kind === 'email') return `parity-${suffix}-${variant}@example.test`;
  if (kind === 'secret' || (key && /pass/i.test(key))) return account.password;
  if (kind === 'email' || (key && /mail/i.test(key))) return account.email;
  if (kind === 'pii') return account.username;
  return undefined;
}

// ---- requests ------------------------------------------------------------------------

// Some apps restart themselves (a setup wizard reloads its config), so once the instance has answered,
// a refused or dropped connection is retried for up to 30 s before the step counts as failed.
const RESTART_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);
async function fetchWithRestart(url: URL, init: RequestInit): Promise<Response> {
  const giveUp = Date.now() + 30_000;
  for (;;) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const code = ((error as Error).cause as { code?: string } | undefined)?.code;
      if (!reachable || !code || !RESTART_CODES.has(code) || Date.now() > giveUp) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

// ---- variables, auth state -----------------------------------------------------------

const vars = new Map<string, unknown>();
let bearer: string | undefined;
const jar = new Map<string, { name: string; value: string; path: string }>(); // key: name + path

/** `$.a[0].b`, plus `[?key="value"]`: the list element whose `key` has that (JSON-encoded) value. */
function jsonPath(value: unknown, path: string): unknown {
  let node: any = value;
  for (const [, key, idx, selKey, selValue] of path.replace(/^\$/, '').matchAll(/\.([^.[\]]+)|\[(\d+)\]|\[\?([^=\]]+)=("(?:[^"\\]|\\.)*"|[^\]]*)\]/g)) {
    if (node === null || node === undefined) return undefined;
    if (selKey !== undefined) {
      const wanted = JSON.parse(selValue!);
      node = Array.isArray(node) ? node.find((item) => item && typeof item === 'object' && item[selKey] === wanted) : undefined;
    } else node = key !== undefined ? node[key] : node[Number(idx)];
  }
  return node;
}

class Unbound extends Error {}

const TIME_FORMATS: Record<string, (d: Date) => string> = {
  iso: (d) => d.toISOString(),
  'iso-s': (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  sql: (d) => d.toISOString().slice(0, 19).replace('T', ' '),
};

/** Fills a `$template` string: {{var:name}}, {{now:<seconds>:<format>}}, {{lb}} / {{rb}} for literal braces. */
function fillTemplate(template: string): string {
  return template.replace(/\{\{(\w+)(?::([^:}]+))?(?::([^}]+))?\}\}/g, (_, kind: string, a: string, b: string) => {
    if (kind === 'lb') return '{';
    if (kind === 'rb') return '}';
    if (kind === 'var') {
      if (!vars.has(a)) throw new Unbound(a);
      return String(vars.get(a));
    }
    if (kind === 'now') return (TIME_FORMATS[b] ?? TIME_FORMATS.iso!)(new Date(Date.now() + Number(a) * 1000));
    throw new Error(`Unknown template token ${kind}`);
  });
}

/** Replaces {$var}, {$template}, redacted credential placeholders, recursively. */
function materialize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => materialize(v));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.$var === 'string' && Object.keys(o).length === 1) {
      if (!vars.has(o.$var)) throw new Unbound(o.$var);
      return vars.get(o.$var);
    }
    if (typeof o.$template === 'string' && Object.keys(o).length === 1) return fillTemplate(o.$template);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, materialize(v, k)]));
  }
  if (typeof value === 'string') {
    const m = value.match(PLACEHOLDER);
    if (m) return credentialFor(m[1]!, key, m[2]) ?? value;
  }
  return value;
}

function storeCookies(res: Response): void {
  for (const header of res.headers.getSetCookie()) {
    const [pair = '', ...attrs] = header.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    let path = '/';
    let expired = false;
    for (const attr of attrs) {
      const [k = '', v = ''] = attr.split('=');
      if (/^path$/i.test(k)) path = v || '/';
      if (/^max-age$/i.test(k) && Number(v) <= 0) expired = true;
      if (/^expires$/i.test(k) && Date.parse(v) < Date.now()) expired = true;
    }
    if (expired) jar.delete(`${name}|${path}`);
    else jar.set(`${name}|${path}`, { name, value, path });
  }
}

function cookieHeader(pathname: string): string | undefined {
  const matching = [...jar.values()].filter((c) => pathname === c.path || pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`) || c.path === '/');
  return matching.length ? matching.map((c) => `${c.name}=${c.value}`).join('; ') : undefined;
}

// An opaque session token comes back under a plain token key (`{"token": "<redacted:secret>"}`), unlike
// other secrets in responses (`signupToken`, invite keys) that the client never sends as its bearer.
const SESSION_TOKEN_KEY = /^(access_?|session_?|auth_?)?token$/i;

/**
 * Remembers a new bearer token wherever the recording had one in the response, except at paths the step binds
 * explicitly: those tokens travel in a header of their own (`tokenHeaders`), not as the bearer.
 */
function learnToken(expected: unknown, actual: unknown, bound: Set<string> = new Set()): void {
  const walk = (e: unknown, a: unknown, path: string, key?: string) => {
    if (bound.has(path)) return;
    if (typeof a === 'string' && a && (e === '<redacted:jwt>' || (key && SESSION_TOKEN_KEY.test(key) && (e === '<redacted:secret>' || e === '<redacted:token>')))) bearer = a;
    else if (e && typeof e === 'object' && a && typeof a === 'object')
      for (const [k, v] of Object.entries(e)) walk(v, (a as Record<string, unknown>)[k], Array.isArray(e) ? `${path}[${k}]` : `${path}.${k}`, Array.isArray(e) ? key : k);
  };
  walk(expected, actual, '$');
}

/** Like materialize, but a redacted token in a socket message (`{"action":"auth","token":...}`) is the session's bearer. */
function materializeMessage(value: unknown, key?: string): unknown {
  if (typeof value === 'string' && key && /token|jwt/i.test(key) && /^<redacted:(jwt|token|secret)>$/.test(value)) return bearer ?? value;
  if (Array.isArray(value)) return value.map((v) => materializeMessage(v));
  if (value && typeof value === 'object' && !('$var' in value || '$template' in value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materializeMessage(v, k)]));
  return materialize(value, key);
}

// ---- comparison ----------------------------------------------------------------------

const volatileKeys = new Set(['$schema', ...(settings.volatileKeys ?? ['id', 'created', 'updated'])]);
const sentStrings = new Set<string>();
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// Strings that recorded responses had already shown before the client sent them back (a role description
// inside a user object the client saves whole) are the server's own data, not values the user entered,
// so they are not compared as sent values.
const serverStrings = new Set<string>();
function rememberServer(value: unknown): void {
  if (typeof value === 'string' && value) serverStrings.add(value);
  else if (Array.isArray(value)) value.forEach(rememberServer);
  else if (value && typeof value === 'object') Object.values(value).forEach(rememberServer);
}

function rememberSent(value: unknown): void {
  if (typeof value === 'string' && value && !PLACEHOLDER.test(value) && !serverStrings.has(value)) sentStrings.add(value);
  else if (Array.isArray(value)) value.forEach(rememberSent);
  else if (value && typeof value === 'object') Object.values(value).forEach(rememberSent);
}

/** key → value pairs the current request sets (object fields, bulk items, JSON Patch ops). */
function requestFields(body: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 2 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object' && 'op' in item && 'path' in item && 'value' in item) out.set(String(item.path).split('/').pop()!, (item as { value: unknown }).value);
        else visit(item, depth + 1);
      }
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && serverStrings.has(x) && !sentStrings.has(x)) continue;
      if (x === null || typeof x !== 'object') out.set(k, x);
      else visit(x, depth + 1);
    }
  };
  visit(body, 0);
  return out;
}

const checks = { keys: 0, values: 0, lists: 0, flags: 0 };
const jsonType = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

let errorBody = false; // set per step: numbers in an error body (status, code) are part of the contract

/** A GraphQL response (or batch of them) with top-level errors: an error body although the status is 200. */
const hasGraphqlErrors = (body: unknown) => (Array.isArray(body) ? body : [body]).some((r) => r && typeof r === 'object' && Array.isArray((r as { errors?: unknown }).errors));
/** An in-band failure result (`{ succeeded: false, errorCode: 1002 }`): its numbers are error codes. */
const isFailureResult = (o: object) => Object.entries(o).some(([k, v]) => /^(succeeded|success|ok)$/i.test(k) && v === false);

function compare(expected: unknown, actual: unknown, path: string, fields: Map<string, unknown>, diffs: string[], key?: string): void {
  if (diffs.length >= 12) return;
  if (expected === null) return; // recorded null accepts any value
  const et = jsonType(expected);
  const at = jsonType(actual);
  if (actual === undefined) {
    diffs.push(`${path}: missing`);
    return;
  }
  if (et !== at) {
    diffs.push(`${path}: expected ${et}, got ${at}`);
    return;
  }
  if (et === 'array') {
    const e = expected as unknown[];
    const a = actual as unknown[];
    // Record lists (arrays of objects) must have the recorded size; scalar lists such as server
    // capability names are configuration, so only their element types are compared. A list recorded
    // empty is a record list when records come back in it (a deleted row still listed).
    const isRecord = (x: unknown) => x !== null && typeof x === 'object' && !Array.isArray(x);
    const records = e.some(isRecord) || (e.length === 0 && a.some(isRecord));
    if (records) checks.lists++;
    if (records && e.length !== a.length) diffs.push(`${path}: expected ${e.length} items, got ${a.length}`);
    const saved = { ...checks };
    const positional: string[] = [];
    for (let i = 0; i < Math.min(e.length, a.length); i++) compare(e[i], a[i], `${path}[${i}]`, fields, positional);
    // A list whose recorded order follows no field (rows in storage order, keyed by random ids) may come back
    // in another order: it passes when every recorded element matches a distinct returned one.
    if (positional.length && records && e.length === a.length && !hasEvidentOrder(e)) {
      Object.assign(checks, saved);
      const used = new Set<number>();
      const pairs: [number, number][] = [];
      for (let i = 0; i < e.length; i++) {
        // An element with the same fields and values first, so a sparse element does not take a fuller one's match.
        let j = a.findIndex((x, k) => !used.has(k) && sameRecord(e[i], x));
        if (j < 0) j = a.findIndex((x, k) => !used.has(k) && cleanMatch(e[i], x, fields));
        if (j < 0) break;
        used.add(j);
        pairs.push([i, j]);
      }
      if (pairs.length === e.length) {
        for (const [i, j] of pairs) compare(e[i], a[j], `${path}[${i}]`, fields, diffs);
        return;
      }
      for (let i = 0; i < e.length; i++) compare(e[i], a[i], `${path}[${i}]`, fields, []);
    }
    diffs.push(...positional);
    return;
  }
  if (et === 'object' && idKeyed(expected as object)) {
    // Keyed by record ids, which differ per instance: compare the number of entries and their values in order.
    const e = Object.values(expected as object);
    const a = Object.values(actual as object);
    checks.lists++;
    if (e.length !== a.length) diffs.push(`${path}: expected ${e.length} entries, got ${a.length}`);
    for (let i = 0; i < Math.min(e.length, a.length); i++) compare(e[i], a[i], `${path}[${i}]`, fields, diffs);
    return;
  }
  if (et === 'object') {
    checks.keys += Object.keys(expected as object).length;
    const outer = errorBody;
    if (isFailureResult(expected as object)) errorBody = true;
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) compare(v, (actual as Record<string, unknown>)[k], `${path}.${k}`, fields, diffs, k);
    errorBody = outer;
    return;
  }
  // Scalars: compare values only where the recording makes them meaningful.
  if (key && volatileKeys.has(key)) return;
  if (typeof expected === 'string' && (PLACEHOLDER.test(expected) || DATE_TIME.test(expected) || /^https?:\/\//.test(expected))) return;
  const echoed = key !== undefined && fields.has(key) && fields.get(key) === expected;
  const sent = typeof expected === 'string' && sentStrings.has(expected);
  // Counts: `total`, `totalHits`, `pagesTotal`, `total_pages`.
  const count = typeof expected === 'number' && key !== undefined && /^total($|[A-Z_])|[a-z]Total$|_total$/.test(key);
  // Booleans are state (done, published, enabled), never ids or clocks, so they must match.
  if (typeof expected === 'boolean') {
    checks.flags++;
    if (expected !== actual) diffs.push(`${path}: expected ${expected}, got ${JSON.stringify(actual)}`);
    return;
  }
  // In an error body, numbers (status, error codes) and a string `code` are the contract.
  const errorNumber = errorBody && (typeof expected === 'number' || (key === 'code' && typeof expected === 'string'));
  if (echoed || sent || count || errorNumber) checks.values++;
  if ((echoed || sent || count || errorNumber) && expected !== actual) diffs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** True when both have the same keys at every level and the same values, apart from ids, times and redacted values. */
function sameRecord(expected: unknown, actual: unknown, key?: string): boolean {
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const ek = Object.keys(expected);
    if (Array.isArray(expected) !== Array.isArray(actual) || ek.length !== Object.keys(actual).length) return false;
    return ek.every((k) => sameRecord((expected as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], Array.isArray(expected) ? key : k));
  }
  if (key && volatileKeys.has(key)) return true;
  if (typeof expected === 'string' && (PLACEHOLDER.test(expected) || DATE_TIME.test(expected) || RECORD_ID.test(expected) || RANDOM_ID.test(expected))) return typeof actual === 'string';
  return expected === actual;
}

/** True when compare() finds no difference, leaving the check counters as they were. */
function cleanMatch(expected: unknown, actual: unknown, fields: Map<string, unknown>): boolean {
  const saved = { ...checks };
  const diffs: string[] = [];
  compare(expected, actual, '$', fields, diffs);
  Object.assign(checks, saved);
  return diffs.length === 0;
}

/**
 * True when the recorded elements are sorted by some field: numbers or times with at least two distinct values
 * (positions, sequential ids, creation times), or other text with at least three (names in alphabetical order).
 */
function hasEvidentOrder(list: unknown[]): boolean {
  const rows = list.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x));
  if (rows.length !== list.length || rows.length < 2) return true;
  const keys = Object.keys(rows[0]!).filter((k) => rows.every((r) => k in r));
  return keys.some((k) => {
    const values = rows.map((r) => r[k]);
    const numeric = values.every((v) => typeof v === 'number') || values.every((v) => typeof v === 'string' && DATE_TIME.test(v));
    const text = values.every((v) => typeof v === 'string' && !RECORD_ID.test(v) && !RANDOM_ID.test(v));
    if (!numeric && !text) return false;
    if (new Set(values).size < (numeric ? 2 : 3)) return false;
    const cmp = (x: unknown, y: unknown) => (numeric && typeof x === 'number' ? x - (y as number) : String(x).localeCompare(String(y)));
    const pairs = values.slice(1).map((v, i) => cmp(values[i], v));
    return pairs.every((d) => d <= 0) || pairs.every((d) => d >= 0);
  });
}

const RANDOM_ID = /^(?=(?:[a-z]*\d){2})(?=(?:\d*[a-z]){2})[a-z0-9]{20,32}$/;
const RECORD_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
const idKeyed = (o: object) => Object.keys(o).length > 0 && Object.keys(o).every((k) => RECORD_ID.test(k));

const baseMime = (ct: string | null | undefined) => (ct ?? '').split(';')[0]!.trim().toLowerCase();

// ---- replay --------------------------------------------------------------------------

interface StepResult {
  flow: string;
  step: number;
  operation: string;
  action?: string;
  pass: boolean;
  status?: number;
  diffs: string[];
  source: string;
}

const results: StepResult[] = [];
let reachable = false;
/** Path parameter values of the last successful request that used them (`projectId` -> 2), for --emit-state. */
const lastParams = new Map<string, unknown>();

// ---- realtime ------------------------------------------------------------------------

/** How long pushed messages may trail the end of a flow. */
const RECEIVE_WAIT_MS = 2000;
interface Inbound {
  channel: string;
  message: unknown;
  used: boolean;
}
interface Expectation extends Receive {
  fields: Map<string, unknown>;
  result: StepResult;
}
const messageKind = (m: unknown) => {
  const o = m && typeof m === 'object' ? (m as Record<string, unknown>) : undefined;
  return o ? String(o.action ?? o.type ?? o.event ?? o.op ?? '(untyped)') : '(non-JSON)';
};

/** Opens a socket for one flow; everything it receives goes to the flow's inbox. */
function openSocket(channel: string, inbox: Inbound[]): Promise<WebSocket> {
  const url = new URL(channel, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const cookie = cookieHeader(url.pathname);
  // Node's WebSocket takes extra handshake headers, as the browser sent its cookies.
  const ws = new (WebSocket as unknown as new (u: URL, o: object) => WebSocket)(url, cookie ? { headers: { Cookie: cookie } } : {});
  ws.onmessage = (ev) => {
    try {
      inbox.push({ channel, message: neutral(JSON.parse(String(ev.data))), used: false });
    } catch {
      inbox.push({ channel, message: String(ev.data), used: false });
    }
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no connection to ${channel} within ${timeoutMs} ms`)), timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`connection to ${channel} failed`));
    };
  });
}

/** compare() without touching the check counters: used to pick which received message an expectation is about. */
function trialDiffs(expected: unknown, actual: unknown, fields: Map<string, unknown>): number {
  const saved = { ...checks };
  const diffs: string[] = [];
  errorBody = false;
  compare(expected, actual, '$', fields, diffs);
  Object.assign(checks, saved);
  return diffs.length;
}

/** Waits for the pushed messages a flow expects, then matches each expectation to one unused message of its kind. */
async function settleRealtime(expectations: Expectation[], inbox: Inbound[], socketErrors: Map<string, string>): Promise<void> {
  if (!expectations.length) return;
  const wanted = (e: Expectation) => (m: Inbound) => !m.used && m.channel === e.channel && messageKind(m.message) === e.kind;
  const deadline = Date.now() + RECEIVE_WAIT_MS;
  const enough = () => expectations.every((e) => inbox.filter(wanted(e)).length >= expectations.filter((x) => x.channel === e.channel && x.kind === e.kind).length);
  while (!enough() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  for (const e of expectations) {
    const candidates = inbox.filter(wanted(e));
    if (!candidates.length) {
      const why = socketErrors.get(e.channel);
      e.result.diffs.push(`no "${e.kind}" message on ${e.channel} within ${RECEIVE_WAIT_MS} ms of the flow's last step${why ? ` (${why})` : ''}`);
      continue;
    }
    // The first message that compares cleanly, else the closest one (its differences are the report).
    const scored = candidates.map((m) => ({ m, n: trialDiffs(e.message, m.message, e.fields) }));
    const best = scored.find((x) => x.n === 0) ?? scored.reduce((a, b) => (b.n < a.n ? b : a));
    best.m.used = true;
    errorBody = false;
    compare(e.message, best.m.message, '$', e.fields, e.result.diffs);
    e.result.pass = e.result.diffs.length === 0;
  }
}

for (const flow of flows) {
  const sockets = new Map<string, WebSocket>();
  const socketErrors = new Map<string, string>();
  const inbox: Inbound[] = [];
  const expectations: Expectation[] = [];
  for (const [i, step] of flow.steps.entries()) {
    // A recorded idle longer than the token lifetime is replayed, so expiry-dependent behaviour is exercised.
    // An app wait (the original restarting itself after setup) can be skipped for an instance that never does.
    if (step.pauseMs && !(step.pauseReason === 'app-wait' && args['skip-app-waits'])) {
      process.stderr.write(`${flow.name} step ${i + 1}: pausing ${(step.pauseMs / 1000).toFixed(1)} s as recorded\n`);
      await new Promise((resolve) => setTimeout(resolve, step.pauseMs));
    }
    let fields = new Map<string, unknown>();
    const expectAfter = (label: string) => {
      for (const rec of step.receive ?? []) {
        rememberServer(rec.message);
        const result: StepResult = { flow: flow.name, step: i + 1, operation: `receive ${rec.kind} on ${rec.channel} (after ${label})`, pass: false, diffs: [], source: rec.source };
        results.push(result);
        expectations.push({ ...rec, fields, result });
      }
    };
    if (step.send) {
      const { channel, reconnect, message } = step.send;
      try {
        if (reconnect) sockets.get(channel)?.close();
        if (reconnect || !sockets.has(channel)) {
          sockets.delete(channel);
          sockets.set(channel, await openSocket(channel, inbox));
          socketErrors.delete(channel);
        }
        const payload = materializeMessage(message);
        rememberSent(payload);
        fields = requestFields(payload);
        sockets.get(channel)!.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      } catch (error) {
        socketErrors.set(channel, error instanceof Unbound ? `variable ${error.message} was never bound` : (error as Error).message);
      }
      expectAfter(`sending ${messageKind(message)}`);
      continue;
    }
    const r = step.request!;
    const result: StepResult = {
      flow: flow.name,
      step: i + 1,
      operation: r.graphql ? `${r.graphql.join(' + ')} (${r.method} ${r.path})` : `${r.method} ${r.path}`,
      ...(step.action ? { action: `${step.action.kind}${step.action.target?.name ? ` "${step.action.target.name}"` : ''}` } : {}),
      pass: false,
      diffs: [],
      source: r.source,
    };
    results.push(result);
    const touched = new Map<string, unknown>();
    try {
      let pathname = r.path.replace(/\{(\w+)\}/g, (_, name: string) => {
        const p = r.pathParams?.[name];
        if (!p) throw new Unbound(name);
        let value: unknown;
        if ('var' in p) {
          if (!vars.has(p.var)) throw new Unbound(p.var);
          value = vars.get(p.var);
        } else value = materialize(p.value);
        touched.set(name, value);
        return encodeURIComponent(String(value));
      });
      pathname = `${apiPrefix}${pathname}`;
      const url = new URL(pathname, baseUrl);
      for (const [k, v] of r.query ?? []) url.searchParams.append(k, String(materialize(v, k)));
      const body = r.body === undefined ? undefined : materialize(r.body);
      rememberSent(body);
      fields = requestFields(body);
      rememberServer(r.expect.body);
      const headers: Record<string, string> = { Accept: 'application/json', ...settings.headers };
      if (body !== undefined) headers['Content-Type'] = r.contentType ?? 'application/json';
      if (r.auth === 'bearer' && bearer) headers.Authorization = `Bearer ${bearer}`;
      for (const [name, t] of Object.entries(r.tokenHeaders ?? {})) {
        if (!vars.has(t.var)) throw new Unbound(t.var);
        headers[name] = String(vars.get(t.var));
      }
      const cookie = cookieHeader(url.pathname);
      if (cookie) headers.Cookie = cookie;
      const res = await fetchWithRestart(url, {
        method: r.method,
        headers,
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        redirect: 'manual',
      });
      reachable = true;
      storeCookies(res);
      const text = await res.text();
      result.status = res.status;
      if (res.status !== r.expect.status) result.diffs.push(`status: expected ${r.expect.status}, got ${res.status}${text ? ` (${text.slice(0, 120).replace(/\s+/g, ' ')})` : ''}`);
      const ct = baseMime(res.headers.get('content-type'));
      if (r.expect.contentType && (text || r.expect.body !== undefined) && ct !== baseMime(r.expect.contentType)) result.diffs.push(`content-type: expected ${r.expect.contentType}, got ${ct || 'none'}`);
      let json: unknown;
      if (/json/.test(ct) && text) {
        try {
          json = neutral(JSON.parse(text));
        } catch {
          result.diffs.push('body: invalid JSON');
        }
      }
      if (r.expect.body !== undefined && res.status === r.expect.status) {
        errorBody = r.expect.status >= 400 || hasGraphqlErrors(r.expect.body);
        compare(r.expect.body, json, '$', fields, result.diffs);
        learnToken(r.expect.body, json, new Set(Object.values(r.bind ?? {})));
      }
      for (const [name, path] of Object.entries(r.bind ?? {})) {
        const value = jsonPath(json, path);
        if (value !== undefined && value !== null) vars.set(name, value);
      }
      if (res.status < 400 && r.method !== 'DELETE') for (const [name, value] of touched) lastParams.set(name, value);
      result.pass = result.diffs.length === 0;
    } catch (error) {
      rememberServer(r.expect.body);
      if (error instanceof Unbound) result.diffs.push(`not run: variable ${error.message} was never bound (an earlier step failed)`);
      else result.diffs.push(`request failed: ${(error as Error).message}`);
    }
    expectAfter(result.operation);
  }
  await settleRealtime(expectations, inbox, socketErrors);
  for (const ws of sockets.values()) ws.close();
}

// ---- report --------------------------------------------------------------------------

if (!reachable) {
  process.stderr.write(`No response from ${baseUrl.origin}. Is the instance running?\n`);
  process.exit(1);
}
const total = results.length;
const passed = results.filter((r) => r.pass).length;
const received = results.filter((r) => r.operation.startsWith('receive '));
const pct = total ? Math.round((passed / total) * 100) : 0;
const generated = new Date().toISOString();
const report = {
  label: args.label,
  baseUrl: baseUrl.origin,
  generated,
  passed,
  total,
  checks,
  flows: flows.map((f) => {
    const rs = results.filter((r) => r.flow === f.name);
    return { name: f.name, passed: rs.filter((r) => r.pass).length, total: rs.length };
  }),
  steps: results,
};
const fileBase = args.label === 'rebuild' ? 'report' : args.label!;
const esc = (s: string) => s.replace(/\|/g, '\\|');
const md = [
  `# Parity: ${args.label}`,
  '',
  `**Passes ${passed}/${total} recorded behaviours (${pct}%)** against ${baseUrl.origin}, ${generated}.`,
  '',
  `Checked ${checks.keys} response keys, ${checks.lists} list sizes, ${checks.values} values (echoed, totals, error codes) and ${checks.flags} true/false flags.`,
  '',
  `Each behaviour is one recorded request replayed in order on a fresh instance${received.length ? `, or one of ${received.length} messages the server pushed over a WebSocket (it passes when a message of the recorded kind arrives on the flow's socket and compares the same way)` : ''}. A step passes when the status code and content type match, every recorded response key exists with the same JSON type, lists of records have the recorded size, values the client sent come back unchanged, booleans match, and error codes match. Ids, timestamps and other volatile values are not compared.`,
  '',
  '| Flow | Passed |',
  '|---|---|',
  ...report.flows.map((f) => `| ${f.name} | ${f.passed}/${f.total} |`),
  ...(received.length ? ['', `Pushed realtime messages: ${received.filter((r) => r.pass).length}/${received.length}.`] : []),
  '',
  '## Failures',
  '',
  ...(results.some((r) => !r.pass)
    ? results
        .filter((r) => !r.pass)
        .flatMap((r) => [`### ${r.flow} step ${r.step}: \`${r.operation}\`${r.action ? ` (${esc(r.action)})` : ''}`, '', ...r.diffs.map((d) => `- ${d}`), `- recorded: \`${r.source}\``, ''])
    : ['_None._', '']),
].join('\n');
const files = args['dry-run'] ? [] : [`parity/${fileBase}.md`, `parity/${fileBase}.json`];
if (!args['dry-run']) {
  await ensureDir(paths.parity);
  await writeFile(join(paths.parity, `${fileBase}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(paths.parity, `${fileBase}.md`), md);
}

if (args['emit-state']) await writeFile(args['emit-state'], `${JSON.stringify({ baseUrl: baseUrl.origin, account, params: Object.fromEntries(lastParams) }, null, 2)}\n`, { mode: 0o600 });

printSummary({ ok: true, label: args.label, passed, total, percent: pct, checks, files });
