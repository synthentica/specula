// infer-api on a hand-written capture: schemas, envelopes, id bindings, brand neutralization, spec diff.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { HarEntry } from '../src/lib/har.ts';

const ORIGIN = 'http://localhost:9999';
let targetsDir: string;
let t0 = 1_700_000_000_000;

function entry(method: string, path: string, status: number, request?: unknown, response?: unknown, headers: { name: string; value: string }[] = []): HarEntry {
  const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  return {
    startedDateTime: new Date(t0).toISOString(),
    time: 5,
    request: {
      method,
      url: `${ORIGIN}${path}`,
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Authorization', value: 'Bearer <redacted:jwt>' }],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: 0,
      ...(request !== undefined ? { postData: { mimeType: Array.isArray(request) ? 'application/json-patch+json' : 'application/json', text: json(request) } } : {}),
    },
    response: {
      status,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers,
      cookies: [],
      content: { size: 0, mimeType: response === undefined ? '' : 'application/json', ...(response !== undefined ? { text: json(response) } : {}) },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 0, wait: 5, receive: 0 },
    _requestId: String(t0),
    _resourceType: 'Fetch',
    _wallTimeMs: t0++,
  };
}

function withCookie(e: HarEntry): HarEntry {
  e.request.headers.push({ name: 'Cookie', value: 'acme_session=<redacted:cookie>' });
  return e;
}

const owner = { id: 7, username: 'someone' };
// A second API style: hex ids, resources wrapped in a named array, optimistic locking on updated_at.
const HEX = '0123456789abcdef01234567';
const note = (title: string) => ({ id: HEX, title, updated_at: '2026-01-01T00:00:01.000Z' });
const nearRecording = new Date(t0 + 60_000).toISOString().slice(0, 19).replace('T', ' ');
const thing = (id: number, title: string) => ({ id, title, done: false, created: '2026-01-01T00:00:00Z', owner });

before(async () => {
  targetsDir = await mkdtemp(join(tmpdir(), 'specula-infer-'));
  const dir = join(targetsDir, 'shop');
  await mkdir(join(dir, 'capture'), { recursive: true });
  await writeFile(join(dir, 'target.json'), JSON.stringify({ name: 'shop', origin: ORIGIN, apiPrefix: '/api', brand: ['Acme'], volatile: { keys: ['id', 'created', 'updated_at'] } }));
  const flows: Record<string, HarEntry[]> = {
    'make-things': [
      entry('POST', '/api/login', 200, { username: '<redacted:pii>', password: '<redacted:secret>' }, { token: '<redacted:jwt>', help: 'https://docs.acme.org/login' }, [{ name: 'Set-Cookie', value: 'acme_session=<redacted:cookie>; HttpOnly' }]),
      // The owner id equals the new thing's id: the binding must still come from the thing.
      entry('POST', '/api/things', 201, { title: 'first' }, thing(7, 'first')),
      entry('POST', '/api/things', 201, { title: 'second' }, thing(8, 'second')),
      withCookie(entry('GET', '/api/things?page=1', 200, undefined, { items: [thing(8, 'second'), thing(7, 'first')], total: 2, page: 1 })),
    ],
    'edit-thing': [
      entry('GET', '/api/things/7', 200, undefined, thing(7, 'first')),
      entry('PATCH', '/api/things/7', 200, [{ op: 'replace', path: '/done', value: true }, { op: 'replace', path: '/owner_id', value: 7 }], { ...thing(7, 'first'), done: true }),
      entry('POST', '/api/things/7/tags', 201, { owner_id: 7 }, { thing_id: 7, owner_id: 7 }),
      entry('DELETE', '/api/things/8', 204),
    ],
    notes: [
      entry('POST', '/api/notes/', 201, { notes: [{ title: 'n1' }] }, { notes: [note('n1')] }),
      entry('PUT', `/api/notes/${HEX}/`, 200, { notes: [note('n1b')] }, { notes: [{ ...note('n1b'), updated_at: '2026-01-01T00:00:02.000Z' }] }),
      entry('GET', `/api/notes/?filter=${encodeURIComponent(`id:${HEX}+updated_at:<='${nearRecording}'`)}`, 200, undefined, { notes: [note('n1b')] }),
      // Idle for 45 s, longer than the 30 s token lifetime below: replay must pause here.
      ((t0 += 45_000), entry('POST', '/api/note-stats/', 200, { noteIds: [HEX] }, { stats: { [HEX]: { views: 0 } } })),
    ],
  };
  for (const [name, entries] of Object.entries(flows)) {
    await writeFile(join(dir, 'capture', `${name}.har`), JSON.stringify({ log: { version: '1.2', creator: { name: 'test', version: '0' }, pages: [], entries } }));
  }
  const jwt = { alg: 'HS256', claimNames: ['exp', 'iat'], lifetimeSec: 30 };
  await writeFile(join(dir, 'capture', 'notes.auth.json'), JSON.stringify({ authorization: [{ scheme: 'Bearer', count: 4, firstEntry: 0, jwt }], cookiesSent: [], cookiesSet: [], csrfHeaders: [], tokenFieldsInResponses: [] }));
});

