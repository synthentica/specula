# Publishing admin: rebuild specification

This folder describes the admin backend of a self-hosted publishing platform
(posts, tags, members, newsletters, site settings) as it was observed from the
browser: 11 recorded user flows, 151 API exchanges. It is everything a rebuild
may use.

| File | What it holds |
|---|---|
| `SPEC.md` | This document: features, behaviour, data model, what was not observed |
| `openapi.yaml` / `openapi.json` | OpenAPI 3.1 for the 46 observed operations, with schemas inferred from real responses |
| `flows/*.json` | The recorded flows as request/response steps; the parity suite replays them |

**Observed** means a recorded request or response shows it (each claim names a
flow step, `flows/<flow>.json` step *n*, counted from 1). **Inferred** means it
follows from observations but was not seen directly. Anything else is unknown
and listed at the end. `x-observed-values` in the OpenAPI document lists values
that were seen, not a closed enum.

UI labels in `flows/*.json` (`action.target.name`) describe the original UI so
the flows are readable. A rebuild uses its own name, wording and look. Text that
the original shipped as seed content (a sample post and page, a sample tag,
theme descriptions, integration names) appears in recorded responses; a rebuild
returns its own seed text in the same shapes (section 4.1).

## 1. Scope

Build: first-run owner setup, session login and logout, the current user and the
user list, posts (create a draft, save, publish, list by status, read, delete,
slug check, revision history), tags (create, read, list), members (create, list,
read, activity events, counts), site settings (read, update), site info, server
config, roles, tiers, newsletters, themes (list, active), the editor search index,
and the dashboard stats endpoints seen in the flows.

Observed but not built beyond the recorded responses (all were empty lists or
fixed objects): labels, offers, snippets, invites, integrations,
recommendations, incoming recommendations, notifications. Return their recorded
shapes with the rebuild's own seed data.

## 2. API conventions (observed)

- Base path `/app/api/admin`. Every path ends with `/` except `/session`.
- JSON in and out. `POST /session` answers `text/plain`; `DELETE` answers 204
  with no body.
- **Resource envelopes.** Requests and responses wrap records in an array named
  after the resource, even for one record: `{ "posts": [ { ... } ] }`,
  `{ "tags": [ { ... } ] }`, `{ "members": [ ... ] }`, `{ "users": [ ... ] }`
  (`flows/create-post.json` step 9, `flows/tags.json` step 1). Singletons
  follow the same rule: `{ "site": { ... } }`, `{ "config": { ... } }`,
  `{ "setup": [ { "status": true } ] }`.
- **Pagination.** Lists add `meta.pagination = { page, limit, pages, total,
  next, prev }` (`flows/posts-list.json` step 3). `next` is the next page number
  or `null` (`flows/publish-post.json` step 9: `limit=1`, 2 posts → `pages: 2,
  next: 2`). Some lists have no `meta` (`/offers/`, `/notifications/`, the
  search index). The member events list reports `limit` as a string and `page:
  null` (`flows/members.json` step 10).
- **Ids** are 24-character lowercase hex strings, unique per record, except the
  owner user, whose id is `"1"` (`flows/setup.json` step 1). Path parameters
  are these ids.
- **Timestamps** are ISO 8601 UTC with whole seconds: `2026-10-11T11:21:39.000Z`.
  Revisions also carry `created_at_ts` in epoch milliseconds.
- **Query parameters** shared by list and read endpoints:
  - `limit`, `page`;
  - `order`: `"<field> asc|desc"` (`published_at desc`, `updated_at desc`,
    `name asc`, `created_at desc`, `id`);
  - `include`: comma-separated relations to embed (`tags,authors,authors.roles,
    tiers,count.clicks,post_revisions,post_revisions.author,newsletters,labels,
    roles,count.active_members,count.posts,api_keys,webhooks`). The flows always
    send the same `include` per endpoint, so a rebuild may always embed what the
    flows show;
  - `fields`: projection. `fields=id,url,title,visibility,published_at` returns
    exactly those keys plus the content keys asked for by `formats`
    (`flows/create-post.json` step 2: 7 keys);
  - `formats=mobiledoc,lexical`: include those two content fields (`mobiledoc`
    is always `null` in the recordings; `lexical` holds the editor document as a
    JSON string);
  - `filter`: see section 2.1;
  - `allFilter`: sent by the client next to `filter`; it does not change the
    result. Ignore it.
- **Errors** are `{ "errors": [ { message, context, type, details, property,
  help, code, id, appErrorCode } ] }` with a JSON content type. `message` and
  `context` are human sentences (use your own wording); `type` names the kind
  of error and `property` the offending field. Observed errors are listed in
  section 5.1.
