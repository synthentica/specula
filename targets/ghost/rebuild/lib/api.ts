// The admin JSON API under /app/api/admin: authentication, users, posts, tags, members, settings and
// the read-only seed resources.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { lexicalFromText } from './content.ts';
import { applyFilter, applyOrder } from './filter.ts';
import { CALCULATED, LABS, THEMES, personalizeSample } from './seed.ts';
import {
  type Ctx, type MemberDoc, type NewsletterDoc, type PostDoc, type Revision, type RoleDoc, type TagDoc, type TierDoc, type UserDoc,
  USER_EDITABLE, memberShape, newUserFields, newsletterShape, postShape, roleShape, tagShape, tierShape, userShape,
} from './shapes.ts';
import type { Doc, Store } from './store.ts';
import {
  ApiError, type Obj, VERSION, firstRecord, invalid, isObj, newId, newUuid, noPermission, notFound, nowIso, paginate, slugify, str, uniqueSlug,
} from './util.ts';

export const API_PREFIX = '/app/api/admin';
export const SESSION_COOKIE = 'pressloft-admin-session';
const SESSION_DAYS = 184;

export interface ApiRequest {
  method: string;
  path: string; // path after API_PREFIX, e.g. /posts/abc/
  query: URLSearchParams;
  body: unknown;
  cookies: Record<string, string>;
  origin: string;
  hostname: string;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string | string[]>;
}

interface Session extends Doc {
  user_id: string;
  expires_at: string;
}

type Handler = (req: ApiRequest, ctx: Ctx & { user: UserDoc | null; params: string[] }) => ApiResponse;

const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
const listOf = <T>(name: string, items: T[], req: ApiRequest, defaultLimit = 15) => {
  const { items: page, pagination } = paginate(items, req.query, defaultLimit);
  return ok({ [name]: page, meta: { pagination } });
};

// ---- passwords and sessions --------------------------------------------------------------

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const tokenId = (token: string) => createHmac('sha256', 'pressloft-session').update(token).digest('hex');

function sessionUser(store: Store, cookies: Record<string, string>): UserDoc | null {
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = store.get<Session>('sessions', tokenId(token));
  if (!session) return null;
  if (Date.parse(session.expires_at) < Date.now()) {
    store.remove('sessions', session.id);
    return null;
  }
  const user = store.get<UserDoc>('users', session.user_id);
  return user && user.status !== 'inactive' ? user : null;
}

function sessionCookie(token: string, expires: Date): string {
  return `${SESSION_COOKIE}=${token}; Path=/app; Expires=${expires.toUTCString()}; HttpOnly; SameSite=Lax`;
}

// ---- helpers -----------------------------------------------------------------------------

const owner = (store: Store) => store.get<UserDoc>('users', '1');

function settingsMap(store: Store): Map<string, unknown> {
  return new Map(store.all<Doc & { key: string; value: unknown }>('settings').map((s) => [s.key, s.value]));
}

function calculatedValue(store: Store, key: string, settings: Map<string, unknown>, hostname: string): unknown {
  const access = settings.get('members_signup_access');
  switch (key) {
    case 'members_enabled':
      return access !== 'none';
    case 'members_invite_only':
      return access === 'invite';
    case 'allow_self_signup':
      return access === 'all';
    case 'default_email_address':
      return owner(store)?.email ?? `noreply@${hostname}`;
    case 'support_email_address': {
      const address = String(settings.get('members_support_address') ?? 'noreply');
      return address.includes('@') ? address : `${address}@${hostname}`;
    }
    case 'all_blocked_email_domains':
      return [];
    default:
      return settings.get(key) ?? null;
  }
}

function settingsList(store: Store, hostname: string, groups: Set<string> | null): { key: string; value: unknown }[] {
  const all = store.all<Doc & { key: string; group: string; value: unknown }>('settings');
  const map = new Map(all.map((s) => [s.key, s.value]));
  return all.filter((s) => !groups || groups.has(s.group)).map((s) => ({ key: s.key, value: CALCULATED.has(s.key) ? calculatedValue(store, s.key, map, hostname) : s.value }));
}

function setSetting(store: Store, key: string, value: unknown): void {
  const row = store.get<Doc & { key: string; value: unknown }>('settings', key);
  if (row) store.put('settings', { ...row, value });
}

