// Minimal GraphQL document reader (no dependency): enough to name anonymous operations by the
// fields they select and to know which field argument each variable feeds.

export interface GraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string | null;
}

export interface GraphqlArgument {
  variable: string;
  argument: string;
  /** Field names from the root down to the field that takes the argument. */
  field: string[];
}

export interface GraphqlOperation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  /** Root fields, each followed by its only child when the root is a bare namespace (`pages.single`). */
  fields: string[];
  args: GraphqlArgument[];
}

/** The GraphQL requests in a JSON body: one object, or an array when the client batches. */
export function graphqlRequests(body: unknown): GraphqlRequest[] | undefined {
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || !items.every((i) => i && typeof i === 'object' && typeof (i as GraphqlRequest).query === 'string')) return undefined;
  return items as GraphqlRequest[];
}

/** Stable operation key: the client's operation name, else `<type> <fields>` (`mutation pages.create`). */
export function operationKey(request: GraphqlRequest, op = parseOperation(request.query)): string {
  if (typeof request.operationName === 'string' && request.operationName) return request.operationName;
  if (op?.name) return op.name;
  return op ? `${op.type} ${op.fields.join(' + ') || '(empty)'}` : 'unparsed';
}

/** Whitespace-normalized document text, for listing the documents an operation was sent with. */
export function normalizeDocument(query: string): string {
  return tokenize(query)
    .map((t) => t.text)
    .join(' ')
    .replace(/ ?([{}():\[\]=@]) ?/g, '$1')
    .replace(/ !/g, '!')
    .replace(/\$ /g, '$');
}

interface Token {
  kind: 'punct' | 'name' | 'string' | 'number';
  text: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/[\s,﻿]/.test(c)) {
      i++;
    } else if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', text: '...' });
      i += 3;
    } else if ('{}():$!=@[]|&'.includes(c)) {
      tokens.push({ kind: 'punct', text: c });
      i++;
    } else if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const stop = end < 0 ? source.length : end + 3;
      tokens.push({ kind: 'string', text: source.slice(i, stop) });
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      tokens.push({ kind: 'string', text: source.slice(i, j + 1) });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)!;
      tokens.push({ kind: 'name', text: m[0] });
      i += m[0].length;
    } else if (/[-0-9]/.test(c)) {
      const m = source.slice(i).match(/^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?/);
      const text = m?.[0] || c;
      tokens.push({ kind: 'number', text });
      i += text.length;
    } else {
      i++; // unknown character: skip
    }
  }
  return tokens;
}

interface Field {
  name: string;
  hasArgs: boolean;
  children: Field[];
}

/** Reads the first operation of a document. Returns undefined for a document it cannot follow. */
export function parseOperation(query: string): GraphqlOperation | undefined {
  const tokens = tokenize(query);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const args: GraphqlArgument[] = [];

  const skipBalanced = (open: string, close: string) => {
    let depth = 0;
    do {
      const t = next();
      if (!t) return;
      if (t.text === open) depth++;
      else if (t.text === close) depth--;
    } while (depth > 0);
  };

  // A value inside arguments; records every $variable it contains for the given argument.
  const readValue = (argument: string, field: string[]) => {
    const t = next();
    if (!t) return;
    if (t.text === '$') {
      const name = next();
      if (name) args.push({ variable: name.text, argument, field });
    } else if (t.text === '[') {
      while (peek() && peek()!.text !== ']') readValue(argument, field);
      next();
    } else if (t.text === '{') {
      while (peek() && peek()!.text !== '}') {
        const key = next();
        if (peek()?.text === ':') next();
        readValue(key?.text ?? argument, field);
      }
      next();
    }
  };

  const readArguments = (field: string[]) => {
    next(); // (
    while (peek() && peek()!.text !== ')') {
      const name = next();
      if (peek()?.text === ':') next();
      readValue(name?.text ?? '', field);
    }
    next(); // )
  };

  const skipDirectives = () => {
    while (peek()?.text === '@') {
      next();
      next();
      if (peek()?.text === '(') skipBalanced('(', ')');
    }
  };

  const readSelection = (path: string[]): Field[] => {
    const fields: Field[] = [];
    next(); // {
    while (peek() && peek()!.text !== '}') {
      if (peek()!.text === '...') {
        next();
        if (peek()?.text === 'on') {
          next();
          next();
        } else if (peek()?.kind === 'name') {
          next(); // named fragment spread: its fields are not followed
        }
        skipDirectives();
        if (peek()?.text === '{') fields.push(...readSelection(path));
        continue;
      }
      let name = next()!.text;
      if (peek()?.text === ':') {
        next();
        name = next()!.text; // alias: keep the schema field name
      }
      const field: Field = { name, hasArgs: false, children: [] };
      if (peek()?.text === '(') {
        field.hasArgs = true;
        readArguments([...path, name]);
      }
      skipDirectives();
      if (peek()?.text === '{') field.children = readSelection([...path, name]);
      fields.push(field);
    }
    next(); // }
    return fields;
  };

  let type: GraphqlOperation['type'] = 'query';
  let name: string | undefined;
  const first = peek();
  if (!first) return undefined;
  if (first.kind === 'name' && ['query', 'mutation', 'subscription'].includes(first.text)) {
    type = next()!.text as GraphqlOperation['type'];
    if (peek()?.kind === 'name') name = next()!.text;
    if (peek()?.text === '(') skipBalanced('(', ')');
    skipDirectives();
  }
  if (peek()?.text !== '{') return undefined;
  const root = readSelection([]);
  const own = (fs: Field[]) => fs.filter((f) => f.name !== '__typename');
  const fields = own(root).map((f) => {
    const children = own(f.children);
    return !f.hasArgs && children.length === 1 ? `${f.name}.${children[0]!.name}` : f.name;
  });
  return { type, ...(name ? { name } : {}), fields, args };
}

/** `query pages.list + mutation pages.create` for a GraphQL request body, else undefined. */
export function graphqlLabel(bodyText: string | undefined): string | undefined {
  if (!bodyText || !/"query"\s*:/.test(bodyText)) return undefined;
  try {
    const requests = graphqlRequests(JSON.parse(bodyText));
    return requests?.map((r) => operationKey(r)).join(' + ');
  } catch {
    return undefined;
  }
}
