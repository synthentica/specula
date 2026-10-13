// A small Markdown renderer for page content and comments. Raw HTML is escaped, never passed through.
// Blocks: ATX headings, paragraphs, bullet and numbered lists, block quotes, fenced code, rules.
// Inline: `code`, **strong**, *em* / _em_, ~~strike~~, [links](url), <autolinks>. Every block ends with "\n".

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed) || /^[/#.]/.test(trimmed) || !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return undefined;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

function inline(text: string): string {
  // Code spans first, kept aside so their contents are not formatted.
  const codes: string[] = [];
  let out = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links: string[] = [];
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (whole, label: string, url: string, title?: string) => {
    const href = safeUrl(url);
    if (!href) return whole;
    links.push(`<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${formatted(escapeHtml(label))}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  out = out.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url: string) => {
    links.push(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  out = formatted(escapeHtml(out));
  out = out.replace(/\u0001(\d+)\u0001/g, (_, i: string) => links[Number(i)] ?? '');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? '');
}

function formatted(html: string): string {
  return html
    .replace(/\*\*(?=\S)([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([^_]+?)__/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([^~]+?)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]+?)_(?!\w)/g, '$1<em>$2</em>');
}

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  const startsBlock = (line: string) => HEADING.test(line) || FENCE.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++;
      const lang = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : '';
      html += `<pre><code${lang}>${escapeHtml(body.join('\n'))}${body.length ? '\n' : ''}</code></pre>\n`;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      html += `<h${level} id="${escapeHtml(slugify(text))}">${inline(text)}</h${level}>\n`;
      i++;
      continue;
    }
    if (RULE.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      html += `<blockquote>\n${renderMarkdown(body.join('\n'))}</blockquote>\n`;
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      const first = ordered ? Number(NUMBERED.exec(line)![1]) : 1;
      while (i < lines.length) {
        const m = pattern.exec(lines[i]!);
        if (m) {
          items.push(ordered ? m[2]! : m[1]!);
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
          items[items.length - 1] += ` ${lines[i]!.trim()}`;
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered && first !== 1 ? ` start="${first}"` : '';
      html += `<${tag}${start}>\n${items.map((item) => `<li>${inline(item)}</li>\n`).join('')}</${tag}>\n`;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines[i]!))) para.push(lines[i++]!);
    html += `<p>${para.map((p, idx) => inline(idx < para.length - 1 && / {2,}$/.test(p) ? `${p.trimEnd()}` : p.trim()) + (idx < para.length - 1 ? (/ {2,}$/.test(p) ? '<br>\n' : '\n') : '')).join('')}</p>\n`;
  }
  return html;
}
