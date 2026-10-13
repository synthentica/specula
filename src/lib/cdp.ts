// Minimal Chrome DevTools Protocol client on Node 22's built-in WebSocket.
// One browser-level connection, flattened target sessions (sessionId per message).

import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

type Json = Record<string, unknown>;
type EventHandler = (params: any, sessionId: string | undefined) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
}

export class CdpConnection {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handlers = new Map<string, Set<EventHandler>>();
  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(String(event.data)));
    ws.addEventListener('close', () => {
      this.#closed = true;
      for (const p of this.#pending.values()) p.reject(new Error(`CDP connection closed during ${p.method}`));
      this.#pending.clear();
      this.#emit('__closed', {}, undefined);
    });
  }

  static async connect(wsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`Could not open CDP WebSocket ${wsUrl}`)), { once: true });
    });
    return new CdpConnection(ws);
  }

  get closed(): boolean {
    return this.#closed;
  }

  send<T = any>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`CDP connection closed, cannot send ${method}`));
    const id = this.#nextId++;
    const message: Json = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(message));
    });
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method: string, handler: EventHandler): () => void {
    let set = this.#handlers.get(method);
    if (!set) this.#handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  onClose(handler: () => void): void {
    this.on('__closed', handler);
  }

  close(): void {
    if (!this.#closed) this.#ws.close();
  }

  #onMessage(raw: string): void {
    const msg = JSON.parse(raw) as { id?: number; method?: string; params?: Json; result?: unknown; error?: { message: string }; sessionId?: string };
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) this.#emit(msg.method, msg.params ?? {}, msg.sessionId);
  }

  #emit(method: string, params: unknown, sessionId: string | undefined): void {
    const set = this.#handlers.get(method);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(params, sessionId);
      } catch (error) {
        process.stderr.write(`specula: handler for ${method} failed: ${(error as Error).message}\n`);
      }
    }
  }
}

export interface BrowserEndpointOptions {
  /** http://host:port of a Chrome started with --remote-debugging-port. */
  cdpUrl?: string;
  /** Chrome >= 144 remote debugging enabled via chrome://inspect/#remote-debugging. */
  autoConnect?: boolean;
  /** Overrides the user data directory searched for DevToolsActivePort (autoConnect). */
  userDataDir?: string;
}

/** Resolves the browser-level WebSocket URL, mirroring chrome-devtools-mcp's two supported modes. */
export async function resolveBrowserWsUrl(options: BrowserEndpointOptions): Promise<string> {
  if (options.cdpUrl) {
    if (options.cdpUrl.startsWith('ws://') || options.cdpUrl.startsWith('wss://')) return options.cdpUrl;
    const base = options.cdpUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/json/version`).catch((error: Error) => {
      throw new Error(`Could not reach ${base}/json/version (${error.message}). Is Chrome running with --remote-debugging-port?`);
    });
    const info = (await response.json()) as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) throw new Error(`${base}/json/version did not return webSocketDebuggerUrl`);
    return info.webSocketDebuggerUrl;
  }
  if (options.autoConnect) {
    const dir = options.userDataDir ?? defaultChromeUserDataDir();
    const file = join(dir, 'DevToolsActivePort');
    const content = await readFile(file, 'utf8').catch(() => {
      throw new Error(`No ${file}. Enable remote debugging in chrome://inspect/#remote-debugging (Chrome >= 144) and keep Chrome running.`);
    });
    const [port, path] = content.trim().split('\n');
    if (!port || !path) throw new Error(`Unexpected DevToolsActivePort content in ${file}`);
    return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
  }
  throw new Error('Pass --cdp http://127.0.0.1:9222 or --auto-connect');
}

export function defaultChromeUserDataDir(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
    default:
      return join(homedir(), '.config', 'google-chrome');
  }
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  attached: boolean;
}

/** Picks the page target to observe: first URL containing `match`, else the first http(s) page. */
export async function pickPageTarget(cdp: CdpConnection, match?: string): Promise<TargetInfo> {
  const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
  const pages = targetInfos.filter((t) => t.type === 'page');
  const chosen = match ? pages.find((t) => t.url.includes(match)) : pages.find((t) => /^https?:/.test(t.url));
  if (!chosen) {
    const listing = pages.map((t) => `  ${t.url}`).join('\n') || '  (no pages)';
    throw new Error(`No page target${match ? ` matching "${match}"` : ''}. Open pages:\n${listing}`);
  }
  return chosen;
}
