// Entry point: node server.ts (from this folder, or with its path from anywhere)
//   PORT     (default 4456)
//   DB_PATH  (default rebuild/data/app.db; ":memory:" for a throwaway instance)
//   ACCESS_TOKEN_TTL  (access-token lifetime in seconds, default 600)

import { fileURLToPath } from 'node:url';

// node:sqlite and stripTypeScriptTypes print "experimental" warnings; keep the log quiet about those only.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/(SQLite|stripTypeScriptTypes) is an experimental feature/.test(text)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { startServer } = await import('./lib/app.ts');
const { closeDb } = await import('./lib/db.ts');
const { closeAll } = await import('./lib/ws.ts');
const { setAccessTokenTtl } = await import('./lib/auth.ts');

const port = Number(process.env.PORT ?? 4456);
const dbPath = process.env.DB_PATH ?? fileURLToPath(new URL('./data/app.db', import.meta.url));

const ttl = process.env.ACCESS_TOKEN_TTL;
if (ttl !== undefined && ttl !== '') {
  if (!/^\d+$/.test(ttl) || Number(ttl) <= 0) {
    process.stderr.write(`ACCESS_TOKEN_TTL must be a positive number of seconds, got "${ttl}".\n`);
    process.exit(1);
  }
  setAccessTokenTtl(Number(ttl));
}

const server = startServer(port, dbPath);
server.on('listening', () => process.stdout.write(`Listening on http://localhost:${port} (database: ${dbPath})\n`));

const shutdown = () => {
  closeAll();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
