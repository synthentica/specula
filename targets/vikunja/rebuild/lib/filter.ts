// The task filter language: comparisons `field op value` joined by && / || with parentheses.
//   done = false && due_date < '2026-10-18T08:49:26.840Z' && due_date > now
// Operators: = == != < > <= >= like in, "not in". Values: booleans, numbers, quoted strings, bare words,
// comma-separated lists for `in`, and relative times such as now, now+7d, now-1w.

export type FilterValue = string | number | boolean;

export type Node =
  | { kind: 'and' | 'or'; left: Node; right: Node }
  | { kind: 'cmp'; field: string; op: string; value: FilterValue | FilterValue[] };

export class FilterError extends Error {}
/** A value that does not fit its field's type, such as a word for the numeric `priority`. */
export class FilterValueError extends FilterError {}

interface Token {
  t: 'word' | 'str' | 'op' | 'lp' | 'rp' | 'and' | 'or' | 'comma';
  v: string;
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&') {
      out.push({ t: 'and', v: two });
      i += 2;
    } else if (two === '||') {
      out.push({ t: 'or', v: two });
      i += 2;
    } else if (two === '!=' || two === '<=' || two === '>=' || two === '==') {
      out.push({ t: 'op', v: two === '==' ? '=' : two });
      i += 2;
    } else if (c === '=' || c === '<' || c === '>') {
      out.push({ t: 'op', v: c });
      i++;
    } else if (c === '(') {
      out.push({ t: 'lp', v: c });
      i++;
    } else if (c === ')') {
      out.push({ t: 'rp', v: c });
      i++;
    } else if (c === ',') {
      out.push({ t: 'comma', v: c });
      i++;
    } else if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new FilterError('Unterminated string in filter.');
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
    } else {
      let j = i;
      while (j < src.length && !/[\s()=<>!&|,'"]/.test(src[j]!)) j++;
      if (j === i) throw new FilterError(`Unexpected character "${c}" in filter.`);
      out.push({ t: 'word', v: src.slice(i, j) });
      i = j;
    }
  }
  return out;
}

export function parseFilter(src: string): Node | undefined {
  const tokens = tokenize(src);
  if (!tokens.length) return undefined;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const scalar = (tok: Token | undefined): FilterValue => {
    if (!tok || (tok.t !== 'word' && tok.t !== 'str')) throw new FilterError('Expected a value in filter.');
    if (tok.t === 'str') return tok.v;
    if (tok.v === 'true') return true;
    if (tok.v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(tok.v)) return Number(tok.v);
    return tok.v;
  };

  const comparison = (): Node => {
    const field = next();
    if (!field || field.t !== 'word') throw new FilterError('Expected a field name in filter.');
    let op: string;
    const o = next();
    if (o?.t === 'op') op = o.v;
    else if (o?.t === 'word' && /^(like|in)$/i.test(o.v)) op = o.v.toLowerCase();
    else if (o?.t === 'word' && /^not$/i.test(o.v) && peek()?.t === 'word' && /^in$/i.test(peek()!.v)) {
      next();
      op = 'not in';
    } else throw new FilterError(`Expected an operator after "${field.v}".`);
    if (op === 'in' || op === 'not in') {
      const values: FilterValue[] = [scalar(next())];
      while (peek()?.t === 'comma') {
        next();
        values.push(scalar(next()));
      }
      return { kind: 'cmp', field: field.v.toLowerCase(), op, value: values };
    }
    return { kind: 'cmp', field: field.v.toLowerCase(), op, value: scalar(next()) };
  };

  const primary = (): Node => {
    if (peek()?.t === 'lp') {
      next();
      const inner = orExpr();
      if (next()?.t !== 'rp') throw new FilterError('Missing ")" in filter.');
      return inner;
    }
    return comparison();
  };
  const andExpr = (): Node => {
    let left = primary();
    while (peek()?.t === 'and') {
      next();
      left = { kind: 'and', left, right: primary() };
    }
    return left;
  };
  const orExpr = (): Node => {
    let left = andExpr();
    while (peek()?.t === 'or') {
      next();
      left = { kind: 'or', left, right: andExpr() };
    }
    return left;
  };
  const tree = orExpr();
  if (pos < tokens.length) throw new FilterError('Unexpected input at the end of the filter.');
  return tree;
}

// ---- evaluation -----------------------------------------------------------------------

/** What a task exposes to filters. Dates are epoch ms, or null for "no date". */
export interface FilterSubject {
  num: Record<string, number>;
  bool: Record<string, boolean>;
  date: Record<string, number | null>;
  text: Record<string, string>;
  ids: Record<string, number[]>;
  idTitles: Record<string, string[]>;
}