after(async () => {
  await rm(targetsDir, { recursive: true, force: true });
});

function run(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/infer-api.ts', '--target', 'shop', ...args], { env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir } });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.once('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`infer-api failed: ${err}`))));
  });
}

test('infer-api builds OpenAPI, flows with typed bindings, and keeps brand names out of spec/', async () => {
  const summary = JSON.parse((await run()).trim().split('\n').pop()!);
  assert.equal(summary.ok, true);
  assert.equal(summary.operations, 11);

  const spec = join(targetsDir, 'shop', 'spec');
  const openapi = JSON.parse(await readFile(join(spec, 'openapi.json'), 'utf8'));
  assert.equal(openapi.openapi, '3.1.0');
  assert.ok(openapi.paths['/things/{thingId}'].patch, 'path parameter templated');
  const thingSchema = openapi.components.schemas.Thing;
  assert.ok(thingSchema, 'Thing component inferred');
  assert.deepEqual(thingSchema.required, ['created', 'done', 'id', 'owner', 'title']);
  assert.equal(thingSchema.properties.created.format, 'date-time');
  const list = openapi.paths['/things'].get.responses['200'].content['application/json'].schema;
  assert.equal(list.properties.items.items.$ref, '#/components/schemas/Thing', 'pagination envelope points at the item component');
  assert.ok(openapi.paths['/things/{thingId}'].patch.requestBody.content['application/json-patch+json'], 'JSON Patch content type kept');

  const edit = JSON.parse(await readFile(join(spec, 'flows', 'edit-thing.json'), 'utf8'));
  const make = JSON.parse(await readFile(join(spec, 'flows', 'make-things.json'), 'utf8'));
  const firstCreate = make.steps[1].request;
  const getThing = edit.steps[0].request;
  const boundName = getThing.pathParams.thingId.var as string;
  assert.ok(boundName, 'GET /things/7 uses a variable');
  assert.ok(boundName.startsWith('thing'), `bound to a thing id, not the owner (${boundName})`);
  assert.equal(firstCreate.bind[boundName], '$.id', 'variable comes from the create response $.id');
  // owner_id in a body binds to an owner id, never to the thing id with the same value.
  const tagBody = edit.steps[2].request.body;
  assert.ok(String(tagBody.owner_id.$var).startsWith('owner'), JSON.stringify(tagBody));
  // Ids inside JSON Patch values bind by the op's field name.
  const patchOps = edit.steps[1].request.body as { path: string; value: unknown }[];
  assert.ok(String((patchOps[1]!.value as { $var: string }).$var).startsWith('owner'), JSON.stringify(patchOps));
  assert.equal(patchOps[0]!.value, true);
  // The second thing (id 8) is deleted through a binding as well.
  assert.ok(edit.steps[3].request.pathParams.thingId.var);
  assert.equal(edit.steps[3].request.expect.status, 204);

  const index = JSON.parse(await readFile(join(spec, 'flows', 'index.json'), 'utf8'));
  assert.deepEqual(index.order, ['make-things', 'edit-thing', 'notes']);

  for (const file of ['openapi.json', 'openapi.yaml', 'flows/make-things.json']) {
    assert.ok(!/acme/i.test(await readFile(join(spec, file), 'utf8')), `${file} mentions the brand`);
  }
  assert.ok(openapi.components.securitySchemes.cookie_app_session, 'cookie name neutralized');
  assert.equal(make.steps[0].request.expect.body.help, 'https://example.invalid/login', 'brand hosts point nowhere real');
});

