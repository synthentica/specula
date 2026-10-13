// A tiny document store on node:sqlite: each collection is a list of JSON records kept in insertion order.

import { DatabaseSync } from 'node:sqlite';

export interface Doc {
  id: string;
  [key: string]: unknown;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (collection, id)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /** All records of a collection, oldest first. Each carries its insertion order as `_seq`. */
  all<T extends Doc>(collection: string): T[] {
    const rows = this.db.prepare('SELECT seq, data FROM docs WHERE collection = ? ORDER BY seq').all(collection) as { seq: number; data: string }[];
    return rows.map((row) => ({ ...(JSON.parse(row.data) as T), _seq: row.seq }));
  }

  get<T extends Doc>(collection: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT seq, data FROM docs WHERE collection = ? AND id = ?').get(collection, id) as { seq: number; data: string } | undefined;
    return row ? { ...(JSON.parse(row.data) as T), _seq: row.seq } : undefined;
  }

  /** Inserts or replaces a record; a replaced record keeps its place in the order. */
  put<T extends Doc>(collection: string, doc: T): T {
    const { _seq, ...data } = doc as T & { _seq?: number };
    void _seq;
    const text = JSON.stringify(data);
    const updated = this.db.prepare('UPDATE docs SET data = ? WHERE collection = ? AND id = ?').run(text, collection, doc.id);
    if (Number(updated.changes) === 0) this.db.prepare('INSERT INTO docs (collection, id, data) VALUES (?, ?, ?)').run(collection, doc.id, text);
    return doc;
  }

  remove(collection: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(collection, id).changes) > 0;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
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
