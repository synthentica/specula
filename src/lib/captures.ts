// Loading recorded flows and resolving stack frames against saved scripts/source maps.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import type { AuthFacts, CaptureEvent, Har, ScriptRecord, StackFrame } from './har.ts';
import { parseJsonl } from './har.ts';
import type { TargetPaths } from './target.ts';

export interface Flow {
  name: string;
  har: Har;
  events: CaptureEvent[];
  auth: AuthFacts;
  scripts: ScriptRecord[];
  runtime: Record<string, any> | null;
}

export async function listFlows(paths: TargetPaths): Promise<string[]> {
  if (!existsSync(paths.capture)) return [];
  return (await readdir(paths.capture))
    .filter((f) => f.endsWith('.har'))
    .map((f) => f.slice(0, -4))
    .sort();
}

export async function loadFlow(paths: TargetPaths, name: string): Promise<Flow> {
  const file = (suffix: string) => join(paths.capture, `${name}${suffix}`);
  const readJson = async <T>(suffix: string, fallback: T): Promise<T> => (existsSync(file(suffix)) ? (JSON.parse(await readFile(file(suffix), 'utf8')) as T) : fallback);
  return {
    name,
    har: await readJson<Har>('.har', { log: { version: '1.2', creator: { name: '', version: '' }, pages: [], entries: [] } }),
    events: existsSync(file('.events.jsonl')) ? parseJsonl<CaptureEvent>(await readFile(file('.events.jsonl'), 'utf8')) : [],
    auth: await readJson<AuthFacts>('.auth.json', { authorization: [], cookiesSent: [], cookiesSet: [], csrfHeaders: [], tokenFieldsInResponses: [] }),
    scripts: await readJson<ScriptRecord[]>('.scripts.json', []),
    runtime: await readJson<Record<string, any> | null>('.runtime.json', null),
  };
}

/** Loads the selected flows, or all of them when `only` is undefined. */
export async function loadFlows(paths: TargetPaths, only?: string): Promise<Flow[]> {
  const names = only ? [only] : await listFlows(paths);
  if (!names.length) throw new Error(`No captures in ${paths.capture}. Run capture first.`);
  return Promise.all(names.map((n) => loadFlow(paths, n)));
}

export interface ResolvedFrame extends StackFrame {
  /** Saved script file relative to the target root, when the script was first-party. */
  file?: string;
  original?: { source: string; line: number; column: number; name?: string };
  /** ~160 characters of (minified) source around the call position. */
  snippet?: string;
}

export class SourceResolver {
  #index: Record<string, ScriptRecord> = {};
  #maps = new Map<string, TraceMap | null>();
  #sources = new Map<string, string[] | null>();
  #paths: TargetPaths;

  private constructor(paths: TargetPaths) {
    this.#paths = paths;
  }

  static async create(paths: TargetPaths): Promise<SourceResolver> {
    const resolver = new SourceResolver(paths);
    const indexFile = join(paths.sources, 'index.json');
    if (existsSync(indexFile)) resolver.#index = JSON.parse(await readFile(indexFile, 'utf8'));
    return resolver;
  }

  get hasSourceMaps(): boolean {
    return Object.values(this.#index).some((r) => r.sourceMapFile);
  }

  record(url: string): ScriptRecord | undefined {
    return this.#index[url];
  }

  async resolve(frame: StackFrame): Promise<ResolvedFrame> {
    const record = this.#index[frame.url];
    if (!record?.file) return { ...frame };
    const out: ResolvedFrame = { ...frame, file: `capture/sources/${record.file}` };
    const lines = await this.#lines(record.file);
    const line = lines?.[frame.lineNumber];
    if (line !== undefined) {
      const start = Math.max(0, frame.columnNumber - 60);
      out.snippet = line.slice(start, frame.columnNumber + 100).trim();
    }
    if (record.sourceMapFile) {
      const map = await this.#map(record.sourceMapFile);
      if (map) {
        const pos = originalPositionFor(map, { line: frame.lineNumber + 1, column: frame.columnNumber });
        if (pos.source) out.original = { source: pos.source, line: pos.line ?? 0, column: pos.column ?? 0, ...(pos.name ? { name: pos.name } : {}) };
      }
    }
    return out;
  }

  async #lines(file: string): Promise<string[] | null> {
    if (!this.#sources.has(file)) {
      const path = join(this.#paths.sources, file);
      this.#sources.set(file, existsSync(path) ? (await readFile(path, 'utf8')).split('\n') : null);
    }
    return this.#sources.get(file) ?? null;
  }

  async #map(file: string): Promise<TraceMap | null> {
    if (!this.#maps.has(file)) {
      try {
        this.#maps.set(file, new TraceMap(await readFile(join(this.#paths.sources, file), 'utf8')));
      } catch {
        this.#maps.set(file, null);
      }
    }
    return this.#maps.get(file) ?? null;
  }
}

export function entryRef(flow: string, index: number): string {
  return `capture/${flow}.har#entries[${index}]`;
}

export function isFirstParty(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
