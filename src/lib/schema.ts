// JSON Schema inference by merging observed samples.
// Samples are folded into a Shape (with counts), then rendered as JSON Schema 2020-12
// (the dialect OpenAPI 3.1 uses).

import { isIdValue } from './paths.ts';

export interface Shape {
  count: number;
  nulls: number;
  boolean?: number;
  integer?: { count: number; values: Map<number, number> };
  number?: { count: number };
  string?: { count: number; formats: Map<string, number>; values: Map<string, number> };
  object?: { count: number; props: Map<string, Shape>; keyCounts: Map<string, number> };
  array?: { count: number; items: Shape; maxLength: number };
}

export type JsonSchema = Record<string, unknown>;

const MAX_TRACKED_VALUES = 12;

export function emptyShape(): Shape {
  return { count: 0, nulls: 0 };
}

export function stringFormat(value: string): string | undefined {
  const redacted = value.match(/^<redacted:(\w+)(?::\w+)?>$/);
  if (redacted) return `redacted-${redacted[1]}`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return 'date-time';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return 'uuid';
  if (/^https?:\/\/\S+$/.test(value)) return 'uri';
  return undefined;
}

function track<K>(map: Map<K, number>, key: K): void {
  if (map.has(key) || map.size < MAX_TRACKED_VALUES) map.set(key, (map.get(key) ?? 0) + 1);
}

/** Folds one sample into the shape (mutates and returns it). */
export function addSample(shape: Shape, value: unknown): Shape {
  shape.count++;
  if (value === null || value === undefined) {
    shape.nulls++;
  } else if (typeof value === 'boolean') {
    shape.boolean = (shape.boolean ?? 0) + 1;
  } else if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      shape.integer ??= { count: 0, values: new Map() };
      shape.integer.count++;
      track(shape.integer.values, value);
    } else {
      shape.number ??= { count: 0 };
      shape.number.count++;
    }
  } else if (typeof value === 'string') {
    shape.string ??= { count: 0, formats: new Map(), values: new Map() };
    shape.string.count++;
    track(shape.string.formats, stringFormat(value) ?? '');
    if (value.length <= 40) track(shape.string.values, value);
  } else if (Array.isArray(value)) {
    shape.array ??= { count: 0, items: emptyShape(), maxLength: 0 };
    shape.array.count++;
    shape.array.maxLength = Math.max(shape.array.maxLength, value.length);
    for (const item of value) addSample(shape.array.items, item);
  } else if (typeof value === 'object') {
    shape.object ??= { count: 0, props: new Map(), keyCounts: new Map() };
    shape.object.count++;
    for (const [key, child] of Object.entries(value)) {
      shape.object.keyCounts.set(key, (shape.object.keyCounts.get(key) ?? 0) + 1);
      let prop = shape.object.props.get(key);
      if (!prop) shape.object.props.set(key, (prop = emptyShape()));
      addSample(prop, child);
    }
  }
  return shape;
}

/** Merges shape b into shape a (mutates a). */
export function mergeShapes(a: Shape, b: Shape): Shape {
  a.count += b.count;
  a.nulls += b.nulls;
  if (b.boolean) a.boolean = (a.boolean ?? 0) + b.boolean;
  if (b.integer) {
    a.integer ??= { count: 0, values: new Map() };
    a.integer.count += b.integer.count;
    for (const [v, n] of b.integer.values) if (a.integer.values.has(v) || a.integer.values.size < MAX_TRACKED_VALUES) a.integer.values.set(v, (a.integer.values.get(v) ?? 0) + n);
  }
  if (b.number) a.number = { count: (a.number?.count ?? 0) + b.number.count };
  if (b.string) {
    a.string ??= { count: 0, formats: new Map(), values: new Map() };
    a.string.count += b.string.count;
    for (const [f, n] of b.string.formats) a.string.formats.set(f, (a.string.formats.get(f) ?? 0) + n);
    for (const [v, n] of b.string.values) if (a.string.values.has(v) || a.string.values.size < MAX_TRACKED_VALUES) a.string.values.set(v, (a.string.values.get(v) ?? 0) + n);
  }
  if (b.array) {
    a.array ??= { count: 0, items: emptyShape(), maxLength: 0 };
    a.array.count += b.array.count;
    a.array.maxLength = Math.max(a.array.maxLength, b.array.maxLength);
    mergeShapes(a.array.items, b.array.items);
  }
  if (b.object) {
    a.object ??= { count: 0, props: new Map(), keyCounts: new Map() };
    a.object.count += b.object.count;
    for (const [key, n] of b.object.keyCounts) a.object.keyCounts.set(key, (a.object.keyCounts.get(key) ?? 0) + n);
    for (const [key, prop] of b.object.props) {
      const existing = a.object.props.get(key);
      if (existing) mergeShapes(existing, prop);
      else a.object.props.set(key, cloneShape(prop));
    }
  }
  return a;
}

