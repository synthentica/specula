// A small GraphQL engine for the subset Pagegrove's client uses: anonymous or named query/mutation
// operations, typed variable definitions, nested selections, aliases, literal arguments, fragments,
// @include/@skip and __typename. Every field remembers its line and column so errors can point at it.

// ---- syntax tree -----------------------------------------------------------------------------

export interface Loc {
  line: number;
  column: number;
}

export type TypeNode = { kind: 'named'; name: string } | { kind: 'list'; of: TypeNode } | { kind: 'nonNull'; of: TypeNode };

export type ValueNode =
  | { kind: 'variable'; name: string; loc: Loc }
  | { kind: 'int' | 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface Directive {
  name: string;
  args: Record<string, ValueNode>;
}

export interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  directives: Directive[];
  selections?: SelectionNode[];
  loc: Loc;
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
  directives: Directive[];
  loc: Loc;
}

export interface InlineFragmentNode {
  kind: 'inline';
  on?: string;
  directives: Directive[];
  selections: SelectionNode[];
  loc: Loc;
}

export type SelectionNode = FieldNode | SpreadNode | InlineFragmentNode;

export interface VariableDef {
  name: string;
  type: TypeNode;
  defaultValue?: ValueNode;
  loc: Loc;
}

export interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variables: VariableDef[];
  selections: SelectionNode[];
  loc: Loc;
}

export interface FragmentNode {
  name: string;
  on: string;
  selections: SelectionNode[];
  loc: Loc;
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

// ---- errors ----------------------------------------------------------------------------------

export interface GraphQLErrorOut {
  message: string;
  locations?: Loc[];
  path?: (string | number)[];
  extensions: Record<string, unknown>;
}

export class QuerySyntaxError extends Error {
  readonly loc: Loc;
  constructor(message: string, loc: Loc) {
    super(message);
    this.loc = loc;
  }
}

/** An application failure inside a resolver: becomes a GraphQL error with a numeric code. */
export class AppError extends Error {
  readonly code: number;
  readonly slug: string;
  readonly kind: string;
  constructor(code: number, slug: string, message: string, kind = 'INTERNAL_SERVER_ERROR') {
    super(message);
    this.code = code;
    this.slug = slug;
    this.kind = kind;
  }
}

// ---- lexer -----------------------------------------------------------------------------------

type TokenKind = 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
  loc: Loc;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const loc = (at: number): Loc => ({ line, column: at - lineStart + 1 });
  const newline = (at: number) => {
    line++;
    lineStart = at + 1;
  };
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\n') {
      newline(i);
      i++;
      continue;
    }
    if (c === '\r') {
      if (source[i + 1] === '\n') i++;
      newline(i);
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === ',' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    const start = loc(i);
    if (c === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...', loc: start });
      i += 3;
      continue;
    }
    if ('!$()[]{}:=@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c, loc: start });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j), loc: start });
      i = j;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!m) throw new QuerySyntaxError(`Unexpected character "${c}".`, start);
      tokens.push({ kind: m[2] || m[3] ? 'float' : 'int', value: m[0], loc: start });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new QuerySyntaxError('Unterminated string.', start);
        const raw = source.slice(i + 3, end);
        for (let k = i; k < end; k++) if (source[k] === '\n') newline(k);
        tokens.push({ kind: 'string', value: blockString(raw), loc: start });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      for (;;) {
        const ch = source[j];
        if (ch === undefined || ch === '\n' || ch === '\r') throw new QuerySyntaxError('Unterminated string.', start);
        if (ch === '"') break;
        if (ch === '\\') {
          const esc = source[j + 1];
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc !== undefined && esc in simple) {
            value += simple[esc];
            j += 2;
          } else if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(j + 2, j + 6))) {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else throw new QuerySyntaxError('Invalid character escape sequence.', loc(j));
          continue;
        }
        value += ch;
        j++;
      }
      tokens.push({ kind: 'string', value, loc: start });
      i = j + 1;
      continue;
    }
    throw new QuerySyntaxError(`Unexpected character "${c}".`, start);
  }
  tokens.push({ kind: 'eof', value: '', loc: loc(i) });
  return tokens;
}

