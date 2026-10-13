// Tackboard: team kanban boards. Serves the JSON API under /api/v2, the realtime socket at /ws and
// the web UI at every other GET path.
//
//   PORT=4459 DB_PATH=:memory: node targets/focalboard/rebuild/server.ts

import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from './lib/api.ts';
import { Store } from './lib/store.ts';
import { seedTemplates } from './lib/templates.ts';
import { closeAll, handleUpgrade } from './lib/ws.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4459);
const dbPath = process.env.DB_PATH ?? ':memory:';
const MAX_BODY = 5 * 1024 * 1024;
const API_PREFIX = '/api/v2';

const store = new Store(dbPath);
seedTemplates(store);
const api = new Api(store);

// ---- static UI ---------------------------------------------------------------------------

const webDir = join(here, 'web');
const assetCache = new Map<string, { type: string; body: string }>();

/** Tackboard's mark: a pin over three columns. */
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#25405f"/><rect x="12" y="18" width="11" height="32" rx="3" fill="#f2efe6"/><rect x="26.5" y="18" width="11" height="22" rx="3" fill="#f2efe6"/><rect x="41" y="18" width="11" height="27" rx="3" fill="#f2efe6"/><circle cx="32" cy="14" r="6" fill="#e2683c"/></svg>';

function asset(name: string): { type: string; body: string } | undefined {
  const cached = assetCache.get(name);
  if (cached) return cached;
  let result: { type: string; body: string } | undefined;
  try {
    if (name === 'app.js') result = { type: 'text/javascript; charset=utf-8', body: stripTypeScriptTypes(readFileSync(join(webDir, 'app.ts'), 'utf8')) };
    else if (name === 'styles.css') result = { type: 'text/css; charset=utf-8', body: readFileSync(join(webDir, 'styles.css'), 'utf8') };
    else if (name === 'index.html') result = { type: 'text/html; charset=utf-8', body: readFileSync(join(webDir, 'index.html'), 'utf8') };
    else if (name === 'icon.svg') result = { type: 'image/svg+xml', body: ICON_SVG };
  } catch {
    result = undefined;
  }
  if (result && process.env.NODE_ENV !== 'development') assetCache.set(name, result);
  return result;
}

// ---- request handling --------------------------------------------------------------------

class BodyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BodyError(413, 'The request body is too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, type: string | null, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...(type ? { 'Content-Type': type } : {}), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
const apiError = (res: ServerResponse, status: number, message: string) => sendJson(res, status, { error: message, errorCode: status });

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
  // Like the original, API calls must come from the app's own scripts (a simple CSRF guard).
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return apiError(res, 400, 'Send the X-Requested-With: XMLHttpRequest header with API requests.');
  let body: unknown;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    const raw = await readBody(req);
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return apiError(res, 400, 'The request body is not valid JSON.');
      }
    }
  }
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const out = api.handle({ method, path: url.pathname.slice(API_PREFIX.length) || '/', query: url.searchParams, body, token });
  sendJson(res, out.status, out.body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${port}`}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) return handleApi(req, res, url, method);
  if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', { Allow: 'GET, HEAD' });
  if (path === '/favicon.ico') return send(res, 302, null, '', { Location: '/assets/icon.svg' });
  const assetMatch = /^\/assets\/([\w.-]+)$/.exec(path);
  if (assetMatch) {
    const file = asset(assetMatch[1]!);
    return file ? send(res, 200, file.type, file.body, { 'Cache-Control': 'no-cache' }) : send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }
  const index = asset('index.html');
  return index ? send(res, 200, index.type, index.body) : send(res, 500, 'text/plain; charset=utf-8', 'The web UI is missing.');
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (error instanceof BodyError) {
      if (!res.headersSent) apiError(res, error.status, error.message);
      return;
    }
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    if (!res.headersSent) apiError(res, 500, 'Something went wrong on the server.');
  });
});

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  handleUpgrade(req, socket, head, (token) => api.userForToken(token)?.id);
});

server.listen(port, () => process.stdout.write(`Tackboard listening on http://localhost:${port}/ (database: ${dbPath})\n`));

const shutdown = () => {
  closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
