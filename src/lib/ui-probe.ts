// Script evaluated in the observed page to describe how the current view looks, without changing it.
// It reads layout boxes and computed styles only: no text, no attribute values, no class names, no image
// sources, so a snapshot carries the structure and style of a view but none of its words, logos or assets.

/** Box in CSS pixels: [x, y, width, height], relative to the top-left of the document. */
export type Rect = [number, number, number, number];

export interface BoxStyle {
  background?: string;
  color?: string;
  border?: { color: string; width: number; sides: string };
  radius?: number;
  shadow?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  textTransform?: string;
  letterSpacing?: number;
  padding?: [number, number];
}

export type RegionRole = 'topbar' | 'sidebar' | 'main' | 'footer' | 'dialog';
export interface Region {
  role: RegionRole;
  rect: Rect;
  style: BoxStyle;
  fixed?: boolean;
}

export type ComponentKind =
  | 'button'
  | 'input'
  | 'checkbox'
  | 'link'
  | 'heading'
  | 'card'
  | 'column'
  | 'badge'
  | 'avatar'
  | 'icon'
  | 'image'
  | 'tabs'
  | 'table'
  | 'row'
  | 'list-item'
  | 'divider';

export interface Component {
  kind: ComponentKind;
  /** button: filled | outline | text; heading: h1..h6; input: text | select | textarea | editor */
  variant?: string;
  rect: Rect;
  style: BoxStyle;
}

/** Weighted usage counts: [value, weight]. */
export type Usage = [string, number][];

export interface UiSnapshot {
  /** Path and hash of the page (query dropped). */
  url: string;
  viewport: { width: number; height: number };
  documentHeight: number;
  page: { background: string; color: string; fontFamily: string; fontSize: number; lineHeight: number };
  regions: Region[];
  components: Component[];
  usage: {
    /** Text colours weighted by characters of text drawn in them. */
    text: Usage;
    /** Background colours weighted by visible area (px²/100). */
    background: Usage;
    border: Usage;
    fontFamily: Usage;
    fontSize: Usage;
    fontWeight: Usage;
    radius: Usage;
    shadow: Usage;
    spacing: Usage;
  };
}

