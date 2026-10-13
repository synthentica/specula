// JSON Patch (RFC 6902) applied to a plain JSON document. Returns a new document.

import { fail, isObject } from './http.ts';

type Json = unknown;

function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) fail(400, `Invalid JSON Pointer "${pointer}".`);
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getAt(doc: Json, path: string[]): Json {
  let node = doc;
  for (const key of path) {
    if (Array.isArray(node)) node = node[key === '-' ? node.length : Number(key)];
    else if (isObject(node)) node = node[key];
    else return undefined;
  }
  return node;
}

function parentOf(doc: Json, path: string[]): { parent: Record<string, Json> | Json[]; key: string } {
  if (!path.length) fail(400, 'A patch operation cannot target the whole document here.');
  const parent = getAt(doc, path.slice(0, -1));
  if (!Array.isArray(parent) && !isObject(parent)) fail(400, `The path "/${path.join('/')}" does not exist.`);
  return { parent, key: path[path.length - 1]! };
}

function add(doc: Json, path: string[], value: Json): void {
  const { parent, key } = parentOf(doc, path);
  if (Array.isArray(parent)) {
    const i = key === '-' ? parent.length : Number(key);
    if (!Number.isInteger(i) || i < 0 || i > parent.length) fail(400, `Invalid array index "${key}".`);
    parent.splice(i, 0, value);
  } else parent[key] = value;
}

function remove(doc: Json, path: string[]): Json {
  const { parent, key } = parentOf(doc, path);
  if (Array.isArray(parent)) {
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) fail(400, `Invalid array index "${key}".`);
    return parent.splice(i, 1)[0];
  }
  if (!(key in parent)) fail(400, `The path "/${path.join('/')}" does not exist.`);
  const old = parent[key];
  delete parent[key];
  return old;
}

export function applyPatch(document: Record<string, Json>, ops: Json[]): Record<string, Json> {
  const doc = structuredClone(document);
  for (const raw of ops) {
    if (!isObject(raw) || typeof raw.op !== 'string' || typeof raw.path !== 'string') fail(400, 'Each patch operation needs "op" and "path".');
    const path = parsePointer(raw.path);
    switch (raw.op) {
      case 'add':
        if (!('value' in raw)) fail(400, '"add" needs a value.');
        add(doc, path, structuredClone(raw.value));
        break;
      case 'replace':
        if (!('value' in raw)) fail(400, '"replace" needs a value.');
        remove(doc, path);
        add(doc, path, structuredClone(raw.value));
        break;
      case 'remove':
        remove(doc, path);
        break;
      case 'move':
      case 'copy': {
        if (typeof raw.from !== 'string') fail(400, `"${raw.op}" needs "from".`);
        const from = parsePointer(raw.from);
        const value = raw.op === 'move' ? remove(doc, from) : structuredClone(getAt(doc, from));
        add(doc, path, value);
        break;
      }
      case 'test':
        if (JSON.stringify(getAt(doc, path)) !== JSON.stringify(raw.value)) fail(409, `Patch test failed at "${raw.path}".`);
        break;
      default:
        fail(400, `Unknown patch operation "${raw.op}".`);
    }
  }
  return doc;
}
