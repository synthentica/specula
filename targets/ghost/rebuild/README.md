# Pressloft

Pressloft is a small publishing admin: owner setup, session login, posts (drafts, publishing,
revisions, topics), tags, members, newsletters, site settings and the read-only resources an
admin client expects. It was built only from `../spec/` (SPEC.md, openapi.yaml, flows/).

## Run

```sh
# fresh instance (state lives in memory and is gone when the process stops)
PORT=4457 DB_PATH=:memory: node targets/ghost/rebuild/server.ts

# persistent instance
PORT=4457 DB_PATH=/path/to/pressloft.db node targets/ghost/rebuild/server.ts
```

- Admin UI: <http://localhost:4457/app/> (`/` redirects there). The first visit asks for the owner account.
- API: `http://localhost:4457/app/api/admin/…`
- `PORT` defaults to 4457 and `DB_PATH` to `:memory:`.
- Node 22.18 or newer; no npm dependencies (`node:http`, `node:sqlite`, `node:crypto`).
- Type-check from the repo root: `npx tsc -p targets/ghost/rebuild`.
- Parity: start a fresh instance, then `node src/parity.ts --target ghost --base-url http://localhost:4457`.

## Layout

| Path | What it holds |
|---|---|
| `server.ts` | HTTP server: API dispatch, JSON bodies, errors, the UI shell, assets (TypeScript served as JavaScript via `stripTypeScriptTypes`), generated cover and avatar SVGs |
| `lib/api.ts` | Every API route and handler, sessions and password hashing, settings logic |
| `lib/shapes.ts` | Stored record types and the response shapes (users, posts, tags, tiers, newsletters, members) |
| `lib/seed.ts` | Install-time seed: roles, settings with their groups, tiers, newsletter, sample tag/post/page, themes, integrations |
| `lib/filter.ts` | The `filter` query language and `order` parameter |
| `lib/content.ts` | Editor documents: plain text from lexical / mobiledoc, lexical from plain text, excerpt and reading time |
| `lib/store.ts` | A JSON document store on `node:sqlite` (`DatabaseSync`), collections in insertion order |
| `lib/util.ts` | Ids, timestamps, slugs, API errors, pagination |
| `web/index.html`, `web/app.ts`, `web/styles.css` | The admin UI, laid out after `../spec/UI.md`: setup, log in, writing desk (in progress / live / everything, topic and order filters), full-width editor with a post-settings panel (topics, delete, unpublish), topics (public / internal, new-topic page, rows open the topic's posts), readers (search, order, CSV export, add form, summary), site details, log out |
| `tsconfig.json` | Strict type-check settings for all of the above |

## Behaviour choices where the spec is silent

- **Seed data** is Pressloft's own wording: sample tag "Highlights", sample post "Hello from Pressloft"
  (stored as mobiledoc, lexical `null`, like the recorded seed post), sample page "Who we are",
  themes `lantern` (active) and `harbor`, four integrations with own names, own role
  descriptions, tier and newsletter descriptions, own setting values for text (site description,
  navigation labels, social handles, accent colour, cover image). Functional values are kept:
  role names `Owner`/`Administrator`/`Editor`/`Author`/`Contributor`/`Super Editor`/`Admin Integration`, tier `Free`/`free` and
  `default-product`, newsletter slug `default-newsletter`, statuses, setting keys and enum-like setting values.
- **Owner role description** is Pressloft's own text. The recorded client sends the original's
  description back in `PUT /users/1/` and post bodies; the checker now treats such round-tripped
  server strings as server data, not user input, so they are not compared.
- **Theme manifests** keep the key structure the flows show (including the `devDependencies` key
  names, which are structural keys) with own values.
- **Seeding** happens when the database is created. The owner (id `"1"`) is created by setup, which
  also sets the site title, the default newsletter's name and the paid tier's name to `blogTitle` and
  puts the title into the sample post's text. A second setup call answers 403.
- **Owner slug** is the slugified first word of the name; `PUT /users/{id}/` may change it.
- **Passwords** need 8 or more characters (scrypt hashes). A wrong password answers 422 `ValidationError`
  with `code: "PASSWORD_INCORRECT"` and a `help` hint, and sets no cookie (as recorded). An email with no
  account (not recorded) answers 422 `ValidationError` with `property: "username"` and no `code`.
- **Sessions** are random tokens (stored hashed) in the `pressloft-admin-session` cookie,
  `HttpOnly; SameSite=Lax; Path=/app`, valid 184 days. `DELETE /session` deletes the session and
  expires the cookie.
- **Public endpoints**: `GET/POST /authentication/setup/`, `GET /site/`, `POST/DELETE /session`.
  Everything else answers 403 `NoPermissionError` without a valid session.
- **Stale saves**: `PUT /posts/{id}/` with an `updated_at` different from the stored one answers 409
  `UpdateCollisionError`.
- **Revisions**: creating a post adds `initial_revision`; every save that leaves the post
  `published` adds a `published` revision; saving a draft adds none.
- **Publishing** sets `published_at` to now unless the body carries one for an already published
  post; moving back to draft clears it.
- **`email_segment`**: stored as `all` unless the client sends a value other than `none`.
- **Tags in a post body** are matched by id, then slug, then name; an unknown name creates a tag.
- **Slugs** are lowercase words joined by `-`; a taken slug gets `-2`, `-3`… (`/slugs/post/` answers the
  next free one; `?id=` excludes the post being edited).
- **Ordering ties** (records created in the same second) fall back to creation order, in the direction
  of the first order key. Nulls sort first in descending order. Default orders: posts `published_at
  desc`, tags `name asc`, members `created_at desc`, users `created_at asc`.
- **Search index**: posts and pages of every status, `published_at desc`; tags newest first.
- **Member events** are not recorded, so `/members/events/` is always an empty list.
- **Member stats**: `/members/stats/count/` lists cumulative totals for each day a member joined;
  `/stats/member_count/` covers the day before the first member (or yesterday) through today.
- **Member avatars** point to a generated SVG at `/app/avatar/<id>.svg` (no third-party service).
- **Members** need a valid, unique email: a missing/invalid or already used address answers 422
  `ValidationError` with `property: "email"`. Without a `newsletters` list a subscribed
  member joins every active newsletter that subscribes on signup.
- **Settings**: `PUT /settings/` ignores unknown and calculated keys and rejects an empty title;
  `GET /settings/?group=…` filters by each setting's group (only `recommendations_enabled` is in the
  `recommendations` group, so the list without that group has one entry fewer).
- **Pagination** defaults to 15 per page; `limit=all` returns everything on one page.
- **Errors** use the recorded envelope with own messages; `property`, `help` and `code` are filled where
  they apply (validation errors name the offending field) and are `null` otherwise. Reading a deleted
  or unknown post answers 404 `NotFoundError`; unknown routes 404 `NotFoundError`, a known path with
  another method 405.
- **`/config/` switches** report the values the flows record (`useGravatar`, `emailAnalytics` and
  `security.staffDeviceVerification` are `true`; labs switches as recorded). They are reported for the
  client only: Pressloft still draws member avatars itself, does not collect email analytics and does
  not send device-verification emails (none of that behaviour is in the spec).
- **Admin UI errors** are rewritten into plain sentences: a wrong password, a reader whose email is
  already on the list, and an editor link to a post that no longer exists (a "Post not found" page with
  a way back) each get their own message; other errors show the server's message and context.
- **Signed-out deep links**: when the session is missing or ended, any admin page sends the visitor to
  `#/signin?next=<page>`; after a successful log in they land on the page they opened (only in-app
  hash routes are accepted as `next`). A failed log in keeps them on the sign-in screen with the error.
