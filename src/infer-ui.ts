// infer-ui: turns UI snapshots of the original into the UI spec a rebuild follows.
//
//   node src/infer-ui.ts --target <name>
//
// Reads capture/ui/<view>.json (named views, from `visual.ts --original`) and, for views not named there, the
// snapshots `capture.ts` took while recording (capture/<flow>.ui.json, one view per route). Writes
// spec/ui/tokens.json (colours, fonts, sizes, radii, shadows, spacing), spec/ui/views.json (per view: regions,
// components with positions and typical style) and spec/UI.md. Snapshots hold no text or images; brand names
// from target.json are still neutralized, like everywhere in spec/.

import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { neutralizer } from './lib/brand.ts';
import { templatePath } from './lib/paths.ts';
import { ensureDir, loadTarget, printSummary } from './lib/target.ts';
import { buildUiSpec, renderUiMd, type NamedSnapshot } from './lib/ui.ts';
import type { UiSnapshot } from './lib/ui-probe.ts';

const { values: args } = parseArgs({ options: { target: { type: 'string' } } });
if (!args.target) {
  process.stderr.write('Usage: node src/infer-ui.ts --target <name>\n');
  process.exit(2);
}
const { config, paths } = await loadTarget(args.target);
const neutral = neutralizer(config.brand);

const named: NamedSnapshot[] = [];
const uiDir = join(paths.capture, 'ui');
if (existsSync(uiDir)) {
  for (const file of (await readdir(uiDir)).filter((f) => f.endsWith('.json')).sort()) named.push(JSON.parse(await readFile(join(uiDir, file), 'utf8')));
}

// Snapshots taken during capture: the last one per route, named after the route's fixed segments.
interface RecordedUi {
  flow: string;
  snapshots: { t: number; afterAction?: string; snapshot: UiSnapshot }[];
}
const order: string[] = existsSync(join(paths.flows, 'index.json')) ? JSON.parse(await readFile(join(paths.flows, 'index.json'), 'utf8')).order : [];
const recorded: NamedSnapshot[] = [];
if (existsSync(paths.capture)) {
  const files = (await readdir(paths.capture)).filter((f) => f.endsWith('.ui.json'));
  files.sort((a, b) => rank(a) - rank(b));
  const byRoute = new Map<string, NamedSnapshot>();
  for (const file of files) {
    const ui = JSON.parse(await readFile(join(paths.capture, file), 'utf8')) as RecordedUi;
    for (const s of ui.snapshots) {
      const route = templatePath(s.snapshot.url.split('#')[0] || '/') + (s.snapshot.url.includes('#') ? '#' + templatePath(s.snapshot.url.split('#')[1] ?? '') : '');
      byRoute.set(route, { name: viewName(route), route, seedFlow: ui.flow, snapshot: s.snapshot });
    }
  }
  const taken = new Set(named.map((n) => n.name));
  for (const s of byRoute.values()) {
    let name = s.name;
    for (let i = 2; taken.has(name); i++) name = `${s.name}-${i}`;
    taken.add(name);
    if (!named.some((n) => n.route === s.route)) recorded.push({ ...s, name });
  }
}
function rank(file: string): number {
  const i = order.indexOf(file.replace(/\.ui\.json$/, ''));
  return i < 0 ? order.length : i;
}
function viewName(route: string): string {
  const words = route.split(/[/#?]/).filter((s) => s && !s.startsWith('{')).map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  return words.join('-').replace(/^-+|-+$/g, '') || 'home';
}

const all = [...named, ...recorded];
if (!all.length) {
  process.stderr.write(`No UI snapshots for ${args.target}. Capture flows with src/capture.ts (it records views as it goes) or run src/visual.ts --original against a local copy.\n`);
  printSummary({ ok: false, reason: 'no-snapshots' });
  process.exit(1);
}

const spec = neutral(buildUiSpec(all));
const outDir = join(paths.spec, 'ui');
await ensureDir(outDir);
await writeFile(join(outDir, 'tokens.json'), `${JSON.stringify(spec.tokens, null, 2)}\n`);
await writeFile(join(outDir, 'views.json'), `${JSON.stringify({ viewport: spec.viewport, views: spec.views }, null, 1)}\n`);
await writeFile(join(paths.spec, 'UI.md'), renderUiMd(spec));
printSummary({ ok: true, views: spec.views.map((v) => v.name), fromNamed: named.length, fromCapture: recorded.length, files: ['spec/ui/tokens.json', 'spec/ui/views.json', 'spec/UI.md'] });
