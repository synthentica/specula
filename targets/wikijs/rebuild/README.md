# Pagegrove

Pagegrove is a small team wiki: Markdown pages addressed by path, tags, page history with old
versions, comments, people and groups, search, and a GraphQL API with first-run setup. It was built
only from `../spec/` (SPEC.md, graphql.json, openapi.yaml, flows/).

## Run

```sh
# fresh instance (state lives in memory and is gone when the process stops)
PORT=4458 DB_PATH=:memory: node targets/wikijs/rebuild/server.ts

# persistent instance
PORT=4458 DB_PATH=/path/to/pagegrove.db node targets/wikijs/rebuild/server.ts
```

- Web UI: <http://localhost:4458/>. The first visit asks for the maintainer account.
- API: `POST /graphql` (a batch array or a single operation), `POST /finalize` (first-run setup).
- `PORT` defaults to 4458 and `DB_PATH` to `:memory:`.
- Node 22.18 or newer; no npm dependencies (`node:http`, `node:sqlite`, `node:crypto`, `node:module`).
- Type-check from the repo root: `npx tsc -p targets/wikijs/rebuild`.
- Parity: start a fresh instance, then
  `node src/parity.ts --target wikijs --base-url http://localhost:4458 --skip-app-waits`.

## Layout

| Path | What it holds |
|---|---|
| `server.ts` | HTTP server: `/graphql` (batches, bearer tokens, token renewal header), `/finalize`, `/status.json`, `/logout`, UI shell and assets (TypeScript served as JavaScript via `stripTypeScriptTypes`), generated SVG marks |
| `lib/graphql.ts` | A small GraphQL engine: lexer with line/column tracking, parser (operations, variables, arguments, aliases, fragments, `@include`/`@skip`), validation against a type map, variable checks, executor with per-field errors |
| `lib/wiki.ts` | The schema (type names, fields) and every resolver: pages, tags, search, conflicts, history, versions, comments, users, groups, sign-in, counters, catalogues; first-run setup |
| `lib/store.ts` | Tables on `node:sqlite` (`DatabaseSync`): users, groups, memberships, pages, page tags, versions, comments, meta |
| `lib/auth.ts` | scrypt password hashes and HS256 JWT signing/verification |
| `lib/markdown.ts` | The Markdown renderer for pages and comments (raw HTML is escaped) |
| `lib/catalogue.json` | UI translation catalogues: the recorded keys per namespace with Pagegrove's own values |
| `web/index.html`, `web/app.ts`, `web/styles.css` | The web UI: setup, sign in/out, pages by path, tag browser, page view, editor, history and old versions, comments, search, people |
| `tsconfig.json` | Strict type-check settings for all of the above |

## Behaviour choices where the spec is silent

- **Seed data** uses Pagegrove's own wording: the administrator is named "Site maintainer", the guest
  "Anonymous reader" (`anonymous-reader@pagegrove.invalid`), the system groups "Maintainers" (id 1)
  and "Public readers" (id 2). The version string is `1.0.0`. The sign-in method is called
  "Email and password", with its own envelope icon (`icon`) and logo URL (`/_assets/sign-in.svg`).
  Functional values are kept: method key `local`, `usernameType: "email"`, success slug `ok`.
- **Translation catalogues** return one entry per recorded key in each namespace. Values are derived
  mechanically from the key (`actions.add` → "Add", `analytics.title` → "Analytics title"); a key whose
  recorded value needs `{{placeholders}}` gets them appended, e.g. `page.id` → "Id ({{id}})". The
  `locale` argument is accepted, only one catalogue exists.
- **Setup** (`POST /finalize`) needs a valid email, a password of 8+ characters and a matching
  confirmation (else 400 `{ ok: false, error }`). A second call answers 403. `redirectPort` is the
  port Pagegrove listens on. `GET /status.json` (not in the spec) tells the UI whether setup is done.
- **Tokens** are HS256 JWTs (claims: user id, email, name, group ids) living 30 minutes, signed with a
  secret kept in the database. A request with a missing, invalid or expired token acts as the guest.
  Renewal (not observed): a request whose token is past half its lifetime gets a fresh one in the
  `X-Pagegrove-Token` response header, which the UI stores. `ACCESS_TOKEN_TTL` is ignored.
  `GET /logout` clears any cookie and sends the browser to the sign-in screen.
