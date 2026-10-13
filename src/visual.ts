// Visual check: opens the app's views in Chrome with the same data the recorded flows leave behind and
// reads a UI snapshot of each (boxes and computed styles, no text or images).
//
//   node src/visual.ts --target <name> --base-url <url> --original     # reference: writes capture/ui/<view>.json
//   node src/visual.ts --target <name> --base-url <url>                # rebuild: scores against spec/ui/views.json
//
// Options: [--label rebuild] [--view <name>] [--screenshots <dir>] [--cdp http://127.0.0.1:9222]
//          [--no-seed] [--param name=value ...]
//
// Seeding: unless --no-seed, the flows are replayed first with `parity.ts --dry-run` on the fresh instance (up to
// the views' seedFlow), so both sides show the same records. The replay's test account then signs in through
// the app's own sign-in form, and each view's route is filled from the path parameters the replay used last
// ({projectId} -> the project the flows last touched) or from --param.
//
// Views and sign-in come from target.json "ui" for the original and from rebuild/views.json for the rebuild:
//   { "login": { "path": "/login", "user": "username" | "email", "value"?: "owner" }, "views": { "board": "/projects/{projectId}/{viewId}" } }
//
// --original runs only against a local copy of the original you started yourself, as the parity baseline does.
// Screenshots (optional) are for people comparing the two sides; they are never part of spec/.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BrowserTab } from './lib/browser.ts';
import { scoreView, type UiSpec, type ViewScore } from './lib/ui.ts';
import type { UiSnapshot } from './lib/ui-probe.ts';
import { ensureDir, loadTarget, printSummary, REPO_ROOT, targetPaths } from './lib/target.ts';

const { values: args } = parseArgs({
  options: {
    target: { type: 'string' },
    'base-url': { type: 'string' },
    original: { type: 'boolean', default: false },
    label: { type: 'string', default: 'rebuild' },
    view: { type: 'string' },
    screenshots: { type: 'string' },
    cdp: { type: 'string' },
    'no-seed': { type: 'boolean', default: false },
    param: { type: 'string', multiple: true },
  },
});
if (!args.target || !args['base-url']) {
  process.stderr.write('Usage: node src/visual.ts --target <name> --base-url <url> [--original] [--label rebuild] [--view <name>] [--screenshots <dir>] [--cdp URL] [--no-seed] [--param k=v]\n');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(args.label!)) throw new Error('--label must be kebab-case');

export interface ViewConfig {
  /** `value`: a fixed sign-in name the recorded flows used (`owner`), instead of the replay's account. */
  login?: { path: string; user?: 'username' | 'email'; value?: string };
  views: Record<string, string>;
  /** Original only: flows replayed before the views are opened (index order, up to and including this one). */
  seedFlow?: string;
  viewport?: { width: number; height: number };
  /** Elements clicked away before each snapshot when present (a "what's new" banner), as CSS selectors. */
  dismiss?: string[];
}

const paths = targetPaths(args.target);
const baseUrl = new URL(args['base-url']).origin;
const specFile = join(paths.spec, 'ui', 'views.json');
const spec: UiSpec | undefined = existsSync(specFile)
  ? { ...JSON.parse(await readFile(specFile, 'utf8')), tokens: JSON.parse(await readFile(join(paths.spec, 'ui', 'tokens.json'), 'utf8')) }
  : undefined;

let config: ViewConfig;
if (args.original) {
  const { config: target } = await loadTarget(args.target);
  if (!target.ui?.views) throw new Error(`target.json has no "ui.views" for ${args.target}`);
  config = target.ui;
} else {
  const file = join(paths.rebuild, 'views.json');
  if (!existsSync(file)) throw new Error(`Missing ${file}: map each view in spec/ui/views.json to a rebuild route`);
  config = JSON.parse(await readFile(file, 'utf8'));
  if (!spec) throw new Error(`Missing ${specFile}. Run node src/infer-ui.ts --target ${args.target} first.`);
}
const viewport = config.viewport ?? spec?.viewport ?? { width: 1280, height: 800 };
const viewNames = args.original ? Object.keys(config.views) : spec!.views.map((v) => v.name);
const selected = args.view ? viewNames.filter((v) => v === args.view) : viewNames;
if (!selected.length) throw new Error(`No view ${args.view ?? ''} (have: ${viewNames.join(', ')})`);
const seedFlow = args.original ? config.seedFlow : spec!.views.find((v) => selected.includes(v.name) && v.seedFlow)?.seedFlow;

// ---- seed with the recorded flows --------------------------------------------------------

