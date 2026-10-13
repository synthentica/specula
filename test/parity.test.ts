// parity replays flows against a small server and reports which recorded behaviours it reproduces.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let targetsDir: string;
let server: Server;
let baseUrl: string;
const seen: { method: string; url: string; auth?: string; cookie?: string; share?: string; body: string }[] = [];

const step = (request: Record<string, unknown>, action: unknown = null) => ({ action, request: { auth: 'bearer', source: 'capture/x.har#entries[0]', ...request } });

before(async () => {
  // A server that reproduces most of the recording, with three deliberate deviations.
  const things = new Map<number, { id: number; title: string; done: boolean }>();
  let nextId = 40;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, cookie: req.headers.cookie, share: req.headers['x-app-share-token'] as string | undefined, body });
      const send = (status: number, value?: unknown, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { ...(value !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
        res.end(value !== undefined ? JSON.stringify(value) : undefined);
      };
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/api/login') {
        if (JSON.parse(body).password !== 'pw-123') return send(403, { title: 'Forbidden', status: 403, code: 1011 });
        return send(200, { token: 'tok-1' }, { 'Set-Cookie': ['refresh=r1; Path=/api/refresh; HttpOnly'] });
      }
      if (url.pathname === '/api/refresh') return req.headers.cookie === 'refresh=r1' ? send(200, { token: 'tok-2' }) : send(401, { message: 'no cookie' });
      if (req.headers.authorization !== 'Bearer tok-1' && req.headers.authorization !== 'Bearer tok-2') return send(401, { message: 'no token' });
      if (url.pathname === '/api/things' && req.method === 'POST') {
        const t = { id: nextId++, title: JSON.parse(body).title, done: false };
        things.set(t.id, t);
        return send(201, t);
      }
      const m = url.pathname.match(/^\/api\/things\/(\d+)$/);
      if (m && req.method === 'GET') {
        const t = things.get(Number(m[1]));
        // Deviation 1: the title comes back changed.
        return t ? send(200, { ...t, title: t.title.toUpperCase() }) : send(404, { message: 'nope' });
      }
      if (m && req.method === 'PATCH') {
        // Deviation 2: "done" is missing from the response.
        const t = things.get(Number(m[1]))!;
        return send(200, { id: t.id, title: t.title });
      }
      // Seed text of its own: the recording had different wording, which the client only round-trips.
      if (url.pathname === '/api/me') return send(200, { name: 'alice', note: 'our own seed text' });
      // Deviation 4: a state flag differs (the count beside it is not compared).
      if (url.pathname === '/api/flags') return send(200, { enabled: false, retries: 5 });
      // Deviation 5: the error code differs.
      if (url.pathname === '/api/gone') return send(404, { status: 404, code: 4003 });
      if (url.pathname === '/api/stats') return send(200, { stats: { fedcba9876543210fedcba98: { views: 3 } } });
      if (url.pathname === '/api/things' && req.method === 'GET') {
        // Deviation 3: the list has one item instead of two.
        return send(200, { items: [...things.values()].slice(0, 1), total: 1 });
      }
      // A public share: its own token, sent back in a header of its own next to the owner's bearer.
      if (url.pathname === '/api/share') return send(200, { websiteId: 'w1', token: 'share-jwt-1' });
      if (url.pathname === '/api/shared-stats') return req.headers['x-app-share-token'] === 'share-jwt-1' ? send(200, { views: 0 }) : send(403, { message: 'no share token' });
      send(404, { message: 'unknown' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  targetsDir = await mkdtemp(join(tmpdir(), 'specula-parity-'));
  const dir = join(targetsDir, 'shop');
  await mkdir(join(dir, 'spec', 'flows'), { recursive: true });
  const flow = {
    name: 'things',
    order: 1,
    description: '',
    steps: [
      step({ operationId: 'postLogin', method: 'POST', path: '/login', auth: 'none', body: { username: '<redacted:pii>', password: '<redacted:secret>' }, contentType: 'application/json', expect: { status: 200, contentType: 'application/json', body: { token: '<redacted:jwt>' } } }),
      step({ operationId: 'postThings', method: 'POST', path: '/things', body: { title: 'paint' }, contentType: 'application/json', expect: { status: 201, contentType: 'application/json', body: { id: 7, title: 'paint', done: false } }, bind: { thing1: '$.id' } }),
      step({ operationId: 'postThings', method: 'POST', path: '/things', body: { title: 'brush' }, contentType: 'application/json', expect: { status: 201, contentType: 'application/json', body: { id: 8, title: 'brush', done: false } } }),
      step({ operationId: 'getThingsById', method: 'GET', path: '/things/{thingId}', pathParams: { thingId: { var: 'thing1' } }, expect: { status: 200, contentType: 'application/json', body: { id: 7, title: 'paint', done: false } } }),
      step({ operationId: 'patchThingsById', method: 'PATCH', path: '/things/{thingId}', pathParams: { thingId: { var: 'thing1' } }, body: [{ op: 'replace', path: '/done', value: true }], contentType: 'application/json-patch+json', expect: { status: 200, contentType: 'application/json', body: { id: 7, title: 'paint', done: true } } }),
      step({ operationId: 'getThings', method: 'GET', path: '/things', query: [['page', '1']], expect: { status: 200, contentType: 'application/json', body: { items: [{ id: 8, title: 'brush', done: false }, { id: 7, title: 'paint', done: true }], total: 2 } } }),
      step({ operationId: 'getStats', method: 'GET', path: '/stats', query: [['filter', { $template: 'id:{{var:thing1}}+at:{{now:-60:sql}}' }]], expect: { status: 200, contentType: 'application/json', body: { stats: { '0123456789abcdef01234567': { views: 3 } } } } }),
      step({ operationId: 'getMe', method: 'GET', path: '/me', expect: { status: 200, contentType: 'application/json', body: { name: '<redacted:pii>', note: 'original seed text' } } }),
      step({ operationId: 'putMe', method: 'PUT', path: '/me', body: { note: 'original seed text' }, contentType: 'application/json', expect: { status: 200, contentType: 'application/json', body: { name: '<redacted:pii>', note: 'original seed text' } } }),
      step({ operationId: 'postRefresh', method: 'POST', path: '/refresh', auth: 'cookie', expect: { status: 200, contentType: 'application/json', body: { token: '<redacted:jwt>' } } }),
      step({ operationId: 'getThingsById', method: 'GET', path: '/things/{thingId}', pathParams: { thingId: { var: 'never' } }, expect: { status: 200, contentType: 'application/json' } }),
      step({ operationId: 'postLogin', method: 'POST', path: '/login', auth: 'none', body: { username: '<redacted:pii>', password: '<redacted:secret:other>' }, contentType: 'application/json', expect: { status: 403, contentType: 'application/json', body: { title: 'Forbidden', status: 403, code: 1011 } } }),
      step({ operationId: 'getFlags', method: 'GET', path: '/flags', expect: { status: 200, contentType: 'application/json', body: { enabled: true, retries: 3 } } }),
      step({ operationId: 'getGone', method: 'GET', path: '/gone', expect: { status: 404, contentType: 'application/json', body: { status: 404, code: 4002 } } }),
    ],
  };
  await writeFile(join(dir, 'spec', 'flows', 'things.json'), JSON.stringify(flow));
  await writeFile(join(dir, 'spec', 'flows', 'index.json'), JSON.stringify({ order: ['things'], apiPrefix: '/api', volatileKeys: ['id'] }));
});

after(async () => {
  server.close();
  await rm(targetsDir, { recursive: true, force: true });
});

test('parity replays flows with bindings, credentials and cookies, and reports each deviation', async () => {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ['src/parity.ts', '--target', 'shop', '--base-url', baseUrl], {
      env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir, SPECULA_USERNAME: 'alice', SPECULA_PASSWORD: 'pw-123' },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.once('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
  });
  const summary = JSON.parse(out.trim().split('\n').pop()!);
  assert.equal(summary.total, 14);
  assert.equal(summary.passed, 8, 'both logins, two creates, the id-keyed stats, both seed-text steps and the cookie refresh pass');

  const [login, wrongLogin] = seen.filter((r) => r.url === '/api/login');
  assert.deepEqual(JSON.parse(login!.body), { username: 'alice', password: 'pw-123' }, 'placeholders filled from the environment');
  const wrong = JSON.parse(wrongLogin!.body);
  assert.ok(wrong.username === 'alice' && wrong.password !== 'pw-123' && wrong.password.length > 0, 'a non-account password stays wrong');
  assert.ok(seen.some((r) => r.url === '/api/things/40' && r.auth === 'Bearer tok-1'), 'bound id and learned bearer used');
  assert.equal(seen.find((r) => r.url === '/api/refresh')?.cookie, 'refresh=r1', 'path-scoped cookie sent');
  assert.equal(seen.find((r) => r.url === '/api/things?page=1')?.cookie, undefined, 'cookie not sent outside its path');
  const filter = new URL(seen.find((r) => r.url.startsWith('/api/stats'))!.url, 'http://x').searchParams.get('filter')!;
  assert.match(filter, /^id:40\+at:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'query template filled with the bound id and a time');
  assert.ok(Math.abs(Date.parse(`${filter.slice(-19).replace(' ', 'T')}Z`) - (Date.now() - 60_000)) < 30_000, 'time shifted from now');

  const report = JSON.parse(await readFile(join(targetsDir, 'shop', 'parity', 'report.json'), 'utf8'));
  const diffs = (n: number) => report.steps[n - 1].diffs.join('\n');
  assert.match(diffs(4), /\$\.title: expected "paint", got "PAINT"/);
  assert.match(diffs(5), /\$\.done: missing/);
  assert.match(diffs(6), /\$\.items: expected 2 items, got 1/);
  assert.match(diffs(6), /\$\.total: expected 2, got 1/);
  assert.match(diffs(11), /variable never was never bound/);
  assert.equal(diffs(13), '$.enabled: expected true, got false', 'booleans compared, plain numbers not');
  assert.equal(diffs(14), '$.code: expected 4002, got 4003', 'numbers in an error body compared');
  const md = await readFile(join(targetsDir, 'shop', 'parity', 'report.md'), 'utf8');
  assert.match(md, /\*\*Passes 8\/14 recorded behaviours \(57%\)\*\*/);
});

