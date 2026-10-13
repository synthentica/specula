// Tackboard's storage on node:sqlite (DatabaseSync). Boards, blocks, members and categories are kept
// as JSON documents next to the columns they are looked up by; users and sessions are plain rows.

import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface User {
  id: string;
  username: string;
  nickname: string;
  firstname: string;
  lastname: string;
  create_at: number;
  update_at: number;
  delete_at: number;
  is_bot: boolean;
  is_guest: boolean;
  roles: string;
}

export interface CardOption {
  id: string;
  value: string;
  color: string;
}

export interface CardProperty {
  id: string;
  name: string;
  type: string;
  options: CardOption[];
}

export interface Board {
  id: string;
  teamId: string;
  channelId: string;
  createdBy: string;
  modifiedBy: string;
  type: string;
  minimumRole: string;
  title: string;
  description: string;
  icon: string;
  showDescription: boolean;
  isTemplate: boolean;
  templateVersion: number;
  properties: Record<string, unknown>;
  cardProperties: CardProperty[];
  createAt: number;
  updateAt: number;
  deleteAt: number;
}

export interface Block {
  id: string;
  parentId: string;
  createdBy: string;
  modifiedBy: string;
  schema: number;
  type: string;
  title: string;
  fields: Record<string, unknown> | null;
  createAt: number;
  updateAt: number;
  deleteAt: number;
  boardId: string;
}

export interface Member {
  boardId: string;
  userId: string;
  roles: string;
  minimumRole: string;
  schemeAdmin: boolean;
  schemeEditor: boolean;
  schemeCommenter: boolean;
  schemeViewer: boolean;
  synthetic: boolean;
}

export interface Category {
  id: string;
  name: string;
  userID: string;
  teamID: string;
  createAt: number;
  updateAt: number;
  deleteAt: number;
  collapsed: boolean;
  sorting: string;
  type: string;
  sortOrder: number;
}

export interface BoardMetadata {
  boardID: string;
  hidden: boolean;
}

// Ids are 27 characters: a kind letter, then 26 characters from a 32-letter alphabet (5 bits each).
const ID_ALPHABET = 'abcdefghijkmnopqrstuwxyz13456789';

export function newId(kind: string): string {
  const bytes = randomBytes(26);
  let out = kind;
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return out;
}

