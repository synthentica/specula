// Tiny synthetic web app for end-to-end tests: JSON login returning a JWT,
// a bearer-protected API, a WebSocket echo and a page that wires them to buttons.
// A sign-up widget is loaded from another origin (localhost instead of 127.0.0.1), like app code on a CDN.

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

// Synthetic unsigned token used only by this fixture.
export const FIXTURE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiaWF0IjoxMDAwLCJleHAiOjQ2MDB9.c2lnbmF0dXJl';

const page = (port: number) => `<!doctype html><html><head><title>fixture</title></head><body>
<div id="app" data-v-abc123>
  <input id="name" aria-label="Item name">
  <button id="login">Log in</button>
  <button id="add" data-testid="add-item">Add item</button>
  <button id="ws">Ping socket</button>
  <button id="subscribe">Subscribe</button>
</div>
<script src="/app.js"></script>
<script src="http://localhost:${port}/widget.js"></script>
</body></html>`;

const APP_JS = `let token;
let socket;
async function login() {
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'wp-tester', password: 'hunter22' }) });
  token = (await res.json()).token;
}
async function addItem() {
  await fetch('/api/items', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ title: document.getElementById('name').value }) });
}
function ping() {
  if (!socket) { socket = new WebSocket('ws://' + location.host + '/ws'); socket.onopen = () => socket.send(JSON.stringify({ type: 'ping', n: 1 })); }
  else socket.send(JSON.stringify({ type: 'ping', n: 2 }));
}
document.getElementById('login').addEventListener('click', login);
document.getElementById('add').addEventListener('click', addItem);
document.getElementById('ws').addEventListener('click', ping);
//# sourceMappingURL=app.js.map
`;

// Identity source map: one source, every line maps to itself (column 0).
const APP_MAP = JSON.stringify({
  version: 3,
  file: 'app.js',
  sources: ['src/app-original.js'],
  names: [],
  mappings: APP_JS.split('\n').map((_, i) => (i === 0 ? 'AAAA' : 'AACA')).join(';'),
});

const WIDGET_JS = `document.getElementById('subscribe').addEventListener('click', function subscribe() {
  fetch('/api/subscribe', { method: 'POST' });
});
//# sourceMappingURL=widget.js.map
`;

const WIDGET_MAP = JSON.stringify({
  version: 3,
  file: 'widget.js',
  sources: ['../src/widget-original.js'],
  names: [],
  mappings: WIDGET_JS.split('\n').map((_, i) => (i === 0 ? 'AAAA' : 'AACA')).join(';'),
});

export async function startFixtureServer(): Promise<{ origin: string; server: Server }> {
  let nextId = 1;
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page(req.socket.localPort ?? 0));
    } else if (req.url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(APP_JS);
    } else if (req.url === '/app.js.map') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(APP_MAP);
    } else if (req.url === '/widget.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(WIDGET_JS);
    } else if (req.url === '/widget.js.map') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(WIDGET_MAP);
    } else if (req.url === '/api/subscribe' && req.method === 'POST') {
      json(201, { subscribed: true });
    } else if (req.url === '/api/login' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=server-session-value-123; Path=/; HttpOnly; SameSite=Lax' });
      res.end(JSON.stringify({ token: FIXTURE_JWT, user: { id: 1, username: 'wp-tester', email: 'tester@example.org' } }));
    } else if (req.url === '/api/items' && req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${FIXTURE_JWT}`) return json(401, { message: 'unauthorized' });
        json(201, { id: nextId++, ...JSON.parse(body), created: new Date().toISOString() });
      });
    } else {
      json(404, { message: 'not found' });
    }
  });
  server.on('upgrade', (req, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (buf: Buffer) => {
      const opcode = buf[0]! & 0x0f;
      if (opcode === 8) return socket.end();
      let len = buf[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        len = buf.readUInt16BE(2);
        offset = 4;
      }
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len).map((b, i) => b ^ mask[i % 4]!));
      const reply = Buffer.from(JSON.stringify({ type: 'pong', echo: JSON.parse(payload.toString('utf8')) }));
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { origin: `http://127.0.0.1:${address.port}`, server };
}
