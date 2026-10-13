// Passwords (scrypt with a per-user salt) and opaque session tokens.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, KEY_LENGTH).toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A random session token: 32 bytes, URL-safe. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}
