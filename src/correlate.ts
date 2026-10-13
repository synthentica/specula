// correlate: links each user action to the requests it caused and to the code that sent them.
//
//   node src/correlate.ts --target vikunja [--flow edit-task] [--window-ms 1500]
//
// Writes analysis/correlation.json.

import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { CaptureEvent, HarEntry, StackFrame } from './lib/har.ts';
import { entryRef, type Flow, isFirstParty, loadFlows, type ResolvedFrame, SourceResolver } from './lib/captures.ts';
import { graphqlLabel } from './lib/graphql.ts';
import { templatePath } from './lib/paths.ts';
import { ensureDir, isTargetOrigin, loadTarget, printSummary } from './lib/target.ts';

/** GraphQL requests share one URL: the operation names tell them apart. */
const graphqlSuffix = (entry: HarEntry) => {
  const op = graphqlLabel(entry.request.postData?.text);
  return op ? ` (${op})` : '';
};

const DYNAMIC_TYPES = new Set(['Fetch', 'XHR', 'WebSocket', 'EventSource', 'Document', 'Other']);
const INPUT_SLACK_MS = 500;
/** Only the first async groups describe the causal path; deeper parents are older context (component setup etc.). */
const CAUSAL_GROUPS = 4;
/** A chunk on the causal path of more than this share of scripted requests is treated as shared infrastructure. */
const SHARED_CHUNK_SHARE = 0.4;
const CLOCK_SLACK_MS = 20;

const { values: args } = parseArgs({ options: { target: { type: 'string' }, flow: { type: 'string' }, 'window-ms': { type: 'string', default: '1500' } } });
if (!args.target) {
  process.stderr.write('Usage: node src/correlate.ts --target <name> [--flow <flow>] [--window-ms 1500]\n');
  process.exit(2);
}
const windowMs = Number(args['window-ms']);
const { config, paths } = await loadTarget(args.target);
const flows = await loadFlows(paths, args.flow);
const resolver = await SourceResolver.create(paths);

type Trigger = Extract<CaptureEvent, { type: 'action' }> | (Extract<CaptureEvent, { type: 'navigation' }> & { id: string });

interface LinkedRequest {
  entry: string;
  method: string;
  url: string;
  endpoint: string;
  status: number;
  resourceType: string;
  delayMs: number;
  confidence: 'high' | 'medium' | 'low';
  initiatorType?: string;
  /** Innermost frame: where the request was issued (often an HTTP client wrapper). */
  callSite?: ResolvedFrame;
  /** Innermost first-party frame in feature code (not shared plumbing): usually the component or store. */
  origin?: ResolvedFrame;
  /** Innermost frame in a PascalCase chunk (a UI component file, e.g. TaskDetailView). */
  component?: ResolvedFrame;
  /** Distinct first-party chunks along the causal async chain, innermost first. */
  chain?: string[];
  /** With a public source map: the app's own original files along the causal chain, innermost first. */
  sourceChain?: { source: string; line: number; name?: string }[];
}

function frames(entry: HarEntry): StackFrame[] {
  return entry._initiator?.stack?.slice(0, CAUSAL_GROUPS).flatMap((g) => g.frames) ?? [];
}

/** Frames in the app's own code: first-party scripts and CDN scripts that call the target. */
function chainOf(entry: HarEntry): StackFrame[] {
  return frames(entry).filter((f) => isFirstParty(f.url, config.origin) || resolver.record(f.url)?.callsTarget);
}

