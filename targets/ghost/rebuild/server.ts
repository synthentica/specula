// Pressloft: a small publishing admin. Serves the admin API under /app/api/admin and the admin UI at /app/.
//
//   PORT=4457 DB_PATH=:memory: node targets/ghost/rebuild/server.ts

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PREFIX, type ApiResponse, handleApi } from './lib/api.ts';
import { seed } from './lib/seed.ts';
import { Store } from './lib/store.ts';
import { ApiError, errorBody } from './lib/util.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4457);
const dbPath = process.env.DB_PATH ?? ':memory:';
const MAX_BODY = 5 * 1024 * 1024;

const store = new Store(dbPath);
seed(store);

// ---- static UI ---------------------------------------------------------------------------

const webDir = join(here, 'web');
const assetCache = new Map<string, { type: string; body: string }>();
function asset(name: string): { type: string; body: string } | undefined {
  const cached = assetCache.get(name);
  if (cached) return cached;
  let result: { type: string; body: string } | undefined;
  try {
    if (name === 'app.js') result = { type: 'text/javascript; charset=utf-8', body: stripTypeScriptTypes(readFileSync(join(webDir, 'app.ts'), 'utf8')) };
    else if (name === 'styles.css') result = { type: 'text/css; charset=utf-8', body: readFileSync(join(webDir, 'styles.css'), 'utf8') };
    else if (name === 'index.html') result = { type: 'text/html; charset=utf-8', body: readFileSync(join(webDir, 'index.html'), 'utf8') };
    else if (name === 'cover.svg') result = { type: 'image/svg+xml', body: coverSvg() };
  } catch {
    result = undefined;
  }
  if (result && process.env.NODE_ENV !== 'development') assetCache.set(name, result);
  return result;
}

function coverSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6f5e"/><stop offset="1" stop-color="#e3b26b"/></linearGradient></defs><rect width="1200" height="600" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="3"><path d="M0 470 Q300 380 600 450 T1200 420"/><path d="M0 520 Q320 440 620 500 T1200 470"/></g></svg>`;
}

function avatarSvg(seedText: string): string {
  const hash = createHash('sha256').update(seedText).digest();
  const hue = (hash[0] ?? 0) * 360 / 256;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="hsl(${hue.toFixed(0)} 45% 55%)"/><circle cx="32" cy="26" r="11" fill="#fff" fill-opacity=".85"/><path d="M12 56c3-11 11-16 20-16s17 5 20 16" fill="#fff" fill-opacity=".85"/></svg>`;
}

// ---- request handling --------------------------------------------------------------------

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'RequestEntityTooLargeError', 'The request body is too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, type: string | null, body: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { ...(type ? { 'Content-Type': type } : {}), 'Cache-Control': 'no-cache, private', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

function sendApi(res: ServerResponse, out: ApiResponse): void {
  if (out.status === 204) return send(res, 204, null, '', out.headers);
  if (out.text !== undefined) return send(res, out.status, 'text/plain; charset=utf-8', out.text, out.headers);
  send(res, out.status, 'application/json; charset=utf-8', JSON.stringify(out.body ?? {}), out.headers);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? `localhost:${port}`;
  const url = new URL(req.url ?? '/', `http://${host}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
    try {
      const raw = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
      let body: unknown;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new ApiError(400, 'BadRequestError', 'The request body is not valid JSON.');
        }
      }
      const out = handleApi(store, { method, path: path.slice(API_PREFIX.length) || '/', query: url.searchParams, body, cookies: parseCookies(req.headers.cookie), origin: url.origin, hostname: url.hostname });
      sendApi(res, out);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, 'InternalServerError', 'Something went wrong on the server.');
      if (!(error instanceof ApiError)) process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      send(res, apiError.status, 'application/json; charset=utf-8', JSON.stringify(errorBody(apiError)));
    }
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
  if (path === '/' || path === '/app') return send(res, 302, null, '', { Location: '/app/' });
  const avatar = path.match(/^\/app\/avatar\/([\w-]+)\.svg$/);
  if (avatar) return send(res, 200, 'image/svg+xml', avatarSvg(avatar[1]!), { 'Cache-Control': 'public, max-age=86400' });
  const assetMatch = path.match(/^\/app\/assets\/([\w.-]+)$/);
  if (assetMatch) {
    const file = asset(assetMatch[1]!);
    return file ? send(res, 200, file.type, file.body) : send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }
  if (path === '/app/' || path.startsWith('/app/')) {
    const index = asset('index.html');
    return index ? send(res, 200, index.type, index.body) : send(res, 500, 'text/plain; charset=utf-8', 'The admin UI is missing.');
  }
  send(res, 404, 'text/html; charset=utf-8', '<!doctype html><title>Not found</title><p>Nothing here. The admin lives at <a href="/app/">/app/</a>.</p>');
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal error');
  });
});

server.listen(port, () => process.stdout.write(`Pressloft admin listening on http://localhost:${port}/app/ (database: ${dbPath})\n`));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
