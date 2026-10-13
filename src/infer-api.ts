// infer-api: merges every observed API exchange into an OpenAPI 3.1 document, plus
// realtime/GraphQL message schemas and replayable flows for parity.
//
//   node src/infer-api.ts --target vikunja
//   node src/infer-api.ts --target vikunja diff --against <openapi-or-swagger.json>
//
// Writes spec/openapi.yaml, spec/openapi.json, spec/flows/*.json and, when observed,
// spec/realtime.json and spec/graphql.json.

import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type Flow, loadFlows } from './lib/captures.ts';
import type { HarEntry } from './lib/har.ts';
import { neutralizer } from './lib/brand.ts';
import { camel, isIdValue, isParamSegment, singular, templatePath } from './lib/paths.ts';
import { addSample, emptyShape, keySimilarity, mergeShapes, type JsonSchema, type Shape, toSchema } from './lib/schema.ts';
import { ensureDir, isTargetOrigin, loadTarget, printSummary } from './lib/target.ts';
import { toYaml } from './lib/yaml.ts';
import { diffSpecs } from './lib/spec-diff.ts';
import { graphqlRequests, normalizeDocument, operationKey, parseOperation } from './lib/graphql.ts';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { target: { type: 'string' }, against: { type: 'string' } } });
if (!args.target) {
  process.stderr.write('Usage: node src/infer-api.ts --target <name> [diff --against <spec.json>]\n');
  process.exit(2);
}
const { config, paths } = await loadTarget(args.target);

if (positionals[0] === 'diff') {
  if (!args.against) throw new Error('diff needs --against <path to the real OpenAPI/Swagger JSON>');
  const inferredFile = join(paths.spec, 'openapi.json');
  if (!existsSync(inferredFile)) throw new Error('Run infer-api first (spec/openapi.json missing).');
  const inferred = JSON.parse(await readFile(inferredFile, 'utf8'));
  const truth = JSON.parse(await readFile(args.against, 'utf8'));
  const { markdown, summary } = diffSpecs(inferred, truth, { apiPrefix: config.apiPrefix ?? '' });
  await ensureDir(paths.analysis);
  await writeFile(join(paths.analysis, 'spec-vs-source.md'), markdown);
  printSummary({ ok: true, file: 'analysis/spec-vs-source.md', ...summary });
  process.exit(0);
}

const apiPrefix = config.apiPrefix ?? '';
const volatileKeys = new Set(config.volatile?.keys ?? ['id', 'created', 'updated']);
const flowRank = (name: string) => {
  const i = config.flowOrder?.indexOf(name) ?? -1;
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};
const flows = (await loadFlows(paths)).sort((a, b) => flowRank(a.name) - flowRank(b.name) || firstTime(a) - firstTime(b));
for (const name of config.flowOrder ?? []) if (!flows.some((f) => f.name === name)) process.stderr.write(`flowOrder: no capture named "${name}"\n`);

function firstTime(flow: Flow): number {
  return flow.events.find((e) => e.type === 'capture-start')?.t ?? flow.har.log.entries[0]?._wallTimeMs ?? 0;
}
const parseJson = (text: string | undefined): unknown => {
  if (text === undefined || text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const headerValue = (entry: HarEntry, where: 'request' | 'response', name: string) => entry[where].headers.find((h) => h.name.toLowerCase() === name)?.value;
const baseMime = (mime: string | undefined) => (mime ?? '').split(';')[0]!.trim().toLowerCase();

// ---- select API exchanges -----------------------------------------------------------

interface Exchange {
  flow: Flow;
  index: number;
  entry: HarEntry;
  pathname: string; // without apiPrefix
  template: string; // without apiPrefix
  method: string;
  pathValues: Record<string, string>;
  requestJson: unknown;
  responseJson: unknown;
}

function isApi(entry: HarEntry): boolean {
  if (!isTargetOrigin(entry.request.url, config)) return false;
  if (!['Fetch', 'XHR', 'Other'].includes(entry._resourceType) || entry.request.method === 'OPTIONS') return false;
  if (!entry.response.status) return false;
  // apiPrefix "" (set explicitly): the API lives at the root (GraphQL at /graphql next to REST setup calls).
  if (config.apiPrefix === '') return /json/.test(entry.response.content.mimeType ?? '');
  return new URL(entry.request.url).pathname.startsWith(apiPrefix || '/api');
}

function toExchange(flow: Flow, entry: HarEntry, index: number): Exchange {
  const pathname = new URL(entry.request.url).pathname.slice(apiPrefix.length) || '/';
  const template = templatePath(pathname);
  const pathValues: Record<string, string> = {};
  const concrete = pathname.split('/');
  template.split('/').forEach((segment, i) => {
    const m = segment.match(/^\{(\w+)\}$/);
    if (m) pathValues[m[1]!] = decodeURIComponent(concrete[i]!);
  });
  return {
    flow,
    index,
    entry,
    pathname,
    template,
    method: entry.request.method,
    pathValues,
    requestJson: parseJson(entry.request.postData?.text),
    responseJson: /json/.test(entry.response.content.mimeType) ? parseJson(entry.response.content.text) : undefined,
  };
}

const exchanges: Exchange[] = flows.flatMap((flow) => flow.har.log.entries.flatMap((entry, index) => (isApi(entry) ? [toExchange(flow, entry, index)] : [])));
if (!exchanges.length) throw new Error(`No API exchanges under "${apiPrefix || '/api'}" in the captures.`);

// ---- aggregate operations -----------------------------------------------------------

interface Operation {
  method: string;
  template: string;
  flows: Set<string>;
  samples: number;
  pathParams: Map<string, Shape>;
  query: Map<string, { present: number; repeated: boolean; shape: Shape }>;
  requestBody?: { mime: string; shape: Shape; count: number };
  responses: Map<number, { mime: string; shape?: Shape; count: number; headers: Map<string, string> }>;
  bearer: number;
  cookies: Set<string>;
  patchPaths: Set<string>;
  /** Named schema for the 2xx body: the body itself, an array of it, or an envelope whose `envelope` property holds the array. */
  component?: { name?: string; array: boolean; envelope?: string };
}

const operations = new Map<string, Operation>();
for (const ex of exchanges) {
  const key = `${ex.method} ${ex.template}`;
  let op = operations.get(key);
  if (!op) {
    op = { method: ex.method, template: ex.template, flows: new Set(), samples: 0, pathParams: new Map(), query: new Map(), responses: new Map(), bearer: 0, cookies: new Set(), patchPaths: new Set() };
    operations.set(key, op);
  }
  op.flows.add(ex.flow.name);
  op.samples++;
  for (const [name, value] of Object.entries(ex.pathValues)) {
    const shape = op.pathParams.get(name) ?? emptyShape();
    addSample(shape, /^-?\d+$/.test(value) ? Number(value) : value);
    op.pathParams.set(name, shape);
  }
  const params = new URL(ex.entry.request.url).searchParams;
  const seen = new Set<string>();
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    const q = op.query.get(name) ?? { present: 0, repeated: false, shape: emptyShape() };
    q.present++;
    q.repeated ||= values.length > 1;
    for (const v of values) addSample(q.shape, /^-?\d+$/.test(v) ? Number(v) : v === 'true' || v === 'false' ? v === 'true' : v);
    op.query.set(name, q);
    seen.add(name);
  }
  if (ex.entry.request.postData?.text) {
    const mime = baseMime(ex.entry.request.postData.mimeType) || 'application/json';
    op.requestBody ??= { mime, shape: emptyShape(), count: 0 };
    op.requestBody.count++;
    if (ex.requestJson !== undefined) addSample(op.requestBody.shape, ex.requestJson);
    if (Array.isArray(ex.requestJson)) for (const item of ex.requestJson) if (item && typeof item === 'object' && 'op' in item && typeof item.path === 'string') op.patchPaths.add(item.path);
  }
  const status = ex.entry.response.status;
  const response = op.responses.get(status) ?? { mime: baseMime(ex.entry.response.content.mimeType), count: 0, headers: new Map<string, string>(), shape: undefined as Shape | undefined };
  response.count++;
  if (ex.responseJson !== undefined) addSample((response.shape ??= emptyShape()), ex.responseJson);
  for (const h of ex.entry.response.headers) if (/^x-/i.test(h.name)) response.headers.set(h.name, h.value);
  op.responses.set(status, response);
  if (/^bearer /i.test(headerValue(ex.entry, 'request', 'authorization') ?? '')) op.bearer++;
  for (const part of (headerValue(ex.entry, 'request', 'cookie') ?? '').split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name) op.cookies.add(name);
  }
}