test('infer-api binds hex ids by entity, echoed updated_at, and ids and times inside query values', async () => {
  const spec = join(targetsDir, 'shop', 'spec');
  const notes = JSON.parse(await readFile(join(spec, 'flows', 'notes.json'), 'utf8'));
  const created = notes.steps[0].request;
  const put = notes.steps[1].request;
  const noteVar = put.pathParams.noteId.var as string;
  assert.ok(noteVar && created.bind[noteVar] === '$.notes[0].id', JSON.stringify(put.pathParams));
  assert.deepEqual(put.body.notes[0].id, { $var: noteVar }, 'bare id in a body binds through its entity');
  const lock = put.body.notes[0].updated_at.$var as string;
  assert.ok(lock?.startsWith('noteUpdatedAt') && created.bind[lock] === '$.notes[0].updated_at', JSON.stringify(put.body));
  assert.equal(put.body.notes[0].title, 'n1b');
  const filter = notes.steps[2].request.query[0][1];
  // The id binds to the latest response holding it (the PUT); the time keeps its offset from the request.
  assert.equal(filter.$template, `id:{{var:${Object.keys(put.bind ?? {}).find((k) => k.startsWith('note') && !k.includes('At'))}}}+updated_at:<='{{now:60:sql}}'`);
  assert.match(notes.steps[3].request.body.noteIds[0].$var, /^note\d+$/, 'id lists bind item by item');
  assert.deepEqual(notes.steps.map((s: { pauseMs?: number }) => s.pauseMs), [undefined, undefined, undefined, 44_996], 'only an idle longer than the token lifetime becomes a pause');
  const openapi = JSON.parse(await readFile(join(spec, 'openapi.json'), 'utf8'));
  const stats = openapi.paths['/note-stats/'].post.responses['200'].content['application/json'].schema.properties.stats;
  assert.equal(stats['x-keys'], 'record-id');
  assert.equal(stats.additionalProperties.properties.views.type, 'integer');
});

test('infer-api diff compares against a reference spec', async () => {
  const truth = {
    openapi: '3.1.0',
    info: { title: 'Reference', version: '1' },
    servers: [{ url: '/api' }],
    paths: {
      '/things/{id}': {
        get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/T' } } } } } },
        put: { responses: { '200': { description: 'unused' } } },
      },
    },
    components: { schemas: { T: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, done: { type: 'boolean' }, color: { type: 'string' } } } } },
  };
  const file = join(targetsDir, 'truth.json');
  await writeFile(file, JSON.stringify(truth));
  const summary = JSON.parse((await run('diff', '--against', file)).trim().split('\n').pop()!);
  assert.equal(summary.matchedOperations, 1);
  assert.equal(summary.responseFieldRecall, '75%');
  const md = await readFile(join(targetsDir, 'shop', 'analysis', 'spec-vs-source.md'), 'utf8');
  assert.match(md, /`GET \/things\/\{\}` \| 3\/4 \| color/);
});