function takenSlugs(store: Store, collection: string, exceptId?: string): Set<string> {
  return new Set(store.all<Doc & { slug: string }>(collection).filter((d) => d.id !== exceptId).map((d) => d.slug));
}

/** Tags referenced in a post body: by id when known, else by slug or name (new names create a tag). */
function resolveTags(store: Store, tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const ids: string[] = [];
  for (const raw of tags) {
    if (!isObj(raw)) continue;
    const all = store.all<TagDoc>('tags');
    let tag = typeof raw.id === 'string' ? all.find((t) => t.id === raw.id) : undefined;
    tag ??= typeof raw.slug === 'string' ? all.find((t) => t.slug === raw.slug) : undefined;
    tag ??= typeof raw.name === 'string' ? all.find((t) => t.name.toLowerCase() === String(raw.name).trim().toLowerCase()) : undefined;
    if (!tag && typeof raw.name === 'string' && raw.name.trim()) tag = createTag(store, { name: raw.name.trim() });
    if (tag && !ids.includes(tag.id)) ids.push(tag.id);
  }
  return ids;
}

const TAG_FIELDS = ['description', 'feature_image', 'og_image', 'og_title', 'og_description', 'twitter_image', 'twitter_title', 'twitter_description', 'meta_title', 'meta_description', 'codeinjection_head', 'codeinjection_foot', 'canonical_url', 'accent_color'];

function createTag(store: Store, body: Obj): TagDoc {
  const name = str(body.name)?.trim();
  if (!name) throw invalid('A tag needs a name.', null, { property: 'name' });
  const t = nowIso();
  const tag: TagDoc = {
    id: newId(),
    name,
    slug: uniqueSlug(slugify(str(body.slug) || name), takenSlugs(store, 'tags')),
    description: null,
    visibility: str(body.visibility) ?? 'public',
    created_at: t,
    updated_at: t,
  };
  for (const key of TAG_FIELDS) tag[key] = body[key] === undefined || body[key] === '' ? (tag[key] ?? null) : body[key];
  return store.put('tags', tag);
}

function resolveAuthors(store: Store, authors: unknown, fallback: string): string[] {
  const ids = Array.isArray(authors) ? authors.map((a) => (isObj(a) ? str(a.id) : null)).filter((id): id is string => !!id && !!store.get('users', id)) : [];
  return ids.length ? [...new Set(ids)] : [fallback];
}

const POST_FIELDS = [
  'feature_image', 'featured', 'visibility', 'custom_excerpt', 'codeinjection_head', 'codeinjection_foot', 'custom_template', 'canonical_url',
  'og_image', 'og_title', 'og_description', 'twitter_image', 'twitter_title', 'twitter_description', 'meta_title', 'meta_description',
  'email_subject', 'frontmatter', 'feature_image_alt', 'feature_image_caption', 'email_only',
];
const POST_STATUSES = new Set(['draft', 'published', 'scheduled']);

function revisionOf(post: PostDoc, reason: string, authorId: string): Revision {
  return {
    id: newId(), lexical: post.lexical, created_at_ts: Date.now(), created_at: nowIso(), title: post.title, post_status: post.status, reason,
    feature_image: (post.feature_image as string | null) ?? null, feature_image_alt: (post.feature_image_alt as string | null) ?? null,
    feature_image_caption: (post.feature_image_caption as string | null) ?? null, custom_excerpt: post.custom_excerpt, author_id: authorId,
  };
}

/** Fields that `filter` can address on a post: its stored fields plus tag/author slugs. */
function postFilterView(store: Store, post: PostDoc): Obj {
  const tagSlugs = post.tag_ids.map((id) => store.get<TagDoc>('tags', id)?.slug).filter(Boolean);
  const authorSlugs = post.author_ids.map((id) => store.get<UserDoc>('users', id)?.slug).filter(Boolean);
  return { ...post, tag: tagSlugs, tags: tagSlugs, author: authorSlugs, authors: authorSlugs, primary_tag: tagSlugs[0] ?? null };
}

function project(record: Obj, query: URLSearchParams): Obj {
  const fields = query.get('fields');
  if (!fields) return record;
  const keys = fields.split(',').map((f) => f.trim()).filter(Boolean);
  for (const format of (query.get('formats') ?? '').split(',').map((f) => f.trim())) if (format === 'mobiledoc' || format === 'lexical') keys.push(format);
  return Object.fromEntries(keys.filter((k) => k in record).map((k) => [k, record[k]]));
}

