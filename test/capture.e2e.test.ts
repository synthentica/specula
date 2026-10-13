// End-to-end: real headless Chrome, synthetic app, capture helper as a child process.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CdpConnection, pickPageTarget } from '../src/lib/cdp.ts';
import type { CaptureEvent, Har } from '../src/lib/har.ts';
import { parseJsonl } from '../src/lib/har.ts';
import { findChrome, launchChrome, type TestBrowser } from './fixtures/chrome.ts';
import { FIXTURE_JWT, startFixtureServer } from './fixtures/app-server.ts';

const chrome = findChrome();
let browser: TestBrowser;
let origin: string;
let stopServer: () => void;
let targetsDir: string;

before(async () => {
  if (!chrome) return;
  const fixture = await startFixtureServer();
  origin = fixture.origin;
  stopServer = () => {
    fixture.server.closeAllConnections();
    fixture.server.close();
  };
  browser = await launchChrome(chrome, `${origin}/`);
  targetsDir = await mkdtemp(join(tmpdir(), 'specula-targets-'));
  await mkdir(join(targetsDir, 'fixture'), { recursive: true });
  await writeFile(join(targetsDir, 'fixture', 'target.json'), JSON.stringify({ name: 'fixture', origin, redact: { values: ['wp-tester'] } }));
});

after(async () => {
  if (!chrome) return;
  // Each step runs even if an earlier one fails, so nothing is left holding the event loop open.
  try {
    await browser?.close();
  } finally {
    stopServer?.();
    if (targetsDir) await rm(targetsDir, { recursive: true, force: true });
  }
});

