// The `filter` query language (equals, one of, none of, comparisons, quoted values, `+` / space as "and")
// and the `order` parameter ("<field> asc|desc", comma-separated).

type Op = 'eq' | 'ne' | 'in' | 'nin' | 'lt' | 'lte' | 'gt' | 'gte';
interface Clause {
  field: string;
  op: Op;
  values: string[];
}

function splitTopLevel(text: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ']') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (depth === 0 && separators.includes(ch)) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const unquote = (v: string) => v.trim().replace(/^'(.*)'$|^"(.*)"$/, (_, a?: string, b?: string) => a ?? b ?? '');

export function parseFilter(filter: string | null): Clause[] {
  if (!filter) return [];
  const clauses: Clause[] = [];
  for (const part of splitTopLevel(filter, '+ ')) {
    const m = part.match(/^([\w.]+):(.*)$/s);
    if (!m) continue;
    const field = m[1]!;
    let rest = m[2]!.trim();
    let op: Op = 'eq';
    if (rest.startsWith('-[')) {
      op = 'nin';
      rest = rest.slice(1);
    } else if (rest.startsWith('[')) op = 'in';
    else if (rest.startsWith('<=')) [op, rest] = ['lte', rest.slice(2)];
    else if (rest.startsWith('>=')) [op, rest] = ['gte', rest.slice(2)];
    else if (rest.startsWith('<')) [op, rest] = ['lt', rest.slice(1)];
    else if (rest.startsWith('>')) [op, rest] = ['gt', rest.slice(1)];
    else if (rest.startsWith('-')) [op, rest] = ['ne', rest.slice(1)];
    const values = op === 'in' || op === 'nin' ? splitTopLevel(rest.replace(/^\[|\]$/g, ''), ',').map(unquote) : [unquote(rest)];
    clauses.push({ field, op, values });
  }
  return clauses;
}

function pick(record: unknown, path: string): unknown {
  let node: unknown = record;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/;
function toTime(value: string): number {
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}${value.length <= 10 ? 'T00:00:00' : ''}Z`;
  return Date.parse(iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

function compareValues(actual: unknown, expected: string): number {
  if (typeof actual === 'string' && DATE.test(actual) && DATE.test(expected)) return Math.sign(toTime(actual) - toTime(expected));
  if (typeof actual === 'number' && expected.trim() !== '' && !Number.isNaN(Number(expected))) return Math.sign(actual - Number(expected));
  const a = actual === null || actual === undefined ? 'null' : String(actual);
  return a < expected ? -1 : a > expected ? 1 : 0;
}

function matchesClause(record: unknown, clause: Clause): boolean {
  const actual = pick(record, clause.field);
  const first = clause.values[0] ?? '';
  const equals = (v: string) => (Array.isArray(actual) ? actual.some((a) => compareValues(a, v) === 0) : compareValues(actual, v) === 0);
  switch (clause.op) {
    case 'eq':
      return equals(first);
    case 'ne':
      return !equals(first);
    case 'in':
      return clause.values.some(equals);
    case 'nin':
      return !clause.values.some(equals);
    case 'lt':
      return actual !== null && actual !== undefined && compareValues(actual, first) < 0;
    case 'lte':
      return actual !== null && actual !== undefined && compareValues(actual, first) <= 0;
    case 'gt':
      return actual !== null && actual !== undefined && compareValues(actual, first) > 0;
    case 'gte':
      return actual !== null && actual !== undefined && compareValues(actual, first) >= 0;
  }
}

export function applyFilter<T>(records: T[], filter: string | null): T[] {
  const clauses = parseFilter(filter);
  return clauses.length ? records.filter((r) => clauses.every((c) => matchesClause(r, c))) : records;
}

/**
 * Sorts by `order` ("published_at desc, id asc"); ties fall back to insertion order (`_seq`) in the same
 * direction as the first key, so records created within the same second still sort newest first.
 * Nulls come first in descending order (drafts before published posts), last in ascending order.
 */
export function applyOrder<T extends object>(records: T[], order: string | null, fallback: string): T[] {
  const keys = (order || fallback)
    .split(',')
    .map((s) => s.trim().split(/\s+/))
    .filter((p) => p[0])
    .map(([field, dir]) => ({ field: field!, desc: (dir ?? 'asc').toLowerCase() === 'desc' }));
  const firstDesc = keys[0]?.desc ?? false;
  return [...records].sort((a, b) => {
    for (const { field, desc } of keys) {
      const x = pick(a, field);
      const y = pick(b, field);
      if (x === y) continue;
      if (x === null || x === undefined) return desc ? -1 : 1;
      if (y === null || y === undefined) return desc ? 1 : -1;
      const c = typeof x === 'string' && typeof y === 'string' && DATE.test(x) && DATE.test(y) ? Math.sign(toTime(x) - toTime(y)) : typeof x === 'number' && typeof y === 'number' ? Math.sign(x - y) : String(x).localeCompare(String(y));
      if (c !== 0) return desc ? -c : c;
    }
    const s = ((a as { _seq?: number })._seq ?? 0) - ((b as { _seq?: number })._seq ?? 0);
    return firstDesc ? -s : s;
  });
}
