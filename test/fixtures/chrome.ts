// Launches a throwaway headless Chrome/Chromium with a remote debugging port for tests.
// Set SPECULA_CHROME to the browser binary; tests are skipped when none is found.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.SPECULA_CHROME,
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function findChrome(): string | undefined {
  return CANDIDATES.find((path): path is string => !!path && existsSync(path));
}

export interface TestBrowser {
  wsUrl: string;
  httpUrl: string;
  close: () => Promise<void>;
}

export async function launchChrome(binary: string, startUrl: string): Promise<TestBrowser> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'specula-chrome-'));
  const child: ChildProcess = spawn(
    binary,
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, startUrl],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not report a DevTools URL:\n${buffer}`)), 20_000);
    child.stderr!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
  });
  const httpUrl = `http://${new URL(wsUrl).host}`;
  return {
    wsUrl,
    httpUrl,
    close: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}