function blockString(raw: string): string {
  const lines = raw.replace(/\\"""/g, '"""').split(/\r\n|\r|\n/);
  let common = Infinity;
  for (const l of lines.slice(1)) {
    const indent = l.length - l.trimStart().length;
    if (indent < l.length) common = Math.min(common, indent);
  }
  const out = lines.map((l, idx) => (idx === 0 || common === Infinity ? l : l.slice(common)));
  while (out.length && out[0]!.trim() === '') out.shift();
  while (out.length && out[out.length - 1]!.trim() === '') out.pop();
  return out.join('\n');
}

// ---- parser ----------------------------------------------------------------------------------

export function parse(source: string): DocumentNode {
  const tokens = lex(source);
  let pos = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const isPunct = (v: string) => peek().kind === 'punct' && peek().value === v;
  const expectPunct = (v: string): Token => {
    const t = next();
    if (t.kind !== 'punct' || t.value !== v) throw new QuerySyntaxError(`Expected "${v}", found ${describe(t)}.`, t.loc);
    return t;
  };
  const expectName = (): Token => {
    const t = next();
    if (t.kind !== 'name') throw new QuerySyntaxError(`Expected a name, found ${describe(t)}.`, t.loc);
    return t;
  };
  const describe = (t: Token) => (t.kind === 'eof' ? '<EOF>' : t.kind === 'string' ? `string "${t.value}"` : `"${t.value}"`);

  const parseType = (): TypeNode => {
    let type: TypeNode;
    if (isPunct('[')) {
      next();
      type = { kind: 'list', of: parseType() };
      expectPunct(']');
    } else type = { kind: 'named', name: expectName().value };
    if (isPunct('!')) {
      next();
      type = { kind: 'nonNull', of: type };
    }
    return type;
  };

  const parseValue = (isConst: boolean): ValueNode => {
    const t = peek();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new QuerySyntaxError('Variables are not allowed here.', t.loc);
      next();
      return { kind: 'variable', name: expectName().value, loc: t.loc };
    }
    if (t.kind === 'punct' && t.value === '[') {
      next();
      const values: ValueNode[] = [];
      while (!isPunct(']')) values.push(parseValue(isConst));
      next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!isPunct('}')) {
        const name = expectName().value;
        expectPunct(':');
        fields.push({ name, value: parseValue(isConst) });
      }
      next();
      return { kind: 'object', fields };
    }
    next();
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true' || t.value === 'false') return { kind: 'boolean', value: t.value === 'true' };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new QuerySyntaxError(`Unexpected ${describe(t)}.`, t.loc);
  };

  const parseArgs = (isConst: boolean): Record<string, ValueNode> => {
    const args: Record<string, ValueNode> = {};
    if (!isPunct('(')) return args;
    next();
    while (!isPunct(')')) {
      const name = expectName().value;
      expectPunct(':');
      args[name] = parseValue(isConst);
    }
    next();
    return args;
  };

  const parseDirectives = (): Directive[] => {
    const out: Directive[] = [];
    while (isPunct('@')) {
      next();
      out.push({ name: expectName().value, args: parseArgs(false) });
    }
    return out;
  };

  const parseSelectionSet = (): SelectionNode[] => {
    const open = expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!isPunct('}')) {
      if (peek().kind === 'eof') throw new QuerySyntaxError('Expected "}", found <EOF>.', peek().loc);
      if (isPunct('...')) {
        const dots = next();
        if (peek().kind === 'name' && peek().value !== 'on') {
          selections.push({ kind: 'spread', name: next().value, directives: parseDirectives(), loc: dots.loc });
        } else {
          let on: string | undefined;
          if (peek().kind === 'name' && peek().value === 'on') {
            next();
            on = expectName().value;
          }
          const directives = parseDirectives();
          selections.push({ kind: 'inline', ...(on ? { on } : {}), directives, selections: parseSelectionSet(), loc: dots.loc });
        }
        continue;
      }
      const first = expectName();
      let name = first.value;
      let alias: string | undefined;
      if (isPunct(':')) {
        next();
        alias = name;
        name = expectName().value;
      }
      const args = parseArgs(false);
      const directives = parseDirectives();
      const field: FieldNode = { kind: 'field', name, args, directives, loc: first.loc, ...(alias ? { alias } : {}) };
      if (isPunct('{')) field.selections = parseSelectionSet();
      selections.push(field);
    }
    next();
    if (!selections.length) throw new QuerySyntaxError('A selection set may not be empty.', open.loc);
    return selections;
  };

  const doc: DocumentNode = { operations: [], fragments: new Map() };
  while (peek().kind !== 'eof') {
    const t = peek();
    if (t.kind === 'punct' && t.value === '{') {
      doc.operations.push({ operation: 'query', variables: [], selections: parseSelectionSet(), loc: t.loc });
      continue;
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      next();
      const op: OperationNode = { operation: t.value, variables: [], selections: [], loc: t.loc };
      if (peek().kind === 'name') op.name = next().value;
      if (isPunct('(')) {
        next();
        while (!isPunct(')')) {
          const dollar = expectPunct('$');
          const name = expectName().value;
          expectPunct(':');
          const type = parseType();
          const def: VariableDef = { name, type, loc: dollar.loc };
          if (isPunct('=')) {
            next();
            def.defaultValue = parseValue(true);
          }
          parseDirectives();
          op.variables.push(def);
        }
        next();
      }
      parseDirectives();
      op.selections = parseSelectionSet();
      doc.operations.push(op);
      continue;
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      next();
      const name = expectName();
      const on = expectName();
      if (on.value !== 'on') throw new QuerySyntaxError(`Expected "on", found "${on.value}".`, on.loc);
      const typeName = expectName().value;
      parseDirectives();
      doc.fragments.set(name.value, { name: name.value, on: typeName, selections: parseSelectionSet(), loc: t.loc });
      continue;
    }
    if (t.kind === 'name' && t.value === 'subscription') throw new QuerySyntaxError('Subscriptions are not supported.', t.loc);
    throw new QuerySyntaxError(`Unexpected ${describe(t)}.`, t.loc);
  }
  if (!doc.operations.length) throw new QuerySyntaxError('The document has no operation.', peek().loc);
  return doc;
}