interface State {
  account: { username: string; email: string; password: string };
  params: Record<string, unknown>;
}
let state: State = {
  account: {
    username: process.env.SPECULA_USERNAME ?? '',
    email: process.env.SPECULA_EMAIL ?? '',
    password: process.env.SPECULA_PASSWORD ?? '',
  },
  params: {},
};
if (!args['no-seed']) {
  const dir = await mkdtemp(join(tmpdir(), 'specula-state-'));
  try {
    const file = join(dir, 'state.json');
    const replay = ['src/parity.ts', '--target', args.target, '--base-url', baseUrl, '--dry-run', '--emit-state', file, ...(args.original ? ['--original'] : []), ...(seedFlow ? ['--flow', seedFlow] : [])];
    const result = await run(replay);
    if (!existsSync(file)) throw new Error(`Seeding replay failed:\n${result.stderr.slice(-2000)}`);
    state = JSON.parse(await readFile(file, 'utf8'));
    process.stderr.write(`specula visual: seeded ${baseUrl} (${result.stdout.trim().split('\n').pop()}); route parameters ${JSON.stringify(state.params)}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
for (const p of args.param ?? []) {
  const [k, ...v] = p.split('=');
  if (k) state.params[k] = v.join('=');
}

function fill(route: string): string {
  return route.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in state.params)) throw new Error(`Route ${route}: no value for {${name}} (the replay never used it; pass --param ${name}=...)`);
    return encodeURIComponent(String(state.params[name]));
  });
}

// ---- open each view --------------------------------------------------------------------

const snapshots = new Map<string, UiSnapshot>();
const missing: string[] = [];
const tab = await BrowserTab.open({ cdpUrl: args.cdp, viewport });
try {
  if (config.login) {
    const user = config.login.user ?? 'username';
    await tab.login(baseUrl + config.login.path, { ...state.account, ...(config.login.value ? { [user]: config.login.value } : {}) }, user);
  }
  if (args.screenshots) await ensureDir(args.screenshots);
  for (const name of selected) {
    const route = config.views[name];
    if (!route) {
      missing.push(name);
      continue;
    }
    await tab.goto(baseUrl + fill(route));
    if (config.dismiss?.length) {
      const clicked = await tab.evaluate<number>(`${JSON.stringify(config.dismiss)}.filter((s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; }).length`);
      if (clicked) await tab.settle();
    }
    const snap = await tab.snapshot();
    snap.url = route;
    snapshots.set(name, snap);
    if (args.screenshots) await writeFile(join(args.screenshots, `${args.target}-${args.original ? 'original' : args.label}-${name}.png`), await tab.screenshot());
    process.stderr.write(`specula visual: ${name} (${snap.components.length} components, ${snap.regions.map((r) => r.role).join('/')})\n`);
  }
} finally {
  await tab.close();
}

// ---- write -----------------------------------------------------------------------------

if (args.original) {
  const dir = join(paths.capture, 'ui');
  await ensureDir(dir);
  for (const [name, snapshot] of snapshots) {
    await writeFile(join(dir, `${name}.json`), `${JSON.stringify({ name, route: config.views[name]!, ...(config.seedFlow ? { seedFlow: config.seedFlow } : {}), snapshot }, null, 1)}\n`);
  }
  printSummary({ ok: true, original: true, views: [...snapshots.keys()], files: [...snapshots.keys()].map((n) => `capture/ui/${n}.json`) });
} else {
  const scores: ViewScore[] = [];
  for (const view of spec!.views.filter((v) => selected.includes(v.name))) {
    const snap = snapshots.get(view.name);
    scores.push(snap ? scoreView(view, spec!.tokens, snap) : { view: view.name, score: 0, layout: 0, components: 0, style: 0, notes: ['no route for this view in rebuild/views.json'] });
  }
  const overall = scores.length ? Math.round(scores.reduce((s, v) => s + v.score, 0) / scores.length) : 0;
  const generated = new Date().toISOString();
  const fileBase = args.label === 'rebuild' ? 'visual' : `visual-${args.label}`;
  const md = [
    `# Visual check: ${args.label}`,
    '',
    `**Looks ${overall}/100 like the UI spec** over ${scores.length} view${scores.length === 1 ? '' : 's'}, against ${baseUrl}, ${generated}.`,
    '',
    'Each view is opened with the data the recorded flows leave behind and compared with `spec/ui/views.json`: layout 40 % (regions and where components sit on the first screen), components 30 % (count, size, style) and style 30 % (page colours, accent, font, radius). Boxes and computed styles only; text and images are not compared. This score is separate from behavioural parity.',
    '',
    '| View | Score | Layout | Components | Style |',
    '|---|---|---|---|---|',
    ...scores.map((s) => `| ${s.view} | **${s.score}** | ${s.layout} | ${s.components} | ${s.style} |`),
    '',
    '## Largest differences',
    '',
    ...scores.flatMap((s) => [`### ${s.view}`, '', ...(s.notes.length ? s.notes.map((n) => `- ${n}`) : ['_None._']), '']),
  ].join('\n');
  await ensureDir(paths.parity);
  await writeFile(join(paths.parity, `${fileBase}.json`), `${JSON.stringify({ label: args.label, baseUrl, generated, score: overall, views: scores }, null, 2)}\n`);
  await writeFile(join(paths.parity, `${fileBase}.md`), md);
  printSummary({ ok: true, label: args.label, score: overall, views: Object.fromEntries(scores.map((s) => [s.view, s.score])), files: [`parity/${fileBase}.md`, `parity/${fileBase}.json`] });
}

function run(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