export const UI_PROBE_SOURCE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const sx = scrollX, sy = scrollY;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  // Any CSS colour (rgb, oklch, color-mix...) to #rrggbb or #rrggbbaa, via one canvas pixel.
  const hex = (css) => {
    if (!css || css === 'transparent' || css === 'rgba(0, 0, 0, 0)') return undefined;
    if (colorCache.has(css)) return colorCache.get(css);
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    // getImageData returns premultiplied-then-unpremultiplied values; alpha 0 means fully transparent.
    const h = (n) => n.toString(16).padStart(2, '0');
    const out = a === 0 ? undefined : '#' + h(r) + h(g) + h(b) + (a < 255 ? h(a) : '');
    colorCache.set(css, out);
    return out;
  };
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0; };
  const family = (f) => (f || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  const usage = { text: new Map(), background: new Map(), border: new Map(), fontFamily: new Map(), fontSize: new Map(), fontWeight: new Map(), radius: new Map(), shadow: new Map(), spacing: new Map() };
  const add = (map, key, w) => { if (key === undefined || key === '' || !(w > 0)) return; map.set(String(key), (map.get(String(key)) || 0) + w); };
  const rectOf = (r) => [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)];
  const visible = (el, cs, r) => r.width >= 1 && r.height >= 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05 && r.bottom > -sy && r.right > 0 && r.left < vw;

  // The background an element shows: its own, else the nearest ancestor's.
  const bgCache = new Map();
  const effectiveBg = (el) => {
    if (!el || el.nodeType !== 1) return hex(getComputedStyle(document.documentElement).backgroundColor) || '#ffffff';
    if (bgCache.has(el)) return bgCache.get(el);
    const own = hex(getComputedStyle(el).backgroundColor);
    const out = own && own.length === 7 ? own : effectiveBg(el.parentElement);
    bgCache.set(el, out);
    return out;
  };
  const styleOf = (el, cs) => {
    const s = {};
    const bg = hex(cs.backgroundColor); if (bg) s.background = bg;
    const fg = hex(cs.color); if (fg) s.color = fg;
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((d) => parseFloat(cs['border' + d + 'Width']) > 0 && cs['border' + d + 'Style'] !== 'none' && hex(cs['border' + d + 'Color']));
    if (sides.length) {
      const d = sides[0];
      s.border = { color: hex(cs['border' + d + 'Color']), width: px(cs['border' + d + 'Width']), sides: sides.length === 4 ? 'all' : sides.map((x) => x[0].toLowerCase()).join('') };
    }
    const radius = px(cs.borderTopLeftRadius); if (radius) s.radius = radius;
    if (cs.boxShadow && cs.boxShadow !== 'none') s.shadow = normShadow(cs.boxShadow);
    s.fontFamily = family(cs.fontFamily);
    s.fontSize = px(cs.fontSize);
    s.fontWeight = Number(cs.fontWeight) || 400;
    if (cs.textTransform && cs.textTransform !== 'none') s.textTransform = cs.textTransform;
    const ls = px(cs.letterSpacing); if (ls) s.letterSpacing = ls;
    const p = [px(cs.paddingTop), px(cs.paddingLeft)]; if (p[0] || p[1]) s.padding = p;
    return s;
  };
  const normShadow = (v) => v.replace(/rgba?\\([^)]*\\)|oklch\\([^)]*\\)|#[0-9a-f]{3,8}/gi, (c) => hex(c) || c).slice(0, 160);

  const ownTextLength = (el) => {
    let n = 0;
    for (const child of el.childNodes) if (child.nodeType === 3) n += child.textContent.replace(/\\s+/g, '').length;
    return n;
  };
  const hasText = (el) => (el.innerText || '').replace(/\\s+/g, '').length > 0;

  const all = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode; el && all.length < 6000; el = walker.nextNode()) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META'].includes(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!visible(el, cs, r)) continue;
    all.push({ el, r, cs });
  }

  // ---- usage (design tokens) ----
  const viewArea = (r) => Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  const rootBg = hex(getComputedStyle(document.body).backgroundColor) || hex(getComputedStyle(document.documentElement).backgroundColor) || '#ffffff';
  add(usage.background, rootBg.slice(0, 7), vw * vh / 100);
  for (const { el, r, cs } of all) {
    const bg = hex(cs.backgroundColor);
    if (bg) add(usage.background, bg, viewArea(r) / 100);
    const t = ownTextLength(el);
    if (t) {
      add(usage.text, hex(cs.color), t);
      add(usage.fontFamily, family(cs.fontFamily), t);
      add(usage.fontSize, px(cs.fontSize), t);
      add(usage.fontWeight, Number(cs.fontWeight) || 400, t);
    }
    for (const d of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs['border' + d + 'Width']) > 0 && cs['border' + d + 'Style'] !== 'none') add(usage.border, hex(cs['border' + d + 'Color']), 1);
    }
    const radius = px(cs.borderTopLeftRadius); if (radius && (bg || cs.borderTopStyle !== 'none' || cs.boxShadow !== 'none')) add(usage.radius, Math.min(radius, 999), 1);
    if (cs.boxShadow && cs.boxShadow !== 'none') add(usage.shadow, normShadow(cs.boxShadow), 1);
    for (const v of [cs.paddingTop, cs.paddingLeft, cs.gap === 'normal' ? '' : cs.rowGap]) { const n = px(v); if (n >= 2 && n <= 64) add(usage.spacing, n, 1); }
  }

  // ---- regions ----
  const regions = [];
  const taken = new Set();
  const regionStyle = (el, cs) => { const s = styleOf(el, cs); s.background = effectiveBg(el); return s; };
  const pick = (role, test) => {
    let best;
    for (const item of all) {
      if (taken.has(item.el)) continue;
      if (!test(item)) continue;
      // Outermost match wins: skip elements inside an earlier candidate of the same role.
      if (best && best.el.contains(item.el)) continue;
      if (!best) best = item;
    }
    if (best) {
      taken.add(best.el);
      regions.push({ role, rect: rectOf(best.r), style: regionStyle(best.el, best.cs), ...(best.cs.position === 'fixed' || best.cs.position === 'sticky' ? { fixed: true } : {}) });
    }
    return best;
  };
  const top = pick('topbar', ({ el, r }) => r.top + sy <= 8 && r.width >= vw * 0.6 && r.height >= 32 && r.height <= 140 && el.children.length > 0);
  const side = pick('sidebar', ({ el, r }) => (r.left <= 8 || r.right >= vw - 8) && r.width >= 120 && r.width <= vw * 0.4 && r.height >= vh * 0.55 && el.children.length > 0 && !(top && el.contains(top.el)));
  // A dialog floats over the page: never one of the bars found above, nor inside or around them.
  const bars = [top, side].filter(Boolean).map((b) => b.el);
  const dialog = all.find(({ el, r, cs }) => !bars.some((b) => b === el || b.contains(el) || el.contains(b)) && (el.matches('dialog[open],[role=dialog],[aria-modal=true]') || (cs.position === 'fixed' && r.width < vw * 0.95 && r.width > 240 && r.height > 120 && Number(cs.zIndex) > 10 && hex(cs.backgroundColor))) && r.width > 200);
  if (dialog) regions.push({ role: 'dialog', rect: rectOf(dialog.r), style: regionStyle(dialog.el, dialog.cs) });
  // Main: the semantic main element, else the space the bars leave free.
  const mainEl = all.find(({ el }) => el.matches('main,[role=main]'));
  if (mainEl) regions.push({ role: 'main', rect: rectOf(mainEl.r), style: regionStyle(mainEl.el, mainEl.cs) });
  else {
    const x = side && side.r.left <= 8 ? Math.round(side.r.right) : 0;
    const y = top ? Math.round(top.r.bottom + sy) : 0;
    const w = (side && side.r.left > 8 ? Math.round(side.r.left) : vw) - x;
    const probe = document.elementFromPoint(Math.min(vw - 1, x + w / 2), Math.min(vh - 1, y + 40));
    regions.push({ role: 'main', rect: [x, y, w, Math.max(document.documentElement.scrollHeight, vh) - y], style: { background: effectiveBg(probe) } });
  }
  const foot = all.find(({ el, r }) => el.matches('footer,[role=contentinfo]') && r.width >= vw * 0.6);
  if (foot) regions.push({ role: 'footer', rect: rectOf(foot.r), style: regionStyle(foot.el, foot.cs) });

  // ---- components ----
  const components = [];
  const counts = new Map();
  const MAX_PER_KIND = 60;
  const push = (kind, item, variant) => {
    const n = counts.get(kind) || 0;
    if (n >= MAX_PER_KIND) return;
    counts.set(kind, n + 1);
    components.push({ kind, ...(variant ? { variant } : {}), rect: rectOf(item.r), style: styleOf(item.el, item.cs) });
  };
  const distinctFromParent = (el, cs) => { const bg = hex(cs.backgroundColor); return !!bg && bg.slice(0, 7) !== effectiveBg(el.parentElement); };
  const framed = (cs) => (cs.boxShadow && cs.boxShadow !== 'none') || (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && parseFloat(cs.borderBottomWidth) > 0);
  const classified = new Set();
  // A row of three or more links or buttons of equal height in a compact box: a view switcher or tab bar.
  const segmented = (el, r) => {
    const kids = Array.from(el.children);
    if (kids.length < 3 || kids.length > 10 || r.width > vw * 0.7 || r.height > 64) return false;
    if (!kids.every((k) => k.matches('a,button,[role=tab],[role=button]'))) return false;
    const boxes = kids.map((k) => k.getBoundingClientRect());
    return boxes.every((b, i) => Math.abs(b.height - boxes[0].height) <= 2 && (i === 0 || b.left >= boxes[i - 1].right - 1));
  };
  // A tall, narrow box next to siblings of the same width: a board column.
  const repeatedColumn = (el, r) => {
    if (r.height < vh * 0.3 || r.width < 160 || r.width > 480 || !el.parentElement) return false;
    const peers = Array.from(el.parentElement.children).filter((c) => c !== el && Math.abs(c.getBoundingClientRect().width - r.width) <= 4 && Math.abs(c.getBoundingClientRect().top - r.top) <= 4);
    return peers.length >= 1;
  };
  for (const item of all) {
    const { el, r, cs } = item;
    const tag = el.tagName;
    const role = el.getAttribute('role');
    let kind, variant;
    if (/^H[1-6]$/.test(tag) || role === 'heading') { kind = 'heading'; variant = /^H[1-6]$/.test(tag) ? tag.toLowerCase() : 'h' + (el.getAttribute('aria-level') || '2'); }
    else if (tag === 'INPUT' && ['checkbox', 'radio'].includes(el.type) || role === 'checkbox' || role === 'switch' || role === 'radio') kind = 'checkbox';
    else if (tag === 'BUTTON' || role === 'button' || (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type))) {
      kind = 'button';
      variant = distinctFromParent(el, cs) ? 'filled' : framed(cs) ? 'outline' : 'text';
    }
    else if (tag === 'INPUT' && !['hidden', 'file'].includes(el.type)) { kind = 'input'; variant = 'text'; }
    else if (tag === 'SELECT') { kind = 'input'; variant = 'select'; }
    else if (tag === 'TEXTAREA') { kind = 'input'; variant = 'textarea'; }
    else if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) { kind = 'input'; variant = 'editor'; }
    else if (role === 'tablist' || segmented(el, r)) kind = 'tabs';
    else if (repeatedColumn(el, r)) kind = 'column';
    else if (tag === 'TABLE' || role === 'grid' || role === 'table') kind = 'table';
    else if (tag === 'TR' || role === 'row') kind = 'row';
    else if (tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO' || (tag === 'svg' && r.width > 48 && r.height > 48)) {
      const round = parseFloat(cs.borderTopLeftRadius) >= Math.min(r.width, r.height) * 0.4;
      kind = round && r.width <= 72 && Math.abs(r.width - r.height) <= 4 ? 'avatar' : 'image';
    }
    else if (tag === 'svg' || ((tag === 'I' || tag === 'SPAN') && r.width <= 28 && r.height <= 28 && !hasText(el) && (cs.backgroundImage !== 'none' || cs.maskImage !== 'none' || el.querySelector('svg')))) kind = 'icon';
    else if (tag === 'HR' || (r.height <= 2 && r.width >= 80 && hex(cs.backgroundColor))) kind = 'divider';
    else if (tag === 'A') {
      const looksButton = distinctFromParent(el, cs) && r.height >= 24 && r.height <= 56 && parseFloat(cs.paddingLeft) >= 6;
      kind = looksButton ? 'button' : 'link';
      if (looksButton) variant = 'filled';
    }
    else if (r.width <= 72 && Math.abs(r.width - r.height) <= 3 && r.width >= 18 && parseFloat(cs.borderTopLeftRadius) >= r.width * 0.4 && distinctFromParent(el, cs)) kind = 'avatar';
    else if (r.height <= 30 && r.width <= 200 && r.width >= 12 && distinctFromParent(el, cs) && parseFloat(cs.borderTopLeftRadius) > 0 && hasText(el) && el.children.length <= 3) kind = 'badge';
    else if ((distinctFromParent(el, cs) || framed(cs)) && r.width >= 120 && r.width <= Math.min(760, vw * 0.7) && r.height >= 36 && hasText(el) && !taken.has(el)) {
      const innerCards = Array.from(el.children).filter((c) => { const s = getComputedStyle(c); return (s.boxShadow !== 'none' || hex(s.backgroundColor)) && c.getBoundingClientRect().height >= 30; }).length;
      kind = r.height >= vh * 0.35 && innerCards >= 2 ? 'column' : r.height <= 520 ? 'card' : undefined;
    }
    else if (tag === 'LI' && hasText(el)) kind = 'list-item';
    if (!kind) continue;
    // A badge or card nested in a component of the same kind counts once.
    if ((kind === 'card' || kind === 'badge' || kind === 'list-item') && el.parentElement && el.parentElement.closest && [...classified].some((c) => c !== el && c.contains(el) && c.__wpKind === kind)) continue;
    el.__wpKind = kind;
    classified.add(el);
    push(kind, item, variant);
  }
  for (const el of classified) delete el.__wpKind;

  const sortUsage = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, Math.round(v * 10) / 10]);
  const rootCs = getComputedStyle(document.body);
  return {
    url: location.pathname + location.hash,
    viewport: { width: vw, height: vh },
    documentHeight: Math.round(document.documentElement.scrollHeight),
    page: { background: rootBg.slice(0, 7), color: hex(rootCs.color) || '#000000', fontFamily: family(rootCs.fontFamily), fontSize: px(rootCs.fontSize), lineHeight: rootCs.lineHeight === 'normal' ? 0 : px(rootCs.lineHeight) },
    regions,
    components,
    usage: Object.fromEntries(Object.entries(usage).map(([k, m]) => [k, sortUsage(m)])),
  };
})()`;