- The client sends `Origin` on writes, `X-Requested-With: XMLHttpRequest`, a
  version header and `App-Pragma: no-cache`. The parity suite sends only
  `App-Pragma: no-cache` (`headers` in `flows/index.json`), so a rebuild must
  not require the others.

### 2.1 Filter expressions (observed)

`filter` is a small query language:

| Form | Example | Meaning |
|---|---|---|
| `field:value` | `status:published`, `type:paid`, `id:<id>` | equals |
| `field:[a,b]` | `status:[published,sent]` | one of |
| `field:-[a,b]` | `type:-[comment_event,aggregated_click_event]` | none of |
| `field:<'time'`, `field:<='time'` | `created_at:<='2026-10-11 11:23:08'` | compare, time as `YYYY-MM-DD HH:mm:ss` UTC |
| `field:'value'` | `data.member_id:'<id>'` | quoted value |
| `a+b` | `type:paid+active:true` | and |

Dotted fields (`data.created_at`) address nested values. In a query string `+`
decodes to a space, so accept a space as "and" too. Unknown fields: not
observed.

## 3. Authentication (observed)

1. `GET /authentication/setup/` → `{ setup: [ { status } ] }`; `status` is
   `true` once an owner exists (`flows/logout-login.json` step 5). Public.
2. `POST /authentication/setup/` with `{ setup: [ { name, email, password,
   blogTitle } ] }` → 201 `{ users: [ owner ] }` (`flows/setup.json` step 1).
   It creates the owner (id `"1"`, role `Owner`, a short slug from the first word of the name),
   and sets the site title, the default newsletter's name and the paid tier's
   name to `blogTitle` (`flows/members.json` step 3, `flows/settings.json`
   step 9).
3. `POST /session` with `{ username: <email>, password }` → 201, `text/plain`
   body, and a session cookie: `HttpOnly; SameSite=Lax; Path=/app`, expiring
   in about six months (`flows/setup.json` step 2). The client then calls every
   endpoint with that cookie only (no bearer token).
4. `DELETE /session` → 204. The server ends the session: the response sets the
   cookie again, but later requests with it get 403 (`flows/logout-login.json`
   steps 1-3). Signing in again issues a working cookie (step 6).
5. Every endpoint other than the two in 1-2 and `GET /site/` requires a valid
   session (inferred from step 2-4 of `logout-login`: `/site/` answered 200
   and `/users/me/` 403 with the ended session).
6. `POST /session` with a wrong password → 422 `ValidationError`, `code:
   "PASSWORD_INCORRECT"`, and no cookie (`flows/session-expired.json` step 6).
7. There is no token refresh: the session cookie lasts about six months and is
   not renewed by use. What the client does when its session is gone is
   recorded in `flows/session-expired.json`: the session ends (step 1), the
   user opens a deep link (the tag list), `/users/me/` answers 403 (steps 2-3),
   the client shows its sign-in screen, a wrong password fails (step 6), the
   right one succeeds (step 7), and the client loads the deep link it was asked
   for (step 14). The server side of this is rules 4-6.

## 4. Data model (observed, from responses)

Full field lists and types are in `openapi.yaml` under `components.schemas`
and in the flow responses.

**User** (36 fields): `id, name, slug, email, profile_image, cover_image, bio,
website, location`, social handles, `accessibility` (a JSON string the client
writes), `status`, `meta_title, meta_description, tour, last_seen`,
notification switches, `created_at, updated_at`, `roles` (with
`include=roles`), `url`. `PUT /users/{id}/` takes the whole user and returns it
(`flows/setup.json` step 9).

**Post** (44 fields in lists, plus `post_revisions` on single reads and writes):
`id, uuid, title, slug, mobiledoc, lexical, comment_id` (equals `id`),
`feature_image, featured, status` (`draft` or `published`), `visibility`
(`public`), `created_at, updated_at, published_at`, SEO and social fields,
`tags, authors, tiers, count { clicks, positive_feedback, negative_feedback }`,
`primary_author, primary_tag, email_segment` (`all`), `url, excerpt,
reading_time, email, newsletter, email_only, frontmatter`.
- `url` is `<origin>/p/<uuid>/` while a draft and `<origin>/<slug>/` once
  published (`flows/create-post.json` step 9, `flows/publish-post.json` step 2).
- `primary_tag` / `primary_author` are the first of `tags` / `authors`.
- `tiers` lists all active tiers (2) for a public post.

**Revision** (`post_revisions[]`): `id, post_id, lexical, created_at_ts,
created_at, title, post_status, reason, feature_image, feature_image_alt,
feature_image_caption, custom_excerpt, author` (the short user).

**Tag**: `id, name, slug, description, feature_image, visibility`, SEO and social
fields, `codeinjection_head, codeinjection_foot, canonical_url, accent_color,
created_at, updated_at, url`.

