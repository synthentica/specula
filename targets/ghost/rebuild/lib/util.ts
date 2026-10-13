// Small shared helpers: ids, timestamps, slugs, API errors, pagination.

import { randomBytes, randomUUID } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = Record<string, unknown>;

export const PRODUCT = 'Pressloft';
export const VERSION = '1.4.2';

/** 24-character lowercase hex record id: 8 hex digits of the creation second, then 16 random ones, so ids sort by age. */
export function newId(): string {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0').slice(-8) + randomBytes(8).toString('hex');
}

export function newUuid(): string {
  return randomUUID();
}

/** ISO 8601 UTC with whole seconds, e.g. 2026-10-11T11:21:39.000Z. */
export function nowIso(offsetMs = 0): string {
  return new Date(Math.floor((Date.now() + offsetMs) / 1000) * 1000).toISOString();
}

export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 185);
  return slug || 'untitled';
}

/** Returns `base` or `base-2`, `base-3`… whichever is not in `taken`. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface ApiErrorExtras {
  property?: string | null;
  help?: string | null;
  code?: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly context: string | null;
  readonly property: string | null;
  readonly help: string | null;
  readonly code: string | null;
  constructor(status: number, type: string, message: string, context: string | null = null, extras: ApiErrorExtras = {}) {
    super(message);
    this.status = status;
    this.type = type;
    this.context = context;
    this.property = extras.property ?? null;
    this.help = extras.help ?? null;
    this.code = extras.code ?? null;
  }
}

export const noPermission = () =>
  new ApiError(403, 'NoPermissionError', 'You are not signed in.', 'No valid session was found for this request. Sign in again to continue.');
export const notFound = (what: string) => new ApiError(404, 'NotFoundError', `${what} not found.`, `The requested ${what.toLowerCase()} does not exist.`);
export const invalid = (message: string, context: string | null = null, extras: ApiErrorExtras = {}) =>
  new ApiError(422, 'ValidationError', message, context, extras);

export function errorBody(error: ApiError): Obj {
  return {
    errors: [
      {
        message: error.message,
        context: error.context,
        type: error.type,
        details: null,
        property: error.property,
        help: error.help,
        code: error.code,
        id: newUuid(),
        appErrorCode: null,
      },
    ],
  };
}

export interface Pagination {
  page: number;
  limit: number | 'all';
  pages: number;
  total: number;
  next: number | null;
  prev: number | null;
}

/** Slices `items` by `limit` / `page` query values and returns the page plus `meta.pagination`. */
export function paginate<T>(items: T[], query: URLSearchParams, defaultLimit = 15): { items: T[]; pagination: Pagination } {
  const rawLimit = query.get('limit');
  const total = items.length;
  if (rawLimit === 'all') return { items, pagination: { page: 1, limit: 'all', pages: 1, total, next: null, prev: null } };
  const limit = Math.max(1, Number.parseInt(rawLimit ?? '', 10) || defaultLimit);
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '', 10) || 1);
  const pages = Math.max(1, Math.ceil(total / limit));
  return {
    items: items.slice((page - 1) * limit, page * limit),
    pagination: { page, limit, pages, total, next: page < pages ? page + 1 : null, prev: page > 1 ? page - 1 : null },
  };
}

export function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Reads `{ <name>: [ {...} ] }` and returns the first record, or throws a validation error. */
export function firstRecord(body: unknown, name: string): Obj {
  const list = isObj(body) ? body[name] : undefined;
  const record = Array.isArray(list) ? list[0] : undefined;
  if (!isObj(record)) throw invalid(`Expected a "${name}" list with one record.`);
  return record;
}
