// Pagegrove's GraphQL schema and resolvers: pages, tags, history, comments, users, groups, sign-in,
// site counters and UI catalogues, plus first-run setup.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, signToken, verifyPassword } from './auth.ts';
import { AppError, type FieldDef, type Schema } from './graphql.ts';
import { renderMarkdown } from './markdown.ts';
import type { CommentRow, GroupRow, PageRow, Store, UserRow, VersionRow } from './store.ts';

export const PRODUCT = 'Pagegrove';
export const VERSION = '1.0.0';
export const TOKEN_LIFETIME = 30 * 60; // seconds
export const ADMIN_GROUP = 1;
export const GUEST_GROUP = 2;
export const GUEST_USER = 2;
const DEFAULT_TIMEZONE = 'Etc/UTC';
const SIGN_IN_NAME = 'Email and password';

const here = dirname(fileURLToPath(import.meta.url));
const catalogue = JSON.parse(readFileSync(join(here, 'catalogue.json'), 'utf8')) as Record<string, Record<string, string>>;

export interface WikiCtx {
  store: Store;
  user: UserRow;
  groups: number[];
  signedIn: boolean;
  origin: string;
  secret: string;
}

// ---- helpers ---------------------------------------------------------------------------------

let lastStamp = 0;
/** ISO time with milliseconds, strictly increasing within the process. */
export function now(): string {
  let t = Date.now();
  if (t <= lastStamp) t = lastStamp + 1;
  lastStamp = t;
  return new Date(t).toISOString();
}

const ok = (message: string) => ({ succeeded: true, errorCode: 0, slug: 'ok', message });
const fail = (errorCode: number, slug: string, message: string) => ({ succeeded: false, errorCode, slug, message });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireMember(ctx: WikiCtx): void {
  if (!ctx.signedIn) throw new AppError(1010, 'SignInRequired', 'Sign in to do this.', 'FORBIDDEN');
}
function isAdmin(ctx: WikiCtx): boolean {
  return ctx.signedIn && ctx.groups.includes(ADMIN_GROUP);
}
function requireAdmin(ctx: WikiCtx): void {
  requireMember(ctx);
  if (!isAdmin(ctx)) throw new AppError(1011, 'NotAllowed', 'Only maintainers can do this.', 'FORBIDDEN');
}

export function groupsOf(store: Store, userId: number): number[] {
  return store.all<{ groupId: number }>('SELECT groupId FROM userGroups WHERE userId = ? ORDER BY groupId', userId).map((r) => r.groupId);
}

export function getUser(store: Store, id: number): UserRow | undefined {
  return store.one<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

function tagsOf(store: Store, pageId: number): string[] {
  return store.all<{ tag: string }>('SELECT tag FROM pageTags WHERE pageId = ? ORDER BY tag', pageId).map((r) => r.tag);
}

function allTags(store: Store): string[] {
  return store.all<{ tag: string }>('SELECT DISTINCT tag FROM pageTags ORDER BY tag').map((r) => r.tag);
}

/** Tags as a set of trimmed, lower-case names. */
function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out = new Set<string>();
  for (const t of tags) if (typeof t === 'string' && t.trim()) out.add(t.trim().toLowerCase().slice(0, 100));
  return [...out];
}

