// UI spec and visual scoring: turns UI snapshots of the original's views into a brand-free UI spec
// (design tokens + per-view layout), and scores how closely a rebuild's view follows it.
//
// Everything here works on UiSnapshot boxes and computed styles only; no text, images or screenshots.

import type { BoxStyle, Component, ComponentKind, Rect, Region, RegionRole, UiSnapshot, Usage } from './ui-probe.ts';

// ---- colour ---------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '');
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : undefined;
}

function lab(hex: string): [number, number, number] | undefined {
  const c = rgb(hex);
  if (!c) return undefined;
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 colour difference; 100 when either colour is missing. */
export function deltaE(a: string | undefined, b: string | undefined): number {
  const la = a ? lab(a) : undefined;
  const lb = b ? lab(b) : undefined;
  if (!la || !lb) return 100;
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

/** 1 for the same colour, 0 at ΔE 50 or more. */
export function colorSimilarity(a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 1;
  return Math.max(0, 1 - deltaE(a, b) / 50);
}

function chroma(hex: string): number {
  const l = lab(hex);
  return l ? Math.hypot(l[1], l[2]) : 0;
}

function lightness(hex: string): number {
  return lab(hex)?.[0] ?? 0;
}

// ---- helpers --------------------------------------------------------------------------

const round = (n: number) => Math.round(n * 10) / 10;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function mode<T>(values: (T | undefined)[]): T | undefined {
  const counts = new Map<string, { value: T; n: number }>();
  for (const v of values) {
    if (v === undefined) continue;
    const key = JSON.stringify(v);
    const e = counts.get(key);
    if (e) e.n++;
    else counts.set(key, { value: v, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.value;
}

function mergeUsage(list: Usage[]): Usage {
  const m = new Map<string, number>();
  for (const u of list) for (const [k, w] of u) m.set(k, (m.get(k) ?? 0) + w);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, w]) => [k, round(w)]);
}

function ratio(a: number, b: number): number {
  if (a === 0 && b === 0) return 1;
  return Math.min(a, b) / Math.max(a, b);
}

/** Closeness of two numbers on a scale where `tolerance` apart scores 0.5. */
function near(a: number | undefined, b: number | undefined, tolerance: number): number {
  if (a === undefined && b === undefined) return 1;
  if (a === undefined || b === undefined) return 0;
  const d = Math.abs(a - b);
  return 1 / (1 + (d / tolerance) ** 2);
}

function iou(a: Rect | undefined, b: Rect | undefined): number {
  if (!a || !b) return 0;
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** Clips a rect to the first screen (the part a viewer sees without scrolling). */
function clip(r: Rect, vp: { width: number; height: number }): Rect | undefined {
  const x = Math.max(0, r[0]);
  const y = Math.max(0, r[1]);
  const w = Math.min(vp.width, r[0] + r[2]) - x;
  const h = Math.min(vp.height, r[1] + r[3]) - y;
  return w > 0 && h > 0 ? [x, y, w, h] : undefined;
}

/** Boxes of components visible on the first screen, clipped to it, in page order (at most RECT_CAP). */
const RECT_CAP = 80;
function firstScreen(list: Component[], vp: { width: number; height: number }): Rect[] {
  return list.map((c) => clip(c.rect, vp)).filter((r): r is Rect => !!r).slice(0, RECT_CAP);
}

/** The main area reaches at least to the bottom of the first screen: a short page leaves the rest the same colour. */
function mainExtended(r: Rect, vp: { width: number; height: number }): Rect {
  return [r[0], r[1], r[2], Math.max(r[3], vp.height - r[1])];
}

function unionRect(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x1 = Math.min(...rects.map((r) => r[0]));
  const y1 = Math.min(...rects.map((r) => r[1]));
  const x2 = Math.max(...rects.map((r) => r[0] + r[2]));
  const y2 = Math.max(...rects.map((r) => r[1] + r[3]));
  return [x1, y1, x2 - x1, y2 - y1];
}

function typicalStyle(styles: BoxStyle[]): BoxStyle {
  const out: BoxStyle = {};
  const pick = <K extends keyof BoxStyle>(key: K) => {
    const v = mode(styles.map((s) => s[key]));
    if (v !== undefined) out[key] = v as BoxStyle[K];
  };
  for (const key of ['background', 'color', 'border', 'radius', 'shadow', 'fontFamily', 'fontSize', 'fontWeight', 'textTransform', 'letterSpacing', 'padding'] as const) pick(key);
  // A property only half the instances have is not typical.
  for (const key of ['background', 'border', 'radius', 'shadow', 'textTransform', 'letterSpacing', 'padding'] as const) {
    if (styles.filter((s) => s[key] !== undefined).length * 2 < styles.length) delete out[key];
  }
  return out;
}

// ---- spec types -----------------------------------------------------------------------

export interface ComponentGroup {
  count: number;
  variants?: Record<string, number>;
  /** Median width and height in px. */
  size: [number, number];
  style: BoxStyle;
  /** Where the instances sit on the first screen, at most 80. */
  rects: Rect[];
}

export interface UiView {
  name: string;
  /** The original's route with ids as {param} (informational: the rebuild maps the view to its own route). */
  route: string;
  /** Flows replayed on a fresh instance before the view is opened, in index order up to and including this one. */
  seedFlow?: string;
  viewport: { width: number; height: number };
  page: UiSnapshot['page'];
  regions: Region[];
  components: Partial<Record<ComponentKind, ComponentGroup>>;
}

export interface UiTokens {
  color: {
    page: string;
    surface?: string;
    text?: string;
    textMuted?: string;
    accent?: string;
    border?: string;
    topbar?: string;
    sidebar?: string;
    palette: { hex: string; weight: number; usedFor: string[] }[];
  };
  font: { family: string; headingFamily?: string; baseSize: number; lineHeight?: number; sizes: number[]; weights: number[] };
  radius: { base: number; scale: number[] };
  shadow: { card?: string; control?: string; all: string[] };
  spacing: number[];
}

export interface UiSpec {
  viewport: { width: number; height: number };
  tokens: UiTokens;
  views: UiView[];
}

export interface NamedSnapshot {
  name: string;
  route: string;
  seedFlow?: string;
  snapshot: UiSnapshot;
}

// ---- spec from snapshots --------------------------------------------------------------

export function viewFromSnapshot(s: NamedSnapshot): UiView {
  const vp = s.snapshot.viewport;
  const groups: UiView['components'] = {};
  const byKind = new Map<ComponentKind, Component[]>();
  for (const c of s.snapshot.components) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  for (const [kind, list] of byKind) {
    const variants: Record<string, number> = {};
    for (const c of list) if (c.variant) variants[c.variant] = (variants[c.variant] ?? 0) + 1;
    groups[kind] = {
      count: list.length,
      ...(Object.keys(variants).length ? { variants } : {}),
      size: [median(list.map((c) => c.rect[2])), median(list.map((c) => c.rect[3]))],
      style: typicalStyle(list.map((c) => c.style)),
      rects: firstScreen(list, vp),
    };
  }
  return { name: s.name, route: s.route, ...(s.seedFlow ? { seedFlow: s.seedFlow } : {}), viewport: vp, page: s.snapshot.page, regions: s.snapshot.regions, components: groups };
}

export function tokensFromSnapshots(snapshots: UiSnapshot[], views: UiView[]): UiTokens {
  const u = (key: keyof UiSnapshot['usage']) => mergeUsage(snapshots.map((s) => s.usage[key]));
  const text = u('text');
  const background = u('background');
  const border = u('border');
  const page = mode(snapshots.map((s) => s.page.background)) ?? background[0]?.[0] ?? '#ffffff';
  const textMain = text[0]?.[0];
  // Muted text sits between the main text and the page in lightness.
  const between = (c: string) => (lightness(c) - lightness(textMain ?? '#000000')) * (lightness(page) - lightness(c)) > 0;
  const muted = text.find(([c]) => c !== textMain && chroma(c) < 12 && deltaE(c, textMain) > 8 && deltaE(c, page) > 25 && between(c))?.[0];
  const groups = (kind: ComponentKind) => views.map((v) => v.components[kind]).filter((g): g is ComponentGroup => !!g);
  // Accent: the most used saturated colour on filled buttons, links and text.
  const accentVotes = new Map<string, number>();
  const vote = (c: string | undefined, w: number) => c && chroma(c) > 25 && accentVotes.set(c.slice(0, 7), (accentVotes.get(c.slice(0, 7)) ?? 0) + w);
  for (const g of groups('button')) if (g.variants?.filled) vote(g.style.background, 4 * g.count);
  for (const g of groups('link')) vote(g.style.color, g.count);
  for (const g of groups('tabs')) vote(g.style.background, 2);
  for (const [c, w] of text) vote(c, w / 20);
  const accent = [...accentVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  // Surface: what raised boxes (cards, board columns) are painted with, when it differs from the page.
  // Only painted cards and columns count; when none differs from the page, the surface is the page itself.
  const raised = snapshots.flatMap((s) => s.components.filter((c) => (c.kind === 'card' || c.kind === 'column') && c.style.background && deltaE(c.style.background, page) > 2));
  const raisedBy = (pick: (c: Component) => string | undefined) => {
    const w = new Map<string, number>();
    for (const c of raised) {
      const v = pick(c);
      if (v) w.set(v, (w.get(v) ?? 0) + c.rect[2] * c.rect[3]);
    }
    return [...w.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const surface = raisedBy((c) => c.style.background?.slice(0, 7)) ?? page;
  const cardShadow = raisedBy((c) => c.style.shadow);
  const regionBg = (role: RegionRole) => mode(views.flatMap((v) => v.regions.filter((r) => r.role === role).map((r) => r.style.background)));
  const color: UiTokens['color'] = {
    page,
    surface,
    text: textMain,
    textMuted: muted,
    accent,
    border: border[0]?.[0],
    topbar: regionBg('topbar'),
    sidebar: regionBg('sidebar'),
    palette: [],
  };
  // Palette: every colour used noticeably, with what it is used for.
  const palette = new Map<string, { weight: number; usedFor: Set<string> }>();
  const note = (c: string | undefined, use: string, w: number) => {
    if (!c) return;
    const hex = c.slice(0, 7);
    const near = [...palette.keys()].find((k) => deltaE(k, hex) < 3) ?? hex;
    const e = palette.get(near) ?? { weight: 0, usedFor: new Set<string>() };
    e.weight += w;
    e.usedFor.add(use);
    palette.set(near, e);
  };
  for (const [c, w] of background.slice(0, 12)) note(c, 'background', w / 50);
  for (const [c, w] of text.slice(0, 10)) note(c, 'text', w);
  for (const [c, w] of border.slice(0, 5)) note(c, 'border', w);
  for (const v of views) for (const [kind, g] of Object.entries(v.components)) if (g?.style.background) note(g.style.background, kind, g.count);
  color.palette = [...palette.entries()]
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 16)
    .map(([hex, e]) => ({ hex, weight: round(e.weight), usedFor: [...e.usedFor] }));

  const families = u('fontFamily');
  const headingFamily = mode(groups('heading').map((g) => g.style.fontFamily));
  const sizes = u('fontSize').slice(0, 8).map(([s]) => Number(s)).sort((a, b) => a - b);
  const radius = u('radius');
  const shadows = u('shadow');
  const page0 = snapshots[0]?.page;
  return {
    color,
    font: {
      family: families[0]?.[0] ?? page0?.fontFamily ?? 'system-ui',
      ...(headingFamily && headingFamily !== families[0]?.[0] ? { headingFamily } : {}),
      baseSize: Number(u('fontSize')[0]?.[0] ?? page0?.fontSize ?? 16),
      ...(page0?.lineHeight ? { lineHeight: page0.lineHeight } : {}),
      sizes,
      weights: u('fontWeight').slice(0, 4).map(([w]) => Number(w)).sort((a, b) => a - b),
    },
    radius: { base: Number(radius[0]?.[0] ?? 0), scale: radius.slice(0, 5).map(([r]) => Number(r)).sort((a, b) => a - b) },
    shadow: {
      ...(cardShadow ? { card: cardShadow } : {}),
      ...(mode(groups('button').map((g) => g.style.shadow)) ? { control: mode(groups('button').map((g) => g.style.shadow)) } : {}),
      all: shadows.slice(0, 5).map(([s]) => s),
    },
    spacing: u('spacing').slice(0, 8).map(([s]) => Number(s)).sort((a, b) => a - b),
  };
}

export function buildUiSpec(snapshots: NamedSnapshot[]): UiSpec {
  const views = snapshots.map(viewFromSnapshot);
  return {
    viewport: snapshots[0]?.snapshot.viewport ?? { width: 1280, height: 800 },
    tokens: tokensFromSnapshots(snapshots.map((s) => s.snapshot), views),
    views,
  };
}

// ---- scoring --------------------------------------------------------------------------

const KIND_WEIGHT: Record<ComponentKind, number> = {
  card: 3,
  column: 3,
  table: 2,
  button: 2,
  input: 2,
  heading: 2,
  tabs: 2,
  badge: 1.5,
  row: 1,
  'list-item': 1,
  avatar: 1,
  checkbox: 1,
  link: 1,
  icon: 0.5,
  image: 0.5,
  divider: 0.5,
};

export interface ViewScore {
  view: string;
  score: number;
  layout: number;
  components: number;
  style: number;
  /** The largest differences, in words. */
  notes: string[];
}

function styleSimilarity(ref: BoxStyle, got: BoxStyle, label: string, notes: [number, string][]): number {
  const parts: [number, number][] = [];
  const add = (sim: number, weight: number, what: string) => {
    parts.push([sim, weight]);
    if (sim < 0.6) notes.push([weight * (1 - sim), `${label}: ${what}`]);
  };
  if (ref.background || got.background) add(colorSimilarity(ref.background, got.background), 2, `background ${got.background ?? 'none'}, spec ${ref.background ?? 'none'}`);
  if (ref.color) add(colorSimilarity(ref.color, got.color), 1, `text colour ${got.color ?? 'none'}, spec ${ref.color}`);
  add(near(ref.radius ?? 0, got.radius ?? 0, 4), 1, `corner radius ${got.radius ?? 0}px, spec ${ref.radius ?? 0}px`);
  add(Boolean(ref.shadow) === Boolean(got.shadow) ? 1 : 0, 1, `${ref.shadow ? 'no shadow, spec has one' : 'has a shadow, spec has none'}`);
  if (ref.border || got.border) add(ref.border && got.border ? colorSimilarity(ref.border.color, got.border.color) * (ref.border.sides === got.border.sides ? 1 : 0.6) : 0, 1, `border ${got.border ? `${got.border.sides} ${got.border.color}` : 'none'}, spec ${ref.border ? `${ref.border.sides} ${ref.border.color}` : 'none'}`);
  if (ref.fontSize) add(near(ref.fontSize, got.fontSize, 2), 1, `font size ${got.fontSize ?? '?'}px, spec ${ref.fontSize}px`);
  if (ref.fontWeight) add(near(ref.fontWeight, got.fontWeight, 150), 0.5, `font weight ${got.fontWeight ?? '?'}, spec ${ref.fontWeight}`);
  add((ref.textTransform ?? 'none') === (got.textTransform ?? 'none') ? 1 : 0, 0.5, `text transform ${got.textTransform ?? 'none'}, spec ${ref.textTransform ?? 'none'}`);
  const total = parts.reduce((s, [, w]) => s + w, 0);
  return total ? parts.reduce((s, [v, w]) => s + v * w, 0) / total : 1;
}

function sameFamily(a: string | undefined, b: string | undefined): number {
  const n = (s: string | undefined) => (s ?? '').toLowerCase().replace(/["']/g, '').trim();
  if (n(a) === n(b)) return 1;
  const generic = /^(system-ui|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica|arial|sans-serif|inter|open sans|noto sans|ubuntu)$/;
  return generic.test(n(a)) && generic.test(n(b)) ? 0.5 : 0;
}

/** Scores one rebuild view against its spec view: 40 % layout, 30 % components, 30 % style. */
export function scoreView(ref: UiView, tokens: UiTokens, got: UiSnapshot): ViewScore {
  const notes: [number, string][] = [];
  const vp = ref.viewport;

  // Layout: regions in the same place, components in the same area of the first screen.
  const regionScores: [number, number][] = [];
  for (const r of ref.regions) {
    // A region entirely below the first screen (a footer under a long page) is not compared.
    if (!clip(r.rect, vp)) continue;
    const match = got.regions.find((g) => g.role === r.role);
    const weight = r.role === 'main' ? 2 : 1;
    if (!match) {
      regionScores.push([0, weight]);
      notes.push([3, `${r.role}: missing (spec ${r.rect.join('×')} at x,y,w,h)`]);
      continue;
    }
    const box = (x: Region, v: { width: number; height: number }) => clip(x.role === 'main' ? mainExtended(x.rect, v) : x.rect, v);
    const overlap = iou(box(r, vp), box(match, got.viewport));
    const bg = colorSimilarity(r.style.background, match.style.background);
    regionScores.push([0.7 * overlap + 0.3 * bg, weight]);
    if (overlap < 0.7) notes.push([2 * (1 - overlap), `${r.role}: box ${match.rect.join(',')}, spec ${r.rect.join(',')} (x,y,w,h)`]);
    if (bg < 0.7) notes.push([1.5 * (1 - bg), `${r.role}: background ${match.style.background}, spec ${r.style.background}`]);
  }
  for (const g of got.regions) {
    if (!ref.regions.some((r) => r.role === g.role) && g.role !== 'main' && clip(g.rect, got.viewport)) {
      regionScores.push([0, 0.5]);
      notes.push([1, `${g.role}: present, the spec view has none`]);
    }
  }
  const regions = weighted(regionScores);

  const placement: [number, number][] = [];
  const comp: [number, number][] = [];
  for (const [kind, refGroup] of Object.entries(ref.components) as [ComponentKind, ComponentGroup][]) {
    const weight = KIND_WEIGHT[kind] ?? 1;
    const mine = got.components.filter((c) => c.kind === kind);
    if (!mine.length) {
      comp.push([0, weight]);
      placement.push([0, weight]);
      notes.push([weight * 1.5, `${kind}: none, spec has ${refGroup.count}`]);
      continue;
    }
    const mineRects = firstScreen(mine, got.viewport);
    // Neither side shows this kind on the first screen: placement cannot differ.
    if (!refGroup.rects.length && !mineRects.length) placement.push([1, weight]);
    else placement.push([iou(unionRect(refGroup.rects), unionRect(mineRects)), weight]);
    const count = ratio(refGroup.count, mine.length);
    if (count < 0.5) notes.push([weight * (1 - count), `${kind}: ${mine.length} on the view, spec ${refGroup.count}`]);
    const size = (near(refGroup.size[0], median(mine.map((c) => c.rect[2])), refGroup.size[0] * 0.25 + 8) + near(refGroup.size[1], median(mine.map((c) => c.rect[3])), refGroup.size[1] * 0.25 + 6)) / 2;
    if (size < 0.6) notes.push([weight * (1 - size), `${kind}: typical size ${median(mine.map((c) => c.rect[2]))}×${median(mine.map((c) => c.rect[3]))}, spec ${refGroup.size.join('×')}`]);
    const style = styleSimilarity(refGroup.style, typicalStyle(mine.map((c) => c.style)), kind, notes);
    comp.push([0.25 * count + 0.25 * size + 0.5 * style, weight]);
  }
  const layout = 0.5 * regions + 0.5 * weighted(placement);
  const components = weighted(comp);

  // Style: the page as a whole against the design tokens.
  const usedColors = [...got.usage.background.slice(0, 12), ...got.usage.text.slice(0, 12)].map(([c]) => c);
  const closest = (c: string | undefined) => (c ? Math.max(0, ...usedColors.map((u) => colorSimilarity(c, u))) : 1);
  const style: [number, number, string][] = [
    [colorSimilarity(ref.page.background, got.page.background), 2, `page background ${got.page.background}, spec ${ref.page.background}`],
    [colorSimilarity(tokens.color.text, got.usage.text[0]?.[0]), 2, `main text colour ${got.usage.text[0]?.[0]}, spec ${tokens.color.text}`],
    [closest(tokens.color.accent), 2, `accent colour ${tokens.color.accent} not used`],
    [closest(tokens.color.surface), 1, `surface colour ${tokens.color.surface} not used`],
    [sameFamily(tokens.font.family, got.usage.fontFamily[0]?.[0]), 2, `font ${got.usage.fontFamily[0]?.[0]}, spec ${tokens.font.family}`],
    [near(tokens.font.baseSize, Number(got.usage.fontSize[0]?.[0] ?? 0), 1.5), 1, `most used font size ${got.usage.fontSize[0]?.[0]}px, spec ${tokens.font.baseSize}px`],
    [near(tokens.radius.base, Number(got.usage.radius[0]?.[0] ?? 0), 3), 1, `most used radius ${got.usage.radius[0]?.[0] ?? 0}px, spec ${tokens.radius.base}px`],
  ];
  for (const [sim, w, what] of style) if (sim < 0.7) notes.push([w * (1 - sim) * 1.5, what]);
  const styleScore = weighted(style.map(([s, w]) => [s, w]));

  const score = Math.round(100 * (0.4 * layout + 0.3 * components + 0.3 * styleScore));
  return {
    view: ref.name,
    score,
    layout: Math.round(100 * layout),
    components: Math.round(100 * components),
    style: Math.round(100 * styleScore),
    notes: notes.sort((a, b) => b[0] - a[0]).slice(0, 8).map(([, n]) => n),
  };
}

function weighted(parts: [number, number][]): number {
  const total = parts.reduce((s, [, w]) => s + w, 0);
  return total ? parts.reduce((s, [v, w]) => s + v * w, 0) / total : 1;
}

// ---- UI.md ----------------------------------------------------------------------------

const REGION_WORDS: Record<RegionRole, string> = { topbar: 'Top bar', sidebar: 'Sidebar', main: 'Main area', footer: 'Footer', dialog: 'Dialog' };

export function renderUiMd(spec: UiSpec): string {
  const t = spec.tokens;
  const sw = (c: string | undefined) => (c ? `\`${c}\`` : '–');
  const lines = [
    '# UI spec',
    '',
    `How the original's views are laid out and styled, measured from the running app at ${spec.viewport.width}×${spec.viewport.height}.`,
    'Generated by `src/infer-ui.ts` from UI snapshots: boxes and computed styles only. It carries no text, names, logos, icons or images',
    'from the original, so the rebuild keeps its own name, wording and artwork and follows the structure and style below.',
    '',
    'Files: `ui/tokens.json` (design tokens), `ui/views.json` (per view: regions, components with positions and typical style).',
    '',
    '## Design tokens',
    '',
    '| Token | Value |',
    '|---|---|',
    ...Object.entries(t.color)
      .filter(([k, v]) => k !== 'palette' && v)
      .map(([k, v]) => `| color.${k} | ${sw(v as string)} |`),
    `| font.family | ${t.font.family}${t.font.headingFamily ? ` (headings: ${t.font.headingFamily})` : ''} |`,
    `| font.baseSize | ${t.font.baseSize}px${t.font.lineHeight ? `, line height ${t.font.lineHeight}px` : ''} |`,
    `| font.sizes | ${t.font.sizes.map((s) => `${s}px`).join(', ')} |`,
    `| font.weights | ${t.font.weights.join(', ')} |`,
    `| radius | base ${t.radius.base}px; scale ${t.radius.scale.map((r) => `${r}px`).join(', ')} |`,
    `| shadow.card | ${t.shadow.card ? `\`${t.shadow.card}\`` : 'none'} |`,
    `| shadow.control | ${t.shadow.control ? `\`${t.shadow.control}\`` : 'none'} |`,
    `| spacing | ${t.spacing.map((s) => `${s}px`).join(', ')} |`,
    '',
    'Palette (most used first): ' + t.color.palette.map((p) => `\`${p.hex}\` (${p.usedFor.join(', ')})`).join('; ') + '.',
    '',
    'Fonts: use the family named here when it is installed or freely licensed; otherwise the closest system font. Never load font files from the original.',
    '',
    '## Views',
    '',
  ];
  for (const v of spec.views) {
    lines.push(`### ${v.name}`, '', `Original route \`${v.route}\`${v.seedFlow ? `, opened after replaying the flows up to \`${v.seedFlow}\`` : ''}. Page background ${sw(v.page.background)}, text ${sw(v.page.color)}, ${v.page.fontFamily} ${v.page.fontSize}px.`, '');
    lines.push('| Region | Box (x, y, w, h) | Background | Edge |', '|---|---|---|---|');
    for (const r of v.regions) {
      const edge = [r.style.border ? `border ${r.style.border.sides} ${r.style.border.width}px ${r.style.border.color}` : '', r.style.shadow ? 'shadow' : '', r.fixed ? 'fixed' : ''].filter(Boolean).join(', ') || '–';
      lines.push(`| ${REGION_WORDS[r.role]} | ${r.rect.join(', ')} | ${sw(r.style.background)} | ${edge} |`);
    }
    lines.push('', '| Component | Count | Typical size | Style |', '|---|---|---|---|');
    for (const [kind, g] of Object.entries(v.components) as [ComponentKind, ComponentGroup][]) {
      const s = g.style;
      const style = [
        s.background ? `bg ${s.background}` : '',
        s.color ? `text ${s.color}` : '',
        s.fontSize ? `${s.fontSize}px/${s.fontWeight ?? 400}` : '',
        s.radius ? `radius ${s.radius}px` : '',
        s.border ? `border ${s.border.sides} ${s.border.color}` : '',
        s.shadow ? 'shadow' : '',
        s.textTransform ? s.textTransform : '',
        s.padding ? `padding ${s.padding.join('/')}px` : '',
      ]
        .filter(Boolean)
        .join(', ');
      const variants = g.variants ? ` (${Object.entries(g.variants).map(([k, n]) => `${n} ${k}`).join(', ')})` : '';
      lines.push(`| ${kind} | ${g.count}${variants} | ${g.size.join('×')} | ${style} |`);
    }
    lines.push('');
  }
  lines.push(
    '## How the look is checked',
    '',
    '`node src/visual.ts --target <name> --base-url <rebuild>` replays the flows on a fresh rebuild, signs in through the',
    "rebuild's own form, opens each view through `rebuild/views.json` and scores it against `ui/views.json`: 40 % layout",
    '(regions and where components sit on the first screen), 30 % components (count, size, style) and 30 % style (page colours,',
    'accent, font, radius). The score is reported apart from behavioural parity, in `parity/visual.md`.',
    '',
  );
  return lines.join('\n');
}
