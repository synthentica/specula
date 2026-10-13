// HTTP server: API routes, the realtime upgrade, and the frontend (TypeScript served as JavaScript).

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PREFIX, handleApi } from './api.ts';
import { initSecret } from './auth.ts';
import { openDb } from './db.ts';
import { applyCors, HttpError, originOf, requestId, sendProblem, sendText } from './http.ts';
import { handleUpgrade } from './ws.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const compiled = new Map<string, { mtime: string; code: string }>();

async function serveStatic(pathname: string): Promise<{ type: string; body: string | Buffer } | undefined> {
  const rel = normalize(decodeURIComponent(pathname.replace(/^\/web\//, ''))).replace(/^([/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB + sep)) return undefined;
  const ext = extname(file);
  if (!MIME[ext]) return undefined;
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  if (ext === '.ts') {
    const hit = compiled.get(file);
    if (hit && hit.mtime === source) return { type: MIME[ext]!, body: hit.code };
    const code = stripTypeScriptTypes(source, { mode: 'strip' });
    compiled.set(file, { mtime: source, code });
    return { type: MIME[ext]!, body: code };
  }
  return { type: MIME[ext]!, body: source };
}

export function startServer(port: number, dbPath: string): Server {
  openDb(dbPath);
  initSecret();

  const server = createServer(async (req, res) => {
    res.setHeader('X-Request-Id', requestId());
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        applyCors(req, res);
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'This method is not allowed here.');
      if (url.pathname.startsWith('/web/')) {
        const file = await serveStatic(url.pathname);
        if (!file) throw new HttpError(404, 'Not found.');
        sendText(res, 200, file.type, file.body, { 'Cache-Control': 'no-cache' });
        return;
      }
      // Every other path is a page of the single-page frontend.
      const index = await readFile(join(WEB, 'index.html'), 'utf8');
      sendText(res, 200, MIME['.html']!, index, { 'Cache-Control': 'no-cache' });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendProblem(res, originOf(req), error);
        return;
      }
      process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      sendProblem(res, originOf(req), new HttpError(500, 'Something went wrong on the server.'));
    }
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== `${API_PREFIX}/ws`) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    handleUpgrade(req, socket);
  });

  server.listen(port);
  return server;
}