- **Permissions** (the spec only infers them): the guest may read pages, tags, search, history,
  versions and comments, list sign-in methods, read catalogues and sign in. Any signed-in account may
  also create and edit pages and post comments. Deleting pages, listing/creating users, listing groups
  and `system.info` need membership of group 1; `users.single` is allowed for maintainers and for the
  account itself. A denial is a GraphQL error with `extensions.code: "FORBIDDEN"` and
  `exception.code` 1010 (not signed in) or 1011 (not a maintainer).
- **Error codes** beyond the recorded ones (6002, 6003, 1002, 1004), all in-band
  (`responseResult.succeeded: false`) for mutations and GraphQL errors for queries:
  6004 invalid path, 6005 empty title, 6006 unknown page version (query error), 6003 also for
  `pages.update`/`pages.delete`/`comments.create` on a missing page, 6002 also when `pages.update` moves a
  page to a taken path, 1001 unknown sign-in method, 1003 invalid email, 1005 missing name, 1006 password
  shorter than 8 characters, 1007 unknown user (query error), 1008 provider other than `local`,
  8001 empty comment, 8002 comment over 20 000 characters. Messages are Pagegrove's own sentences.
- **GraphQL errors** carry `locations` computed from the document, `path`, and
  `extensions { code, exception { code, message, stack, stacktrace } }`; the stack is a short
  Pagegrove-made trace, never file paths. Syntax errors (`GRAPHQL_PARSE_FAILED`), unknown fields
  (`GRAPHQL_VALIDATION_FAILED`) and bad or missing variables (`BAD_USER_INPUT`) answer without `data`.
  Every GraphQL answer is HTTP 200; unreadable JSON is 400 and batches over 50 operations are refused.
- **Paths** lose leading/trailing slashes and doubled slashes; whitespace, `? # % \ " < > | * :`,
  control characters and `.`/`..` segments are refused (6004).
- **Tags** are trimmed, lower-cased and de-duplicated. A page's tags are listed by name.
  `pages.list` with a `tags` filter returns, for each matching page, only the tags it matched (the
  recording lists `["notes"]` for a page tagged guide+notes when filtering by notes, and
  `["guide","notes"]` when filtering by both); without a filter all tags are listed.
- **`pages.searchTags`** matches anywhere in the tag name, case-insensitive; prefix matches come first,
  at most 25.
- **Search** looks at titles, descriptions and paths (not content), case-insensitive, every word must
  match; title hits rank first, then by id. `suggestions` is always empty.
- **`pages.list`** supports `orderBy` `ID`/`TITLE`/`PATH`/`CREATED`/`UPDATED`, `orderByDirection`
  `ASC`/`DESC` (default `ID ASC`), `limit`, `locale`, `creatorId` and `authorId`.
- **History**: every update stores the previous state as a version (`action: "updated"`). The trail
  is newest first; each entry tells how that state came about: the oldest is `initial`, later ones
  `edit`, or `move` (with `valueBefore`/`valueAfter` paths) when the path differs from the version
  before it. `offsetPage`/`offsetSize` page through it (default size 100, at most 500).
  A version's `tags` are the tags the page had then (the recording shows `[]`).
- **`checkConflicts`** is `true` when the page's `updatedAt` is later than `checkoutDate` (or the
  date cannot be read). Timestamps are strictly increasing so two saves never share a time.
- **Page `hash`** is a SHA-1 of the page id and creation time, so it never changes for a page.
- **Publishing fields** (`isPublished`, `isPrivate`, publish dates, `scriptCss`/`scriptJs`) are stored
  and returned but do not restrict reading. Only `markdown` content is rendered.
- **Comments** are oldest first and need a signed-in account (guest comments are refused);
  `replyTo` is kept when it names a comment on the same page, else stored as 0. Deleting a page
  deletes its comments and versions.
- **Users**: emails are stored lower-case and compared without case. New accounts get timezone
  `Etc/UTC`, `isVerified: true`, and the groups listed (unknown ids are skipped). `mustChangePassword`
  is stored but sign-in still answers `null` for every continuation field.
- **API extensions** the UI uses (not in the spec): `pages.singleByPath(locale, path)`, `content`,
  `render` and `tags` on `Page`, `render` on `PageVersion` and `CommentPost`, `users.profile`,
  `GroupMinimal.userCount`, `SystemInfo.productName`.
- **Not built**: two-factor sign-in, sign-in methods other than `local`, self-registration,
  editing/deleting users and groups, restoring old versions, locales other than `en`.
