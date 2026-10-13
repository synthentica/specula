// Passwords (scrypt) and access tokens (HS256 JWT) for Pagegrove.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltText, keyText] = stored.split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64url');
  const actual = scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface TokenClaims {
  /** User id. */
  id: number;
  email: string;
  name: string;
  /** Group ids. */
  grp: number[];
  iat: number;
  exp: number;
  iss: string;
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export function signToken(claims: Omit<TokenClaims, 'iat' | 'exp' | 'iss'>, secret: string, lifetimeSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ ...claims, iat: now, exp: now + lifetimeSeconds, iss: 'pagegrove' }));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The claims of a valid, unexpired token signed with `secret`, else undefined. */
export function readToken(token: string, secret: string): TokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string };
    if (head.alg !== 'HS256') return undefined;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
    if (typeof claims.id !== 'number' || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