**Member**: `id, uuid, email, name, note, geolocation, subscribed, created_at,
updated_at, labels, subscriptions, avatar_image, comped, email_count,
email_opened_count, email_open_rate, status` (`free`), `last_seen_at,
attribution { id, type, url, title, referrer_source, referrer_medium,
referrer_url }, unsubscribe_url, tiers, email_suppression { suppressed, info },
newsletters` (`id, name, description, status`) (`flows/members.json` step 4).

**Setting**: `{ key, value }`. The settings resource is a list of these.

**Role**: `id, name, description, created_at, updated_at`.
**Tier**: `id, name, description, slug, active, type` (`free`/`paid`),
`welcome_page_url, visibility, benefits, currency, monthly_price, yearly_price,
trial_days, created_at, updated_at`.
**Newsletter**, **Theme**, **Integration**, **Site**, **Config**: see the
responses of `flows/members.json` step 3, `flows/settings.json` steps 2, 3, 8,
14.

### 4.1 Seed state of a fresh instance (observed)

A new instance, right after setup, already contains (`flows/settings.json`,
`flows/create-post.json` steps 4-7):

| Resource | Count | Notes |
|---|---|---|
| roles | 11 | Five staff roles (`Administrator, Editor, Author, Contributor, Owner`), five integration roles, and `Super Editor`. The flows send `Owner` back, so keep the staff role names. |
| tiers | 2 | `free` named `Free`; `paid` named after the site, 500 / 5000 monthly / yearly, `USD` |
| newsletters | 1 | named after the site, slug `default-newsletter`, `active` |
| tags | 1 | a sample tag (own name) |
| posts | 1 published | a sample post (own title and content) |
| pages | 1 published | a sample page (only seen in `/search-index/pages/`) |
| themes | 2 | one active (with `templates`), one inactive |
| integrations | 4 | each with one admin API key (`secret` is redacted in the recording) |
| settings | 99 | keys as in the flows. `GET /settings/?group=...` returns 98 because the flows' `group` list leaves out `recommendations`, whose only key is `recommendations_enabled`; `PUT /settings/` returns all 99 |
| labels, offers, snippets, invites, recommendations, notifications | 0 | |

Theme `package` objects are package manifests; return the same key structure
the flows show with your own values.

## 5. Behaviour by operation

| Operation | Behaviour | Evidence |
|---|---|---|
| `GET /users/me/?include=roles` | The signed-in user with roles. | `setup` step 3 |
| `GET /users/` | All staff users with roles, paginated. | `settings` step 5 |
| `PUT /users/{userId}/` | Saves the whole user, returns it. | `setup` step 9 |
| `GET /config/`, `GET /site/` | Server config and public site info (`title, description, logo, icon, cover_image, accent_color, locale, url, version, allow_external_signup, site_uuid`). Inferred: `site.title` follows the `title` setting. | `settings` steps 2-3 |
| `GET /settings/?group=...` | The settings list, `meta.filters.group` echoes the groups. | `setup` step 5 |
| `PUT /settings/` | Body `{ settings: [ { key, value } ] }` with the changed keys only; stores them and returns the full list with new values. | `settings` steps 15-16 |
| `GET /slugs/post/{slug}/` | `{ slugs: [ { slug } ] }`: a free slug for the title the editor is typing (lowercase words joined by `-`). Inferred: a taken slug gets a numeric suffix. | `create-post` step 8 |
| `POST /posts/` | Body: one post in an envelope (`status: draft`, `title`, `lexical`, `authors`, `tags`, …). Creates it with a new `id` and `uuid`, the slug from the title, and one revision (`reason: initial_revision`, `post_status: draft`). 201 with the full post and the requested includes. | `create-post` step 9 |
| `PUT /posts/{postId}/` | Body: the whole post, including the `updated_at` the client last saw. Saves and returns the post. Setting `status: published` sets `published_at` to now and adds a revision with `reason: published`. A later save of the published post added another `published` revision. Saving a draft (here with new body text) kept the single initial revision. Tags in the body, referenced by `id`, become the post's tags. | `create-post` step 13, `publish-post` step 2, `tags` step 23 |
| `GET /posts/{postId}/` | One post with includes. | `tags` step 7 |
| `GET /posts/` | Filtered (`status`, `id`), ordered, projected (`fields`), paginated. Post lists never include `post_revisions`. | `posts-list` steps 1-7, `publish-post` steps 8-9 |
| `DELETE /posts/{postId}/` | 204. Later lists no longer contain the post. | `delete-post` steps 17-18 |
| `POST /stats/posts-member-counts/` | Body `{ postIds: [...] }` → `{ stats: [ { "<postId>": { free_members, paid_members } } ] }`, one key per requested id, in request order. | `posts-list` step 4 |
| `GET /search-index/{users,tags,posts,pages}/` | Compact records for the editor's link search: users `id, slug, name, url, profile_image`; tags `id, slug, name, url`; posts and pages `id, url, title, status, published_at, visibility`. No pagination. | `create-post` steps 4-7 |
| `POST /tags/`, `GET /tags/{tagId}/`, `GET /tags/` | Create (slug from the name), read, list (`order=name asc`). `url` of a tag with no posts was `<origin>/404/`. | `tags` steps 1-2, 22 |
| `POST /members/` | Creates a member (`status: free`, subscribed to the newsletters sent, `attribution.referrer_source: "Created manually"`). 201 with includes. | `members` step 4 |
| `GET /members/`, `GET /members/{memberId}/` | List (filter on `created_at`, `order`, includes) and read. | `members` steps 7, 9 |
| `GET /members/events/` | Member activity for a filter; empty in the recordings. | `members` step 10 |
| `GET /members/stats/count/` | `{ resource: "members", total, data: [ { date, paid, free, comped } ] }`; one entry for the day the member was created. | `members` step 5 |
| `GET /stats/member_count/` | Daily member totals (two days in the recording: yesterday and today) plus `meta.totals`. | `members` step 6 |
| `GET /stats/referrers/` | Signups per day and source; a manually created member counts as source `Created manually`. | `settings` step 12 |
| `GET /roles/`, `/tiers/`, `/newsletters/`, `/themes/`, `/themes/active/`, `/integrations/`, `/labels/`, `/offers/`, `/snippets/`, `/invites/`, `/recommendations/`, `/incoming_recommendations/`, `/notifications/` | Seed lists (section 4.1), honouring the `filter`, `include` and `limit` seen in the flows (`tiers?filter=type:paid+active:true` returns the paid tier only). | `setup`, `members`, `settings` |
| `POST /session`, `DELETE /session`, `/authentication/setup/` | See section 3. | |