/** A page path without leading/trailing slashes; undefined when it cannot be used. */
function cleanPath(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const p = path.trim().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!p || p.length > 255) return undefined;
  if (/[\s?#%\\"<>|*:\x00-\x1f]/.test(p)) return undefined;
  if (p.split('/').some((seg) => seg === '.' || seg === '..' || seg === '')) return undefined;
  return p;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback: boolean): number => (typeof v === 'boolean' ? (v ? 1 : 0) : fallback ? 1 : 0);

// ---- output shapes ---------------------------------------------------------------------------

function userName(store: Store, id: number): { name: string; email: string } {
  const u = getUser(store, id);
  return { name: u?.name ?? 'Former member', email: u?.email ?? '' };
}

function pageOut(store: Store, row: PageRow) {
  const author = userName(store, row.authorId);
  const creator = userName(store, row.creatorId);
  const tags = tagsOf(store, row.id);
  return {
    id: row.id,
    locale: row.locale,
    path: row.path,
    hash: row.hash,
    title: row.title,
    description: row.description,
    content: row.content,
    render: () => renderMarkdown(row.content),
    contentType: row.contentType,
    editor: row.editor,
    isPublished: !!row.isPublished,
    isPrivate: !!row.isPrivate,
    privateNS: row.privateNS,
    publishStartDate: row.publishStartDate,
    publishEndDate: row.publishEndDate,
    tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    authorId: row.authorId,
    authorName: author.name,
    authorEmail: author.email,
    creatorId: row.creatorId,
    creatorName: creator.name,
    creatorEmail: creator.email,
  };
}

function versionOut(store: Store, v: VersionRow) {
  return {
    versionId: v.id,
    pageId: v.pageId,
    action: v.action,
    authorId: String(v.authorId),
    authorName: userName(store, v.authorId).name,
    content: v.content,
    render: () => renderMarkdown(v.content),
    contentType: v.contentType,
    editor: v.editor,
    description: v.description,
    isPrivate: !!v.isPrivate,
    isPublished: !!v.isPublished,
    locale: v.locale,
    path: v.path,
    publishStartDate: v.publishStartDate,
    publishEndDate: v.publishEndDate,
    tags: JSON.parse(v.tags) as string[],
    title: v.title,
    createdAt: v.createdAt,
    versionDate: v.versionDate,
  };
}

function commentOut(c: CommentRow) {
  return {
    id: c.id,
    pageId: c.pageId,
    replyTo: c.replyTo,
    content: c.content,
    render: () => renderMarkdown(c.content),
    authorId: c.authorId,
    authorName: c.authorName,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function userMinimal(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    providerKey: u.providerKey,
    isSystem: !!u.isSystem,
    isActive: !!u.isActive,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

function userFull(store: Store, u: UserRow) {
  const groups = store.all<GroupRow>('SELECT g.* FROM wikiGroups g JOIN userGroups ug ON ug.groupId = g.id WHERE ug.userId = ? ORDER BY g.id', u.id);
  return {
    ...userMinimal(u),
    providerName: SIGN_IN_NAME,
    providerId: null,
    providerIs2FACapable: true,
    location: u.location,
    jobTitle: u.jobTitle,
    timezone: u.timezone,
    isVerified: !!u.isVerified,
    updatedAt: u.updatedAt,
    tfaIsActive: false,
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
  };
}

function groupOut(store: Store, g: GroupRow) {
  return {
    id: g.id,
    name: g.name,
    isSystem: !!g.isSystem,
    userCount: () => store.one<{ n: number }>('SELECT COUNT(*) AS n FROM userGroups WHERE groupId = ?', g.id)?.n ?? 0,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

function signInIcon(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
}

function strategyOut(origin: string) {
  return {
    key: 'local',
    strategy: {
      key: 'local',
      title: SIGN_IN_NAME,
      description: 'Accounts kept in this wiki, signed in with an email address and a password.',
      logo: `${origin}/_assets/sign-in.svg`,
      color: 'green darken-2',
      icon: signInIcon(),
      useForm: true,
      usernameType: 'email',
      website: origin,
    },
    displayName: SIGN_IN_NAME,
    order: 0,
    isEnabled: true,
    selfRegistration: false,
    domainWhitelist: [] as string[],
    autoEnrollGroups: [] as number[],
  };
}

// ---- pages -----------------------------------------------------------------------------------

function findPage(store: Store, id: unknown): PageRow | undefined {
  return typeof id === 'number' ? store.one<PageRow>('SELECT * FROM pages WHERE id = ?', id) : undefined;
}

const pageMissing = () => new AppError(6003, 'PageMissing', 'There is no page with this id.');

function listPages(store: Store, args: Record<string, any>) {
  let rows = store.all<PageRow>('SELECT * FROM pages ORDER BY id');
  if (typeof args.locale === 'string' && args.locale) rows = rows.filter((r) => r.locale === args.locale);
  const wanted = cleanTags(args.tags);
  if (wanted.length) {
    rows = rows.filter((r) => {
      const have = new Set(tagsOf(store, r.id));
      return wanted.every((t) => have.has(t));
    });
  }
  if (typeof args.creatorId === 'number') rows = rows.filter((r) => r.creatorId === args.creatorId);
  if (typeof args.authorId === 'number') rows = rows.filter((r) => r.authorId === args.authorId);
  const keys: Record<string, (r: PageRow) => string | number> = { ID: (r) => r.id, TITLE: (r) => r.title.toLowerCase(), PATH: (r) => r.path, CREATED: (r) => r.createdAt, UPDATED: (r) => r.updatedAt };
  const key = keys[String(args.orderBy ?? 'ID')] ?? keys.ID!;
  const dir = String(args.orderByDirection ?? 'ASC') === 'DESC' ? -1 : 1;
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return (x < y ? -1 : x > y ? 1 : a.id - b.id) * dir;
  });
  if (Number.isInteger(args.limit) && args.limit > 0) rows = rows.slice(0, args.limit);
  // With a tag filter, each item lists the tags it matched (as recorded), still sorted by name.
  return rows.map((r) => {
    const out = pageOut(store, r);
    return wanted.length ? { ...out, tags: out.tags.filter((t) => wanted.includes(t)) } : out;
  });
}

function searchPages(store: Store, query: string, locale?: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { results: [], suggestions: [], totalHits: 0 };
  const rows = store.all<PageRow>('SELECT * FROM pages ORDER BY id').filter((r) => {
    if (locale && r.locale !== locale) return false;
    const hay = `${r.title}\n${r.description}\n${r.path}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  // Title hits first, then description/path hits; ties by id.
  const score = (r: PageRow) => words.filter((w) => r.title.toLowerCase().includes(w)).length;
  rows.sort((a, b) => score(b) - score(a) || a.id - b.id);
  return { results: rows.map((r) => ({ id: r.id, title: r.title, description: r.description, path: r.path, locale: r.locale })), suggestions: [] as string[], totalHits: rows.length };
}

function createPage(ctx: WikiCtx, args: Record<string, any>) {
  requireMember(ctx);
  const { store } = ctx;
  const title = str(args.title).trim();
  const path = cleanPath(args.path);
  const locale = str(args.locale, 'en').trim() || 'en';
  if (!title) return { responseResult: fail(6005, 'PageTitleMissing', 'A page needs a title.'), page: null };
  if (!path) return { responseResult: fail(6004, 'PagePathInvalid', 'This path cannot be used. Use letters, numbers, dashes and slashes, without spaces.'), page: null };
  if (store.one('SELECT id FROM pages WHERE locale = ? AND path = ?', locale, path)) {
    return { responseResult: fail(6002, 'PageExists', 'A page already lives at this path. Pick another path.'), page: null };
  }
  const stamp = now();
  const id = store.transaction(() => {
    const newId = store.insert('pages', {
      locale,
      path,
      title,
      description: str(args.description),
      content: str(args.content),
      contentType: 'markdown',
      editor: str(args.editor, 'markdown') || 'markdown',
      isPublished: bool(args.isPublished, true),
      isPrivate: bool(args.isPrivate, false),
      privateNS: null,
      publishStartDate: str(args.publishStartDate),
      publishEndDate: str(args.publishEndDate),
      scriptCss: str(args.scriptCss),
      scriptJs: str(args.scriptJs),
      hash: '',
      authorId: ctx.user.id,
      creatorId: ctx.user.id,
      createdAt: stamp,
      updatedAt: stamp,
    });
    store.update('pages', newId, { hash: createHash('sha1').update(`pagegrove:page:${newId}:${stamp}`).digest('hex') });
    for (const tag of cleanTags(args.tags)) store.run('INSERT INTO pageTags (pageId, tag) VALUES (?, ?)', newId, tag);
    return newId;
  });
  return { responseResult: ok('The page is saved.'), page: pageOut(store, findPage(store, id)!) };
}

function updatePage(ctx: WikiCtx, args: Record<string, any>) {
  requireMember(ctx);
  const { store } = ctx;
  const page = findPage(store, args.id);
  if (!page) return { responseResult: fail(6003, 'PageMissing', 'There is no page with this id.'), page: null };
  const changes: Record<string, string | number | null> = {};
  if (typeof args.title === 'string') {
    if (!args.title.trim()) return { responseResult: fail(6005, 'PageTitleMissing', 'A page needs a title.'), page: null };
    changes.title = args.title.trim();
  }
  const locale = typeof args.locale === 'string' && args.locale.trim() ? args.locale.trim() : page.locale;
  let path = page.path;
  if (args.path !== undefined && args.path !== null) {
    const p = cleanPath(args.path);
    if (!p) return { responseResult: fail(6004, 'PagePathInvalid', 'This path cannot be used. Use letters, numbers, dashes and slashes, without spaces.'), page: null };
    path = p;
  }
  if ((path !== page.path || locale !== page.locale) && store.one('SELECT id FROM pages WHERE locale = ? AND path = ? AND id <> ?', locale, path, page.id)) {
    return { responseResult: fail(6002, 'PageExists', 'A page already lives at this path. Pick another path.'), page: null };
  }
  changes.path = path;
  changes.locale = locale;
  for (const key of ['description', 'content', 'editor', 'publishStartDate', 'publishEndDate', 'scriptCss', 'scriptJs'] as const) {
    if (typeof args[key] === 'string') changes[key] = args[key];
  }
  for (const key of ['isPublished', 'isPrivate'] as const) if (typeof args[key] === 'boolean') changes[key] = args[key] ? 1 : 0;
  const stamp = now();
  store.transaction(() => {
    store.insert('pageVersions', {
      pageId: page.id,
      action: 'updated',
      authorId: page.authorId,
      locale: page.locale,
      path: page.path,
      title: page.title,
      description: page.description,
      content: page.content,
      contentType: page.contentType,
      editor: page.editor,
      isPublished: page.isPublished,
      isPrivate: page.isPrivate,
      publishStartDate: page.publishStartDate,
      publishEndDate: page.publishEndDate,
      tags: JSON.stringify(tagsOf(store, page.id)),
      versionDate: page.updatedAt,
      createdAt: stamp,
    });
    store.update('pages', page.id, { ...changes, authorId: ctx.user.id, updatedAt: stamp });
    if (Array.isArray(args.tags)) {
      store.run('DELETE FROM pageTags WHERE pageId = ?', page.id);
      for (const tag of cleanTags(args.tags)) store.run('INSERT INTO pageTags (pageId, tag) VALUES (?, ?)', page.id, tag);
    }
  });
  return { responseResult: ok('Your changes are saved.'), page: pageOut(store, findPage(store, page.id)!) };
}

function deletePage(ctx: WikiCtx, args: Record<string, any>) {
  requireAdmin(ctx);
  const { store } = ctx;
  const page = findPage(store, args.id);
  if (!page) return { responseResult: fail(6003, 'PageMissing', 'There is no page with this id.') };
  store.transaction(() => {
    store.run('DELETE FROM comments WHERE pageId = ?', page.id);
    store.run('DELETE FROM pageVersions WHERE pageId = ?', page.id);
    store.run('DELETE FROM pages WHERE id = ?', page.id);
  });
  return { responseResult: ok('The page is gone.') };
}

function pageHistory(store: Store, args: Record<string, any>) {
  const page = findPage(store, args.id);
  if (!page) throw pageMissing();
  const versions = store.all<VersionRow>('SELECT * FROM pageVersions WHERE pageId = ? ORDER BY id', page.id);
  const trail = versions.map((v, i) => {
    const previous = versions[i - 1];
    const moved = previous && previous.path !== v.path;
    return {
      versionId: v.id,
      authorId: v.authorId,
      authorName: userName(store, v.authorId).name,
      actionType: i === 0 ? 'initial' : moved ? 'move' : 'edit',
      valueBefore: moved ? previous.path : null,
      valueAfter: moved ? v.path : null,
      versionDate: v.versionDate,
    };
  });
  trail.reverse();
  const size = Number.isInteger(args.offsetSize) && args.offsetSize > 0 ? Math.min(args.offsetSize, 500) : 100;
  const pageNo = Number.isInteger(args.offsetPage) && args.offsetPage > 0 ? args.offsetPage : 0;
  return { trail: trail.slice(pageNo * size, pageNo * size + size), total: trail.length };
}

// ---- comments --------------------------------------------------------------------------------

function createComment(ctx: WikiCtx, args: Record<string, any>) {
  requireMember(ctx);
  const { store } = ctx;
  const page = findPage(store, args.pageId);
  if (!page) return { responseResult: fail(6003, 'PageMissing', 'There is no page with this id.'), id: null };
  const content = str(args.content).trim();
  if (!content) return { responseResult: fail(8001, 'CommentEmpty', 'Write something before posting.'), id: null };
  if (content.length > 20000) return { responseResult: fail(8002, 'CommentTooLong', 'This comment is too long.'), id: null };
  let replyTo = Number.isInteger(args.replyTo) ? (args.replyTo as number) : 0;
  if (replyTo && !store.one('SELECT id FROM comments WHERE id = ? AND pageId = ?', replyTo, page.id)) replyTo = 0;
  const stamp = now();
  const id = store.insert('comments', { pageId: page.id, replyTo, content, authorId: ctx.user.id, authorName: ctx.user.name, authorEmail: ctx.user.email, createdAt: stamp, updatedAt: stamp });
  return { responseResult: ok('Your comment is up.'), id };
}

// ---- users -----------------------------------------------------------------------------------

function createUser(ctx: WikiCtx, args: Record<string, any>) {
  requireAdmin(ctx);
  const { store } = ctx;
  const email = str(args.email).trim().toLowerCase();
  const name = str(args.name).trim();
  const password = str(args.passwordRaw);
  if (str(args.providerKey, 'local') !== 'local') return { responseResult: fail(1008, 'SignInMethodUnknown', 'Only the email and password sign-in method can hold new accounts.') };
  if (!EMAIL.test(email)) return { responseResult: fail(1003, 'EmailInvalid', 'Enter a valid email address.') };
  if (!name) return { responseResult: fail(1005, 'NameMissing', 'Enter a display name.') };
  if (password.length < 8) return { responseResult: fail(1006, 'PasswordTooShort', 'The password needs at least 8 characters.') };
  if (store.one('SELECT id FROM users WHERE email = ?', email)) return { responseResult: fail(1004, 'EmailTaken', 'Another account already uses this email address.') };
  const stamp = now();
  store.transaction(() => {
    const id = store.insert('users', {
      email,
      name: name.slice(0, 255),
      providerKey: 'local',
      passwordHash: hashPassword(password),
      isSystem: 0,
      isActive: 1,
      isVerified: 1,
      mustChangePwd: args.mustChangePassword === true ? 1 : 0,
      location: '',
      jobTitle: '',
      timezone: DEFAULT_TIMEZONE,
      createdAt: stamp,
      updatedAt: stamp,
      lastLoginAt: null,
    });
    const wanted = Array.isArray(args.groups) ? (args.groups as unknown[]).filter((g): g is number => Number.isInteger(g)) : [];
    for (const g of new Set(wanted)) if (store.one('SELECT id FROM wikiGroups WHERE id = ?', g)) store.run('INSERT INTO userGroups (userId, groupId) VALUES (?, ?)', id, g);
  });
  return { responseResult: ok('The account is ready.') };
}

function login(ctx: WikiCtx, args: Record<string, any>) {
  const empty = { jwt: null, mustChangePwd: null, mustProvideTFA: null, mustSetupTFA: null, continuationToken: null, redirect: null, tfaQRImage: null };
  if (str(args.strategy, 'local') !== 'local') return { responseResult: fail(1001, 'SignInMethodUnknown', 'This sign-in method is not available.'), ...empty };
  const { store } = ctx;
  const user = store.one<UserRow>('SELECT * FROM users WHERE email = ? AND isSystem = 0', str(args.username).trim());
  if (!user || !user.isActive || !user.passwordHash || !verifyPassword(str(args.password), user.passwordHash)) {
    return { responseResult: fail(1002, 'SignInFailed', 'That email and password do not match an account.'), ...empty };
  }
  const stamp = now();
  store.update('users', user.id, { lastLoginAt: stamp });
  const jwt = signToken({ id: user.id, email: user.email, name: user.name, grp: groupsOf(store, user.id) }, ctx.secret, TOKEN_LIFETIME);
  return { responseResult: ok('Welcome back.'), ...empty, jwt, redirect: '/' };
}

// ---- setup -----------------------------------------------------------------------------------

export function isSetUp(store: Store): boolean {
  return store.getMeta('setupDone') === '1';
}

/** First-run setup: the administrator, the guest account and the two system groups. */
export function finalizeSetup(store: Store, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
  if (isSetUp(store)) return { status: 403, body: { ok: false, error: 'This wiki is already set up.' } };
  const email = str(body.adminEmail).trim().toLowerCase();
  const password = str(body.adminPassword);
  if (!EMAIL.test(email)) return { status: 400, body: { ok: false, error: 'Enter a valid email address for the administrator.' } };
  if (password.length < 8) return { status: 400, body: { ok: false, error: 'The password needs at least 8 characters.' } };
  if (password !== str(body.adminPasswordConfirm)) return { status: 400, body: { ok: false, error: 'The two passwords are not the same.' } };
  const stamp = now();
  store.transaction(() => {
    const base = { providerKey: 'local', isActive: 1, isVerified: 1, mustChangePwd: 0, location: '', jobTitle: '', timezone: DEFAULT_TIMEZONE, lastLoginAt: null };
    store.insert('wikiGroups', { name: 'Maintainers', isSystem: 1, createdAt: stamp, updatedAt: stamp });
    store.insert('wikiGroups', { name: 'Public readers', isSystem: 1, createdAt: stamp, updatedAt: stamp });
    const adminId = store.insert('users', { ...base, email, name: 'Site maintainer', passwordHash: hashPassword(password), isSystem: 0, createdAt: stamp, updatedAt: stamp });
    const guestStamp = now();
    const guestId = store.insert('users', { ...base, email: 'anonymous-reader@pagegrove.invalid', name: 'Anonymous reader', passwordHash: '', isSystem: 1, createdAt: guestStamp, updatedAt: guestStamp });
    store.run('INSERT INTO userGroups (userId, groupId) VALUES (?, ?)', adminId, ADMIN_GROUP);
    store.run('INSERT INTO userGroups (userId, groupId) VALUES (?, ?)', guestId, GUEST_GROUP);
    store.setMeta('siteUrl', str(body.siteUrl));
    store.setMeta('telemetry', body.telemetry === true ? '1' : '0');
    store.setMeta('setupDone', '1');
  });
  return { status: 200, body: { ok: true, redirectPath: '/' } };
}

/** The user a request acts as when it carries no valid token. */
export function guestUser(store: Store): UserRow {
  const guest = getUser(store, GUEST_USER);
  if (guest?.isSystem) return guest;
  const stamp = new Date(0).toISOString();
  return { id: GUEST_USER, email: '', name: 'Anonymous reader', providerKey: 'local', passwordHash: '', isSystem: 1, isActive: 1, isVerified: 1, mustChangePwd: 0, location: '', jobTitle: '', timezone: DEFAULT_TIMEZONE, createdAt: stamp, updatedAt: stamp, lastLoginAt: null };
}

// ---- schema ----------------------------------------------------------------------------------

type C = WikiCtx;
const ns = (type: string): FieldDef => ({ type, resolve: () => ({}) });
const scalar = (type: string, names: string[]): Record<string, FieldDef> => Object.fromEntries(names.map((n) => [n, { type }]));

export const schema: Schema = {
  query: 'Query',
  mutation: 'Mutation',
  types: {
    Query: {
      pages: ns('PageQuery'),
      users: ns('UserQuery'),
      comments: ns('CommentQuery'),
      groups: ns('GroupQuery'),
      authentication: ns('AuthenticationQuery'),
      localization: ns('LocalizationQuery'),
      system: ns('SystemQuery'),
    },
    Mutation: {
      pages: ns('PageMutation'),
      users: ns('UserMutation'),
      comments: ns('CommentMutation'),
      authentication: ns('AuthenticationMutation'),
    },
    PageQuery: {
      single: { type: 'Page', resolve: (_p, a, ctx: C) => pageOut(ctx.store, findPage(ctx.store, a.id) ?? (() => { throw pageMissing(); })()) },
      singleByPath: {
        type: 'Page',
        resolve: (_p, a, ctx: C) => {
          const row = ctx.store.one<PageRow>('SELECT * FROM pages WHERE locale = ? AND path = ?', str(a.locale, 'en') || 'en', cleanPath(a.path) ?? '');
          if (!row) throw new AppError(6003, 'PageMissing', 'There is no page at this path.');
          return pageOut(ctx.store, row);
        },
      },
      list: { type: '[PageListItem]', resolve: (_p, a, ctx: C) => listPages(ctx.store, a) },
      tags: { type: '[PageTag]', resolve: (_p, _a, ctx: C) => allTags(ctx.store).map((t) => ({ tag: t, title: t })) },
      searchTags: {
        type: '[String]',
        resolve: (_p, a, ctx: C) => {
          const q = str(a.query).trim().toLowerCase();
          const tags = allTags(ctx.store).filter((t) => t.includes(q));
          return [...tags.filter((t) => t.startsWith(q)), ...tags.filter((t) => !t.startsWith(q))].slice(0, 25);
        },
      },
      search: { type: 'PageSearchResponse', resolve: (_p, a, ctx: C) => searchPages(ctx.store, str(a.query), typeof a.locale === 'string' ? a.locale : undefined) },
      checkConflicts: {
        type: 'Boolean',
        resolve: (_p, a, ctx: C) => {
          const page = findPage(ctx.store, a.id);
          if (!page) throw pageMissing();
          const since = Date.parse(str(a.checkoutDate));
          return Number.isNaN(since) ? true : Date.parse(page.updatedAt) > since;
        },
      },
      history: { type: 'PageHistoryResult', resolve: (_p, a, ctx: C) => pageHistory(ctx.store, a) },
      version: {
        type: 'PageVersion',
        resolve: (_p, a, ctx: C) => {
          const v = ctx.store.one<VersionRow>('SELECT * FROM pageVersions WHERE id = ? AND pageId = ?', Number(a.versionId), Number(a.pageId));
          if (!v) throw new AppError(6006, 'VersionMissing', 'This page has no such version.');
          return versionOut(ctx.store, v);
        },
      },
    },
    PageMutation: {
      create: { type: 'PageResponse', resolve: (_p, a, ctx: C) => createPage(ctx, a) },
      update: { type: 'PageResponse', resolve: (_p, a, ctx: C) => updatePage(ctx, a) },
      delete: { type: 'DefaultResponse', resolve: (_p, a, ctx: C) => deletePage(ctx, a) },
    },
    PageResponse: { responseResult: { type: 'ResponseStatus' }, page: { type: 'Page' } },
    DefaultResponse: { responseResult: { type: 'ResponseStatus' } },
    ResponseStatus: { ...scalar('Boolean', ['succeeded']), ...scalar('Int', ['errorCode']), ...scalar('String', ['slug', 'message']) },
    Page: {
      ...scalar('Int', ['id', 'authorId', 'creatorId']),
      ...scalar('String', ['locale', 'path', 'hash', 'title', 'description', 'content', 'render', 'contentType', 'editor', 'privateNS', 'authorName', 'authorEmail', 'creatorName', 'creatorEmail']),
      ...scalar('Boolean', ['isPublished', 'isPrivate']),
      ...scalar('Date', ['publishStartDate', 'publishEndDate', 'createdAt', 'updatedAt']),
      tags: { type: '[String]' },
    },
    PageListItem: {
      ...scalar('Int', ['id']),
      ...scalar('String', ['locale', 'path', 'title', 'description', 'contentType', 'privateNS']),
      ...scalar('Boolean', ['isPublished', 'isPrivate']),
      ...scalar('Date', ['createdAt', 'updatedAt']),
      tags: { type: '[String]' },
    },
    PageTag: scalar('String', ['tag', 'title']),
    PageSearchResponse: { results: { type: '[PageSearchResult]' }, suggestions: { type: '[String]' }, totalHits: { type: 'Int' } },
    PageSearchResult: { ...scalar('Int', ['id']), ...scalar('String', ['title', 'description', 'path', 'locale']) },
    PageHistoryResult: { trail: { type: '[PageHistory]' }, total: { type: 'Int' } },
    PageHistory: { ...scalar('Int', ['versionId', 'authorId']), ...scalar('String', ['authorName', 'actionType', 'valueBefore', 'valueAfter']), versionDate: { type: 'Date' } },
    PageVersion: {
      ...scalar('Int', ['versionId', 'pageId']),
      ...scalar('String', ['action', 'authorId', 'authorName', 'content', 'render', 'contentType', 'editor', 'description', 'locale', 'path', 'title']),
      ...scalar('Boolean', ['isPrivate', 'isPublished']),
      ...scalar('Date', ['publishStartDate', 'publishEndDate', 'createdAt', 'versionDate']),
      tags: { type: '[String]' },
    },
    CommentQuery: {
      list: {
        type: '[CommentPost]',
        resolve: (_p, a, ctx: C) => {
          const page = ctx.store.one<PageRow>('SELECT * FROM pages WHERE locale = ? AND path = ?', str(a.locale, 'en'), cleanPath(a.path) ?? '');
          return page ? ctx.store.all<CommentRow>('SELECT * FROM comments WHERE pageId = ? ORDER BY id', page.id).map(commentOut) : [];
        },
      },
    },
    CommentMutation: { create: { type: 'CommentCreateResponse', resolve: (_p, a, ctx: C) => createComment(ctx, a) } },
    CommentCreateResponse: { responseResult: { type: 'ResponseStatus' }, id: { type: 'Int' } },
    CommentPost: { ...scalar('Int', ['id', 'pageId', 'replyTo', 'authorId']), ...scalar('String', ['content', 'render', 'authorName']), ...scalar('Date', ['createdAt', 'updatedAt']) },
    UserQuery: {
      list: {
        type: '[UserMinimal]',
        resolve: (_p, _a, ctx: C) => {
          requireAdmin(ctx);
          return ctx.store.all<UserRow>('SELECT * FROM users ORDER BY id').map(userMinimal);
        },
      },
      single: {
        type: 'User',
        resolve: (_p, a, ctx: C) => {
          requireMember(ctx);
          if (!isAdmin(ctx) && a.id !== ctx.user.id) throw new AppError(1011, 'NotAllowed', 'Only maintainers can do this.', 'FORBIDDEN');
          const u = typeof a.id === 'number' ? getUser(ctx.store, a.id) : undefined;
          if (!u) throw new AppError(1007, 'UserMissing', 'There is no account with this id.');
          return userFull(ctx.store, u);
        },
      },
      profile: {
        type: 'User',
        resolve: (_p, _a, ctx: C) => {
          requireMember(ctx);
          return userFull(ctx.store, ctx.user);
        },
      },
    },
    UserMutation: { create: { type: 'UserResponse', resolve: (_p, a, ctx: C) => createUser(ctx, a) } },
    UserResponse: { responseResult: { type: 'ResponseStatus' } },
    UserMinimal: { ...scalar('Int', ['id']), ...scalar('String', ['name', 'email', 'providerKey']), ...scalar('Boolean', ['isSystem', 'isActive']), ...scalar('Date', ['createdAt', 'lastLoginAt']) },
    User: {
      ...scalar('Int', ['id']),
      ...scalar('String', ['name', 'email', 'providerKey', 'providerName', 'providerId', 'location', 'jobTitle', 'timezone']),
      ...scalar('Boolean', ['providerIs2FACapable', 'isSystem', 'isActive', 'isVerified', 'tfaIsActive']),
      ...scalar('Date', ['createdAt', 'updatedAt', 'lastLoginAt']),
      groups: { type: '[Group]' },
    },
    Group: { ...scalar('Int', ['id']), ...scalar('String', ['name']) },
    GroupQuery: {
      list: {
        type: '[GroupMinimal]',
        resolve: (_p, _a, ctx: C) => {
          requireAdmin(ctx);
          return ctx.store.all<GroupRow>('SELECT * FROM wikiGroups ORDER BY id').map((g) => groupOut(ctx.store, g));
        },
      },
    },
    GroupMinimal: { ...scalar('Int', ['id', 'userCount']), ...scalar('String', ['name']), ...scalar('Boolean', ['isSystem']), ...scalar('Date', ['createdAt', 'updatedAt']) },
    AuthenticationQuery: {
      activeStrategies: { type: '[AuthenticationActiveStrategy]', resolve: (_p, _a, ctx: C) => [strategyOut(ctx.origin)] },
    },
    AuthenticationMutation: { login: { type: 'AuthenticationLoginResponse', resolve: (_p, a, ctx: C) => login(ctx, a) } },
    AuthenticationLoginResponse: {
      responseResult: { type: 'ResponseStatus' },
      ...scalar('String', ['jwt', 'continuationToken', 'redirect', 'tfaQRImage']),
      ...scalar('Boolean', ['mustChangePwd', 'mustProvideTFA', 'mustSetupTFA']),
    },
    AuthenticationActiveStrategy: {
      key: { type: 'String' },
      strategy: { type: 'AuthenticationStrategy' },
      ...scalar('String', ['displayName']),
      ...scalar('Int', ['order']),
      ...scalar('Boolean', ['isEnabled', 'selfRegistration']),
      domainWhitelist: { type: '[String]' },
      autoEnrollGroups: { type: '[Int]' },
    },
    AuthenticationStrategy: { ...scalar('String', ['key', 'title', 'description', 'logo', 'color', 'icon', 'usernameType', 'website']), useForm: { type: 'Boolean' } },
    LocalizationQuery: {
      translations: {
        type: '[Translation]',
        resolve: (_p, a) => Object.entries(catalogue[str(a.namespace)] ?? {}).map(([key, value]) => ({ key, value })),
      },
    },
    Translation: scalar('String', ['key', 'value']),
    SystemQuery: {
      info: {
        type: 'SystemInfo',
        resolve: (_p, _a, ctx: C) => {
          requireAdmin(ctx);
          const count = (sql: string) => ctx.store.one<{ n: number }>(sql)?.n ?? 0;
          return {
            currentVersion: VERSION,
            latestVersion: VERSION,
            productName: PRODUCT,
            groupsTotal: count('SELECT COUNT(*) AS n FROM wikiGroups'),
            pagesTotal: count('SELECT COUNT(*) AS n FROM pages'),
            usersTotal: count('SELECT COUNT(*) AS n FROM users'),
            tagsTotal: count('SELECT COUNT(DISTINCT tag) AS n FROM pageTags'),
          };
        },
      },
    },
    SystemInfo: { ...scalar('String', ['currentVersion', 'latestVersion', 'productName']), ...scalar('Int', ['groupsTotal', 'pagesTotal', 'usersTotal', 'tagsTotal']) },
  },
};
