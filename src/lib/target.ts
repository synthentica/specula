// Per-target layout: targets/<name>/{capture,analysis,spec,rebuild,parity}/ plus target.json.

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Overridable so tests can use a throwaway directory. */
export const TARGETS_DIR = process.env.SPECULA_TARGETS_DIR ?? join(REPO_ROOT, 'targets');

export interface TargetConfig {
  name: string;
  /** Origin of the app under observation, e.g. http://localhost:3456 */
  origin: string;
  /** Path prefix of the JSON API, e.g. /api/v1 */
  apiPrefix?: string;
  /** Further origins that serve the app's own API, when it is not on `origin`, e.g. https://api.example.com */
  apiOrigins?: string[];
  redact?: {
    /** Extra header names to redact (case-insensitive). */
    headers?: string[];
    /** Extra JSON keys / form fields to redact (case-insensitive, exact match). */
    keys?: string[];
    /** Literal values to scrub everywhere, e.g. the test account's username. */
    values?: string[];
  };
  /** Flows that replay first, in this order (sign-in before everything else); the rest follow in recording order. */
  flowOrder?: string[];
  /** Brand names replaced with a neutral word ("app") everywhere in spec/, so a rebuild never sees them. */
  brand?: string[];
  volatile?: {
    /** JSON keys whose values are always volatile (ids, timestamps...). */
    keys?: string[];
  };
  /**
   * Views of a local copy of the original for `visual.ts --original`: how to sign in, which flows to replay first
   * (up to and including `seedFlow`), and each view's route with path parameters named as in the API ({projectId}).
   */
  ui?: {
    login?: { path: string; user?: 'username' | 'email'; value?: string };
    seedFlow?: string;
    viewport?: { width: number; height: number };
    /** CSS selectors clicked away before each snapshot when present (a "what's new" banner). */
    dismiss?: string[];
    views: Record<string, string>;
  };
}

export interface TargetPaths {
  root: string;
  config: string;
  capture: string;
  sources: string;
  analysis: string;
  spec: string;
  flows: string;
  rebuild: string;
  parity: string;
}

export function targetPaths(name: string): TargetPaths {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`Invalid target name "${name}"`);
  const root = join(TARGETS_DIR, name);
  return {
    root,
    config: join(root, 'target.json'),
    capture: join(root, 'capture'),
    sources: join(root, 'capture', 'sources'),
    analysis: join(root, 'analysis'),
    spec: join(root, 'spec'),
    flows: join(root, 'spec', 'flows'),
    rebuild: join(root, 'rebuild'),
    parity: join(root, 'parity'),
  };
}

export async function loadTarget(name: string): Promise<{ config: TargetConfig; paths: TargetPaths }> {
  const paths = targetPaths(name);
  const raw = await readFile(paths.config, 'utf8').catch(() => {
    throw new Error(`Missing ${paths.config}. Create it first (see .claude/skills/specula/reference/capture.md).`);
  });
  const config = JSON.parse(raw) as TargetConfig;
  if (!config.origin) throw new Error(`${paths.config}: "origin" is required`);
  for (const o of config.apiOrigins ?? []) {
    if (!URL.canParse(o)) throw new Error(`${paths.config}: "apiOrigins" entry "${o}" is not a URL`);
  }
  return { config, paths };
}

/** The app's own origins: `origin` plus `apiOrigins`. */
export function targetOrigins(config: TargetConfig): Set<string> {
  return new Set([config.origin, ...(config.apiOrigins ?? [])].map((o) => new URL(o).origin));
}

/** True when `url` is on `origin` or one of `apiOrigins`. */
export function isTargetOrigin(url: string, config: TargetConfig): boolean {
  try {
    return targetOrigins(config).has(new URL(url).origin);
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function validateFlowName(flow: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(flow)) throw new Error(`Flow name must be kebab-case: "${flow}"`);
  return flow;
}

/** Prints the one-line JSON summary every helper ends with. */
export function printSummary(summary: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