// ---- schema description ----------------------------------------------------------------------

export interface Ctx {
  [key: string]: unknown;
}

export type Resolver = (parent: any, args: Record<string, any>, ctx: any) => unknown;

export interface FieldDef {
  /** Output type: a type name, optionally wrapped as `[Name]`. Non-null markers are not used. */
  type: string;
  resolve?: Resolver;
}

export interface Schema {
  query: string;
  mutation: string;
  types: Record<string, Record<string, FieldDef>>;
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'Date', 'JSON']);

function unwrap(type: string): { name: string; list: boolean } {
  const m = /^\[(\w+)\]$/.exec(type);
  return m ? { name: m[1]!, list: true } : { name: type, list: false };
}

const typeString = (t: TypeNode): string => (t.kind === 'named' ? t.name : t.kind === 'list' ? `[${typeString(t.of)}]` : `${typeString(t.of)}!`);

// ---- execution -------------------------------------------------------------------------------

export interface Request {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export interface ExecutionResult {
  errors?: GraphQLErrorOut[];
  data?: Record<string, unknown> | null;
}

function failure(message: string, code: string, loc?: Loc): ExecutionResult {
  return { errors: [{ message, ...(loc ? { locations: [loc] } : {}), extensions: { code } }] };
}

export function execute(schema: Schema, request: Request, ctx: Ctx): ExecutionResult {
  if (typeof request.query !== 'string' || !request.query.trim()) return failure('The request carries no query document.', 'BAD_USER_INPUT');
  let doc: DocumentNode;
  try {
    doc = parse(request.query);
  } catch (error) {
    if (error instanceof QuerySyntaxError) return failure(`Syntax error: ${error.message}`, 'GRAPHQL_PARSE_FAILED', error.loc);
    throw error;
  }

  const wanted = typeof request.operationName === 'string' && request.operationName ? request.operationName : undefined;
  let op: OperationNode | undefined;
  if (wanted) op = doc.operations.find((o) => o.name === wanted);
  else if (doc.operations.length === 1) op = doc.operations[0];
  if (!op) return failure(wanted ? `No operation named "${wanted}" in the document.` : 'The document has several operations: name the one to run in operationName.', 'BAD_USER_INPUT');

  const rootType = op.operation === 'mutation' ? schema.mutation : schema.query;
  const validation = validate(schema, doc, op, rootType);
  if (validation.length) return { errors: validation };

  // Variables
  const given = request.variables && typeof request.variables === 'object' && !Array.isArray(request.variables) ? (request.variables as Record<string, unknown>) : {};
  const vars: Record<string, unknown> = {};
  for (const def of op.variables) {
    let value: unknown = Object.hasOwn(given, def.name) ? given[def.name] : undefined;
    if (value === undefined && def.defaultValue) value = literal(def.defaultValue, {});
    const problem = coerceCheck(def.type, value);
    if (problem !== null) {
      return { errors: [{ message: `Variable "$${def.name}" (${typeString(def.type)}) ${problem}`, locations: [def.loc], extensions: { code: 'BAD_USER_INPUT' } }] };
    }
    if (value !== undefined) vars[def.name] = coerce(def.type, value);
  }

  const errors: GraphQLErrorOut[] = [];
  const state = { doc, vars, errors, ctx, schema };
  const data = executeSet(state, rootType, {}, op.selections, []);
  return errors.length ? { errors, data } : { data };
}

interface ExecState {
  doc: DocumentNode;
  vars: Record<string, unknown>;
  errors: GraphQLErrorOut[];
  ctx: Ctx;
  schema: Schema;
}

function included(directives: Directive[], vars: Record<string, unknown>): boolean {
  for (const d of directives) {
    const ifArg = d.args.if ? literal(d.args.if, vars) : undefined;
    if (d.name === 'skip' && ifArg === true) return false;
    if (d.name === 'include' && ifArg !== true) return false;
  }
  return true;
}

/** Flattens fragments into the fields to resolve for one object type, keyed by response name. */
function collect(state: { doc: DocumentNode; vars: Record<string, unknown> }, typeName: string, selections: SelectionNode[], out = new Map<string, FieldNode[]>(), seen = new Set<string>()): Map<string, FieldNode[]> {
  for (const sel of selections) {
    if (!included(sel.directives, state.vars)) continue;
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      const list = out.get(key);
      if (list) list.push(sel);
      else out.set(key, [sel]);
    } else if (sel.kind === 'inline') {
      if (!sel.on || sel.on === typeName) collect(state, typeName, sel.selections, out, seen);
    } else {
      if (seen.has(sel.name)) continue;
      seen.add(sel.name);
      const frag = state.doc.fragments.get(sel.name);
      if (frag && frag.on === typeName) collect(state, typeName, frag.selections, out, seen);
    }
  }
  return out;
}