test('capture records actions, requests with initiators, websocket frames, and redacts secrets', { skip: !chrome && 'no Chrome found' }, async () => {
  const child = spawn(process.execPath, ['src/capture.ts', '--target', 'fixture', '--flow', 'login-add', '--cdp', browser.httpUrl], {
    env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  await new Promise<void>((resolve, reject) => {
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.includes('recording')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`capture exited early (${code}): ${stderr}`)));
  });

  // Drive the page from a separate CDP connection, like chrome-devtools-mcp would.
  const driver = await CdpConnection.connect(browser.wsUrl);
  const page = await pickPageTarget(driver, origin);
  const { sessionId } = await driver.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const run = (expression: string) => driver.send('Runtime.evaluate', { expression, awaitPromise: true }, sessionId);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await run(`document.getElementById('login').click()`);
  await pause(400);
  await run(`(() => { const el = document.getElementById('name'); el.value = 'Milk'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await pause(600);
  await run(`document.getElementById('add').click()`);
  await pause(400);
  await run(`document.getElementById('ws').click()`);
  await pause(600);
  await run(`document.getElementById('ws').click()`);
  await pause(600);
  await run(`document.getElementById('subscribe').click()`);
  await pause(400);
  driver.close();

  child.kill('SIGINT');
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
  const summary = JSON.parse(stdout.trim().split('\n').pop()!);
  assert.equal(summary.ok, true);

  const dir = join(targetsDir, 'fixture', 'capture');
  const harText = await readFile(join(dir, 'login-add.har'), 'utf8');
  const har = JSON.parse(harText) as Har;
  const events = parseJsonl<CaptureEvent>(await readFile(join(dir, 'login-add.events.jsonl'), 'utf8'));
  const auth = JSON.parse(await readFile(join(dir, 'login-add.auth.json'), 'utf8'));

  // Nothing secret on disk.
  for (const secret of [FIXTURE_JWT, 'hunter22', 'server-session-value-123', 'tester@example.org', 'wp-tester']) {
    assert.ok(!harText.includes(secret), `HAR leaks ${secret.slice(0, 6)}…`);
  }

  const login = har.log.entries.find((e) => e.request.url.endsWith('/api/login'))!;
  assert.ok(login, 'login request captured');
  assert.match(login.request.postData!.text, /"password":"<redacted:secret>"/);
  assert.match(login.response.content.text!, /"token":"<redacted:jwt>"/);
  assert.ok(login.response.headers.some((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('sid=<redacted:cookie>')));

  const add = har.log.entries.find((e) => e.request.url.endsWith('/api/items'))!;
  assert.equal(add.response.status, 201);
  assert.ok(add.request.headers.some((h) => h.name.toLowerCase() === 'authorization' && h.value === 'Bearer <redacted:jwt>'));
  const frames = add._initiator?.stack?.flatMap((g) => g.frames) ?? [];
  assert.ok(frames.some((f) => f.functionName === 'addItem' && f.url.endsWith('/app.js')), 'initiator stack points at addItem in app.js');

  const actions = events.filter((e) => e.type === 'action');
  assert.deepEqual(
    actions.map((a) => (a.type === 'action' ? `${a.kind}:${a.target.name ?? a.target.selector}` : '')),
    ['click:Log in', 'input:Item name', 'click:Add item', 'click:Ping socket', 'click:Ping socket', 'click:Subscribe'],
  );
  const inputAction = actions[1];
  assert.ok(inputAction?.type === 'action' && inputAction.valueInfo?.length === 4, 'input records length only');
  assert.ok(!JSON.stringify(events).includes('Milk'), 'typed value never recorded');

  const wsFrames = events.filter((e) => e.type === 'ws-frame');
  assert.ok(wsFrames.length >= 3, `expected websocket frames, got ${wsFrames.length}`);
  assert.ok(wsFrames.some((f) => f.type === 'ws-frame' && f.direction === 'received' && f.payload.includes('pong')));

  assert.equal(auth.authorization[0].scheme, 'Bearer');
  assert.deepEqual(auth.authorization[0].jwt.claimNames, ['exp', 'iat', 'sub']);
  assert.ok(auth.cookiesSet.some((c: { name: string; attributes: string[] }) => c.name === 'sid' && c.attributes.includes('HttpOnly')));
  assert.ok(auth.tokenFieldsInResponses.some((t: { path: string; kind: string }) => t.path === '$.token' && t.kind === 'jwt'));

  const scripts = JSON.parse(await readFile(join(dir, 'login-add.scripts.json'), 'utf8'));
  const app = scripts.find((s: { url: string }) => s.url.endsWith('/app.js'));
  assert.ok(app?.file && app.sourceMapFile, 'first-party script and its source map saved');
  const widget = scripts.find((s: { url: string }) => s.url.endsWith('/widget.js'));
  assert.ok(widget?.callsTarget && widget.file && widget.sourceMapFile, 'CDN script that calls the target saved with its map');

  const runtime = JSON.parse(await readFile(join(dir, 'login-add.runtime.json'), 'utf8'));
  assert.equal(runtime.markers.vue, true, 'data-v-* attribute detected');

  // The look of each view: boxes and computed styles, never the words on the page.
  const uiText = await readFile(join(dir, 'login-add.ui.json'), 'utf8');
  const ui = JSON.parse(uiText);
  assert.ok(ui.snapshots.length >= 1, 'at least one view snapshot');
  const snap = ui.snapshots.at(-1).snapshot;
  assert.ok(snap.regions.some((r: { role: string }) => r.role === 'main'), 'main region found');
  assert.ok(snap.components.some((c: { kind: string }) => c.kind === 'button'), 'buttons found');
  assert.match(snap.page.background, /^#[0-9a-f]{6}$/);
  for (const text of ['Log in', 'Add item', 'Milk', 'Ping socket']) assert.ok(!uiText.includes(text), `ui.json holds page text "${text}"`);

  // Analysis on the same capture.
  const helper = (name: string) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, [`src/${name}.ts`, '--target', 'fixture'], { env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir } });
      let out = '';
      let err = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (err += c));
      p.once('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${name} failed: ${err}`))));
    });
  await helper('correlate');
  const correlation = JSON.parse(await readFile(join(targetsDir, 'fixture', 'analysis', 'correlation.json'), 'utf8'));
  const flowResult = correlation.flows[0];
  const addAction = flowResult.actions.find((a: { target?: { name?: string } }) => a.target?.name === 'Add item');
  const linked = addAction.requests.find((r: { endpoint: string }) => r.endpoint === 'PUT /api/items');
  assert.ok(linked, 'Add item click linked to PUT /api/items');
  assert.equal(linked.confidence, 'high');
  assert.equal(linked.callSite.functionName, 'addItem');
  assert.equal(linked.callSite.original.source, 'src/app-original.js', 'frame resolved through the public source map');
  assert.ok(flowResult.actions.find((a: { target?: { name?: string } }) => a.target?.name === 'Ping socket').wsFramesSent.length >= 1);
  const subscribe = flowResult.actions.find((a: { target?: { name?: string } }) => a.target?.name === 'Subscribe').requests[0];
  assert.equal(subscribe.endpoint, 'POST /api/subscribe');
  assert.deepEqual(subscribe.sourceChain?.[0], { source: 'src/widget-original.js', line: 2 }, 'CDN frame resolved to its original file');

  await helper('infer-ui');
  const uiViews = JSON.parse(await readFile(join(targetsDir, 'fixture', 'spec', 'ui', 'views.json'), 'utf8'));
  assert.ok(uiViews.views.length >= 1, 'UI spec has a view from the capture');
  assert.equal(uiViews.views[0].seedFlow, 'login-add');
  const tokens = JSON.parse(await readFile(join(targetsDir, 'fixture', 'spec', 'ui', 'tokens.json'), 'utf8'));
  assert.match(tokens.color.page, /^#[0-9a-f]{6}$/);
  assert.ok((await readFile(join(targetsDir, 'fixture', 'spec', 'UI.md'), 'utf8')).startsWith('# UI spec'));

  await helper('fingerprint');
  const fp = JSON.parse(await readFile(join(targetsDir, 'fixture', 'analysis', 'fingerprint.json'), 'utf8'));
  assert.ok(fp.auth.some((f: { claim: string }) => f.claim === 'Credential endpoint: POST /api/login'));
  assert.ok(fp.realtime.some((f: { claim: string }) => f.claim === 'WebSocket /ws'));
  assert.ok(fp.apiPathsInCode.paths.some((p: { path: string; observed: boolean }) => p.path === '/api/items' && p.observed));

  await helper('report');
  const report = await readFile(join(targetsDir, 'fixture', 'analysis', 'REPORT.md'), 'utf8');
  assert.match(report, /## Not determined/);
  assert.match(report, /`PUT \/api\/items` 201/);
  assert.match(report, /source `src\/widget-original\.js:2`/);
});
