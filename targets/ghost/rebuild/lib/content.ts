// Editor documents: the `lexical` field is a JSON string holding a node tree; `mobiledoc` is an older
// section-array format that only seed content uses. These helpers turn either into plain text.

interface Node {
  type?: string;
  text?: string;
  children?: Node[];
}

const BLOCKS = new Set(['paragraph', 'heading', 'quote', 'listitem', 'list', 'code']);

/** Plain text of a lexical document: one line per block, empty string when there is no text. */
export function lexicalText(lexical: unknown): string {
  if (typeof lexical !== 'string' || !lexical) return '';
  let doc: { root?: Node };
  try {
    doc = JSON.parse(lexical) as { root?: Node };
  } catch {
    return '';
  }
  const lines: string[] = [];
  const walk = (node: Node, line: string[]): void => {
    if (typeof node.text === 'string') line.push(node.text);
    for (const child of node.children ?? []) {
      if (child.type && BLOCKS.has(child.type) && !(child.children ?? []).some((c) => c.type && BLOCKS.has(c.type))) {
        const own: string[] = [];
        walk(child, own);
        lines.push(own.join(''));
      } else walk(child, line);
    }
  };
  const stray: string[] = [];
  if (doc.root) walk(doc.root, stray);
  if (stray.length) lines.push(stray.join(''));
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Plain text of a mobiledoc document (markup sections only). */
export function mobiledocText(mobiledoc: unknown): string {
  if (typeof mobiledoc !== 'string' || !mobiledoc) return '';
  try {
    const doc = JSON.parse(mobiledoc) as { sections?: unknown[] };
    const lines: string[] = [];
    for (const section of doc.sections ?? []) {
      if (!Array.isArray(section) || section[0] !== 1 || !Array.isArray(section[2])) continue;
      lines.push(section[2].map((marker: unknown) => (Array.isArray(marker) && typeof marker[3] === 'string' ? marker[3] : '')).join(''));
    }
    return lines.filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

/** Builds a lexical document string from plain text: one paragraph per line. */
export function lexicalFromText(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const paragraphs = (lines.some((l) => l.trim()) ? lines.filter((l) => l.trim()) : ['']).map((line) => ({
    children: line
      ? [{ detail: 0, format: 0, mode: 'normal', style: '', text: line, type: 'extended-text', version: 1 }]
      : [],
    direction: line ? 'ltr' : null,
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
  }));
  const hasText = paragraphs.some((p) => p.children.length);
  return JSON.stringify({ root: { children: paragraphs, direction: hasText ? 'ltr' : null, format: '', indent: 0, type: 'root', version: 1 } });
}

export function excerptOf(text: string, length = 500): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > length ? `${flat.slice(0, length).replace(/\s+\S*$/, '')}…` : flat;
}

export function readingTime(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round(words / 275);
}
