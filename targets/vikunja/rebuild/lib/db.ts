// SQLite storage (node:sqlite). All timestamps are stored as RFC 3339 UTC strings with second precision;
// "no date" is stored as the zero time 0001-01-01T00:00:00Z.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export const ZERO_TIME = '0001-01-01T00:00:00Z';

export type Param = SQLInputValue | boolean | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'GMT',
  week_start INTEGER NOT NULL DEFAULT 0,
  default_project_id INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL,
  long_lived INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  last_refreshed TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_refresh ON sessions(refresh_hash);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  identifier TEXT NOT NULL DEFAULT '',
  hex_color TEXT NOT NULL DEFAULT '',
  parent_project_id INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  filter TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
-- project_id is negative for the views of a saved filter: -(filter id + 1).
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  view_kind TEXT NOT NULL,
  filter TEXT,
  position INTEGER NOT NULL,
  bucket_configuration_mode TEXT NOT NULL DEFAULT 'none',
  default_bucket_id INTEGER NOT NULL DEFAULT 0,
  done_bucket_id INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS views_project ON views(project_id);
CREATE TABLE IF NOT EXISTS buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_view_id INTEGER NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  "limit" INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL,
  created_by INTEGER NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT NOT NULL DEFAULT '${ZERO_TIME}',
  due_date TEXT NOT NULL DEFAULT '${ZERO_TIME}',
  start_date TEXT NOT NULL DEFAULT '${ZERO_TIME}',
  end_date TEXT NOT NULL DEFAULT '${ZERO_TIME}',
  priority INTEGER NOT NULL DEFAULT 0,
  percent_done REAL NOT NULL DEFAULT 0,
  hex_color TEXT NOT NULL DEFAULT '',
  repeat_after INTEGER NOT NULL DEFAULT 0,
  repeat_mode INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  cover_image_attachment_id INTEGER NOT NULL DEFAULT 0,
  "index" INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
CREATE TABLE IF NOT EXISTS task_positions (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_view_id INTEGER NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  PRIMARY KEY (task_id, project_view_id)
);
CREATE TABLE IF NOT EXISTS task_buckets (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_view_id INTEGER NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  bucket_id INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, project_view_id)
);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  hex_color TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS label_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created TEXT NOT NULL,
  UNIQUE (label_id, task_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  comment TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created TEXT NOT NULL
);
`;

let db: DatabaseSync;

export function openDb(path: string): void {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
}

export function closeDb(): void {
  db?.close();
}

function bind(params: Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function one<T>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...bind(params)) as T | undefined;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...bind(params)) as T[];
}

export function run(sql: string, ...params: Param[]): number {
  return Number(db.prepare(sql).run(...bind(params)).lastInsertRowid);
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Current time, RFC 3339 UTC with second precision. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Normalizes a client date value: empty / zero / null → zero time; invalid → undefined. */
export function normalizeDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return ZERO_TIME;
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('0001-01-01')) return ZERO_TIME;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
}

export function metaGet(key: string): string | undefined {
  return one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
}

export function metaSet(key: string, value: string): void {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