const day = (iso: string) => iso.slice(0, 10);

// ---- handlers ----------------------------------------------------------------------------

const getSetup: Handler = (_req, { store }) => ok({ setup: [{ status: !!owner(store) }] });

const postSetup: Handler = (req, ctx) => {
  const { store } = ctx;
  if (owner(store)) throw new ApiError(403, 'NoPermissionError', 'This site is already set up.', 'Sign in with the owner account instead.');
  const data = firstRecord(req.body, 'setup');
  const name = str(data.name)?.trim();
  const email = str(data.email)?.trim().toLowerCase();
  const password = str(data.password) ?? '';
  const blogTitle = str(data.blogTitle)?.trim() || 'My Pressloft site';
  if (!name) throw invalid('Please enter your name.', null, { property: 'name' });
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw invalid('Please enter a valid email address.', null, { property: 'email' });
  if (password.length < 8) throw invalid('Your password must be at least 8 characters long.');
  const ownerRole = store.all<RoleDoc>('roles').find((r) => r.name === 'Owner');
  const t = nowIso();
  const user: UserDoc = {
    id: '1', name, slug: slugify(name.split(/\s+/)[0] ?? name), email, password_hash: hashPassword(password), role_ids: ownerRole ? [ownerRole.id] : [],
    status: 'active', last_seen: null, created_at: t, updated_at: t, ...newUserFields(),
  };
  store.transaction(() => {
    store.put('users', user);
    setSetting(store, 'title', blogTitle);
    for (const nl of store.all<NewsletterDoc>('newsletters').slice(0, 1)) store.put('newsletters', { ...nl, name: blogTitle, updated_at: t });
    for (const tier of store.all<TierDoc>('tiers').filter((x) => x.type === 'paid').slice(0, 1)) store.put('tiers', { ...tier, name: blogTitle, updated_at: t });
    personalizeSample(store, blogTitle);
  });
  return ok({ users: [userShape(ctx, user)] }, 201);
};

const postSession: Handler = (req, { store }) => {
  const body = isObj(req.body) ? req.body : {};
  const email = str(body.username)?.trim().toLowerCase() ?? '';
  const password = str(body.password) ?? '';
  const user = store.all<UserDoc>('users').find((u) => u.email.toLowerCase() === email);
  if (!user) {
    throw invalid('There is no account with that email address.', 'Check the address you signed up with and try again.', { property: 'username' });
  }
  if (!verifyPassword(password, user.password_hash)) {
    throw invalid('That password does not match this account.', 'The password you entered is not the one saved for this account.', {
      code: 'PASSWORD_INCORRECT',
      help: 'Check for typing mistakes or caps lock, then try again.',
    });
  }
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  store.put('sessions', { id: tokenId(token), user_id: user.id, expires_at: expires.toISOString() });
  store.put('users', { ...user, last_seen: nowIso() });
  return { status: 201, text: 'Created', headers: { 'Set-Cookie': sessionCookie(token, expires) } };
};

