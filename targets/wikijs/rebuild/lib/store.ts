// Pagegrove's storage on node:sqlite (DatabaseSync): users, groups, pages with their tags, page
// versions and comments. Ids are integers per table, starting at 1 and never reused.

import { DatabaseSync } from 'node:sqlite';

export interface UserRow {
  id: number;
  email: string;
  name: string;
  providerKey: string;
  passwordHash: string;
  isSystem: number;
  isActive: number;
  isVerified: number;
  mustChangePwd: number;
  location: string;
  jobTitle: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface GroupRow {
  id: number;
  name: string;
  isSystem: number;
  createdAt: string;
  updatedAt: string;
}

export interface PageRow {
  id: number;
  locale: string;
  path: string;
  title: string;
  description: string;
  content: string;
  contentType: string;
  editor: string;
  isPublished: number;
  isPrivate: number;
  privateNS: string | null;
  publishStartDate: string;
  publishEndDate: string;
  scriptCss: string;
  scriptJs: string;
  hash: string;
  authorId: number;
  creatorId: number;
  createdAt: string;
  updatedAt: string;
}

export interface VersionRow {
  id: number;
  pageId: number;
  action: string;
  authorId: number;
  locale: string;
  path: string;
  title: string;
  description: string;
  content: string;
  contentType: string;
  editor: string;
  isPublished: number;
  isPrivate: number;
  publishStartDate: string;
  publishEndDate: string;
  tags: string;
  versionDate: string;
  createdAt: string;
}

export interface CommentRow {
  id: number;
  pageId: number;
  replyTo: number;
  content: string;
  authorId: number;
  authorName: string;
  authorEmail: string;
  createdAt: string;
  updatedAt: string;
}

type Params = (string | number | null)[];

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        providerKey TEXT NOT NULL,
        passwordHash TEXT NOT NULL DEFAULT '',
        isSystem INTEGER NOT NULL DEFAULT 0,
        isActive INTEGER NOT NULL DEFAULT 1,
        isVerified INTEGER NOT NULL DEFAULT 1,
        mustChangePwd INTEGER NOT NULL DEFAULT 0,
        location TEXT NOT NULL DEFAULT '',
        jobTitle TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastLoginAt TEXT
      );
      CREATE TABLE IF NOT EXISTS wikiGroups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        isSystem INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS userGroups (
        userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        groupId INTEGER NOT NULL REFERENCES wikiGroups(id) ON DELETE CASCADE,
        PRIMARY KEY (userId, groupId)
      );
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        locale TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        contentType TEXT NOT NULL,
        editor TEXT NOT NULL,
        isPublished INTEGER NOT NULL,
        isPrivate INTEGER NOT NULL,
        privateNS TEXT,
        publishStartDate TEXT NOT NULL,
        publishEndDate TEXT NOT NULL,
        scriptCss TEXT NOT NULL,
        scriptJs TEXT NOT NULL,
        hash TEXT NOT NULL,
        authorId INTEGER NOT NULL,
        creatorId INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE (locale, path)
      );
      CREATE TABLE IF NOT EXISTS pageTags (
        pageId INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (pageId, tag)
      );
      CREATE TABLE IF NOT EXISTS pageVersions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pageId INTEGER NOT NULL,
        action TEXT NOT NULL,
        authorId INTEGER NOT NULL,
        locale TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        contentType TEXT NOT NULL,
        editor TEXT NOT NULL,
        isPublished INTEGER NOT NULL,
        isPrivate INTEGER NOT NULL,
        publishStartDate TEXT NOT NULL,
        publishEndDate TEXT NOT NULL,
        tags TEXT NOT NULL,
        versionDate TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pageId INTEGER NOT NULL,
        replyTo INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        authorId INTEGER NOT NULL,
        authorName TEXT NOT NULL,
        authorEmail TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  all<T>(sql: string, ...params: Params): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  one<T>(sql: string, ...params: Params): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Params): { changes: number; lastId: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  /** Inserts a row from an object's keys and returns the new id. */
  insert(table: string, row: Record<string, string | number | null>): number {
    const keys = Object.keys(row);
    return this.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k] ?? null)).lastId;
  }

  update(table: string, id: number, row: Record<string, string | number | null>): void {
    const keys = Object.keys(row);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => row[k] ?? null), id);
  }

  getMeta(key: string): string | undefined {
    return this.one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