function executeSet(state: ExecState, typeName: string, parent: unknown, selections: SelectionNode[], path: (string | number)[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const fieldsDef = state.schema.types[typeName] ?? {};
  for (const [key, nodes] of collect(state, typeName, selections)) {
    const node = nodes[0]!;
    if (node.name === '__typename') {
      result[key] = typeName;
      continue;
    }
    const def = fieldsDef[node.name]!;
    const fieldPath = [...path, key];
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.args)) {
      if (value.kind === 'variable' && !Object.hasOwn(state.vars, value.name)) continue;
      args[name] = literal(value, state.vars);
    }
    let value: unknown;
    try {
      value = def.resolve ? def.resolve(parent, args, state.ctx) : (parent as Record<string, unknown> | null)?.[node.name];
      // Lazy fields are stored as functions on the parent object.
      if (typeof value === 'function') value = (value as Resolver)(args, state.ctx, undefined);
    } catch (error) {
      state.errors.push(errorOut(error, node, fieldPath));
      result[key] = null;
      continue;
    }
    const subSelections = nodes.flatMap((n) => n.selections ?? []);
    result[key] = complete(state, def.type, value, subSelections, fieldPath);
  }
  return result;
}

function complete(state: ExecState, type: string, value: unknown, selections: SelectionNode[], path: (string | number)[]): unknown {
  if (value === undefined || value === null) return null;
  const { name, list } = unwrap(type);
  if (list) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item, i) => complete(state, name, item, selections, [...path, i]));
  }
  if (SCALARS.has(name)) return value;
  return executeSet(state, name, value, selections, path);
}