type Param = string | number | null;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        passwordHash TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL, createAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        teamId TEXT NOT NULL,
        isTemplate INTEGER NOT NULL,
        createAt INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        boardId TEXT NOT NULL,
        parentId TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blocksByBoard ON blocks (boardId);
      CREATE TABLE IF NOT EXISTS members (boardId TEXT NOT NULL, userId TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (boardId, userId));
      CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, userId TEXT NOT NULL, teamId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS categoryBoards (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        categoryId TEXT NOT NULL,
        boardId TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        UNIQUE (categoryId, boardId)
      );
    `);
  }

  private all<T>(sql: string, ...params: Param[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private one<T>(sql: string, ...params: Param[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private run(sql: string, ...params: Param[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  private docs<T>(sql: string, ...params: Param[]): T[] {
    return this.all<{ data: string }>(sql, ...params).map((r) => JSON.parse(r.data) as T);
  }

  private doc<T>(sql: string, ...params: Param[]): T | undefined {
    const row = this.one<{ data: string }>(sql, ...params);
    return row ? (JSON.parse(row.data) as T) : undefined;
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

  // ---- meta ------------------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    return this.one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  // ---- users and sessions ----------------------------------------------------------------

  userCount(): number {
    return this.one<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
  }

  insertUser(user: User, email: string, passwordHash: string): void {
    this.run('INSERT INTO users (id, username, email, passwordHash, data) VALUES (?, ?, ?, ?, ?)', user.id, user.username, email, passwordHash, JSON.stringify(user));
  }

  userById(id: string): User | undefined {
    return this.doc<User>('SELECT data FROM users WHERE id = ?', id);
  }

  /** The user signing in by username or email address, with their password hash. */
  userForLogin(login: string): { user: User; passwordHash: string } | undefined {
    const row = this.one<{ data: string; passwordHash: string }>('SELECT data, passwordHash FROM users WHERE username = ? OR email = ?', login, login);
    return row ? { user: JSON.parse(row.data) as User, passwordHash: row.passwordHash } : undefined;
  }

  usernameOrEmailTaken(username: string, email: string): boolean {
    return !!this.one('SELECT 1 FROM users WHERE username = ? OR email = ?', username, email);
  }

  listUsers(): User[] {
    return this.docs<User>('SELECT data FROM users ORDER BY username');
  }

  createSession(token: string, userId: string): void {
    this.run('INSERT INTO sessions (token, userId, createAt) VALUES (?, ?, ?)', token, userId, Date.now());
  }

  sessionUserId(token: string): string | undefined {
    return this.one<{ userId: string }>('SELECT userId FROM sessions WHERE token = ?', token)?.userId;
  }

  deleteSession(token: string): void {
    this.run('DELETE FROM sessions WHERE token = ?', token);
  }

  // ---- boards ----------------------------------------------------------------------------

  putBoard(board: Board): void {
    this.run(
      'INSERT INTO boards (id, teamId, isTemplate, createAt, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET teamId = excluded.teamId, isTemplate = excluded.isTemplate, data = excluded.data',
      board.id,
      board.teamId,
      board.isTemplate ? 1 : 0,
      board.createAt,
      JSON.stringify(board),
    );
  }

  getBoard(id: string): Board | undefined {
    return this.doc<Board>('SELECT data FROM boards WHERE id = ?', id);
  }

  templates(teamId: string): Board[] {
    return this.docs<Board>('SELECT data FROM boards WHERE isTemplate = 1 AND teamId = ? ORDER BY createAt, rowid', teamId);
  }

  /** The non-template boards of a team that the user is a member of. */
  boardsForUser(userId: string, teamId: string): Board[] {
    return this.docs<Board>(
      'SELECT b.data FROM boards b JOIN members m ON m.boardId = b.id WHERE m.userId = ? AND b.teamId = ? AND b.isTemplate = 0 ORDER BY b.createAt, b.rowid',
      userId,
      teamId,
    );
  }

  // ---- blocks ----------------------------------------------------------------------------

  putBlock(block: Block): void {
    this.run(
      'INSERT INTO blocks (id, boardId, parentId, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET boardId = excluded.boardId, parentId = excluded.parentId, data = excluded.data',
      block.id,
      block.boardId,
      block.parentId,
      JSON.stringify(block),
    );
  }

  getBlock(id: string): Block | undefined {
    return this.doc<Block>('SELECT data FROM blocks WHERE id = ?', id);
  }

  blocksOf(boardId: string): Block[] {
    return this.docs<Block>('SELECT data FROM blocks WHERE boardId = ? ORDER BY seq', boardId);
  }

  childrenOf(parentId: string): Block[] {
    return this.docs<Block>('SELECT data FROM blocks WHERE parentId = ? ORDER BY seq', parentId);
  }

  deleteBlock(id: string): void {
    this.run('DELETE FROM blocks WHERE id = ?', id);
  }

  // ---- members ---------------------------------------------------------------------------

  putMember(member: Member): void {
    this.run(
      'INSERT INTO members (boardId, userId, data) VALUES (?, ?, ?) ON CONFLICT(boardId, userId) DO UPDATE SET data = excluded.data',
      member.boardId,
      member.userId,
      JSON.stringify(member),
    );
  }

  getMember(boardId: string, userId: string): Member | undefined {
    return this.doc<Member>('SELECT data FROM members WHERE boardId = ? AND userId = ?', boardId, userId);
  }

  membersOf(boardId: string): Member[] {
    return this.docs<Member>('SELECT data FROM members WHERE boardId = ? ORDER BY rowid', boardId);
  }

  membershipsOf(userId: string): Member[] {
    return this.docs<Member>('SELECT data FROM members WHERE userId = ? ORDER BY rowid', userId);
  }

  // ---- categories ------------------------------------------------------------------------

  putCategory(category: Category): void {
    this.run(
      'INSERT INTO categories (id, userId, teamId, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      category.id,
      category.userID,
      category.teamID,
      JSON.stringify(category),
    );
  }

  categoriesOf(userId: string, teamId: string): Category[] {
    return this.docs<Category>('SELECT data FROM categories WHERE userId = ? AND teamId = ? ORDER BY rowid', userId, teamId);
  }

  fileBoard(categoryId: string, boardId: string): void {
    this.run('INSERT INTO categoryBoards (categoryId, boardId) VALUES (?, ?) ON CONFLICT(categoryId, boardId) DO NOTHING', categoryId, boardId);
  }

  boardMetadata(categoryId: string): BoardMetadata[] {
    return this.all<{ boardId: string; hidden: number }>('SELECT boardId, hidden FROM categoryBoards WHERE categoryId = ? ORDER BY seq', categoryId).map((r) => ({ boardID: r.boardId, hidden: r.hidden === 1 }));
  }
}
