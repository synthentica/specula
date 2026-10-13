// Small HTTP helpers: JSON responses, errors, body parsing, CORS.

import { randomBytes } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * Numeric error codes in problem+json bodies. The first group is what clients rely on (spec section 5.1);
 * every other error uses GENERIC_CODE_BASE + the HTTP status (for example 9404).
 */
export const ErrorCode = {
  TokenInvalid: 11,
  UsernameTaken: 1001,
  WrongCredentials: 1011,
  TaskNotFound: 4002,
  FilterValueInvalid: 4019,
} as const;
export const GENERIC_CODE_BASE = 9000;

export class HttpError extends Error {
  status: number;
  code: number;
  constructor(status: number, message: string, code: number = GENERIC_CODE_BASE + status) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fail(status: number, message: string, code?: number): never {
  throw new HttpError(status, message, code);
}

export function requestId(): string {
  return randomBytes(16).toString('hex');
}

export function originOf(req: IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Ratelimit-Limit, X-Ratelimit-Remaining, X-Ratelimit-Reset');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** An RFC 9457 problem document: { $schema, title, status, detail, code }. */
export function sendProblem(res: ServerResponse, origin: string, error: HttpError): void {
  const body = {
    $schema: `${origin}/api/v2/schemas/Problem.json`,
    title: STATUS_CODES[error.status] ?? 'Error',
    status: error.status,
    detail: error.message,
    code: error.code,
  };
  const text = JSON.stringify(body);
  res.writeHead(error.status, { 'Content-Type': 'application/problem+json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

export function sendText(res: ServerResponse, status: number, contentType: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

const MAX_BODY = 1024 * 1024;

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) fail(413, 'The request body is too large.');
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === '' || type.endsWith('json')) {
    try {
      return JSON.parse(text);
    } catch {
      fail(400, 'The request body is not valid JSON.');
    }
  }
  fail(415, 'Only JSON request bodies are accepted.');
}

/** Parses a Cookie header into a map. */
export function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return out;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
