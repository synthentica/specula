// One-command demo: starts each rebuild on a fresh in-memory instance, replays the recorded flows
// against it and prints the parity score. Needs no Docker, Chrome or network; writes no files.
// Takes about half a minute: one flow waits out a short token lifetime, as recorded.
//
//   npm run demo                # every target that has a rebuild
//   npm run demo -- ghost       # one target

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const available = readdirSync(join(root, 'targets')).filter((t) => existsSync(join(root, 'targets', t, 'rebuild', 'server.ts')));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : available;
for (const t of targets) {
  if (!available.includes(t)) throw new Error(`no rebuild for target "${t}" (have: ${available.join(', ')})`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, ms = 15000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(url, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`${url} did not answer within ${ms} ms`);
}

function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// One test account for the rebuild and the replay: a target recorded against a hosted service has no
// sign-up flow, so its rebuild seeds this account at start-up and the replay signs in with it.
const account = {
  SPECULA_EMAIL: process.env.SPECULA_EMAIL ?? 'parity@example.test',
  SPECULA_PASSWORD: process.env.SPECULA_PASSWORD ?? 'Parity-password-1',
  SPECULA_USERNAME: process.env.SPECULA_USERNAME ?? 'parity',
};

const rows: string[] = [];
let allPassed = true;
for (const target of targets) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  process.stdout.write(`\n${target}: starting rebuild on ${baseUrl} (fresh, in memory)\n`);
  const server = spawn(process.execPath, [join('targets', target, 'rebuild', 'server.ts')], {
    cwd: root,
    // ACCESS_TOKEN_TTL: the token-refresh flow was recorded with 15-second tokens (targets/vikunja/spec/SPEC.md §3).
    env: { ...process.env, ...account, PORT: String(port), DB_PATH: ':memory:', ACCESS_TOKEN_TTL: '15' },
    stdio: 'ignore',
  });
  try {
    await waitForHttp(baseUrl);
    process.stdout.write(`${target}: replaying recorded flows from targets/${target}/spec/flows\n`);
    const result = await run(['src/parity.ts', '--target', target, '--base-url', baseUrl, '--label', 'demo', '--dry-run', '--skip-app-waits'], { ...process.env, ...account });
    const line = result.stdout.trim().split('\n').pop() ?? '';
    const summary = (() => {
      try {
        return JSON.parse(line) as { passed: number; total: number; checks: { keys: number; lists: number; values: number; flags: number } };
      } catch {
        return undefined;
      }
    })();
    if (!summary) {
      allPassed = false;
      rows.push(`| ${target} | error | ${(result.stderr.trim().split('\n').pop() ?? 'no output').slice(0, 80)} |`);
      continue;
    }
    if (summary.passed !== summary.total) allPassed = false;
    rows.push(`| ${target} | ${summary.passed}/${summary.total} | ${summary.checks.keys} keys, ${summary.checks.lists} list sizes, ${summary.checks.values} values, ${summary.checks.flags} flags |`);
  } finally {
    server.kill();
  }
}

process.stdout.write(['', '| Target | Parity | Checked |', '|---|---|---|', ...rows, ''].join('\n'));
process.stdout.write(allPassed ? '\nEvery recorded behaviour reproduced by the rebuild.\n' : '\nSome behaviours differ: run src/parity.ts without --dry-run for the full report.\n');
process.exitCode = allPassed ? 0 : 1;