/** `../../src/utils/api.js` → `src/utils/api.js`; webpack:// and similar prefixes go too. */
function cleanSource(source: string): string {
  return source.replace(/^[a-z-]+:\/\/+[^/]*\//i, '').replace(/^(\.\.?\/)+/, '');
}

// Chunk frequency over all scripted requests decides which chunks are shared plumbing
// (HTTP client, router, query library) and which are feature code.
const chunkShare = new Map<string, number>();
{
  let scripted = 0;
  for (const flow of flows) {
    for (const entry of flow.har.log.entries) {
      const chain = chainOf(entry);
      if (!chain.length) continue;
      scripted++;
      for (const name of new Set(chain.map((f) => chunkName(f.url)))) chunkShare.set(name, (chunkShare.get(name) ?? 0) + 1);
    }
  }
  for (const [name, count] of chunkShare) chunkShare.set(name, count / Math.max(1, scripted));
}
const isShared = (url: string) => (chunkShare.get(chunkName(url)) ?? 0) > SHARED_CHUNK_SHARE;

function chunkName(url: string): string {
  return basename(new URL(url).pathname).replace(/[-.][A-Za-z0-9_-]{8}\.m?js$/, '').replace(/\.m?js$/, '');
}

async function link(flow: Flow, entry: HarEntry, index: number, trigger: Trigger | undefined): Promise<LinkedRequest> {
  const url = new URL(entry.request.url);
  const all = frames(entry);
  const firstParty = chainOf(entry);
  const delayMs = trigger ? Math.max(0, entry._wallTimeMs - trigger.t) : 0;
  const scripted = entry._initiator?.type === 'script' && all.length > 0;
  const confidence: LinkedRequest['confidence'] = !trigger ? 'low' : scripted && delayMs <= 1000 ? 'high' : delayMs <= windowMs ? 'medium' : 'low';
  const out: LinkedRequest = {
    entry: entryRef(flow.name, index),
    method: entry.request.method,
    url: entry.request.url,
    endpoint: `${entry.request.method} ${isTargetOrigin(entry.request.url, config) ? templatePath(url.pathname) : url.host + templatePath(url.pathname)}${graphqlSuffix(entry)}`,
    status: entry.response.status,
    resourceType: entry._resourceType,
    delayMs,
    confidence,
    initiatorType: entry._initiator?.type,
  };
  if (all[0]) out.callSite = await resolver.resolve(all[0]);
  const feature = firstParty.find((f) => !isShared(f.url));
  if (feature) out.origin = await resolver.resolve(feature);
  const component = firstParty.find((f) => /^[A-Z]/.test(chunkName(f.url)));
  if (component) out.component = await resolver.resolve(component);
  if (firstParty.length) out.chain = [...new Set(firstParty.map((f) => chunkName(f.url)))];
  const sourceChain: NonNullable<LinkedRequest['sourceChain']> = [];
  for (const frame of await Promise.all(firstParty.map((f) => resolver.resolve(f)))) {
    if (!frame.original || /node_modules/.test(frame.original.source)) continue;
    const source = cleanSource(frame.original.source);
    const last = sourceChain.at(-1);
    if (last?.source === source && last.line === frame.original.line) continue;
    sourceChain.push({ source, line: frame.original.line, ...(frame.original.name ? { name: frame.original.name } : {}) });
  }
  if (sourceChain.length) out.sourceChain = sourceChain;
  return out;
}

function classifyBackground(entry: HarEntry, firstTriggerT: number | undefined, sameEndpointCount: number): string {
  const path = new URL(entry.request.url).pathname;
  if (/refresh|token/i.test(path) && entry.request.method !== 'GET') return 'auth-refresh';
  if (firstTriggerT === undefined || entry._wallTimeMs < firstTriggerT) return entry._initiator?.type === 'parser' ? 'page-load' : 'startup';
  if (sameEndpointCount >= 3) return 'periodic';
  return 'background';
}

const result = [];
let totalActions = 0;
let totalLinked = 0;
let totalBackground = 0;

for (const flow of flows) {
  const triggers: Trigger[] = [];
  let navSeq = 0;
  for (const event of flow.events) {
    if (event.type === 'action') triggers.push(event);
    else if (event.type === 'navigation' && !event.sameDocument) triggers.push({ ...event, id: `n${++navSeq}` });
  }
  triggers.sort((a, b) => a.t - b.t);
  const firstActionT = triggers.find((t) => t.type === 'action')?.t;

  const byTrigger = new Map<string, LinkedRequest[]>();
  const background: (LinkedRequest & { reason: string })[] = [];
  const endpointCounts = new Map<string, number>();
  for (const entry of flow.har.log.entries) {
    const key = `${entry.request.method} ${templatePath(new URL(entry.request.url).pathname)}`;
    endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
  }

  for (const [index, entry] of flow.har.log.entries.entries()) {
    if (!DYNAMIC_TYPES.has(entry._resourceType)) continue;
    const t = entry._wallTimeMs;
    const trigger = triggers.filter((tr) => tr.t - (tr.type === 'action' && tr.kind === 'input' ? INPUT_SLACK_MS : CLOCK_SLACK_MS) <= t).at(-1);
    const inWindow = trigger && t - trigger.t <= windowMs;
    const linked = await link(flow, entry, index, inWindow ? trigger : undefined);
    if (inWindow && trigger) {
      const list = byTrigger.get(trigger.id) ?? [];
      list.push(linked);
      byTrigger.set(trigger.id, list);
    } else {
      const key = `${entry.request.method} ${templatePath(new URL(entry.request.url).pathname)}`;
      background.push({ ...linked, reason: classifyBackground(entry, firstActionT, endpointCounts.get(key) ?? 0) });
    }
  }

  const wsSent = flow.events.filter((e) => e.type === 'ws-frame' && e.direction === 'sent') as Extract<CaptureEvent, { type: 'ws-frame' }>[];
  const actions = triggers.map((trigger) => {
    const requests = byTrigger.get(trigger.id) ?? [];
    const next = triggers.find((t) => t.t > trigger.t)?.t ?? Infinity;
    const frames = wsSent.filter((f) => f.t >= trigger.t && f.t < Math.min(next, trigger.t + windowMs)).map((f) => f.payload.slice(0, 200));
    return {
      id: trigger.id,
      t: trigger.t,
      kind: trigger.type === 'action' ? trigger.kind : 'navigate',
      ...(trigger.type === 'action' ? { target: trigger.target, ...(trigger.key ? { key: trigger.key } : {}) } : {}),
      url: trigger.url,
      requests,
      ...(frames.length ? { wsFramesSent: frames } : {}),
    };
  });
  totalActions += actions.filter((a) => a.kind !== 'navigate').length;
  totalLinked += actions.reduce((n, a) => n + a.requests.length, 0);
  totalBackground += background.length;
  result.push({ flow: flow.name, actions, background });
}

await ensureDir(paths.analysis);
const out = join(paths.analysis, 'correlation.json');
await writeFile(
  out,
  `${JSON.stringify({ generatedBy: 'specula correlate', windowMs, sourceMaps: resolver.hasSourceMaps, flows: result }, null, 2)}\n`,
);
printSummary({ ok: true, flows: result.length, actions: totalActions, linkedRequests: totalLinked, backgroundRequests: totalBackground, sourceMaps: resolver.hasSourceMaps, file: 'analysis/correlation.json' });