const deleteSession: Handler = (req, { store }) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) store.remove('sessions', tokenId(token));
  return { status: 204, headers: { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/app; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax` } };
};

const getMe: Handler = (_req, ctx) => ok({ users: [userShape(ctx, ctx.user!, { roles: true })] });

const getUsers: Handler = (req, ctx) => {
  const users = applyOrder(applyFilter(ctx.store.all<UserDoc>('users'), req.query.get('filter')), req.query.get('order'), 'created_at asc');
  return listOf('users', users.map((u) => userShape(ctx, u, { roles: true })), req);
};

const getUser: Handler = (_req, ctx) => {
  const user = ctx.store.get<UserDoc>('users', ctx.params[0]!);
  if (!user) throw notFound('User');
  return ok({ users: [userShape(ctx, user, { roles: true })] });
};

const putUser: Handler = (req, ctx) => {
  const { store } = ctx;
  const user = store.get<UserDoc>('users', ctx.params[0]!);
  if (!user) throw notFound('User');
  if (ctx.user!.id !== user.id && ctx.user!.id !== '1') throw noPermission();
  const data = firstRecord(req.body, 'users');
  const next: UserDoc = { ...user };
  for (const key of USER_EDITABLE) if (data[key] !== undefined) next[key] = data[key];
  if (typeof data.name === 'string' && !data.name.trim()) throw invalid('A name is required.', null, { property: 'name' });
  if (typeof data.slug === 'string') next.slug = uniqueSlug(slugify(data.slug), takenSlugs(store, 'users', user.id));
  next.updated_at = nowIso();
  store.put('users', next);
  return ok({ users: [userShape(ctx, next, { roles: true })] });
};

const getConfig: Handler = () =>
  ok({
    config: {
      version: VERSION, environment: process.env.NODE_ENV ?? 'production', database: 'sqlite3', mail: 'Disabled', useGravatar: true,
      labs: LABS, clientExtensions: {}, enableDeveloperExperiments: false, stripeDirect: false, mailgunIsConfigured: false, emailAnalytics: true,
      tenor: { googleApiKey: null, contentFilter: 'off' },
      signupForm: { url: '/app/assets/signup-form.js?v={version}', version: '1.0' },
      security: { staffDeviceVerification: true },
    },
  });

const getSite: Handler = (req, { store }) => {
  const s = settingsMap(store);
  const meta = store.getMeta('site_uuid') ?? newUuid();
  store.setMeta('site_uuid', meta);
  return ok({
    site: {
      title: s.get('title'), description: s.get('description'), logo: s.get('logo') || null, icon: s.get('icon') || null, cover_image: s.get('cover_image') || null,
      accent_color: s.get('accent_color'), locale: s.get('locale'), url: `${req.origin}/`, version: VERSION.split('.').slice(0, 2).join('.'),
      allow_external_signup: s.get('members_signup_access') === 'all', site_uuid: meta,
    },
  });
};

const getSettings: Handler = (req, { store }) => {
  const group = req.query.get('group');
  const groups = group ? new Set(group.split(',').map((g) => g.trim())) : null;
  return ok({ settings: settingsList(store, req.hostname, groups), meta: group ? { filters: { group } } : {} });
};

const putSettings: Handler = (req, { store }) => {
  const list = isObj(req.body) && Array.isArray(req.body.settings) ? req.body.settings : null;
  if (!list) throw invalid('Expected a "settings" list.');
  store.transaction(() => {
    for (const item of list) {
      if (!isObj(item) || typeof item.key !== 'string' || CALCULATED.has(item.key)) continue;
      if (item.key === 'title' && (typeof item.value !== 'string' || !item.value.trim())) throw invalid('The site title cannot be empty.');
      setSetting(store, item.key, item.value ?? null);
    }
  });
  return ok({ settings: settingsList(store, req.hostname, null), meta: {} });
};

const getSlug: Handler = (req, { store, params }) => {
  const collection = params[0] === 'tag' ? 'tags' : params[0] === 'user' ? 'users' : 'posts';
  const base = slugify(decodeURIComponent(params[1] ?? ''));
  const exceptId = req.query.get('id') ?? undefined;
  return ok({ slugs: [{ slug: uniqueSlug(base, takenSlugs(store, collection, exceptId)) }] });
};

const allPosts = (store: Store, type: 'post' | 'page') => store.all<PostDoc>('posts').filter((p) => p.type === type);

const getPosts: Handler = (req, ctx) => {
  const { store } = ctx;
  const views = allPosts(store, 'post').map((p) => ({ post: p, view: postFilterView(store, p) }));
  const filtered = applyFilter(views.map((x) => ({ ...x.view, _seq: (x.post as { _seq?: number })._seq })), req.query.get('filter'));
  const ordered = applyOrder(filtered, req.query.get('order'), 'published_at desc');
  const posts = ordered.map((v) => views.find((x) => x.post.id === (v as { id?: unknown }).id)!.post);
  return listOf('posts', posts.map((p) => project(postShape(ctx, p), req.query)), req);
};

const getPost: Handler = (req, ctx) => {
  const post = ctx.store.get<PostDoc>('posts', ctx.params[0]!);
  if (!post || post.type !== 'post') throw notFound('Post');
  return ok({ posts: [project(postShape(ctx, post, { revisions: true }), req.query)] });
};

function applyPostFields(store: Store, post: PostDoc, data: Obj): void {
  for (const key of POST_FIELDS) if (data[key] !== undefined) post[key] = data[key];
  if (typeof data.title === 'string') post.title = data.title.trim() || '(Untitled)';
  if (data.lexical !== undefined) post.lexical = typeof data.lexical === 'string' ? data.lexical : null;
  if (data.mobiledoc !== undefined) post.mobiledoc = typeof data.mobiledoc === 'string' ? data.mobiledoc : null;
  if (typeof data.email_segment === 'string' && data.email_segment !== 'none') post.email_segment = data.email_segment;
  if (Array.isArray(data.tags)) post.tag_ids = resolveTags(store, data.tags);
  if (post.custom_excerpt === '') post.custom_excerpt = null;
}

const postPosts: Handler = (req, ctx) => {
  const { store } = ctx;
  const data = firstRecord(req.body, 'posts');
  const status = str(data.status) ?? 'draft';
  if (!POST_STATUSES.has(status)) throw invalid(`Unknown post status "${status}".`);
  const t = nowIso();
  const title = str(data.title)?.trim() || '(Untitled)';
  const post: PostDoc = {
    id: newId(), uuid: newUuid(), type: 'post', title, slug: uniqueSlug(slugify(str(data.slug) || title), takenSlugs(store, 'posts')),
    mobiledoc: null, lexical: lexicalFromText(''), status, visibility: 'public', created_at: t, updated_at: t,
    published_at: status === 'published' ? (str(data.published_at) ?? t) : null, custom_excerpt: null, email_segment: 'all',
    tag_ids: [], author_ids: resolveAuthors(store, data.authors, ctx.user!.id), revisions: [],
    feature_image: null, featured: false, codeinjection_head: null, codeinjection_foot: null, custom_template: null, canonical_url: null,
    og_image: null, og_title: null, og_description: null, twitter_image: null, twitter_title: null, twitter_description: null,
    meta_title: null, meta_description: null, email_subject: null, frontmatter: null, feature_image_alt: null, feature_image_caption: null, email_only: false,
  };
  applyPostFields(store, post, data);
  for (const key of ['codeinjection_head', 'codeinjection_foot']) if (post[key] === '') post[key] = null;
  post.revisions = [revisionOf(post, 'initial_revision', ctx.user!.id)];
  store.put('posts', post);
  return ok({ posts: [postShape(ctx, post, { revisions: true })] }, 201);
};

const putPost: Handler = (req, ctx) => {
  const { store } = ctx;
  const current = store.get<PostDoc>('posts', ctx.params[0]!);
  if (!current || current.type !== 'post') throw notFound('Post');
  const data = firstRecord(req.body, 'posts');
  if (typeof data.updated_at === 'string' && data.updated_at !== current.updated_at) {
    throw new ApiError(409, 'UpdateCollisionError', 'This post was changed somewhere else since you opened it.', 'Reload the post to see the latest version before saving.');
  }
  const post: PostDoc = { ...current, revisions: [...current.revisions] };
  applyPostFields(store, post, data);
  if (Array.isArray(data.authors)) post.author_ids = resolveAuthors(store, data.authors, current.author_ids[0] ?? ctx.user!.id);
  if (typeof data.slug === 'string' && data.slug.trim() && data.slug !== current.slug) post.slug = uniqueSlug(slugify(data.slug), takenSlugs(store, 'posts', post.id));
  const status = str(data.status) ?? current.status;
  if (!POST_STATUSES.has(status)) throw invalid(`Unknown post status "${status}".`);
  post.status = status;
  if (status === 'published') post.published_at = current.status === 'published' ? (str(data.published_at) ?? current.published_at ?? nowIso()) : (str(data.published_at) ?? nowIso());
  else if (status === 'draft') post.published_at = null;
  else post.published_at = str(data.published_at) ?? current.published_at;
  post.updated_at = nowIso();
  if (status === 'published') post.revisions.push(revisionOf(post, 'published', ctx.user!.id));
  store.put('posts', post);
  return ok({ posts: [postShape(ctx, post, { revisions: true })] });
};

const deletePost: Handler = (_req, { store, params }) => {
  const post = store.get<PostDoc>('posts', params[0]!);
  if (!post || post.type !== 'post') throw notFound('Post');
  store.remove('posts', post.id);
  return { status: 204 };
};

const postMemberCounts: Handler = (req) => {
  const ids = isObj(req.body) && Array.isArray(req.body.postIds) ? req.body.postIds.filter((id): id is string => typeof id === 'string') : [];
  return ok({ stats: [Object.fromEntries(ids.map((id) => [id, { free_members: 0, paid_members: 0 }]))] });
};

const searchIndex: Handler = (_req, ctx) => {
  const { store, origin } = ctx;
  const kind = ctx.params[0]!;
  if (kind === 'users') return ok({ users: store.all<UserDoc>('users').map((u) => ({ id: u.id, slug: u.slug, name: u.name, url: `${origin}/author/${u.slug}/`, profile_image: u.profile_image ?? null })) });
  if (kind === 'tags') {
    const posts = store.all<PostDoc>('posts');
    return ok({ tags: applyOrder(store.all<TagDoc>('tags'), 'created_at desc', '').map((t) => { const s = tagShape(ctx, t, posts); return { id: s.id, slug: s.slug, name: s.name, url: s.url }; }) });
  }
  const type = kind === 'pages' ? 'page' : 'post';
  const items = applyOrder(allPosts(store, type), 'published_at desc', '').map((p) => {
    const s = postShape(ctx, p);
    return { id: s.id, url: s.url, title: s.title, status: s.status, published_at: s.published_at, visibility: s.visibility };
  });
  return ok({ [kind]: items });
};

const getTags: Handler = (req, ctx) => {
  const posts = ctx.store.all<PostDoc>('posts');
  const tags = applyOrder(applyFilter(ctx.store.all<TagDoc>('tags'), req.query.get('filter')), req.query.get('order'), 'name asc');
  const withCount = (req.query.get('include') ?? '').includes('count.posts');
  return listOf('tags', tags.map((t) => ({ ...tagShape(ctx, t, posts), ...(withCount ? { count: { posts: posts.filter((p) => p.tag_ids.includes(t.id)).length } } : {}) })), req);
};

const getTag: Handler = (_req, ctx) => {
  const tag = ctx.store.get<TagDoc>('tags', ctx.params[0]!);
  if (!tag) throw notFound('Tag');
  return ok({ tags: [tagShape(ctx, tag)] });
};

const postTags: Handler = (req, ctx) => ok({ tags: [tagShape(ctx, createTag(ctx.store, firstRecord(req.body, 'tags')))] }, 201);

const getMembers: Handler = (req, ctx) => {
  const members = applyOrder(applyFilter(ctx.store.all<MemberDoc>('members'), req.query.get('filter')), req.query.get('order'), 'created_at desc');
  return listOf('members', members.map((m) => memberShape(ctx, m)), req);
};

const getMember: Handler = (_req, ctx) => {
  const member = ctx.store.get<MemberDoc>('members', ctx.params[0]!);
  if (!member) throw notFound('Member');
  return ok({ members: [memberShape(ctx, member, { attribution: true })] });
};

const postMembers: Handler = (req, ctx) => {
  const { store } = ctx;
  const data = firstRecord(req.body, 'members');
  const email = str(data.email)?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalid('Please enter a valid email address.', 'A member needs an email address that can receive mail.', { property: 'email' });
  }
  if (store.all<MemberDoc>('members').some((m) => m.email === email)) {
    throw invalid('This member could not be saved.', 'Another member already uses this email address.', { property: 'email' });
  }
  const newsletters = store.all<NewsletterDoc>('newsletters');
  let newsletterIds: string[];
  if (Array.isArray(data.newsletters)) newsletterIds = data.newsletters.map((n) => (isObj(n) ? str(n.id) : null)).filter((id): id is string => !!id && newsletters.some((n) => n.id === id));
  else newsletterIds = data.subscribed === false ? [] : newsletters.filter((n) => n.status === 'active' && n.subscribe_on_signup).map((n) => n.id);
  const t = nowIso();
  const member: MemberDoc = {
    id: newId(), uuid: newUuid(), email, name: str(data.name)?.trim() || null, note: str(data.note)?.trim() || null, status: 'free',
    subscribed: newsletterIds.length > 0, newsletter_ids: newsletterIds, source: 'Created manually', created_at: t, updated_at: t,
    unsubscribe_key: randomBytes(16).toString('hex'),
  };
  store.put('members', member);
  return ok({ members: [memberShape(ctx, member, { attribution: true })] }, 201);
};

const getMemberEvents: Handler = (req) => {
  const limit = req.query.get('limit') ?? '15';
  return ok({ events: [], meta: { pagination: { limit, total: 0, pages: 0, page: null, next: null, prev: null } } });
};

/** Cumulative member totals per day on which members joined. */
const getMemberCount: Handler = (_req, { store }) => {
  const members = applyOrder(store.all<MemberDoc>('members'), 'created_at asc', '');
  const data: { date: string; paid: number; free: number; comped: number }[] = [];
  let free = 0;
  for (const m of members) {
    free++;
    const date = day(m.created_at);
    const last = data[data.length - 1];
    if (last && last.date === date) last.free = free;
    else data.push({ date, paid: 0, free, comped: 0 });
  }
  return ok({ resource: 'members', total: members.length, data });
};

/** Daily cumulative totals from the day before the first member (or yesterday) up to today. */
const getStatsMemberCount: Handler = (_req, { store }) => {
  const members = store.all<MemberDoc>('members');
  const today = day(new Date().toISOString());
  const first = members.reduce((min, m) => (day(m.created_at) < min ? day(m.created_at) : min), today);
  const stats: Obj[] = [];
  for (let d = new Date(Date.parse(`${first}T00:00:00Z`) - 86_400_000); day(d.toISOString()) <= today; d = new Date(d.getTime() + 86_400_000)) {
    const date = day(d.toISOString());
    stats.push({ date, paid: 0, free: members.filter((m) => day(m.created_at) <= date).length, comped: 0, paid_subscribed: 0, paid_canceled: 0 });
  }
  return ok({ stats, meta: { totals: { paid: 0, free: members.length, comped: 0 } } });
};

const getReferrers: Handler = (_req, { store }) => {
  const rows = new Map<string, Obj & { signups: number }>();
  for (const m of applyOrder(store.all<MemberDoc>('members'), 'created_at asc', '')) {
    const key = `${day(m.created_at)}|${m.source}`;
    const row = rows.get(key) ?? { date: day(m.created_at), signups: 0, source: m.source, paid_conversions: 0 };
    row.signups++;
    rows.set(key, row);
  }
  return ok({ stats: [...rows.values()], meta: {} });
};

const getRoles: Handler = (req, { store }) => {
  const roles = applyFilter(store.all<RoleDoc>('roles'), req.query.get('filter'));
  return ok({ roles: roles.map(roleShape) });
};

const getTiers: Handler = (req, { store }) => {
  const tiers = applyFilter(store.all<TierDoc>('tiers'), req.query.get('filter'));
  return listOf('tiers', tiers.map(tierShape), req);
};

const getNewsletters: Handler = (req, ctx) => {
  let list = ctx.store.all<NewsletterDoc>('newsletters');
  const status = req.query.get('status');
  if (status) list = list.filter((n) => n.status === status);
  list = applyOrder(applyFilter(list, req.query.get('filter')), req.query.get('order'), 'sort_order asc');
  const withCount = /count\./.test(req.query.get('include') ?? '');
  return listOf('newsletters', list.map((n) => newsletterShape(ctx, n, withCount)), req);
};

const themeOut = (t: (typeof THEMES)[number]) => ({ ...t });
const getThemes: Handler = () => ok({ themes: THEMES.map(themeOut) });
const getActiveTheme: Handler = () => ok({ themes: THEMES.filter((t) => t.active).map(themeOut) });

const getIntegrations: Handler = (req, { store }) => {
  const list = store.all<Doc & { api_keys: Obj[] }>('integrations').map(({ _seq, ...rest }) => {
    void _seq;
    return { ...rest, api_keys: rest.api_keys.map((k) => ({ ...k })) };
  });
  return listOf('integrations', list, req);
};

const emptyList = (name: string, meta: 'paged' | 'none' | 'zero-pages'): Handler => (req) => {
  if (meta === 'none') return ok({ [name]: [] });
  const { pagination } = paginate([], req.query);
  return ok({ [name]: [], meta: { pagination: meta === 'zero-pages' ? { ...pagination, pages: 0 } : pagination } });
};

// ---- routing -----------------------------------------------------------------------------

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  public?: boolean;
}

const ID = '([^/]+)';
const routes: Route[] = [
  { method: 'GET', pattern: /^\/authentication\/setup\/$/, handler: getSetup, public: true },
  { method: 'POST', pattern: /^\/authentication\/setup\/$/, handler: postSetup, public: true },
  { method: 'POST', pattern: /^\/session\/?$/, handler: postSession, public: true },
  { method: 'DELETE', pattern: /^\/session\/?$/, handler: deleteSession, public: true },
  { method: 'GET', pattern: /^\/site\/$/, handler: getSite, public: true },
  { method: 'GET', pattern: /^\/users\/me\/$/, handler: getMe },
  { method: 'GET', pattern: /^\/users\/$/, handler: getUsers },
  { method: 'GET', pattern: new RegExp(`^/users/${ID}/$`), handler: getUser },
  { method: 'PUT', pattern: new RegExp(`^/users/${ID}/$`), handler: putUser },
  { method: 'GET', pattern: /^\/config\/$/, handler: getConfig },
  { method: 'GET', pattern: /^\/settings\/$/, handler: getSettings },
  { method: 'PUT', pattern: /^\/settings\/$/, handler: putSettings },
  { method: 'GET', pattern: new RegExp(`^/slugs/(post|tag|user)/${ID}/$`), handler: getSlug },
  { method: 'GET', pattern: /^\/posts\/$/, handler: getPosts },
  { method: 'POST', pattern: /^\/posts\/$/, handler: postPosts },
  { method: 'GET', pattern: new RegExp(`^/posts/${ID}/$`), handler: getPost },
  { method: 'PUT', pattern: new RegExp(`^/posts/${ID}/$`), handler: putPost },
  { method: 'DELETE', pattern: new RegExp(`^/posts/${ID}/$`), handler: deletePost },
  { method: 'POST', pattern: /^\/stats\/posts-member-counts\/$/, handler: postMemberCounts },
  { method: 'GET', pattern: /^\/search-index\/(users|tags|posts|pages)\/$/, handler: searchIndex },
  { method: 'GET', pattern: /^\/tags\/$/, handler: getTags },
  { method: 'POST', pattern: /^\/tags\/$/, handler: postTags },
  { method: 'GET', pattern: new RegExp(`^/tags/${ID}/$`), handler: getTag },
  { method: 'GET', pattern: /^\/members\/events\/$/, handler: getMemberEvents },
  { method: 'GET', pattern: /^\/members\/stats\/count\/$/, handler: getMemberCount },
  { method: 'GET', pattern: /^\/members\/$/, handler: getMembers },
  { method: 'POST', pattern: /^\/members\/$/, handler: postMembers },
  { method: 'GET', pattern: new RegExp(`^/members/${ID}/$`), handler: getMember },
  { method: 'GET', pattern: /^\/stats\/member_count\/$/, handler: getStatsMemberCount },
  { method: 'GET', pattern: /^\/stats\/referrers\/$/, handler: getReferrers },
  { method: 'GET', pattern: /^\/roles\/$/, handler: getRoles },
  { method: 'GET', pattern: /^\/tiers\/$/, handler: getTiers },
  { method: 'GET', pattern: /^\/newsletters\/$/, handler: getNewsletters },
  { method: 'GET', pattern: /^\/themes\/$/, handler: getThemes },
  { method: 'GET', pattern: /^\/themes\/active\/$/, handler: getActiveTheme },
  { method: 'GET', pattern: /^\/integrations\/$/, handler: getIntegrations },
  { method: 'GET', pattern: /^\/labels\/$/, handler: emptyList('labels', 'paged') },
  { method: 'GET', pattern: /^\/offers\/$/, handler: emptyList('offers', 'none') },
  { method: 'GET', pattern: /^\/snippets\/$/, handler: emptyList('snippets', 'paged') },
  { method: 'GET', pattern: /^\/invites\/$/, handler: emptyList('invites', 'paged') },
  { method: 'GET', pattern: /^\/recommendations\/$/, handler: emptyList('recommendations', 'zero-pages') },
  { method: 'GET', pattern: /^\/incoming_recommendations\/$/, handler: emptyList('recommendations', 'paged') },
  { method: 'GET', pattern: /^\/notifications\/$/, handler: emptyList('notifications', 'none') },
];

export function handleApi(store: Store, req: ApiRequest): ApiResponse {
  const matching = routes.filter((r) => r.pattern.test(req.path));
  const route = matching.find((r) => r.method === req.method);
  if (!route) {
    if (matching.length) throw new ApiError(405, 'MethodNotAllowedError', 'This method is not supported here.');
    throw new ApiError(404, 'NotFoundError', 'Resource not found.', `No API endpoint matches ${req.path}.`);
  }
  const user = sessionUser(store, req.cookies);
  if (!route.public && !user) throw noPermission();
  const params = (req.path.match(route.pattern) ?? []).slice(1).map((p) => decodeURIComponent(p));
  return route.handler(req, { store, origin: req.origin, user, params });
}
