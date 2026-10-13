// parity replays a flow's WebSocket messages and scores each push the recording expects.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let targetsDir: string;
let server: Server;
let baseUrl: string;
const socketMessages: unknown[] = [];
const requestUrls: string[] = [];
let csrfRejected = 0;

// Just enough RFC 6455 for one client: unfragmented text frames, client-to-server masked.
function sendFrame(socket: Duplex, value: unknown): void {
  const data = Buffer.from(JSON.stringify(value));
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  socket.write(Buffer.concat([head, data]));
}
function readFrames(buffer: Buffer, onText: (text: string) => void, onClose: () => void): void {
  let at = 0;
  while (at + 2 <= buffer.length) {
    const opcode = buffer[at]! & 15;
    let len = buffer[at + 1]! & 127;
    let off = at + 2;
    if (len === 126) {
      len = buffer.readUInt16BE(off);
      off += 2;
    }
    const mask = buffer.subarray(off, off + 4);
    const payload = Buffer.from(buffer.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]!));
    if (opcode === 1) onText(payload.toString());
    if (opcode === 8) onClose();
    at = off + 4 + len;
  }
}

before(async () => {
  const cards: { id: string; title: string; done: boolean }[] = [];
  const sockets = new Set<Duplex>();
  const push = (value: unknown, delayMs = 0) => setTimeout(() => sockets.forEach((s) => sendFrame(s, value)), delayMs);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requestUrls.push(`${req.method} ${req.url}`);
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        csrfRejected++;
        return send(400, { error: 'csrf' });
      }
      if (req.url === '/api/login') return send(200, { token: 'tok-9' });
      if (req.headers.authorization !== 'Bearer tok-9') return send(401, { error: 'no token' });
      if (req.url === '/api/cards' && req.method === 'POST') {
        const card = { id: `c${createHash('sha1').update(String(cards.length)).digest('hex').replace(/\d/g, 'q').slice(0, 20)}${cards.length}x9k3m`, title: JSON.parse(body).title as string, done: false };
        cards.push(card);
        // The first card's push arrives late, after the second card's: the runner must match pushes in any order.
        push({ action: 'UPDATE_CARD', card }, cards.length === 1 ? 300 : 0);
        if (cards.length === 1) push({ action: 'UPDATE_COUNT', total: 1 });
        return send(200, card);
      }
      // Storage order, not creation order.
      if (req.url === '/api/cards' && req.method === 'GET') return send(200, [...cards].reverse());
      const m = req.url?.match(/^\/api\/cards\/(\w+)$/);
      if (m && req.method === 'DELETE') return send(200, {});
      send(404, { error: 'unknown' });
    });
  });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (buffer: Buffer) =>
      readFrames(
        buffer,
        (text) => {
          const message = JSON.parse(text) as { action?: string; token?: string };
          socketMessages.push(message);
          if (message.action === 'AUTH' && message.token === 'tok-9') sockets.add(socket);
        },
        () => {
          sockets.delete(socket);
          socket.end();
        },
      ),
    );
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  targetsDir = await mkdtemp(join(tmpdir(), 'specula-realtime-'));
  const dir = join(targetsDir, 'board');
  await mkdir(join(dir, 'spec', 'flows'), { recursive: true });
  const source = 'capture/cards.har#entries[0]';
  const card = (title: string) => ({ id: 'cr1xt3nsrmt8r9fqybixh61ytyr', title, done: false });
  const receive = (kind: string, message: unknown) => ({ channel: '/ws', kind, message, source: 'capture/cards.events.jsonl:1' });
  const flow = {
    name: 'cards',
    order: 1,
    description: '',
    steps: [
      { action: null, request: { operationId: 'postLogin', method: 'POST', path: '/login', auth: 'none', body: { username: 'me', password: '<redacted:secret>' }, expect: { status: 200, contentType: 'application/json', body: { token: '<redacted:secret>' } }, source } },
      { action: null, send: { channel: '/ws', message: { action: 'AUTH', token: '<redacted:secret>' } }, source: 'capture/cards.events.jsonl:2' },
      {
        action: null,
        request: { operationId: 'postCards', method: 'POST', path: '/cards', auth: 'bearer', body: { title: 'Paint' }, expect: { status: 200, contentType: 'application/json', body: card('Paint') }, source },
        receive: [receive('UPDATE_CARD', { action: 'UPDATE_CARD', card: card('Paint') }), receive('UPDATE_COUNT', { action: 'UPDATE_COUNT', total: 1 })],
      },
      {
        action: null,
        request: { operationId: 'postCards', method: 'POST', path: '/cards', auth: 'bearer', body: { title: 'Brush' }, expect: { status: 200, contentType: 'application/json', body: card('Brush') }, source },
        receive: [receive('UPDATE_CARD', { action: 'UPDATE_CARD', card: card('Brush') })],
      },
      { action: null, request: { operationId: 'getCards', method: 'GET', path: '/cards', auth: 'bearer', expect: { status: 200, contentType: 'application/json', body: [card('Paint'), card('Brush')] }, bind: { brush: '$[?title="Brush"].id' }, source } },
      {
        action: null,
        request: { operationId: 'deleteCard', method: 'DELETE', path: '/cards/{cardId}', pathParams: { cardId: { var: 'brush' } }, auth: 'bearer', expect: { status: 200, contentType: 'application/json', body: {} }, source },
        receive: [receive('CARD_GONE', { action: 'CARD_GONE' })],
      },
    ],
  };
  await writeFile(join(dir, 'spec', 'flows', 'cards.json'), JSON.stringify(flow));
  await writeFile(join(dir, 'spec', 'flows', 'index.json'), JSON.stringify({ order: ['cards'], apiPrefix: '/api', volatileKeys: ['id'], headers: { 'X-Requested-With': 'XMLHttpRequest' } }));
});

after(async () => {
  server.close();
  server.closeAllConnections();
  await rm(targetsDir, { recursive: true, force: true });
});

test('parity sends socket messages with the session token and matches expected pushes in any order', async () => {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ['src/parity.ts', '--target', 'board', '--base-url', baseUrl], { env: { ...process.env, SPECULA_TARGETS_DIR: targetsDir } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.once('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
  });
  const summary = JSON.parse(out.trim().split('\n').pop()!);
  assert.equal(summary.total, 9, '5 requests and 4 expected pushes');
  assert.equal(summary.passed, 8, 'everything but the push the server never sends');

  assert.deepEqual(socketMessages, [{ action: 'AUTH', token: 'tok-9' }], 'a redacted token in a socket message is the session token learned from {"token": ...}');
  assert.equal(csrfRejected, 0, 'flows/index.json headers went with every request');
  const brushId = requestUrls.find((u) => u.startsWith('DELETE'))!.split('/').pop()!;
  assert.match(brushId, /1x9k3m$/, 'the selector bound the second card although the list came back reversed');

  const report = JSON.parse(await readFile(join(targetsDir, 'board', 'parity', 'report.json'), 'utf8'));
  const failed = report.steps.filter((s: { pass: boolean }) => !s.pass);
  assert.equal(failed.length, 1);
  assert.match(failed[0].operation, /^receive CARD_GONE on \/ws \(after DELETE \/cards\/\{cardId\}\)$/);
  assert.match(failed[0].diffs[0], /no "CARD_GONE" message on \/ws/);
  const md = await readFile(join(targetsDir, 'board', 'parity', 'report.md'), 'utf8');
  assert.match(md, /Pushed realtime messages: 3\/4\./);
});
