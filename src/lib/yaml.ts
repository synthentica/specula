// Minimal YAML emitter for JSON-compatible data (enough for OpenAPI documents).

const PLAIN = /^[A-Za-z_$/][\w$ ./{}()-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|y|n)$/i;

function scalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (s && PLAIN.test(s) && !RESERVED.test(s) && !/[:#]\s|\s$|^\s/.test(s) && !s.includes(': ')) return s;
  return JSON.stringify(s);
}

function key(k: string): string {
  return PLAIN.test(k) && !RESERVED.test(k) && !k.includes(' ') ? k : JSON.stringify(k);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

function emit(value: unknown, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item)) lines.push(`${pad}- ${scalar(item)}`);
      else if (Array.isArray(item) ? !item.length : !Object.keys(item as object).length) lines.push(`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`);
      else {
        const nested: string[] = [];
        emit(item, indent + 1, nested);
        lines.push(`${pad}- ${nested[0]!.trimStart()}`, ...nested.slice(1));
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (isScalar(v)) lines.push(`${pad}${key(k)}: ${scalar(v)}`);
    else if (Array.isArray(v) && !v.length) lines.push(`${pad}${key(k)}: []`);
    else if (!Array.isArray(v) && !Object.keys(v as object).length) lines.push(`${pad}${key(k)}: {}`);
    else if (Array.isArray(v) && v.every(isScalar) && v.length <= 8 && JSON.stringify(v).length < 80) lines.push(`${pad}${key(k)}: [${v.map(scalar).join(', ')}]`);
    else {
      lines.push(`${pad}${key(k)}:`);
      emit(v, indent + 1, lines);
    }
  }
}

export function toYaml(value: unknown): string {
  const lines: string[] = [];
  emit(value, 0, lines);
  return `${lines.join('\n')}\n`;
}