### 5.1 Errors (observed)

| Situation | Response | Evidence |
|---|---|---|
| `GET /posts/{postId}/` for a deleted post | 404 `NotFoundError` | `errors` step 1 |
| `POST /members/` with an email that an existing member has | 422 `ValidationError`, `property: "email"` | `errors` step 5 |
| Any session endpoint without a valid session | 403 `NoPermissionError` | `session-expired` steps 2-3 |
| `POST /session` with a wrong password | 422 `ValidationError`, `code: "PASSWORD_INCORRECT"` | `session-expired` step 6 |

All use the error envelope from section 2; `details`, `help`, `code` and
`appErrorCode` may be `null`. Each error has its own `id`.

## 6. Realtime

None observed.

## 7. Not determined

- Validation rules and error bodies beyond the four in section 5.1.
- What a stale `updated_at` on `PUT /posts/{id}/` does (inferred: a conflict
  error), and slug collisions.
- Scheduled posts, pages (beyond the search index), email newsletters sending,
  paid members, offers, labels, comments, recommendations: fields exist,
  behaviour unknown.
- Member event payloads (the list was empty).
- Permission rules for non-owner staff roles.

## 8. How parity is checked

The parity suite replays `flows/index.json` order against one fresh instance of
the rebuild: owner setup (credentials come from the environment or are random),
then every step in order, binding ids and echoed `updated_at` values from
responses (`bind`) into later paths, bodies and query strings (`{ "var": ... }`,
`{ "$var": ... }`, `{ "$template": ... }`; `{{now:<seconds>:<format>}}` in a
template is the replay time shifted as in the recording). A step passes when:

1. the status code matches;
2. the content type matches (ignoring parameters; not checked for 204);
3. every key in the recorded JSON body exists with the same JSON type
   (a recorded `null` accepts any value; ids, timestamps, URLs and other
   volatile values are not compared). Objects keyed by record ids are compared
   by entry count and values, not by key;
4. values the client itself sent earlier in the flow (titles, names, notes,
   the site title) come back unchanged. Strings a recorded response had shown
   before the client sent them back (a role description inside a user object
   the client saves whole) are the server's own data and are not compared.
   Lists of records
   (`posts`, `tags`, `settings`, `roles`, embedded `tiers` and
   `post_revisions`) have the recorded size, as does `total`. Lists of plain
   values are compared by element type only;
5. every boolean has the recorded value (`featured`, `subscribed`, feature
   switches in `/config/` and settings), and in error responses (status 400 or
   higher) every number does too.

A password written `<redacted:secret:other>` is not the account's password
(a wrong-password attempt); the runner sends a wrong one. Extra keys in the
rebuild's responses do not fail a step.
