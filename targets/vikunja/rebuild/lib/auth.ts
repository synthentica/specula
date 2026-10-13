// Passwords (scrypt), HS256 JWTs, refresh-token sessions and the refresh cookie.

import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { metaGet, metaSet, nowIso, one, run } from './db.ts';
import { ErrorCode, HttpError } from './http.ts';

export const DEFAULT_ACCESS_TOKEN_SECONDS = 600;
let accessTokenSeconds = DEFAULT_ACCESS_TOKEN_SECONDS;

/** Lifetime of a normal access token in seconds (ACCESS_TOKEN_TTL at start-up). */
export function accessTokenTtl(): number {
  return accessTokenSeconds;
}

export function setAccessTokenTtl(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('The access-token lifetime must be a positive whole number of seconds.');
  accessTokenSeconds = seconds;
}
export const LONG_TOKEN_SECONDS = 30 * 24 * 3600;
export const REFRESH_SECONDS = 259200; // 3 days
export const REFRESH_COOKIE = 'app_refresh_token';
export const REFRESH_PATH = '/api/v2/user/token/refresh';

let secret: Buffer;

export function initSecret(): void {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    secret = Buffer.from(fromEnv, 'utf8');
    return;
  }
  let stored = metaGet('jwt_secret');
  if (!stored) {
    stored = randomBytes(32).toString('base64url');
    metaSet('jwt_secret', stored);
  }
  secret = Buffer.from(stored, 'base64url');
}

// ---- passwords ------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length);
  return timingSafeEqual(expected, actual);
}

// ---- JWT ------------------------------------------------------------------------------

export interface Claims {
  exp: number;
  iat: number;
  id: number;
  is_admin: boolean;
  jti: string;
  sid: string;
  type: number;
  username: string;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function signToken(user: { id: number; username: string }, sid: string, lifetime: number): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: Claims = { exp: iat + lifetime, iat, id: user.id, is_admin: false, jti: randomUUID(), sid, type: 1, username: user.username };
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

export function verifyToken(token: string): Claims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [h, p, s] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return undefined;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Claims;
    if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return undefined;
    if (typeof claims.id !== 'number' || typeof claims.sid !== 'string') return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

// ---- sessions -------------------------------------------------------------------------

export interface UserRow {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  name: string;
  language: string;
  timezone: string;
  week_start: number;
  default_project_id: number;
  created: string;
  updated: string;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Starts a session; returns its id and the raw refresh token for the cookie. */
export function createSession(userId: number, longLived: boolean): { sid: string; refresh: string } {
  const sid = randomUUID();
  const refresh = randomBytes(32).toString('base64url');
  const now = nowIso();
  run('INSERT INTO sessions (id, user_id, refresh_hash, long_lived, created, last_refreshed) VALUES (?, ?, ?, ?, ?, ?)', sid, userId, sha256(refresh), longLived, now, now);
  return { sid, refresh };
}

/** Exchanges a refresh token for a new one (rotation). */
export function rotateSession(refresh: string): { sid: string; refresh: string; userId: number; longLived: boolean } | undefined {
  const row = one<{ id: string; user_id: number; long_lived: number; last_refreshed: string }>('SELECT id, user_id, long_lived, last_refreshed FROM sessions WHERE refresh_hash = ?', sha256(refresh));
  if (!row) return undefined;
  if (Date.parse(row.last_refreshed) + REFRESH_SECONDS * 1000 < Date.now()) {
    run('DELETE FROM sessions WHERE id = ?', row.id);
    return undefined;
  }
  const next = randomBytes(32).toString('base64url');
  run('UPDATE sessions SET refresh_hash = ?, last_refreshed = ? WHERE id = ?', sha256(next), nowIso(), row.id);
  return { sid: row.id, refresh: next, userId: row.user_id, longLived: row.long_lived === 1 };
}

export function endSession(sid: string): void {
  run('DELETE FROM sessions WHERE id = ?', sid);
}

export function refreshCookie(value: string, maxAge: number): string {
  return `${REFRESH_COOKIE}=${value}; Path=${REFRESH_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

/** Resolves the bearer token of a request to a user and session, or throws 401. */
export function authenticate(req: IncomingMessage): { user: UserRow; claims: Claims } {
  const header = req.headers.authorization ?? '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new HttpError(401, 'Please sign in: this request needs a bearer token.', ErrorCode.TokenInvalid);
  const claims = verifyToken(m[1]!.trim());
  if (!claims) throw new HttpError(401, 'Your access token is invalid or has expired. Refresh it or sign in again.', ErrorCode.TokenInvalid);
  const session = one<{ id: string }>('SELECT id FROM sessions WHERE id = ? AND user_id = ?', claims.sid, claims.id);
  if (!session) throw new HttpError(401, 'This session has ended. Please sign in again.', ErrorCode.TokenInvalid);
  const user = one<UserRow>('SELECT * FROM users WHERE id = ?', claims.id);
  if (!user) throw new HttpError(401, 'The account behind this token no longer exists.', ErrorCode.TokenInvalid);
  return { user, claims };
}

/** Token check for the realtime channel. */
export function userForToken(token: string): UserRow | undefined {
  const claims = verifyToken(token);
  if (!claims) return undefined;
  if (!one('SELECT id FROM sessions WHERE id = ?', claims.sid)) return undefined;
  return one<UserRow>('SELECT * FROM users WHERE id = ?', claims.id);
}

// ---- simple fixed-window rate limit for credential endpoints ---------------------------

const LIMIT = 10;
const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; count: number }>();

export function rateLimit(key: string): { limit: number; remaining: number; reset: number; allowed: boolean } {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 };
    windows.set(key, w);
  }
  w.count++;
  return { limit: LIMIT, remaining: Math.max(0, LIMIT - w.count), reset: Math.ceil((w.start + WINDOW_MS) / 1000), allowed: w.count <= LIMIT };
}