test('infer-api puts socket messages into flows, keeps constant client headers, and binds list ids by a telling field', async () => {
  // A second target: random base32 ids, an opaque session token, a WebSocket, a custom CSRF header.
  const dir = join(targetsDir, 'board');
  await mkdir(join(dir, 'capture'), { recursive: true });
  await writeFile(join(dir, 'target.json'), JSON.stringify({ name: 'board', origin: ORIGIN, apiPrefix: '/api', brand: ['Acme'], volatile: { keys: ['id'] } }));
  const BOARD = 'b1dooum4safgcuf5za47ebg3gaa';
  const CARD = 'c3mqh7wd7bbywzyxzmr1gzkxgse';
  const VIEW = 'v3eaywyyz6ib6tkzeuy77k3gige';
  const headers = (e: HarEntry) => {
    e.request.headers.push({ name: 'X-Requested-With', value: 'XMLHttpRequest' }, { name: 'X-Acme-Version', value: '7.8' });
    return e;
  };
  const entries = [
    entry('POST', '/api/login', 200, { username: 'me', password: '<redacted:secret>' }, { token: '<redacted:secret>' }),
    entry('GET', '/api/boards', 200, undefined, [{ id: BOARD, title: 'Home' }]),
    // Creating answers nothing useful, so the card's id first appears in the list below.
    entry('POST', `/api/boards/${BOARD}/cards`, 200, { title: 'Paint the fence' }, {}),
    entry('GET', `/api/boards/${BOARD}/cards`, 200, undefined, [
      { id: VIEW, title: 'Default view', type: 'view' },
      { id: CARD, title: 'Paint the fence', type: 'card' },
    ]),
    entry('PATCH', `/api/cards/${CARD}`, 200, { title: 'Paint it red' }, {}),
    entry('PATCH', `/api/views/${VIEW}`, 200, { cardOrder: [CARD] }, {}),
  ].map(headers);
  const at = (i: number) => entries[i]!._wallTimeMs!;
  const frame = (t: number, requestId: string, direction: string, payload: unknown) => ({ t, type: 'ws-frame', requestId, direction, opcode: 1, payload: JSON.stringify(payload) });
  const events = [
    { t: at(0) + 0.2, type: 'ws-open', requestId: 'ws1', url: 'ws://localhost:9999/ws' },
    frame(at(0) + 0.3, 'ws1', 'sent', { action: 'AUTH', token: '<redacted:secret>' }),
    frame(at(2) + 0.5, 'ws1', 'received', { action: 'UPDATE_BLOCK', block: { id: CARD, title: 'Paint the fence' } }),
    { t: at(3) + 0.2, type: 'ws-open', requestId: 'ws2', url: 'ws://localhost:9999/ws' },
    frame(at(3) + 0.3, 'ws2', 'sent', { action: 'AUTH', token: '<redacted:secret>' }),
  ];
  await writeFile(join(dir, 'capture', 'cards.har'), JSON.stringify({ log: { version: '1.2', creator: { name: 'test', version: '0' }, pages: [], entries } }));
  await writeFile(join(dir, 'capture', 'cards.events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, ['src/infer-api.ts', '--target', 'board'], { env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir } });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });

  const spec = join(dir, 'spec');
  const index = JSON.parse(await readFile(join(spec, 'flows', 'index.json'), 'utf8'));
  assert.deepEqual(index.headers, { 'X-Requested-With': 'XMLHttpRequest' }, 'a header naming the brand is left out');
  const openapi = JSON.parse(await readFile(join(spec, 'openapi.json'), 'utf8'));
  assert.ok(openapi.paths['/boards/{boardId}/cards'], 'random base32 ids are path parameters');

  const steps = JSON.parse(await readFile(join(spec, 'flows', 'cards.json'), 'utf8')).steps;
  const sends = steps.filter((s: { send?: unknown }) => s.send);
  assert.deepEqual(
    sends.map((s: { send: unknown }) => s.send),
    [
      { channel: '/ws', message: { action: 'AUTH', token: '<redacted:secret>' } },
      { channel: '/ws', reconnect: true, message: { action: 'AUTH', token: '<redacted:secret>' } },
    ],
  );
  const create = steps.find((s: { request?: { method: string; path: string } }) => s.request?.method === 'POST' && s.request.path === '/boards/{boardId}/cards');
  assert.deepEqual(create.receive.map((r: { kind: string; channel: string }) => [r.channel, r.kind]), [['/ws', 'UPDATE_BLOCK']], 'a push is expected after the step it followed');
  const list = steps.find((s: { request?: { method: string; path: string } }) => s.request?.method === 'GET' && s.request.path === '/boards/{boardId}/cards').request;
  // The card binds by the title the user typed; the view by its machine type, never by the server's own name for it.
  assert.deepEqual(Object.values(list.bind).sort(), ['$[?title="Paint the fence"].id', '$[?type="view"].id']);
  const viewPatch = steps.find((s: { request?: { path: string } }) => s.request?.path === '/views/{viewId}').request;
  assert.ok(viewPatch.body.cardOrder[0].$var, 'ids under a key that does not say so (cardOrder) bind too');
});

test('infer-api reads the API from apiOrigins when it is not on the app origin', async () => {
  const dir = join(targetsDir, 'split');
  await mkdir(join(dir, 'capture'), { recursive: true });
  const API = 'http://127.0.0.1:9998';
  await writeFile(join(dir, 'target.json'), JSON.stringify({ name: 'split', origin: ORIGIN, apiOrigins: [API], apiPrefix: '/api', volatile: { keys: ['id'] } }));
  const at = (base: string, e: HarEntry) => ((e.request.url = e.request.url.replace(ORIGIN, base)), e);
  const entries = [
    at(API, entry('POST', '/api/things', 201, { title: 'first' }, thing(7, 'first'))),
    at(API, entry('GET', '/api/things/7', 200, undefined, thing(7, 'first'))),
    // The app's own usage tracking on another host is not part of its API.
    at('http://tracker.test', entry('POST', '/api/collect', 200, { event: 'view' }, { ok: true })),
  ];
  await writeFile(join(dir, 'capture', 'split.har'), JSON.stringify({ log: { version: '1.2', creator: { name: 'test', version: '0' }, pages: [], entries } }));
  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, ['src/infer-api.ts', '--target', 'split'], { env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir } });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  const openapi = JSON.parse(await readFile(join(dir, 'spec', 'openapi.json'), 'utf8'));
  assert.deepEqual(Object.keys(openapi.paths).sort(), ['/things', '/things/{thingId}']);
});