function errorOut(error: unknown, node: FieldNode, path: (string | number)[]): GraphQLErrorOut {
  const app = error instanceof AppError ? error : new AppError(5000, 'Unexpected', 'Something went wrong while answering this field.');
  if (!(error instanceof AppError)) process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`);
  const stack = `${app.slug} ${app.code}: ${app.message}\n    at ${path.filter((p) => typeof p === 'string').join('.')} (pagegrove resolver)`;
  return {
    message: app.message,
    locations: [node.loc],
    path,
    extensions: { code: app.kind, exception: { code: app.code, message: app.message, stack, stacktrace: stack.split('\n') } },
  };
}

// ---- values ----------------------------------------------------------------------------------

function literal(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name] ?? null;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => literal(v, vars));
    case 'object':
      return Object.fromEntries(node.fields.map((f) => [f.name, literal(f.value, vars)]));
    default:
      return node.value;
  }
}

/** Returns null when the value fits the declared variable type, else a sentence saying why not. */
function coerceCheck(type: TypeNode, value: unknown): string | null {
  if (type.kind === 'nonNull') {
    if (value === undefined || value === null) return value === undefined ? 'was not provided.' : 'must not be null.';
    return coerceCheck(type.of, value);
  }
  if (value === undefined || value === null) return null;
  if (type.kind === 'list') {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const p = coerceCheck(type.of, item);
      if (p) return p;
    }
    return null;
  }
  switch (type.name) {
    case 'Int':
      return Number.isInteger(value) && Math.abs(value as number) <= 2147483647 ? null : `expects a whole number, got ${JSON.stringify(value)}.`;
    case 'Float':
      return typeof value === 'number' && Number.isFinite(value) ? null : `expects a number, got ${JSON.stringify(value)}.`;
    case 'Boolean':
      return typeof value === 'boolean' ? null : `expects true or false, got ${JSON.stringify(value)}.`;
    case 'ID':
      return typeof value === 'string' || Number.isInteger(value) ? null : `expects an id, got ${JSON.stringify(value)}.`;
    case 'String':
    case 'Date':
      return typeof value === 'string' ? null : `expects text, got ${JSON.stringify(value)}.`;
    default:
      // Enums and input objects are passed through as given.
      return null;
  }
}

function coerce(type: TypeNode, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (type.kind === 'nonNull') return coerce(type.of, value);
  if (type.kind === 'list') return (Array.isArray(value) ? value : [value]).map((v) => coerce(type.of, v));
  if (type.name === 'ID') return String(value);
  return value;
}

// ---- validation ------------------------------------------------------------------------------

function validate(schema: Schema, doc: DocumentNode, op: OperationNode, rootType: string): GraphQLErrorOut[] {
  const errors: GraphQLErrorOut[] = [];
  const defined = new Set(op.variables.map((v) => v.name));
  const add = (message: string, loc: Loc) => errors.push({ message, locations: [loc], extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } });
  const checkValue = (v: ValueNode) => {
    if (v.kind === 'variable' && !defined.has(v.name)) add(`Variable "$${v.name}" is not defined by the operation.`, v.loc);
    if (v.kind === 'list') v.values.forEach(checkValue);
    if (v.kind === 'object') v.fields.forEach((f) => checkValue(f.value));
  };
  const visit = (typeName: string, selections: SelectionNode[], stack: Set<string>) => {
    for (const sel of selections) {
      sel.directives.forEach((d) => Object.values(d.args).forEach(checkValue));
      if (sel.kind === 'inline') {
        if (sel.on && !schema.types[sel.on]) add(`Unknown type "${sel.on}".`, sel.loc);
        visit(sel.on ?? typeName, sel.selections, stack);
        continue;
      }
      if (sel.kind === 'spread') {
        const frag = doc.fragments.get(sel.name);
        if (!frag) add(`Unknown fragment "${sel.name}".`, sel.loc);
        else if (stack.has(sel.name)) add(`Fragment "${sel.name}" spreads itself.`, sel.loc);
        else visit(frag.on, frag.selections, new Set([...stack, sel.name]));
        continue;
      }
      Object.values(sel.args).forEach(checkValue);
      if (sel.name === '__typename') {
        if (sel.selections) add('Field "__typename" is a scalar and takes no selection.', sel.loc);
        continue;
      }
      const def = schema.types[typeName]?.[sel.name];
      if (!def) {
        add(`Type "${typeName}" has no field "${sel.name}".`, sel.loc);
        continue;
      }
      const { name } = unwrap(def.type);
      if (SCALARS.has(name)) {
        if (sel.selections) add(`Field "${sel.name}" holds a ${name} and takes no selection.`, sel.loc);
      } else if (!sel.selections) add(`Field "${sel.name}" of type "${name}" needs a selection of subfields.`, sel.loc);
      else visit(name, sel.selections, stack);
    }
  };
  visit(rootType, op.selections, new Set());
  return errors;
}