export function cloneShape(shape: Shape): Shape {
  return mergeShapes(emptyShape(), shape);
}

export function objectKeys(shape: Shape): Set<string> {
  return new Set(shape.object?.props.keys() ?? []);
}

/** Jaccard similarity of two object shapes' key sets. */
export function keySimilarity(a: Shape, b: Shape): number {
  const ka = objectKeys(a);
  const kb = objectKeys(b);
  if (!ka.size || !kb.size) return 0;
  let shared = 0;
  for (const k of ka) if (kb.has(k)) shared++;
  return shared / (ka.size + kb.size - shared);
}

/** True for objects keyed by record ids rather than by field names. */
export function isIdMap(shape: Shape): boolean {
  const keys = [...(shape.object?.props.keys() ?? [])];
  return keys.length > 0 && keys.every((k) => isIdValue(k));
}

export interface RenderOptions {
  /** Returns a $ref for nested object shapes that match a named component, if any. */
  refFor?: (shape: Shape) => string | undefined;
  /** Keys whose observed values are volatile (ids, timestamps): no examples/observed values. */
  volatileKeys?: Set<string>;
}

/** Renders a shape as JSON Schema 2020-12. */
export function toSchema(shape: Shape, options: RenderOptions = {}, key?: string, depth = 0): JsonSchema {
  const variants: JsonSchema[] = [];
  const volatile = key !== undefined && options.volatileKeys?.has(key);
  if (shape.object) {
    const ref = depth > 0 ? options.refFor?.(shape) : undefined;
    if (ref) variants.push({ $ref: ref });
    else if (isIdMap(shape)) {
      // Keys are record ids ({ "<id>": {...} }): one value schema for all of them.
      const values = emptyShape();
      for (const prop of shape.object.props.values()) mergeShapes(values, prop);
      variants.push({ type: 'object', 'x-keys': 'record-id', additionalProperties: toSchema(values, options, undefined, depth + 1) });
    } else {
      const o = shape.object;
      const properties: Record<string, JsonSchema> = {};
      for (const [k, prop] of [...o.props.entries()].sort(([x], [y]) => x.localeCompare(y))) properties[k] = toSchema(prop, options, k, depth + 1);
      const required = [...o.keyCounts.entries()].filter(([, n]) => n === o.count).map(([k]) => k).sort();
      variants.push({ type: 'object', properties, ...(required.length ? { required } : {}) });
    }
  }
  if (shape.array) {
    const items = shape.array.items.count ? toSchema(shape.array.items, options, undefined, depth + 1) : {};
    variants.push({ type: 'array', items });
  }
  if (shape.string) {
    const s: JsonSchema = { type: 'string' };
    const formats = [...shape.string.formats.keys()];
    if (formats.length === 1 && formats[0]) {
      const format = formats[0];
      if (format.startsWith('redacted-')) s['x-redacted'] = format.slice(9);
      else s.format = format;
    }
    if (!volatile && !formats.some((f) => f.startsWith('redacted-')) && formats[0] !== 'date-time') {
      const values = [...shape.string.values.keys()];
      if (values.length && values.length <= 5 && shape.string.values.size < MAX_TRACKED_VALUES) s['x-observed-values'] = values;
      else if (values.length) s.examples = values.slice(0, 2);
    }
    variants.push(s);
  }
  if (shape.integer) {
    const s: JsonSchema = { type: 'integer' };
    const values = [...shape.integer.values.keys()].sort((x, y) => x - y);
    if (!volatile && values.length <= 6 && shape.integer.values.size < MAX_TRACKED_VALUES) s['x-observed-values'] = values;
    variants.push(s);
  }
  if (shape.number) variants.push({ type: 'number' });
  if (shape.boolean) variants.push({ type: 'boolean' });

  const nullable = shape.nulls > 0;
  if (!variants.length) return nullable ? { type: 'null' } : {};
  // integer + number collapse to number.
  if (variants.some((v) => v.type === 'number')) {
    const i = variants.findIndex((v) => v.type === 'integer');
    if (i >= 0) variants.splice(i, 1);
  }
  if (variants.length === 1) {
    const only = variants[0]!;
    if (!nullable) return only;
    if (only.$ref) return { anyOf: [only, { type: 'null' }] };
    return { ...only, type: [only.type, 'null'] };
  }
  return { anyOf: [...variants, ...(nullable ? [{ type: 'null' }] : [])] };
}
