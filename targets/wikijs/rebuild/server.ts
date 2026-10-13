// Pagegrove: a small team wiki. Serves the GraphQL API at POST /graphql, first-run setup at
// POST /finalize and the web UI at every other GET path.
//
//   PORT=4458 DB_PATH=:memory: node targets/wikijs/rebuild/server.ts

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToken, signToken } from './lib/auth.ts';
import { type ExecutionResult, execute } from './lib/graphql.ts';
import { Store } from './lib/store.ts';
import { PRODUCT, TOKEN_LIFETIME, VERSION, type WikiCtx, finalizeSetup, getUser, groupsOf, guestUser, isSetUp, schema } from './lib/wiki.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4458);
const dbPath = process.env.DB_PATH ?? ':memory:';
const MAX_BODY = 5 * 1024 * 1024;
const MAX_BATCH = 50;

const store = new Store(dbPath);
let secret = store.getMeta('tokenSecret');
if (!secret) {
  secret = randomBytes(32).toString('base64url');
  store.setMeta('tokenSecret', secret);
}
const tokenSecret = secret;

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
    else if (name === 'sign-in.svg') result = { type: 'image/svg+xml', body: signInSvg() };
    else if (name === 'mark.svg') result = { type: 'image/svg+xml', body: markSvg() };
  } catch {
    result = undefined;
  }
  if (result && process.env.NODE_ENV !== 'development') assetCache.set(name, result);
  return result;
}

function signInSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2e6b4f"/><rect x="14" y="20" width="36" height="25" rx="4" fill="none" stroke="#f4efe3" stroke-width="3"/><path d="m15 23 17 12 17-12" fill="none" stroke="#f4efe3" stroke-width="3" stroke-linejoin="round"/></svg>';
}

/** Pagegrove's mark: three leaves on a stem. */
function markSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#2e6b4f"/><path d="M32 54V26" stroke="#f4efe3" stroke-width="4" stroke-linecap="round"/><path d="M32 30c-10 0-15-6-15-15 10 0 15 6 15 15Z" fill="#a9d18e"/><path d="M32 38c10 0 15-6 15-15-10 0-15 6-15 15Z" fill="#e3c169"/><path d="M32 46c-8 0-12-5-12-12 8 0 12 5 12 12Z" fill="#f4efe3"/></svg>';
}

// ---- request handling --------------------------------------------------------------------

class HttpError extends Error {
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
        reject(new HttpError(413, 'The request body is too large.'));
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

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), headers);

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

/** Who the request acts as: the token's user, or the guest. Also hands out a fresh token past half-life. */
function contextFor(req: IncomingMessage, origin: string): { ctx: WikiCtx; renewed?: string } {
  const header = req.headers.authorization ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  const claims = token ? readToken(token, tokenSecret) : undefined;
  const user = claims ? getUser(store, claims.id) : undefined;
  if (claims && user && user.isActive && !user.isSystem) {
    const groups = groupsOf(store, user.id);
    const ctx: WikiCtx = { store, user, groups, signedIn: true, origin, secret: tokenSecret };
    const left = claims.exp - Date.now() / 1000;
    if (left < TOKEN_LIFETIME / 2) return { ctx, renewed: signToken({ id: user.id, email: user.email, name: user.name, grp: groups }, tokenSecret, TOKEN_LIFETIME) };
    return { ctx };
  }
  const guest = guestUser(store);
  return { ctx: { store, user: guest, groups: [2], signedIn: false, origin, secret: tokenSecret } };
}

function runOne(op: unknown, ctx: WikiCtx): ExecutionResult {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return { errors: [{ message: 'Each operation must be a JSON object with a query.', extensions: { code: 'BAD_USER_INPUT' } }] };
  return execute(schema, op as Record<string, unknown>, ctx as unknown as Record<string, unknown>);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? `localhost:${port}`;
  const url = new URL(req.url ?? '/', `http://${host}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  if (path === '/graphql') {
    if (method !== 'POST') return sendJson(res, 405, { errors: [{ message: 'Send GraphQL operations with POST.', extensions: { code: 'METHOD_NOT_ALLOWED' } }] }, { Allow: 'POST' });
    const body = await readJson(req);
    const { ctx, renewed } = contextFor(req, url.origin);
    const headers: Record<string, string> = renewed ? { 'X-Pagegrove-Token': renewed } : {};
    if (Array.isArray(body)) {
      if (body.length > MAX_BATCH) throw new HttpError(400, `A batch may hold at most ${MAX_BATCH} operations.`);
      return sendJson(res, 200, body.map((op) => runOne(op, ctx)), headers);
    }
    return sendJson(res, 200, runOne(body, ctx), headers);
  }

  if (path === '/finalize') {
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Send the setup form with POST.' }, { Allow: 'POST' });
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The setup form must be a JSON object.');
    const out = finalizeSetup(store, body as Record<string, unknown>);
    return sendJson(res, out.status, out.status === 200 ? { ...out.body, redirectPort: port } : out.body);
  }

  if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');

  if (path === '/status.json') return sendJson(res, 200, { product: PRODUCT, version: VERSION, setupDone: isSetUp(store) });
  if (path === '/logout') return send(res, 302, null, '', { Location: '/#/signin', 'Set-Cookie': 'pagegrove-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
  if (path === '/favicon.ico') return send(res, 302, null, '', { Location: '/_assets/mark.svg' });
  const assetMatch = /^\/_assets\/([\w.-]+)$/.exec(path);
  if (assetMatch) {
    const file = asset(assetMatch[1]!);
    return file ? send(res, 200, file.type, file.body, { 'Cache-Control': 'no-cache' }) : send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }
  const index = asset('index.html');
  return index ? send(res, 200, index.type, index.body) : send(res, 500, 'text/plain; charset=utf-8', 'The web UI is missing.');
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (error instanceof HttpError) {
      if (!res.headersSent) sendJson(res, error.status, { errors: [{ message: error.message, extensions: { code: 'BAD_REQUEST' } }] });
      return;
    }
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    if (!res.headersSent) sendJson(res, 500, { errors: [{ message: 'Something went wrong on the server.', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
  });
});

server.listen(port, () => process.stdout.write(`${PRODUCT} ${VERSION} listening on http://localhost:${port}/ (database: ${dbPath})\n`));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