const UNITS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, M: 2592e6, y: 31536e6 };

export function toTime(v: FilterValue): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const rel = v.match(/^now(?:([+-])(\d+)([smhdwMy]))?(?:\/[dwMy])?$/);
  if (rel) {
    const base = Date.now();
    if (!rel[1]) return base;
    const delta = Number(rel[2]) * UNITS[rel[3]!]!;
    return rel[1] === '+' ? base + delta : base - delta;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

const ALIASES: Record<string, string> = { project_id: 'project', label: 'labels', label_id: 'labels', assignee: 'assignees', duedate: 'due_date' };

type FieldKind = 'num' | 'bool' | 'date' | 'text' | 'ids';
/** The fields a filter may use (must match what FilterSubject provides). */
const FIELD_KINDS: Record<string, FieldKind> = {
  id: 'num',
  priority: 'num',
  percent_done: 'num',
  index: 'num',
  project: 'num',
  repeat_after: 'num',
  done: 'bool',
  is_favorite: 'bool',
  due_date: 'date',
  start_date: 'date',
  end_date: 'date',
  done_at: 'date',
  created: 'date',
  updated: 'date',
  title: 'text',
  description: 'text',
  labels: 'ids',
  assignees: 'ids',
};

function fits(kind: FieldKind, v: FilterValue): boolean {
  switch (kind) {
    case 'num':
      return typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()));
    case 'bool':
      return typeof v === 'boolean' || v === 'true' || v === 'false' || v === 0 || v === 1;
    case 'date':
      return toTime(v) !== undefined;
    default:
      return true;
  }
}

/** Checks field names and value types up front, so a bad filter fails even when no task would be compared. */
export function validateFilter(node: Node | undefined): void {
  if (!node) return;
  if (node.kind !== 'cmp') {
    validateFilter(node.left);
    validateFilter(node.right);
    return;
  }
  const field = ALIASES[node.field] ?? node.field;
  const kind = FIELD_KINDS[field];
  if (!kind) throw new FilterError(`Unknown filter field "${node.field}".`);
  for (const v of Array.isArray(node.value) ? node.value : [node.value]) {
    if (!fits(kind, v)) throw new FilterValueError(`"${String(v)}" is not a valid value for the filter field "${node.field}".`);
  }
}

function cmp(a: number | string, b: number | string, op: string): boolean {
  switch (op) {
    case '=':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
    default:
      return false;
  }
}

export function evaluate(node: Node | undefined, s: FilterSubject, includeNulls: boolean): boolean {
  if (!node) return true;
  if (node.kind !== 'cmp') {
    if (node.kind === 'and') return evaluate(node.left, s, includeNulls) && evaluate(node.right, s, includeNulls);
    return evaluate(node.left, s, includeNulls) || evaluate(node.right, s, includeNulls);
  }
  const field = ALIASES[node.field] ?? node.field;
  const values = Array.isArray(node.value) ? node.value : [node.value];
  const op = node.op;
  const any = (pred: (v: FilterValue) => boolean) => (op === 'not in' ? !values.some(pred) : values.some(pred));
  const scalarOp = op === 'in' || op === 'not in' ? '=' : op;

  if (field in s.bool) {
    const actual = s.bool[field]!;
    return any((v) => cmp(Number(actual), Number(v === true || v === 'true' || v === 1), scalarOp));
  }
  if (field in s.date) {
    const actual = s.date[field];
    if (actual === null || actual === undefined) return includeNulls;
    return any((v) => {
      const t = toTime(v);
      return t !== undefined && cmp(actual, t, scalarOp);
    });
  }
  if (field in s.num) {
    const actual = s.num[field]!;
    return any((v) => cmp(actual, Number(v), scalarOp));
  }
  if (field in s.ids) {
    const ids = s.ids[field]!;
    const titles = (s.idTitles[field] ?? []).map((t) => t.toLowerCase());
    const has = (v: FilterValue) => (typeof v === 'number' ? ids.includes(v) : titles.includes(String(v).toLowerCase()));
    if (ids.length === 0 && includeNulls) return true;
    if (op === '!=') return !values.some(has);
    return any(has);
  }
  if (field in s.text) {
    const actual = s.text[field]!.toLowerCase();
    if (op === 'like') {
      const pattern = String(values[0]).toLowerCase().replace(/^%|%$/g, '');
      return actual.includes(pattern);
    }
    return any((v) => cmp(actual, String(v).toLowerCase(), scalarOp));
  }
  throw new FilterError(`Unknown filter field "${node.field}".`);
}