test('infer-api templates base62 slugs in paths and binds them to the response that created them', async () => {
  const dir = join(targetsDir, 'slugs');
  await mkdir(join(dir, 'capture'), { recursive: true });
  await writeFile(join(dir, 'target.json'), JSON.stringify({ name: 'slugs', origin: ORIGIN, apiPrefix: '/api', volatile: { keys: ['id'] } }));
  const SLUG = 'e6yGJpWYlZJne8Ja';
  const entries = [
    entry('POST', '/api/things/7/shares', 200, { name: 'public' }, { id: '70c73ece-27d7-48f7-a6ce-c8822db64086', name: 'public', slug: SLUG }),
    entry('GET', `/api/share/${SLUG}`, 200, undefined, { thingId: 7 }),
  ];
  await writeFile(join(dir, 'capture', 'share.har'), JSON.stringify({ log: { version: '1.2', creator: { name: 'test', version: '0' }, pages: [], entries } }));
  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, ['src/infer-api.ts', '--target', 'slugs'], { env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir } });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  const openapi = JSON.parse(await readFile(join(dir, 'spec', 'openapi.json'), 'utf8'));
  assert.ok(openapi.paths['/share/{shareId}'], 'slug segment templated');
  const flow = JSON.parse(await readFile(join(dir, 'spec', 'flows', 'share.json'), 'utf8'));
  const [create, open] = flow.steps.map((s: { request: unknown }) => s.request);
  const variable = open.pathParams.shareId.var;
  assert.ok(variable, 'slug replayed from a variable, not the recorded value');
  assert.equal(create.bind[variable], '$.slug');
});

test('infer-api follows flowOrder and binds a token the client sends in a header of its own', async () => {
  const dir = join(targetsDir, 'shares');
  await mkdir(join(dir, 'capture'), { recursive: true });
  await writeFile(join(dir, 'target.json'), JSON.stringify({ name: 'shares', origin: ORIGIN, apiPrefix: '/api', flowOrder: ['login'], brand: ['Acme'], volatile: { keys: ['id'] } }));
  const shared = (e: HarEntry) => (e.request.headers.push({ name: 'x-acme-share-token', value: '<redacted:jwt>' }), e);
  const har = (entries: HarEntry[]) => JSON.stringify({ log: { version: '1.2', creator: { name: 'test', version: '0' }, pages: [], entries } });
  // Recorded first, replayed second.
  await writeFile(join(dir, 'capture', 'view-share.har'), har([
    entry('GET', '/api/share/e6yGJpWYlZJne8Ja', 200, undefined, { websiteId: '1d56f797-e459-4079-b2b1-5bfe0190cd54', token: '<redacted:jwt>' }),
    shared(entry('GET', '/api/websites/1d56f797-e459-4079-b2b1-5bfe0190cd54/stats', 200, undefined, { views: 0 })),
  ]));
  await writeFile(join(dir, 'capture', 'login.har'), har([entry('POST', '/api/login', 200, { password: '<redacted:secret>' }, { token: '<redacted:secret>' })]));
  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, ['src/infer-api.ts', '--target', 'shares'], { env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir } });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  const index = JSON.parse(await readFile(join(dir, 'spec', 'flows', 'index.json'), 'utf8'));
  assert.deepEqual(index.order, ['login', 'view-share']);
  const flow = JSON.parse(await readFile(join(dir, 'spec', 'flows', 'view-share.json'), 'utf8'));
  const [share, stats] = flow.steps.map((s: { request: { bind?: Record<string, string>; tokenHeaders?: Record<string, { var: string }> } }) => s.request);
  const header = stats.tokenHeaders['x-app-share-token'];
  assert.ok(header, 'header kept, brand neutralized in its name');
  assert.equal(share.bind[header.var], '$.token');
});