// ---- components: merge structurally similar response objects -------------------------

const NON_RESOURCE = new Set(['bulk', 'search', 'refresh', 'token', 'login', 'logout', 'register', 'info', 'all', 'duplicate', 'move', 'read', 'check']);
function resourceName(template: string): string {
  const statics = template.split('/').filter((s) => s && !isParamSegment(s) && !s.startsWith('{'));
  let name = statics.at(-1) ?? 'root';
  if (NON_RESOURCE.has(name) && statics.length > 1 && !['login', 'logout', 'register', 'info', 'refresh', 'token'].includes(name)) name = statics.at(-2)!;
  return camel(singular(name)).replace(/^./, (c) => c.toUpperCase());
}

const components = new Map<string, Shape>();
function attachComponent(shape: Shape, wanted: string): string {
  let best: { name: string; score: number } | undefined;
  for (const [name, component] of components) {
    const score = keySimilarity(component, shape) + (name === wanted ? 0.15 : 0);
    if (score >= 0.5 && (!best || score > best.score)) best = { name, score };
  }
  if (best) {
    mergeShapes(components.get(best.name)!, shape);
    return best.name;
  }
  let name = wanted;
  for (let i = 2; components.has(name); i++) name = `${wanted}${i}`;
  components.set(name, mergeShapes(emptyShape(), shape));
  return name;
}
// Item endpoints first so their names win over list/bulk variants.
const ordered = [...operations.values()].sort((a, b) => Number(b.template.endsWith('}')) - Number(a.template.endsWith('}')) || a.template.length - b.template.length);
for (const op of ordered) {
  for (const [status, response] of op.responses) {
    if (status >= 300 || !response.shape) continue;
    const shape = response.shape;
    const wanted = resourceName(op.template);
    const envelope = envelopeOf(shape);
    if (envelope) {
      const items = shape.object!.props.get(envelope)!.array!.items;
      op.component = { array: false, envelope, ...(items.object && objectKeyCount(items) >= 3 ? { name: attachComponent(objectOnly(items), wanted) } : {}) };
    } else if (shape.object && objectKeyCount(shape) >= 3) op.component = { name: attachComponent(objectOnly(shape), selfDescribedName(shape) ?? wanted), array: false };
    else if (shape.array?.items.object && objectKeyCount(shape.array.items) >= 3) op.component = { name: attachComponent(objectOnly(shape.array.items), wanted), array: true };
  }
}

/** A list wrapper: exactly one array property (items/data/tasks...) next to scalar metadata (total, page...). */
function envelopeOf(shape: Shape): string | undefined {
  if (!shape.object) return undefined;
  const entries = [...shape.object.props.entries()];
  const arrays = entries.filter(([, p]) => p.array && !p.object && !p.string);
  const others = entries.filter(([, p]) => !p.array);
  if (arrays.length !== 1 || others.some(([, p]) => p.object)) return undefined;
  const [name, prop] = arrays[0]!;
  const hasObjects = !!prop.array!.items.object;
  const looksLikeList = /^(items|data|results|records|entries|list)$/.test(name) || others.some(([k]) => /total|count|page|cursor|next/i.test(k));
  return hasObjects || looksLikeList ? name : undefined;
}

/** Some APIs link each body to its schema ("$schema": ".../schemas/Task.json"); use that name when present. */
function selfDescribedName(shape: Shape): string | undefined {
  const values = [...(shape.object?.props.get('$schema')?.string?.values.keys() ?? [])];
  const names = new Set(values.map((v) => v.match(/\/([A-Za-z][\w]*)\.json$/)?.[1]).filter(Boolean));
  return names.size === 1 ? [...names][0] : undefined;
}
function objectKeyCount(shape: Shape): number {
  return shape.object?.props.size ?? 0;
}
function objectOnly(shape: Shape): Shape {
  return { count: shape.object!.count, nulls: 0, object: shape.object };
}
// Nested objects (labels on a task, owner of a project) also collapse into components.
function refFor(shape: Shape): string | undefined {
  if (!shape.object || objectKeyCount(shape) < 3) return undefined;
  let best: { name: string; score: number } | undefined;
  for (const [name, component] of components) {
    const score = keySimilarity(component, shape);
    if (score >= 0.6 && (!best || score > best.score)) best = { name, score };
  }
  return best && `#/components/schemas/${best.name}`;
}
const render = (shape: Shape) => toSchema(shape, { refFor, volatileKeys });

