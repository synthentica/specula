// Tiny DOM helpers. Text always goes through text nodes, never innerHTML.

export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'class') el.className = String(value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove('show'), 3500);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Turns stored comment HTML into safe paragraphs of plain text. */
export function commentParagraphs(html: string): HTMLElement[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = Array.from(doc.body.children);
  const texts = blocks.length ? blocks.map((b) => b.textContent ?? '') : [doc.body.textContent ?? ''];
  return texts.filter((t) => t.trim()).map((t) => h('p', null, t));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---- icons ----------------------------------------------------------------------------------
// Listwell's own line icons: simple strokes on a 24-unit grid, drawn in the current text colour.

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  calendar: 'M4 6h16v15H4z M4 10h16 M8 3v4 M16 3v4',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  tag: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z M8 8h.01',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4-4',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z M10 21h4',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  chevron: 'M6 9l6 6 6-6',
  dots: 'M5 12h.01 M12 12h.01 M19 12h.01',
  plus: 'M12 5v14 M5 12h14',
  check: 'M5 12l5 5 9-11',
  back: 'M19 12H5 M11 6l-6 6 6 6',
  list: 'M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01',
  table: 'M3 5h18v14H3z M3 10h18 M3 15h18 M9 5v14',
  board: 'M4 4h4v16H4z M10 4h4v10h-4z M16 4h4v6h-4z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  flag: 'M5 21V4 M5 4h12l-3 4 3 4H5',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7v5l3 3',
  comment: 'M4 5h16v11H9l-5 4z',
  text: 'M4 6h16 M4 11h16 M4 16h10',
  bold: 'M7 5h6a3.5 3.5 0 0 1 0 7H7z M7 12h7a3.5 3.5 0 0 1 0 7H7z',
  italic: 'M11 5h6 M7 19h6 M14 5l-4 14',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4 M5 20h14',
  strike: 'M5 12h14 M16 7c-1-2-7-3-8 0 M8 17c1 2 7 3 8 0',
  heading: 'M6 5v14 M18 5v14 M6 12h12',
  bullets: 'M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01',
  numbers: 'M10 6h10 M10 12h10 M10 18h10 M4 4h1v4 M3.5 8h2.5',
  quote: 'M5 11h4v6H5z M5 11c0-3 1-5 4-6 M14 11h4v6h-4z M14 11c0-3 1-5 4-6',
  code: 'M9 8l-4 4 4 4 M15 8l4 4-4 4',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h3',
  eraser: 'M4 20h16 M7 17l-3-3 9-9 6 6-6 6z',
  rule: 'M4 12h16 M8 7h8 M8 17h8',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1 M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
  help: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6 M12 17h.01',
  keyboard: 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10',
  logout: 'M10 4H5v16h5 M15 8l4 4-4 4 M19 12H9',
  user: 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M4 21c1-4 4-6 8-6s7 2 8 6',
};

export function icon(name: keyof typeof ICONS | string, size = 16, cls = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.dots!);
  svg.appendChild(path);
  return svg;
}

/** Listwell's mark: a check in a rounded square. */
export function logoMark(size = 32): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'logo-mark');
  const rect = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ width: '32', height: '32', rx: '8', fill: 'currentColor' })) rect.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, 'path');
  for (const [k, v] of Object.entries({ d: 'M9 17l5 5 9-11', stroke: '#fff', 'stroke-width': '3.5', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(k, v);
  svg.append(rect, path);
  return svg;
}

/** An empty-state drawing (Listwell's own): a sheet of finished to-dos on a soft disc. */
export function emptyIllustration(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 300 300');
  svg.setAttribute('width', '300');
  svg.setAttribute('height', '300');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Nothing left to do');
  svg.setAttribute('class', 'empty-art');
  const shape = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  };
  shape('circle', { cx: '150', cy: '160', r: '120', class: 'art-disc' });
  shape('rect', { x: '88', y: '62', width: '124', height: '170', rx: '10', class: 'art-sheet' });
  shape('rect', { x: '122', y: '50', width: '56', height: '22', rx: '6', class: 'art-clip' });
  for (const [i, y] of [100, 140, 180].entries()) {
    shape('rect', { x: '106', y: String(y - 10), width: '20', height: '20', rx: '5', class: 'art-box' });
    shape('path', { d: `M110 ${y}l5 5 8-10`, class: 'art-tick' });
    shape('rect', { x: '136', y: String(y - 4), width: String(i === 2 ? 40 : 58), height: '8', rx: '4', class: 'art-line' });
  }
  shape('circle', { cx: '236', cy: '86', r: '8', class: 'art-dot' });
  shape('circle', { cx: '62', cy: '214', r: '6', class: 'art-dot' });
  shape('path', { d: 'M232 220l10 10 M242 220l-10 10', class: 'art-tick' });
  return svg;
}

// ---- rich text -------------------------------------------------------------------------------

const ALLOWED_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'HR', 'DIV', 'SPAN']);

/** Copies stored HTML into live nodes, keeping only simple formatting tags and safe links. */
export function sanitizeHtml(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = document.createDocumentFragment();
  const copy = (from: Node, to: Node) => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) to.appendChild(document.createTextNode(child.textContent ?? ''));
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (!ALLOWED_TAGS.has(el.tagName)) {
          if (!['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'TEMPLATE'].includes(el.tagName)) copy(el, to);
          continue;
        }
        const clean = document.createElement(el.tagName.toLowerCase());
        if (el.tagName === 'A') {
          const href = el.getAttribute('href') ?? '';
          if (/^(https?:|mailto:)/i.test(href)) {
            clean.setAttribute('href', href);
            clean.setAttribute('target', '_blank');
            clean.setAttribute('rel', 'noopener noreferrer');
          }
        }
        copy(el, clean);
        to.appendChild(clean);
      }
    }
  };
  copy(doc.body, out);
  return out;
}

export function isBlankHtml(html: string): boolean {
  return !new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim();
}

// ---- popovers --------------------------------------------------------------------------------

let openPopover: { panel: HTMLElement; button: HTMLElement } | null = null;
document.addEventListener('click', (e) => {
  if (openPopover && !openPopover.panel.contains(e.target as Node) && !openPopover.button.contains(e.target as Node)) closePopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openPopover) {
    const { button } = openPopover;
    closePopover();
    button.focus();
  }
});
window.addEventListener('hashchange', () => closePopover());

export function closePopover(): void {
  if (!openPopover) return;
  openPopover.panel.hidden = true;
  openPopover.button.setAttribute('aria-expanded', 'false');
  openPopover = null;
}

/** Wires a button to show and hide a dropdown panel placed next to it. */
export function popover(button: HTMLElement, panel: HTMLElement, onOpen?: () => void): void {
  panel.hidden = true;
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = openPopover?.panel === panel;
    closePopover();
    if (wasOpen) return;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    openPopover = { panel, button };
    onOpen?.();
  });
}

/** Dark or light text, whichever reads better on the given background colour. */
export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#1f2937';
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x!, 16) / 255) as [number, number, number];
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? '#1f2937' : '#ffffff';
}