test('a token bound for a header of its own is sent there and never becomes the bearer', async () => {
  const dir = join(targetsDir, 'shared');
  await mkdir(join(dir, 'spec', 'flows'), { recursive: true });
  const flow = {
    name: 'shared',
    order: 1,
    description: '',
    steps: [
      step({ operationId: 'postLogin', method: 'POST', path: '/login', auth: 'none', body: { username: '<redacted:pii>', password: '<redacted:secret>' }, contentType: 'application/json', expect: { status: 200, contentType: 'application/json', body: { token: '<redacted:jwt>' } } }),
      step({ operationId: 'getShare', method: 'GET', path: '/share', expect: { status: 200, contentType: 'application/json', body: { websiteId: 'w1', token: '<redacted:jwt>' } }, bind: { appShareToken1: '$.token' } }),
      step({ operationId: 'getSharedStats', method: 'GET', path: '/shared-stats', tokenHeaders: { 'x-app-share-token': { var: 'appShareToken1' } }, expect: { status: 200, contentType: 'application/json', body: { views: 0 } } }),
      step({ operationId: 'getMe', method: 'GET', path: '/me', expect: { status: 200, contentType: 'application/json', body: { name: '<redacted:pii>' } } }),
      // Recorded empty (everything deleted), but the server still lists a row.
      step({ operationId: 'getThings', method: 'GET', path: '/things', expect: { status: 200, contentType: 'application/json', body: { items: [], total: 1 } } }),
    ],
  };
  await writeFile(join(dir, 'spec', 'flows', 'shared.json'), JSON.stringify(flow));
  await writeFile(join(dir, 'spec', 'flows', 'index.json'), JSON.stringify({ order: ['shared'], apiPrefix: '/api', volatileKeys: ['id'] }));
  seen.length = 0;
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ['src/parity.ts', '--target', 'shared', '--base-url', baseUrl], {
      env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir, SPECULA_USERNAME: 'alice', SPECULA_PASSWORD: 'pw-123' },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.once('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
  });
  const summary = JSON.parse(out.trim().split('\n').pop()!);
  assert.equal(summary.passed, 4);
  assert.equal(seen.find((r) => r.url === '/api/shared-stats')?.share, 'share-jwt-1', 'share token sent in its header');
  assert.equal(seen.find((r) => r.url === '/api/me')?.auth, 'Bearer tok-1', 'the bearer stays the login token');
  const report = JSON.parse(await readFile(join(dir, 'parity', 'report.json'), 'utf8'));
  assert.equal(report.steps[4].diffs.join('\n'), '$.items: expected 0 items, got 1', 'a list recorded empty must come back empty');
});
