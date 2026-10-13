// A Chrome tab driven over CDP for the visual check: open a page at a fixed viewport, sign in through the
// app's own form, wait until the view settles, read a UI snapshot and take a screenshot.
//
// Chrome comes from --cdp (an already running Chrome; a new tab is opened and closed again) or is started
// headless with a throwaway profile (CHROME_PATH or a known install location).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection, resolveBrowserWsUrl } from './cdp.ts';
import { UI_PROBE_SOURCE, type UiSnapshot } from './ui-probe.ts';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/opt/pw-browsers/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export interface Viewport {
  width: number;
  height: number;
}

export class BrowserTab {
  #cdp: CdpConnection;
  #sessionId: string;
  #targetId: string;
  #chrome?: ChildProcess;
  #profile?: string;
  #inflight = new Set<string>();
  #lastNetwork = Date.now();

  private constructor(cdp: CdpConnection, sessionId: string, targetId: string) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    cdp.on('Network.requestWillBeSent', (p, sid) => {
      if (sid !== sessionId) return;
      this.#inflight.add(p.requestId);
      this.#lastNetwork = Date.now();
    });
    const done = (p: { requestId: string }, sid: string | undefined) => {
      if (sid !== sessionId) return;
      this.#inflight.delete(p.requestId);
      this.#lastNetwork = Date.now();
    };
    cdp.on('Network.loadingFinished', done);
    cdp.on('Network.loadingFailed', done);
  }

  static async open(options: { cdpUrl?: string; viewport: Viewport }): Promise<BrowserTab> {
    let chrome: ChildProcess | undefined;
    let profile: string | undefined;
    let wsUrl: string;
    if (options.cdpUrl) wsUrl = await resolveBrowserWsUrl({ cdpUrl: options.cdpUrl });
    else {
      const executable = CHROME_CANDIDATES.find((c) => c && existsSync(c));
      if (!executable) throw new Error('No Chrome found. Set CHROME_PATH or pass --cdp http://127.0.0.1:9222');
      profile = await mkdtemp(join(tmpdir(), 'specula-visual-'));
      chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--lang=en-US', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
      wsUrl = await waitForDevToolsPort(profile);
    }
    const cdp = await CdpConnection.connect(wsUrl);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const tab = new BrowserTab(cdp, sessionId, targetId);
    tab.#chrome = chrome;
    tab.#profile = profile;
    await tab.send('Page.enable');
    await tab.send('Network.enable');
    await tab.send('Runtime.enable');
    await tab.send('Emulation.setDeviceMetricsOverride', { width: options.viewport.width, height: options.viewport.height, deviceScaleFactor: 1, mobile: false });
    // Fixed clock-independent rendering: no animations or caret blinking in screenshots.
    await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] });
    return tab;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#cdp.send<T>(method, params, this.#sessionId);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    await this.settle();
  }

  /** Waits until no request has been in flight for `quietMs` and the DOM stopped changing, at most `maxMs`. */
  async settle(quietMs = 700, maxMs = 15_000): Promise<void> {
    const until = Date.now() + maxMs;
    let lastSize = -1;
    let stableSince = Date.now();
    while (Date.now() < until) {
      await sleep(150);
      const size = await this.evaluate<number>('document.readyState === "complete" ? document.getElementsByTagName("*").length : -1').catch(() => -1);
      if (size !== lastSize) {
        lastSize = size;
        stableSince = Date.now();
      }
      const networkQuiet = this.#inflight.size === 0 && Date.now() - this.#lastNetwork >= quietMs;
      if (size >= 0 && networkQuiet && Date.now() - stableSince >= quietMs) break;
    }
    await this.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => {});
  }

  /**
   * Signs in through the app's own sign-in form: types the account into the text or email field just before the
   * password field and the password, then presses Enter. `user` says which account value goes into the first field.
   */
  async login(url: string, account: { username: string; email: string; password: string }, user: 'username' | 'email'): Promise<void> {
    await this.goto(url);
    const found = await this.evaluate<boolean>(`(() => {
      const pass = document.querySelector('input[type=password]');
      if (!pass) return false;
      const fields = Array.from((pass.form || document).querySelectorAll('input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])'));
      // The account field is the last one before the password field (a search box in the header comes earlier).
      const before = fields.filter((f) => f.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING);
      const name = before[before.length - 1] || fields[0];
      if (name) name.setAttribute('data-specula-login', 'user');
      pass.setAttribute('data-specula-login', 'password');
      return true;
    })()`);
    if (!found) throw new Error(`No password field at ${url}`);
    for (const [field, value] of [['user', account[user]], ['password', account.password]] as const) {
      const exists = await this.evaluate<boolean>(`(() => { const el = document.querySelector('[data-specula-login="${field}"]'); if (!el) return false; el.focus(); el.select && el.select(); return true; })()`);
      if (!exists) continue;
      await this.send('Input.insertText', { text: value });
    }
    await this.key('Enter');
    await sleep(700);
    // Some forms ignore a synthetic Enter: submit through the form (or its submit button) when still on it.
    await this.evaluate(`(() => {
      const pass = document.querySelector('[data-specula-login="password"]');
      if (!pass || !pass.isConnected || !pass.value) return;
      const form = pass.form;
      const button = (form || document).querySelector('button[type=submit],input[type=submit]') || (form ? null : Array.from(document.querySelectorAll('button')).find((b) => b.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_PRECEDING));
      if (button) button.click(); else if (form) form.requestSubmit();
    })()`).catch(() => {});
    // Leave the field, as a person clicking the button would: some apps hold re-renders while an input has focus.
    await this.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()').catch(() => {});
    await sleep(300);
    await this.settle();
  }

  async key(key: string): Promise<void> {
    const code = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
  }

  async snapshot(): Promise<UiSnapshot> {
    return this.evaluate<UiSnapshot>(UI_PROBE_SOURCE);
  }

  /** PNG of the viewport. */
  async screenshot(): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  }

  async close(): Promise<void> {
    await this.#cdp.send('Target.closeTarget', { targetId: this.#targetId }).catch(() => {});
    this.#cdp.close();
    if (this.#chrome) {
      this.#chrome.kill();
      await new Promise((r) => setTimeout(r, 300));
    }
    if (this.#profile) await rm(this.#profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForDevToolsPort(profile: string): Promise<string> {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    const content = await readFile(file, 'utf8').catch(() => '');
    const [port, path] = content.trim().split('\n');
    if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    await sleep(100);
  }
  throw new Error('Chrome did not start (no DevToolsActivePort)');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