// ---- OpenAPI document -------------------------------------------------------------

const usedOperationIds = new Set<string>();
function operationId(op: Operation): string {
  const statics = op.template.split('/').filter((s) => s && !s.startsWith('{'));
  const base = op.method.toLowerCase() + statics.map((s) => camel(s).replace(/^./, (c) => c.toUpperCase())).join('') + (op.template.endsWith('}') ? 'ById' : '');
  let id = base;
  for (let i = 2; usedOperationIds.has(id); i++) id = `${base}${i}`;
  usedOperationIds.add(id);
  return id;
}

const opIds = new Map<string, string>();
const pathsDoc: Record<string, Record<string, unknown>> = {};
for (const op of [...operations.values()].sort((a, b) => a.template.localeCompare(b.template) || a.method.localeCompare(b.method))) {
  const id = operationId(op);
  opIds.set(`${op.method} ${op.template}`, id);
  const parameters: JsonSchema[] = [];
  for (const [name, shape] of op.pathParams) parameters.push({ name, in: 'path', required: true, schema: toSchema(shape, { volatileKeys: new Set([name]) }, name) });
  for (const [name, q] of [...op.query.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const valueSchema = toSchema(q.shape);
    parameters.push({
      name,
      in: 'query',
      required: q.present === op.samples,
      schema: q.repeated ? { type: 'array', items: valueSchema } : valueSchema,
      ...(q.repeated ? { style: 'form', explode: true } : {}),
    });
  }
  const responses: Record<string, unknown> = {};
  for (const [status, response] of [...op.responses.entries()].sort(([a], [b]) => a - b)) {
    const content: Record<string, unknown> = {};
    if (response.mime) {
      let schema: JsonSchema;
      if (op.component?.envelope && status < 300 && response.shape?.object) {
        const env = op.component.envelope;
        const o = response.shape.object;
        const properties: Record<string, JsonSchema> = {};
        for (const [k, prop] of [...o.props.entries()].sort(([x], [y]) => x.localeCompare(y))) {
          properties[k] = k === env ? { type: 'array', items: op.component.name ? { $ref: `#/components/schemas/${op.component.name}` } : render(prop.array!.items) } : toSchema(prop, { volatileKeys }, k);
        }
        const required = [...o.keyCounts.entries()].filter(([, n]) => n === o.count).map(([k]) => k).sort();
        schema = { type: 'object', properties, required };
      } else if (op.component?.name && status < 300 && response.shape) {
        const ref = { $ref: `#/components/schemas/${op.component.name}` };
        schema = op.component.array ? { type: 'array', items: ref } : ref;
      } else if (response.shape) schema = render(response.shape);
      else schema = /json/.test(response.mime) ? {} : { type: 'string', ...(/image|octet|pdf|zip/.test(response.mime) ? { format: 'binary' } : {}) };
      content[response.mime] = { schema };
    }
    responses[String(status)] = {
      description: `Observed ${response.count}×`,
      ...(response.headers.size ? { headers: Object.fromEntries([...response.headers.keys()].sort().map((h) => [h, { schema: { type: 'string' } }])) } : {}),
      ...(Object.keys(content).length ? { content } : {}),
    };
  }
  const security: Record<string, string[]>[] = [];
  if (op.bearer === op.samples) security.push({ bearerAuth: [] });
  const refreshCookie = [...op.cookies].find((c) => /refresh|session|token|auth/i.test(c));
  if (!security.length && refreshCookie) security.push({ [`cookie_${refreshCookie}`]: [] });
  const operation: Record<string, unknown> = {
    operationId: id,
    tags: [op.template.split('/').find((s) => s && !s.startsWith('{')) ?? 'root'],
    summary: `${op.method} ${op.template}`,
    ...(parameters.length ? { parameters } : {}),
    ...(op.requestBody
      ? {
          requestBody: {
            required: true,
            content: { [op.requestBody.mime]: { schema: op.requestBody.shape.count ? render(op.requestBody.shape) : {} } },
            ...(op.patchPaths.size ? { description: `JSON Patch document. Observed paths: ${[...op.patchPaths].sort().join(', ')}` } : {}),
          },
        }
      : {}),
    responses,
    security,
    'x-specula-samples': op.samples,
    'x-specula-flows': [...op.flows].sort(),
    ...(op.patchPaths.size ? { 'x-specula-patch-paths': [...op.patchPaths].sort() } : {}),
  };
  (pathsDoc[op.template] ??= {})[op.method.toLowerCase()] = operation;
}

const securitySchemes: Record<string, unknown> = {};
const anyAuth = flows.flatMap((f) => f.auth.authorization);
if (anyAuth.length) {
  const jwt = anyAuth.find((a) => a.jwt)?.jwt;
  securitySchemes.bearerAuth = {
    type: 'http',
    scheme: 'bearer',
    ...(jwt ? { bearerFormat: 'JWT', description: `JWT (${jwt.alg}) with claims ${jwt.claimNames.join(', ')}; observed lifetime ${jwt.lifetimeSec}s.` } : {}),
  };
}
for (const op of operations.values()) {
  for (const cookie of op.cookies) {
    if (/refresh|session|token|auth/i.test(cookie)) securitySchemes[`cookie_${cookie}`] = { type: 'apiKey', in: 'cookie', name: cookie, description: 'HttpOnly cookie set by the server.' };
  }
}

const schemas: Record<string, unknown> = {};
for (const [name, shape] of [...components.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  // Render the component's own top level inline, nested objects as refs.
  schemas[name] = toSchema(shape, { refFor: (s) => (s === shape ? undefined : refFor(s)), volatileKeys });
}

const openapi = {
  openapi: '3.1.0',
  info: {
    title: `${config.name} API (inferred by specula)`,
    version: 'observed',
    description: `Inferred from ${exchanges.length} recorded exchanges in ${flows.length} flows. Only observed behaviour is described. x-observed-values lists values seen, not a closed enum.`,
  },
  servers: [{ url: apiPrefix || '/' }],
  paths: pathsDoc,
  components: { schemas, securitySchemes },
};

// ---- realtime and GraphQL ------------------------------------------------------------

const channels = new Map<string, Map<string, { direction: string; kind: string; count: number; shape: Shape; flows: Set<string> }>>();
for (const flow of flows) {
  const urls = new Map<string, string>();
  for (const e of flow.events) if (e.type === 'ws-open') urls.set(e.requestId, new URL(e.url).pathname);
  for (const e of flow.events) {
    if (e.type !== 'ws-frame' && e.type !== 'sse') continue;
    const channel = e.type === 'sse' ? `sse:${e.requestId}` : (urls.get(e.requestId) ?? 'unknown');
    const payload = parseJson(e.type === 'ws-frame' ? e.payload : e.data) as Record<string, unknown> | undefined;
    const kind = payload && typeof payload === 'object' ? String(payload.action ?? payload.type ?? payload.event ?? payload.op ?? '(untyped)') : '(non-JSON)';
    const direction = e.type === 'ws-frame' ? e.direction : 'received';
    const messages = channels.get(channel) ?? new Map();
    const message = messages.get(`${direction} ${kind}`) ?? { direction, kind, count: 0, shape: emptyShape(), flows: new Set<string>() };
    message.count++;
    message.flows.add(flow.name);
    if (payload !== undefined) addSample(message.shape, payload);
    messages.set(`${direction} ${kind}`, message);
    channels.set(channel, messages);
  }
}
const realtime = {
  channels: [...channels.entries()].map(([url, messages]) => ({
    url,
    messages: [...messages.values()].map((m) => ({ direction: m.direction, kind: m.kind, count: m.count, flows: [...m.flows], schema: toSchema(m.shape, { volatileKeys }) })),
  })),
};

interface GraphqlOp {
  type: string;
  fields: string[];
  documents: Set<string>;
  variables: Shape;
  data: Shape;
  errors: Map<string, { message: string; code?: string; path?: string }>;
  failures: Map<string, Record<string, unknown>>;
  count: number;
  flows: Set<string>;
}
const graphqlOps = new Map<string, GraphqlOp>();
/** Result objects that report failure in-band (`{ succeeded: false, errorCode, message }`), with their path. */
function inBandFailures(value: unknown, path: string, out: Map<string, Record<string, unknown>>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.slice(0, 20).forEach((v) => inBandFailures(v, path, out));
  const o = value as Record<string, unknown>;
  if (Object.entries(o).some(([k, v]) => /^(succeeded|success|ok)$/i.test(k) && v === false)) {
    const kept = Object.fromEntries(Object.entries(o).filter(([k]) => k !== '__typename'));
    out.set(JSON.stringify(kept), { path, ...kept });
    return;
  }
  for (const [k, v] of Object.entries(o)) inBandFailures(v, `${path}.${k}`, out);
}
for (const flow of flows) {
  for (const entry of flow.har.log.entries) {
    const requests = graphqlRequests(parseJson(entry.request.postData?.text));
    if (!requests) continue;
    const response = parseJson(entry.response.content.text);
    const results = Array.isArray(response) ? response : [response];
    requests.forEach((request, i) => {
      const parsed = parseOperation(request.query);
      const name = operationKey(request, parsed);
      const op: GraphqlOp = graphqlOps.get(name) ?? {
        type: parsed?.type ?? 'query',
        fields: parsed?.fields ?? [],
        documents: new Set(),
        variables: emptyShape(),
        data: emptyShape(),
        errors: new Map(),
        failures: new Map(),
        count: 0,
        flows: new Set(),
      };
      op.count++;
      op.flows.add(flow.name);
      op.documents.add(normalizeDocument(request.query));
      if (request.variables && Object.keys(request.variables).length) addSample(op.variables, request.variables);
      const result = results[i] as { data?: unknown; errors?: { message?: string; path?: unknown[]; extensions?: { code?: string } }[] } | undefined;
      if (result?.data !== undefined && result.data !== null) {
        addSample(op.data, result.data);
        inBandFailures(result.data, '$.data', op.failures);
      }
      for (const error of result?.errors ?? []) {
        const e = { message: String(error.message ?? ''), ...(error.extensions?.code ? { code: error.extensions.code } : {}), ...(Array.isArray(error.path) ? { path: error.path.join('.') } : {}) };
        op.errors.set(JSON.stringify(e), e);
      }
      graphqlOps.set(name, op);
    });
  }
}

// ---- flows (for parity) ------------------------------------------------------------

const correlationFile = join(paths.analysis, 'correlation.json');
const actionByEntry = new Map<string, { kind: string; target?: { role?: string; name?: string; selector?: string }; key?: string }>();
if (existsSync(correlationFile)) {
  const correlation = JSON.parse(await readFile(correlationFile, 'utf8'));
  for (const f of correlation.flows) for (const a of f.actions) for (const r of a.requests) actionByEntry.set(r.entry, { kind: a.kind, target: a.target, ...(a.key ? { key: a.key } : {}) });
}

interface Binding {
  name: string;
  value: string | number;
  /** What the id identifies, snake_case singular: "task", "project_view", "created_by". */
  entity: string;
  /** The response key the value sat under ("id", "label_id", "updated_at"). */
  key: string;
  path: string;
  seq: number;
}
const bindings: Binding[] = []; // shared across flows (they replay as one suite)
let varSeq = 0;
const isIdKey = (key: string) => key === 'id' || /_id$/.test(key) || /Id$/.test(key);
/** Public handles that stand in for an id in URLs (`/share/{slug}`); only bound when the value itself looks like an id. */
const isSlugKey = (key: string) => key === 'slug' || /_slug$/.test(key) || /Slug$/.test(key);
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

const NO_WRAPPERS = new Set<string>();
/** GraphQL result fields that are verbs or wrappers (`pages { single }`, `users { list }`): their objects keep the parent's entity. */
const GRAPHQL_WRAPPERS = new Set(['data', 'single', 'list', 'create', 'update', 'delete', 'search', 'results', 'tree', 'items', 'nodes', 'node', 'edges']);

interface FoundId {
  path: string;
  value: string | number;
  entity: string;
  key: string;
}

/**
 * Collects id-like values with the entity each one identifies, plus volatile strings (`updated_at`) with the
 * entity they belong to, since clients echo those back (optimistic locking). `own` is the response's entity.
 */
function collectIds(value: unknown, path: string, own: string, envelopeKey: string | undefined, out: FoundId[], depth = 0, wrappers: Set<string> = NO_WRAPPERS): void {
  if (depth > 5 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.slice(0, 50).forEach((v, i) => collectIds(v, `${path}[${i}]`, own, envelopeKey, out, depth + 1, wrappers));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if ((isIdKey(k) || isSlugKey(k)) && isIdValue(v)) {
      const entity = k === 'id' || k === 'slug' ? own : snake(k).replace(/_(id|slug)$/, '');
      out.push({ path: `${path}.${k}`, value: v, entity, key: k });
    } else if (volatileKeys.has(k) && typeof v === 'string' && v) {
      out.push({ path: `${path}.${k}`, value: v, entity: own, key: k });
    } else if (v && typeof v === 'object') {
      // Children of a named property identify that property's entity ("views" -> view, "created_by" -> created_by);
      // the envelope array keeps the response's own entity.
      const child = (Array.isArray(v) && (k === envelopeKey || k === 'items') && depth === 0) || wrappers.has(k) ? own : snake(singular(k));
      collectIds(v, `${path}.${k}`, child, envelopeKey, out, depth + 1, wrappers);
    }
  }
}

/** How well an earlier id's entity fits a parameter (path param `viewId`, body key `label_id`). */
function entityScore(entity: string, param: string): number {
  const wanted = snake(param).replace(/_id\d*$/, '').replace(/^id$/, '');
  if (!wanted) return 0;
  if (entity === wanted) return 3;
  if (entity.endsWith(`_${wanted}`) || wanted.endsWith(`_${entity}`)) return 2;
  return 0;
}

// A list the server returns in storage order (rows keyed by random ids) can come back in another order on a
// fresh instance, so an id taken from a list element binds by a field that tells that element apart
// (`$[?title="Write announcement"].id`) instead of by position, when one exists.
// The selector value must be one a rebuild returns too: text the client itself sent earlier (a title the user
// typed), or a machine value (`kanban`, `card`). Server-written prose (a default view's name, a seeded template's
// title) is the original's own wording, which a rebuild replaces.
const SELECTOR_KEYS = ['name', 'title', 'slug', 'key', 'username', 'email', 'type'];
const MACHINE_VALUE = /^[a-z][a-z0-9_.:-]{0,39}$/;
const clientStrings = new Set<string>();
function rememberClientStrings(value: unknown): void {
  if (typeof value === 'string') clientStrings.add(value);
  else if (Array.isArray(value)) value.forEach(rememberClientStrings);
  else if (value && typeof value === 'object') Object.values(value).forEach(rememberClientStrings);
}
function stablePath(root: unknown, path: string): string {
  let node: unknown = root;
  let out = '$';
  for (const [segment, key, idx] of path.replace(/^\$/, '').matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)) {
    if (key !== undefined) {
      out += segment;
      node = (node as Record<string, unknown> | undefined)?.[key];
      continue;
    }
    const list = Array.isArray(node) ? node : [];
    const element = list[Number(idx)];
    node = element;
    const distinct = (k: string) => {
      const v = (element as Record<string, unknown>)[k];
      if (typeof v !== 'string' || !v || volatileKeys.has(k) || isIdKey(k) || isIdValue(v) || /^<redacted:|^\d{4}-\d{2}-\d{2}|^https?:/.test(v)) return false;
      if (!clientStrings.has(v) && !MACHINE_VALUE.test(v)) return false;
      return list.every((other, i) => i === Number(idx) || !other || typeof other !== 'object' || (other as Record<string, unknown>)[k] !== v);
    };
    const keys = element && typeof element === 'object' && !Array.isArray(element) && list.length > 1 ? Object.keys(element) : [];
    const pick = [...SELECTOR_KEYS.filter((k) => keys.includes(k)), ...keys.filter((k) => !SELECTOR_KEYS.includes(k))].find(distinct);
    out += pick ? `[?${pick}=${JSON.stringify((element as Record<string, unknown>)[pick])}]` : segment;
  }
  return out;
}

/** Array positions a path depends on: one per index plus the index itself, so `[0]` beats `[2]`. */
const positional = (path: string) => [...path.matchAll(/\[(\d+)\]/g)].reduce((n, m) => n + 1 + Number(m[1]), 0);

/**
 * Finds the earlier response value that `value` used as `param` most plausibly came from. Numeric ids never bind
 * across entity types; a UUID or random string id is unique on its own, so it may (a template listed as a
 * `template` and opened as a board), ranked below any same-entity match.
 */
function findBinding(value: string | number, param: string): Binding | undefined {
  let best: Binding | undefined;
  let bestScore = 0;
  for (const b of bindings) {
    if (String(b.value) !== String(value) || !(isIdKey(b.key) || isSlugKey(b.key))) continue;
    const score = entityScore(b.entity, param) || (typeof value === 'string' ? (b.key === 'id' ? 1 : 0.5) : 0);
    if (!score) continue;
    // Higher score wins; then the least positional path ($.id over $.items[2].id), then the most recent response.
    const better = !best || score > bestScore || (score === bestScore && (positional(b.path) < positional(best.path) || (positional(b.path) === positional(best.path) && b.seq > best.seq)));
    if (better) {
      best = b;
      bestScore = score;
    }
  }
  return best;
}

/** Finds the latest earlier response that held `value` under the same key on the same entity (an echoed volatile value). */
function findEcho(value: string, key: string, entity: string): Binding | undefined {
  let best: Binding | undefined;
  for (const b of bindings) if (b.key === key && b.entity === entity && b.value === value && (!best || b.seq > best.seq || (b.seq === best.seq && positional(b.path) < positional(best.path)))) best = b;
  return best;
}

/** Finds the latest earlier volatile time on the same entity with exactly this value, whatever key the client used for it. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
function findTimeEcho(value: string, entity: string): Binding | undefined {
  if (!ISO_TIME.test(value) || Date.parse(value) < Date.UTC(1971, 0, 1)) return undefined; // not a zero-date sentinel
  let best: Binding | undefined;
  for (const b of bindings) if (!isIdKey(b.key) && b.entity === entity && b.value === value && (!best || b.seq > best.seq)) best = b;
  return best;
}

// Query values can embed ids (`filter=id:<id>`) and times the client derived from "now"
// (`filter=created_at:<='<time>'`). Both become `{ $template }` strings: `{{var:name}}` is a bound
// variable, `{{now:<seconds>:<format>}}` is the replay time shifted like the recording was.
const EMBEDDED_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{24,}\b)/gi;
const EMBEDDED_TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{3})?Z?/g;
function templateQuery(value: string, key: string, entity: string, requestMs: number): string | { $template: string } {
  let changed = false;
  let out = value.replace(/[{}]/g, (c) => `{{${c === '{' ? 'lb' : 'rb'}}}`);
  out = out.replace(EMBEDDED_ID, (id, _m, offset: number) => {
    const field = out.slice(0, offset).match(/(\w+):'?$/)?.[1] ?? key;
    const b = findBinding(id, field === 'id' ? `${entity}_id` : field);
    if (!b) return id;
    changed = true;
    return `{{var:${b.name}}}`;
  });
  out = out.replace(EMBEDDED_TIME, (time, ms: string | undefined) => {
    const format = time[10] === ' ' ? 'sql' : ms ? 'iso' : 'iso-s';
    const at = Date.parse(format === 'sql' ? `${time.replace(' ', 'T')}Z` : time.endsWith('Z') ? time : `${time}Z`);
    const offset = Math.round((at - requestMs) / 1000);
    if (!Number.isFinite(offset) || Math.abs(offset) > 31 * 86400) return time;
    changed = true;
    return `{{now:${offset}:${format}}}`;
  });
  return changed ? { $template: out } : value;
}

let responseSeq = 0;
// `entity` is what the object being walked describes: the resource at the top, then each property's
// singular name ({ posts: [{ id, tags: [{ id }] }] } -> post, tag), so a bare `id` binds by its entity.
function substitute(value: unknown, key: string | undefined, entity: string): unknown {
  // A list of plain ids keeps its key in singular form (`postIds: [...]` -> postId) so each id can bind.
  const itemKey = key?.replace(/_ids$/, '_id').replace(/Ids$/, 'Id');
  if (Array.isArray(value)) return value.map((v) => substitute(v, v && typeof v === 'object' ? undefined : (itemKey ?? 'id'), entity));
  // JSON Patch op: the field name is the last segment of `path`.
  if (value && typeof value === 'object' && 'op' in value && typeof (value as { path?: unknown }).path === 'string' && 'value' in value) {
    const op = value as unknown as { path: string; value: unknown };
    return { ...op, value: substitute(op.value, op.path.split('/').pop(), entity) };
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, k, v && typeof v === 'object' ? snake(singular(k)) : entity)]));
  if (key && isIdKey(key) && isIdValue(value)) {
    const b = findBinding(value, key === 'id' ? `${entity}_id` : key);
    if (b) return { $var: b.name };
  } else if (typeof value === 'string' && isIdValue(value)) {
    // A unique id under a key that does not say so (`cardOrder: [...]`, `contentOrder`).
    const b = findBinding(value, key ?? `${entity}_id`);
    if (b) return { $var: b.name };
  } else if (key && volatileKeys.has(key) && typeof value === 'string') {
    const b = findEcho(value, key, entity);
    if (b) return { $var: b.name };
  } else if (typeof value === 'string') {
    // An echoed time under the client's own name (`checkoutDate` carrying the page's `updatedAt`).
    const b = findTimeEcho(value, entity);
    if (b) return { $var: b.name };
  }
  return value;
}

const stepsByFlow = new Map<string, unknown[]>();

// ---- realtime messages inside flows ------------------------------------------------------
// WebSocket frames join the flow they were recorded in: a message the client sent becomes a step of its own
// (`send`), and a message the server pushed is expected after the latest step before it (`receive`), so a
// replay can check that a change made over HTTP reaches a subscribed socket.
const messageKind = (payload: unknown) => (payload && typeof payload === 'object' ? String((payload as Record<string, unknown>).action ?? (payload as Record<string, unknown>).type ?? (payload as Record<string, unknown>).event ?? (payload as Record<string, unknown>).op ?? '(untyped)') : '(non-JSON)');
const wsCursor = new Map<string, number>();
const wsChannels = new Map<string, string>();
const wsReconnects = new Set<string>();
function flushRealtime(flow: Flow, untilMs: number): void {
  const steps = stepsByFlow.get(flow.name) ?? [];
  let i = wsCursor.get(flow.name) ?? 0;
  for (; i < flow.events.length; i++) {
    const e = flow.events[i]!;
    if (e.t >= untilMs) break;
    if (e.type === 'ws-open') {
      const channel = new URL(e.url).pathname;
      // A second connection to a channel within one flow (after a logout or a token refresh): the replay
      // opens a new socket too, at the first message the client sent on it.
      if ([...wsChannels].some(([k, c]) => k.startsWith(`${flow.name}|`) && c === channel)) wsReconnects.add(`${flow.name}|${e.requestId}`);
      wsChannels.set(`${flow.name}|${e.requestId}`, channel);
    }
    if (e.type !== 'ws-frame' || e.truncated) continue;
    const channel = wsChannels.get(`${flow.name}|${e.requestId}`);
    const payload = parseJson(e.payload);
    if (!channel || payload === undefined) continue;
    const source = `capture/${flow.name}.events.jsonl:${i + 1}`;
    if (e.direction === 'sent') {
      const reconnect = wsReconnects.delete(`${flow.name}|${e.requestId}`);
      steps.push({ action: null, send: { channel, ...(reconnect ? { reconnect } : {}), message: substitute(payload, undefined, snake(singular(channel.split('/').filter(Boolean).pop() ?? 'message'))) }, source });
    }
    else {
      const last = steps.at(-1) as { receive?: unknown[] } | undefined;
      if (last) (last.receive ??= []).push({ channel, kind: messageKind(payload), message: payload, source });
    }
  }
  wsCursor.set(flow.name, i);
  if (steps.length) stepsByFlow.set(flow.name, steps);
}

const BROWSER_HEADERS = /^(accept|accept-encoding|accept-language|authorization|cache-control|connection|content-length|content-type|cookie|dnt|host|origin|pragma|priority|referer|user-agent|upgrade-insecure-requests|sec-.*|if-.*|x-forwarded-.*|:.*)$/i;
// A token the app received in a response and later sent in a header of its own (a share link's token in
// `X-<App>-Share-Token`) replays from that response. It is bound explicitly, so the runner keeps the bearer it has.
const REDACTED_TOKEN = /^<redacted:(jwt|token|secret)>$/;
const tokenLeaves: { value: string; path: string; request: Record<string, unknown>; name?: string }[] = [];
function collectTokens(value: unknown, path: string, request: Record<string, unknown>, depth = 0): void {
  if (typeof value === 'string' && REDACTED_TOKEN.test(value)) tokenLeaves.push({ value, path, request });
  else if (Array.isArray(value) && depth < 5) value.slice(0, 50).forEach((v, i) => collectTokens(v, `${path}[${i}]`, request, depth + 1));
  else if (value && typeof value === 'object' && depth < 5) for (const [k, v] of Object.entries(value)) collectTokens(v, `${path}.${k}`, request, depth + 1);
}

// Replay skips idle time, except a pause at least as long as the shortest token lifetime seen in the flow:
// whatever happened next (a refresh, a rejected request) may depend on the token having expired.
const lastEndByFlow = new Map<string, number>();
const lastMethodByFlow = new Map<string, string>();
for (const ex of exchanges) {
  flushRealtime(ex.flow, ex.entry._wallTimeMs ?? Date.parse(ex.entry.startedDateTime));
  rememberClientStrings(ex.requestJson);
  const op = operations.get(`${ex.method} ${ex.template}`)!;
  const pathParams: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(ex.pathValues)) {
    const value = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    const b = isIdValue(value) ? findBinding(value, name) : undefined;
    pathParams[name] = b ? { var: b.name } : { value };
  }
  const own = snake(resourceName(ex.template));
  // GraphQL: each variable binds by the entity of the namespace field that takes it (`pages { single(id: $id) }` -> page).
  const gql = graphqlRequests(ex.requestJson);
  const gqlBody = gql?.map((r) => {
    const op = parseOperation(r.query);
    if (!r.variables) return r;
    const variables = Object.fromEntries(
      Object.entries(r.variables).map(([k, v]) => {
        const arg = op?.args.find((a) => a.variable === k);
        return [k, substitute(v, arg?.argument ?? k, arg ? snake(singular(arg.field[0]!)) : own)];
      }),
    );
    return { ...r, variables };
  });
  const requestMs = ex.entry._wallTimeMs ?? Date.parse(ex.entry.startedDateTime);
  const lifetimes = ex.flow.auth.authorization.map((a) => a.jwt?.lifetimeSec).filter((n): n is number => typeof n === 'number');
  const lastEnd = lastEndByFlow.get(ex.flow.name);
  const idleMs = lastEnd === undefined ? 0 : requestMs - lastEnd;
  const action = actionByEntry.get(`capture/${ex.flow.name}.har#entries[${ex.index}]`);
  // The app itself waited: a page load several seconds after a write, with no click or key in between
  // (a setup wizard that restarts the server, then sends the browser on). Kept, capped at 20 s.
  const appWait = idleMs >= 5000 && lastMethodByFlow.get(ex.flow.name) !== 'GET' && action?.kind === 'navigate';
  const tokenWait = lifetimes.length > 0 && idleMs >= Math.min(...lifetimes) * 1000;
  const pauseMs = tokenWait ? Math.round(idleMs) : appWait ? Math.round(Math.min(idleMs, 20_000)) : undefined;
  const pauseReason = tokenWait ? 'token-lifetime' : 'app-wait';
  lastEndByFlow.set(ex.flow.name, Math.max(lastEnd ?? 0, requestMs + (ex.entry.time ?? 0)));
  lastMethodByFlow.set(ex.flow.name, ex.method);
  const query = [...new URL(ex.entry.request.url).searchParams.entries()].map(([k, v]) => [k, templateQuery(v, k, own, requestMs)]);
  const tokenHeaders: Record<string, { var: string }> = {};
  for (const h of ex.entry.request.headers) {
    const lower = h.name.toLowerCase();
    if (BROWSER_HEADERS.test(lower) || !REDACTED_TOKEN.test(h.value)) continue;
    const source = tokenLeaves.findLast((t) => t.value === h.value);
    if (!source) continue;
    if (!source.name) {
      source.name = `${camel(lower.replace(/^x-/, ''))}${++varSeq}`;
      ((source.request.bind as Record<string, string> | undefined) ?? (source.request.bind = {}) as Record<string, string>)[source.name] = source.path;
    }
    tokenHeaders[lower] = { var: source.name };
  }
  const request: Record<string, unknown> = {
    operationId: opIds.get(`${ex.method} ${ex.template}`),
    ...(gql ? { graphql: gql.map((r) => operationKey(r)) } : {}),
    method: ex.method,
    path: ex.template,
    ...(Object.keys(pathParams).length ? { pathParams } : {}),
    ...(query.length ? { query } : {}),
    ...(ex.entry.request.postData?.text !== undefined
      ? {
          body: gqlBody ? (Array.isArray(ex.requestJson) ? gqlBody : gqlBody[0]) : ex.requestJson !== undefined ? substitute(ex.requestJson, undefined, own) : ex.entry.request.postData.text,
          contentType: baseMime(ex.entry.request.postData.mimeType),
        }
      : {}),
    auth: /^bearer /i.test(headerValue(ex.entry, 'request', 'authorization') ?? '') ? 'bearer' : op.cookies.size ? 'cookie' : 'none',
    ...(Object.keys(tokenHeaders).length ? { tokenHeaders } : {}),
    expect: {
      status: ex.entry.response.status,
      // A 204's content type says nothing (servers differ), so it is not recorded.
      ...(ex.entry.response.status !== 204 && ex.entry.response.content.mimeType ? { contentType: baseMime(ex.entry.response.content.mimeType) } : {}),
      ...(op.component?.name && !gql && ex.entry.response.status < 300 ? { schema: `#/components/schemas/${op.component.name}${op.component.array ? '[]' : ''}`, ...(op.component.envelope ? { envelope: op.component.envelope } : {}) } : {}),
      ...(ex.responseJson !== undefined ? { body: ex.responseJson } : {}),
    },
    source: `capture/${ex.flow.name}.har#entries[${ex.index}]`,
  };
  // Register ids from this response for later requests.
  const ids: FoundId[] = [];
  if (gql) {
    const results = Array.isArray(ex.responseJson) ? ex.responseJson : [ex.responseJson];
    results.forEach((r, i) => collectIds((r as { data?: unknown } | undefined)?.data, Array.isArray(ex.responseJson) ? `$[${i}].data` : '$.data', own, undefined, ids, 0, GRAPHQL_WRAPPERS));
  } else collectIds(ex.responseJson, '$', own, op.component?.envelope, ids);
  const bind: Record<string, string> = {};
  const seq = ++responseSeq;
  for (const id of ids) {
    const name = `${camel(id.entity)}${isIdKey(id.key) ? '' : camel(`_${id.key}`)}${++varSeq}`;
    bindings.push({ name, value: id.value, entity: id.entity, key: id.key, path: id.path, seq });
    bind[name] = stablePath(ex.responseJson, id.path);
  }
  if (Object.keys(bind).length) request.bind = bind;
  if (!gql) collectTokens(ex.responseJson, '$', request);
  const steps = stepsByFlow.get(ex.flow.name) ?? [];
  steps.push({ ...(action ? { action } : { action: null }), ...(pauseMs ? { pauseMs, pauseReason } : {}), request });
  stepsByFlow.set(ex.flow.name, steps);
}
for (const flow of flows) flushRealtime(flow, Infinity);
// Keep only bindings that are actually used, to keep flows readable.
const usedVars = new Set<string>();
const scanVars = (v: unknown) => {
  if (Array.isArray(v)) v.forEach(scanVars);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.var === 'string') usedVars.add(o.var);
    if (typeof o.$var === 'string') usedVars.add(o.$var);
    if (typeof o.$template === 'string') for (const m of o.$template.matchAll(/\{\{var:(\w+)\}\}/g)) usedVars.add(m[1]!);
    Object.values(o).forEach(scanVars);
  }
};
for (const steps of stepsByFlow.values()) for (const s of steps as { request?: { pathParams?: unknown; body?: unknown; query?: unknown; tokenHeaders?: unknown }; send?: { message: unknown } }[]) scanVars([s.request?.pathParams, s.request?.body, s.request?.query, s.request?.tokenHeaders, s.send?.message]);
for (const steps of stepsByFlow.values()) {
  for (const s of steps as { request?: { bind?: Record<string, string> } }[]) {
    if (!s.request?.bind) continue;
    s.request.bind = Object.fromEntries(Object.entries(s.request.bind).filter(([k]) => usedVars.has(k)));
    if (!Object.keys(s.request.bind).length) delete s.request.bind;
  }
}

// Custom headers the client sent on every API request with the same value (`X-Requested-With`): servers may
// require them (CSRF checks), so the replay sends them too. Browser-managed and secret headers are left out.
const clientHeaders: Record<string, string> = {};
{
  const seen = new Map<string, { name: string; value: string; count: number }>();
  for (const ex of exchanges) {
    for (const h of ex.entry.request.headers) {
      const lower = h.name.toLowerCase();
      if (BROWSER_HEADERS.test(lower) || h.value.includes('<redacted')) continue;
      const prev = seen.get(lower);
      if (!prev) seen.set(lower, { name: h.name, value: h.value, count: 1 });
      else if (prev.value === h.value) prev.count++;
      else prev.count = -Infinity;
    }
  }
  for (const h of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))) if (h.count === exchanges.length) clientHeaders[h.name] = h.value;
}

// ---- write -------------------------------------------------------------------------

// Brand names never reach spec/ (the rebuild reads only spec/): replace them in keys and values.
const neutral = neutralizer(config.brand);
// A header that names the brand (`X-<Brand>-Version`) cannot be replayed as recorded from a brand-free spec: left out.
for (const [name, value] of Object.entries(clientHeaders)) if (neutral(name) !== name || neutral(value) !== value) delete clientHeaders[name];

await ensureDir(paths.flows);
await writeFile(join(paths.spec, 'openapi.yaml'), toYaml(neutral(openapi)));
await writeFile(join(paths.spec, 'openapi.json'), `${JSON.stringify(neutral(openapi), null, 2)}\n`);
for (const file of ['realtime.json', 'graphql.json']) await rm(join(paths.spec, file), { force: true });
if (realtime.channels.length) await writeFile(join(paths.spec, 'realtime.json'), `${JSON.stringify(neutral(realtime), null, 2)}\n`);
if (graphqlOps.size) {
  const graphql = {
    note: 'Operations sent to the GraphQL endpoint, keyed by the client operation name or by "<type> <fields>". documents are the exact query texts the client sent (whitespace normalized); data is the shape of the result; errors are top-level GraphQL errors; failures are in-band results with a false success flag.',
    operations: [...graphqlOps.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, op]) => ({
      name,
      type: op.type,
      fields: op.fields,
      count: op.count,
      flows: [...op.flows].sort(),
      documents: [...op.documents],
      variables: op.variables.count ? toSchema(op.variables, { volatileKeys }) : {},
      data: op.data.count ? toSchema(op.data, { volatileKeys }) : {},
      ...(op.errors.size ? { errors: [...op.errors.values()] } : {}),
      ...(op.failures.size ? { failures: [...op.failures.values()] } : {}),
    })),
  };
  await writeFile(join(paths.spec, 'graphql.json'), `${JSON.stringify(neutral(graphql), null, 2)}\n`);
}
const order = flows.map((f) => f.name).filter((name) => stepsByFlow.has(name));
for (const [index, name] of order.entries()) {
  const flow = { name, order: index + 1, description: '', steps: stepsByFlow.get(name) };
  await writeFile(join(paths.flows, `${name}.json`), `${JSON.stringify(neutral(flow), null, 2)}\n`);
}
await writeFile(
  join(paths.flows, 'index.json'),
  `${JSON.stringify(
    neutral({ order, apiPrefix, volatileKeys: [...volatileKeys], ...(Object.keys(clientHeaders).length ? { headers: clientHeaders } : {}), note: 'Flows replay in this order against one fresh instance; variables bound in earlier flows stay available. volatileKeys are never compared by value. headers are sent with every request, as the client did.' }),
    null,
    2,
  )}\n`,
);

printSummary({
  ok: true,
  exchanges: exchanges.length,
  operations: operations.size,
  paths: Object.keys(pathsDoc).length,
  components: components.size,
  realtimeChannels: realtime.channels.length,
  graphqlOperations: graphqlOps.size,
  flows: order.length,
  files: ['spec/openapi.yaml', 'spec/openapi.json', ...(realtime.channels.length ? ['spec/realtime.json'] : []), ...(graphqlOps.size ? ['spec/graphql.json'] : []), 'spec/flows/'],
});
