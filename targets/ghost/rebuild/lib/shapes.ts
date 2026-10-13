// Record types as stored, and the response shapes built from them.

import { excerptOf, lexicalText, mobiledocText, readingTime } from './content.ts';
import type { Doc, Store } from './store.ts';

export interface UserDoc extends Doc {
  name: string;
  slug: string;
  email: string;
  password_hash: string;
  role_ids: string[];
  status: string;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoleDoc extends Doc {
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface Revision {
  id: string;
  lexical: string | null;
  created_at_ts: number;
  created_at: string;
  title: string;
  post_status: string;
  reason: string;
  feature_image: string | null;
  feature_image_alt: string | null;
  feature_image_caption: string | null;
  custom_excerpt: string | null;
  author_id: string;
}

export interface PostDoc extends Doc {
  uuid: string;
  type: 'post' | 'page';
  title: string;
  slug: string;
  mobiledoc: string | null;
  lexical: string | null;
  status: string;
  visibility: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  custom_excerpt: string | null;
  email_segment: string;
  tag_ids: string[];
  author_ids: string[];
  revisions: Revision[];
}

export interface TagDoc extends Doc {
  name: string;
  slug: string;
  description: string | null;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export interface TierDoc extends Doc {
  name: string;
  slug: string;
  type: 'free' | 'paid';
  active: boolean;
  currency: string | null;
  created_at: string;
}

export interface NewsletterDoc extends Doc {
  name: string;
  description: string | null;
  status: string;
  subscribe_on_signup: boolean;
}

export interface MemberDoc extends Doc {
  uuid: string;
  email: string;
  name: string | null;
  note: string | null;
  status: string;
  subscribed: boolean;
  newsletter_ids: string[];
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Ctx {
  store: Store;
  origin: string;
}

const USER_SOCIAL = ['facebook', 'twitter', 'threads', 'bluesky', 'mastodon', 'tiktok', 'youtube', 'instagram', 'linkedin'] as const;
const USER_NOTIFY: [string, boolean][] = [
  ['comment_notifications', true],
  ['free_member_signup_notification', true],
  ['paid_subscription_started_notification', true],
  ['paid_subscription_canceled_notification', false],
  ['mention_notifications', true],
  ['recommendation_notifications', true],
  ['milestone_notifications', true],
  ['donation_notifications', true],
];
/** Fields a `PUT /users/{id}/` may change. */
export const USER_EDITABLE = ['name', 'slug', 'email', 'profile_image', 'cover_image', 'bio', 'website', 'location', ...USER_SOCIAL, 'accessibility', 'meta_title', 'meta_description', 'tour', ...USER_NOTIFY.map(([k]) => k)];

export function newUserFields(): Record<string, unknown> {
  return {
    profile_image: null, cover_image: null, bio: null, website: null, location: null,
    ...Object.fromEntries(USER_SOCIAL.map((k) => [k, null])),
    accessibility: null, meta_title: null, meta_description: null, tour: null,
    ...Object.fromEntries(USER_NOTIFY),
  };
}

const v = (doc: Doc, key: string, fallback: unknown = null) => (doc[key] === undefined ? fallback : doc[key]);

export function roleShape(role: RoleDoc): Record<string, unknown> {
  return { id: role.id, name: role.name, description: role.description, created_at: role.created_at, updated_at: role.updated_at };
}

export function userShape(ctx: Ctx, user: UserDoc, opts: { roles?: boolean; revisionAuthor?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: user.id,
    name: user.name,
    slug: user.slug,
    email: user.email,
    profile_image: v(user, 'profile_image'),
    cover_image: v(user, 'cover_image'),
    bio: v(user, 'bio'),
    website: v(user, 'website'),
    location: v(user, 'location'),
    ...Object.fromEntries(USER_SOCIAL.map((k) => [k, v(user, k)])),
    accessibility: v(user, 'accessibility'),
    status: user.status,
    ...(opts.revisionAuthor ? { locale: null, visibility: 'public' } : {}),
    meta_title: v(user, 'meta_title'),
    meta_description: v(user, 'meta_description'),
    tour: v(user, 'tour'),
    last_seen: user.last_seen,
    ...Object.fromEntries(USER_NOTIFY.map(([k, d]) => [k, v(user, k, d)])),
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
  if (opts.revisionAuthor) return out;
  if (opts.roles) out.roles = user.role_ids.map((id) => ctx.store.get<RoleDoc>('roles', id)).filter((r): r is RoleDoc => !!r).map(roleShape);
  out.url = `${ctx.origin}/author/${user.slug}/`;
  return out;
}

export function tagShape(ctx: Ctx, tag: TagDoc, posts?: PostDoc[]): Record<string, unknown> {
  const used = (posts ?? ctx.store.all<PostDoc>('posts')).some((p) => p.status === 'published' && p.tag_ids.includes(tag.id));
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'name', 'slug', 'description', 'feature_image', 'visibility', 'og_image', 'og_title', 'og_description', 'twitter_image', 'twitter_title', 'twitter_description', 'meta_title', 'meta_description', 'codeinjection_head', 'codeinjection_foot', 'canonical_url', 'accent_color', 'created_at', 'updated_at']) out[key] = v(tag, key);
  out.url = used ? `${ctx.origin}/tag/${tag.slug}/` : `${ctx.origin}/404/`;
  return out;
}

/** A tier as embedded in a post (`include=tiers`): lowercase currency, price ids. */
export function postTierShape(tier: TierDoc): Record<string, unknown> {
  const paid = tier.type === 'paid';
  return {
    id: tier.id, name: tier.name, slug: tier.slug, active: tier.active, welcome_page_url: v(tier, 'welcome_page_url'), visibility: v(tier, 'visibility', 'public'), trial_days: v(tier, 'trial_days', 0), description: v(tier, 'description'), type: tier.type,
    currency: paid && tier.currency ? tier.currency.toLowerCase() : null, monthly_price: paid ? v(tier, 'monthly_price') : null, yearly_price: paid ? v(tier, 'yearly_price') : null,
    created_at: tier.created_at, updated_at: v(tier, 'updated_at'), monthly_price_id: null, yearly_price_id: null,
  };
}

/** A tier as listed by `GET /tiers/`. Free tiers carry no price fields. */
export function tierShape(tier: TierDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: tier.id, name: tier.name, description: v(tier, 'description'), slug: tier.slug, active: tier.active, type: tier.type, welcome_page_url: v(tier, 'welcome_page_url'), created_at: tier.created_at, updated_at: v(tier, 'updated_at'), visibility: v(tier, 'visibility', 'public'), benefits: v(tier, 'benefits', []),
  };
  if (tier.type === 'paid') Object.assign(out, { currency: tier.currency, monthly_price: v(tier, 'monthly_price'), yearly_price: v(tier, 'yearly_price') });
  out.trial_days = v(tier, 'trial_days', 0);
  return out;
}

export function postText(post: PostDoc): string {
  return post.lexical ? lexicalText(post.lexical) : mobiledocText(post.mobiledoc);
}

export function postUrl(ctx: Ctx, post: PostDoc): string {
  return post.status === 'published' ? `${ctx.origin}/${post.slug}/` : `${ctx.origin}/p/${post.uuid}/`;
}

export function postShape(ctx: Ctx, post: PostDoc, opts: { revisions?: boolean } = {}): Record<string, unknown> {
  const { store } = ctx;
  const allPosts = store.all<PostDoc>('posts');
  const tags = post.tag_ids.map((id) => store.get<TagDoc>('tags', id)).filter((t): t is TagDoc => !!t).map((t) => tagShape(ctx, t, allPosts));
  const authors = post.author_ids.map((id) => store.get<UserDoc>('users', id)).filter((u): u is UserDoc => !!u).map((u) => userShape(ctx, u, { roles: true }));
  const tiers = post.visibility === 'public' ? store.all<TierDoc>('tiers').filter((t) => t.active).map(postTierShape) : [];
  const text = postText(post);
  const out: Record<string, unknown> = {
    id: post.id, uuid: post.uuid, title: post.title, slug: post.slug, mobiledoc: post.mobiledoc, lexical: post.lexical, comment_id: post.id,
    feature_image: v(post, 'feature_image'), featured: v(post, 'featured', false), status: post.status, visibility: post.visibility,
    created_at: post.created_at, updated_at: post.updated_at, published_at: post.published_at,
    custom_excerpt: post.custom_excerpt, codeinjection_head: v(post, 'codeinjection_head'), codeinjection_foot: v(post, 'codeinjection_foot'), custom_template: v(post, 'custom_template'), canonical_url: v(post, 'canonical_url'),
    tags, authors, tiers,
  };
  if (opts.revisions) {
    out.post_revisions = post.revisions.map((r) => {
      const author = store.get<UserDoc>('users', r.author_id);
      const { author_id, ...rest } = r;
      void author_id;
      return { ...rest, post_id: post.id, author: author ? userShape(ctx, author, { revisionAuthor: true }) : null };
    });
  }
  Object.assign(out, {
    count: { clicks: 0, positive_feedback: 0, negative_feedback: 0 },
    primary_author: authors[0] ?? null,
    primary_tag: tags[0] ?? null,
    email_segment: post.email_segment,
    url: postUrl(ctx, post),
    excerpt: post.custom_excerpt ?? excerptOf(text),
    reading_time: readingTime(text),
  });
  for (const key of ['og_image', 'og_title', 'og_description', 'twitter_image', 'twitter_title', 'twitter_description', 'meta_title', 'meta_description', 'email_subject', 'frontmatter', 'feature_image_alt', 'feature_image_caption']) out[key] = v(post, key);
  Object.assign(out, { email_only: v(post, 'email_only', false), email: null, newsletter: null });
  return out;
}

export function newsletterShape(ctx: Ctx, nl: NewsletterDoc, withCount: boolean): Record<string, unknown> {
  const { _seq, ...rest } = nl as NewsletterDoc & { _seq?: number };
  void _seq;
  if (!withCount) return rest;
  const activeMembers = ctx.store.all<MemberDoc>('members').filter((m) => m.subscribed && m.newsletter_ids.includes(nl.id)).length;
  return { ...rest, count: { posts: 0, active_members: activeMembers } };
}

export function memberShape(ctx: Ctx, m: MemberDoc, opts: { attribution?: boolean } = {}): Record<string, unknown> {
  const newsletters = m.newsletter_ids.map((id) => ctx.store.get<NewsletterDoc>('newsletters', id)).filter((n): n is NewsletterDoc => !!n).map((n) => ({ id: n.id, name: n.name, description: n.description, status: n.status }));
  const out: Record<string, unknown> = {
    id: m.id, uuid: m.uuid, email: m.email, name: m.name, note: m.note, geolocation: null, subscribed: m.subscribed,
    created_at: m.created_at, updated_at: m.updated_at, labels: [], subscriptions: [],
    avatar_image: `${ctx.origin}/app/avatar/${m.id}.svg`, comped: false, email_count: 0, email_opened_count: 0, email_open_rate: null, status: m.status, last_seen_at: null,
  };
  if (opts.attribution) out.attribution = { id: null, type: null, url: null, title: null, referrer_source: m.source, referrer_medium: 'Pressloft admin', referrer_url: null };
  Object.assign(out, {
    unsubscribe_url: `${ctx.origin}/unsubscribe/?uuid=${m.uuid}&key=${String(v(m, 'unsubscribe_key', ''))}`,
    tiers: [],
    email_suppression: { suppressed: false, info: null },
    newsletters,
  });
  return out;
}
