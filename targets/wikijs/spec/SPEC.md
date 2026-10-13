# Team wiki: rebuild specification

This folder describes the backend of a self-hosted team wiki (Markdown pages
addressed by path, tags, page history, comments, users and groups) as it was
observed from the browser: 13 recorded user flows, 52 API exchanges. Almost
all of the API is **GraphQL**: one endpoint, many operations. It is everything
a rebuild may use.

| File | What it holds |
|---|---|
| `SPEC.md` | This document: features, behaviour, data model, what was not observed |
| `graphql.json` | The 21 observed GraphQL operations: the exact documents the client sent, variable and result shapes, errors and in-band failures |
| `openapi.yaml` / `openapi.json` | OpenAPI 3.1 for the two HTTP endpoints (`POST /finalize`, `POST /graphql`) |
| `flows/*.json` | The recorded flows as request/response steps; the parity suite replays them |

**Observed** means a recorded request or response shows it (each claim names a
flow step, `flows/<flow>.json` step *n*, counted from 1). **Inferred** means it
follows from observations but was not seen directly. Anything else is unknown
and listed in section 8.

UI labels in `flows/*.json` (`action.target.name`) describe the original UI so
the flows are readable. A rebuild uses its own name, wording and look. Text the
original ships with (UI translation strings, the sign-in method's icon, the
display names it gives the first users and groups, its version number) appears
in recorded responses; a rebuild returns its own text in the same shapes.

## 1. Scope

Build: first-run setup, sign-in with email and password, pages (create, update,
delete, read by id, list, list by tags), the tag list and tag suggestions,
search, edit-conflict check, page history and old versions, comments (list,
post), users (list, create, read), groups (list), site counters, the list of
sign-in methods, and UI translation catalogues.

Observed but not built beyond the recorded responses: two-factor fields and
sign-in continuation fields of the login result (always `null`), sign-in
methods other than the local one, user groups beyond the two system groups.

## 2. API conventions (observed)

- **One endpoint.** Everything after setup is `POST /graphql` with a JSON body.
  The only other API call is `POST /finalize` (section 3).
- **Batching.** The client always sends a JSON **array** of operations, even
  for one operation, and the server answers with an array of results in the
  same order (`flows/users.json` step 1: five operations, five results). Each
  operation is `{ "operationName": null, "variables": {...}, "extensions": {},
  "query": "<document>" }`. A non-array body with one operation is not
  observed; answering it with a single result object is the usual GraphQL
  behaviour (inferred).
- **Documents.** Every operation is anonymous (`operationName: null`, no name
  after `query`/`mutation`). The exact documents are listed in `graphql.json`
  and in the flows; a rebuild must answer exactly those. They use variables
  with types (`$id: Int!`, `$tags: [String]!`, `$publishEndDate: Date`), one
  literal argument (`activeStrategies(enabledOnly: true)`), nested selections
  and `__typename` on every object. A rebuild may implement a small GraphQL
  executor for this subset; no general schema language is needed.
- **Namespaces.** Root fields are namespaces without arguments
  (`pages`, `users`, `comments`, `groups`, `authentication`, `localization`,
  `system`); the operation is the namespace's child (`pages { create(...) }`).
  Operations are named `<type> <namespace>.<child>` in `graphql.json` and in
  the parity report (`mutation pages.create`).
- **Selections are honoured.** A result contains exactly the fields the
  document selected (the two `pages.list` documents select different fields:
  `flows/browse.json` steps 2 and 4).
- **`__typename`** is selected on every object and holds a schema type name
  (`PageQuery`, `PageMutation`, `PageResponse`, `ResponseStatus`, `Page`,
  `PageListItem`, ...). The recorded responses show the name for every
  position; a rebuild uses the same names. Query namespaces are `<Thing>Query`,
  mutation namespaces `<Thing>Mutation`.
- **HTTP status** is 200 for every observed GraphQL answer, including a result
  with errors (`flows/errors.json` step 2). Content type `application/json`.
- **Result envelope.** Each result is `{ "data": {...} }`, or `{ "errors":
  [...], "data": {...} }` when a field failed (section 6.2).
- **Ids** are positive integers per table, starting at 1 and increasing
  (pages 1, 2, 3; comment 1; users 1-3; versions 1). The one exception: a page
  version's `authorId` is a string (`"1"`, `flows/history.json` step 2).
- **Timestamps** are ISO 8601 UTC with milliseconds: `2026-10-12T07:56:08.914Z`.
  Optional publish dates are empty strings when unset (`publishStartDate: ""`).
- **Mutation results** carry `responseResult { succeeded, errorCode, slug,
  message }`: `succeeded: true, errorCode: 0, slug: "ok"` on success, and a
  failure is reported here **inside a 200 response** with `succeeded: false`
  and a numeric `errorCode` (section 6.1). `message` is a human sentence (use
  your own wording).
- `Date` variables are ISO strings (`checkoutDate`). `publishStartDate` and
  `publishEndDate` arrive as empty strings and are stored as given.

## 3. Setup and authentication (observed)

1. `POST /finalize` with `{ adminEmail, adminPassword, adminPasswordConfirm,
   siteUrl, telemetry }` → 200 `{ "ok": true, "redirectPath": "/",
   "redirectPort": <port> }` (`flows/setup.json` step 1). It creates the
   administrator (user id 1), the system guest user (id 2, `isSystem: true`)
   and the two system groups: administrators (id 1) and guests (id 2)
   (`flows/users.json` step 1). The administrator's display name is chosen by
   the server (the setup form has no name field).
2. The original restarts itself after setup; the browser waited about 14 s
   before loading the sign-in page. The flow keeps that pause (`pauseReason:
   "app-wait"`). A rebuild does not need to restart; it must answer right
   after `/finalize`.
3. Sign-in is a GraphQL mutation: `authentication.login(username, password,
   strategy: "local")` with the email as `username` (`flows/login.json`).
   Success → `responseResult.succeeded: true`, `jwt: <token>`, `redirect: "/"`,
   and `null` for `mustChangePwd`, `mustProvideTFA`, `mustSetupTFA`,
   `continuationToken`, `tfaQRImage` (step 2). A wrong password →
   `succeeded: false`, `errorCode: 1002`, `jwt: null`, `redirect: null`
   (step 1).
4. The client sends the token as `Authorization: Bearer <token>` on every later
   request (`auth: "bearer"` in the flows). The original's token is a JWT with
   a 30-minute lifetime and claims for the user id, email, name, groups and
   permissions (from the capture's auth analysis). A rebuild may use any token
   format; the parity suite takes the token from the `jwt` field.
5. Requests without a token act as the guest user. Observed guest operations:
   `localization.translations`, `authentication.activeStrategies`,
   `authentication.login`, and `comments.list` (`flows/logout-login.json`
   steps 2-4, after signing out). Signing out is a full page navigation
   (`GET /logout`) outside the API; the client then simply stops sending the
   token. What the guest is denied was not observed (section 8).
6. `authentication.activeStrategies` lists sign-in methods. With
   `enabledOnly: true` the client selects `key`, `strategy { key, logo, color,
   icon, useForm, usernameType }`, `displayName`, `order`, `selfRegistration`
   (`flows/setup.json` step 3); without the argument only `key` and
   `displayName` (`flows/users.json` step 1). One method is observed: key
   `"local"`, `useForm: true`, `usernameType: "email"`, `order: 0`,
   `selfRegistration: false`. `logo` is a URL and `icon` an SVG string; use the
   rebuild's own.

## 4. Data model (observed, from responses)

### 4.1 Page

`id`, `locale` (`"en"`), `path` (`"home"`, `"notes/first-steps"`: no leading
slash, may contain `/`), `title`, `description`, `content` (Markdown source),
`contentType` and `editor` (both `"markdown"`), `isPublished`, `isPrivate`,
`privateNS` (`null`), `publishStartDate`, `publishEndDate`, `tags` (list of
tag names), `hash` (40 lowercase hex characters, stable per page), `createdAt`,
`updatedAt`, `authorId`/`authorName`/`authorEmail` (last editor) and
`creatorId`/`creatorName`/`creatorEmail` (creator); both are the signed-in user
in the recordings (`flows/delete-page.json` step 2). `scriptCss` and
`scriptJs` are accepted on create/update; they are never selected in a result.

Uniqueness: one page per `locale` + `path` (section 6.1).

### 4.2 Tag

A tag exists while a page uses it. `pages.tags` returns `{ tag, title }` with
`title` equal to `tag`, sorted by name (`flows/browse.json` step 1). A page's
`tags` in `pages.list` are sorted by name (`flows/browse.json` step 3: created
with `["notes", "guide"]`, listed as `["guide", "notes"]`). In a list filtered
by `tags`, each page lists only the tags that matched the filter (step 2: the
same page, filtered by `["notes"]`, shows `["notes"]`).

### 4.3 Page version

Stored when a page is updated: a copy of the page **as it was before** the
update. Fields: `versionId`, `pageId`, `action` (`"updated"`), `authorId`
(string), `authorName`, `content`, `contentType`, `editor`, `description`,
`isPrivate`, `isPublished`, `locale`, `path`, `publishStartDate`,
`publishEndDate`, `tags` (`[]` in the recording, although the page had a tag),
`title`, `createdAt` (when the version was stored, i.e. the time of the
update) and `versionDate` (the page's `updatedAt` before the update)
(`flows/history.json` step 2).

### 4.4 Comment

`id`, `render` (the comment rendered from Markdown to HTML, e.g.
`"<p>text</p>\n"`), `authorName` (the poster's display name), `createdAt`,
`updatedAt` (equal at creation) (`flows/comments.json` step 3).

### 4.5 User and group

User list item: `id`, `name`, `email`, `providerKey` (`"local"`), `isSystem`,
`isActive`, `createdAt`, `lastLoginAt` (`null` until the user signs in; the
administrator's is set by sign-in). Full user (`users.single`) adds
`providerName` (display name of the sign-in method), `providerId` (`null`),
`providerIs2FACapable` (`true`), `location` and `jobTitle` (`""`), `timezone`
(an IANA zone name; the default for a new user is a fixed zone),
`isVerified` (`true`), `updatedAt`, `tfaIsActive` (`false`) and `groups`
(`[{ id, name }]`, empty for a user created with `groups: []`)
(`flows/users.json` step 5). Groups: `{ id, name, isSystem }`
(`flows/users.json` step 1).

### 4.6 Seed state after setup (observed)

| Record | Values |
|---|---|
| User 1 | the administrator: email from setup, `isSystem: false`, `isActive: true` |
| User 2 | the guest: `isSystem: true`, `isActive: true`, its own address, `lastLoginAt: null` |
| Group 1 | administrators, `isSystem: true` |
| Group 2 | guests, `isSystem: true` |
| Pages, comments, tags | none |

## 5. Behaviour by operation

All are under `POST /graphql`. "Echo" means the value sent comes back unchanged.

| Operation | Behaviour | Evidence |
|---|---|---|
| `mutation pages.create` | Creates a page from the variables; returns `page { id, updatedAt }`. Tags are stored as a set of names. | `create-home` 4, `create-pages` 5, 9 |
| `mutation pages.update(id, ...)` | Stores a version of the current state (4.3), then applies every variable; returns `page { updatedAt }` with a new time. | `edit-page` 3 |
| `mutation pages.delete(id)` | Removes the page; it disappears from lists and counters (`pagesTotal` 3 → 2). | `delete-page` 3-4, `errors` 2 |
| `query pages.single(id)` | The full page (4.1). Unknown id: error (6.2). | `delete-page` 2, `errors` 2 |
| `query pages.list` | All pages, ordered by id ascending. Optional `tags`: only pages that have **every** listed tag (`["notes"]` → 2 pages, `["notes","guide"]` → 1). `locale: null` means any. `limit`, `orderBy`, `orderByDirection` are declared but never sent. | `browse` 2-4, `delete-page` 1, 4 |
| `query pages.tags` | Every tag in use (4.2). | `browse` 1 |
| `query pages.searchTags(query)` | Names of existing tags that match the typed text (`"g"` → `["guide"]` once a page has `guide`; `[]` before any page exists). Whether the match is prefix or substring was not determined. | `create-home` 2-3, `create-pages` 1-4, 7-8 |
| `query pages.search(query)` | `{ results: [{ id, title, description, path, locale }], suggestions: [], totalHits }`. Both recorded searches had no hits: `"release"` matched only page **content**, so content is not searched (inferred: title and description are). | `search` 2-3 |
| `query pages.checkConflicts(id, checkoutDate)` | `false` when the page has not changed since `checkoutDate` (the client sends the `updatedAt` it loaded). `true` when it changed later (inferred). | `edit-page` 1-2 |
| `query pages.history(id, offsetPage, offsetSize)` | `{ trail: [...], total }`. One trail entry per stored version: `versionId`, `authorId` (number), `authorName`, `actionType`, `valueBefore`, `valueAfter` (`null`), `versionDate`. After one update the trail has one entry with `actionType: "initial"` and `total: 1`. | `history` 1 |
| `query pages.version(pageId, versionId)` | The stored version (4.3). | `history` 2 |
| `query comments.list(locale, path)` | Comments of the page at that path (oldest first, inferred: one comment was recorded); `[]` for a page without comments. | `comments` 1, 3 |
| `mutation comments.create(pageId, replyTo, content, guestName, guestEmail)` | Adds a comment by the signed-in user (`replyTo: 0`, empty guest fields); returns the new `id`. | `comments` 2 |
| `query users.list` | All users including the guest, by id. | `users` 1, 3 |
| `mutation users.create(providerKey, email, name, passwordRaw, groups, mustChangePassword, sendWelcomeEmail)` | Creates a local user; `usersTotal` goes up. Same email again: failure 1004 (6.1). | `users` 2-4 |
| `query users.single(id)` | The full user (4.5). | `users` 5 |
| `query groups.list` | The groups (4.5). | `users` 1, 5 |
| `query system.info` | `{ currentVersion, latestVersion, groupsTotal, pagesTotal, usersTotal, tagsTotal }`: live counts (users include the guest; tags in use). The version strings are the rebuild's own. | `browse` 4, `users` 1, `delete-page` 1, `errors` 2 |
| `query localization.translations(locale, namespace)` | `[{ key, value }]`: the UI strings of one namespace (section 7). | `setup` 2, `create-home` 1, `browse` 1, 4, `history` 1, `users` 5 |
| `query authentication.activeStrategies` | Section 3, rule 6. | `setup` 3, `users` 1, `logout-login` 3 |
| `mutation authentication.login` | Section 3, rule 3. | `login` 1-2, `logout-login` 4 |

## 6. Errors (observed)

### 6.1 In-band failures (HTTP 200, `data` present)

| Situation | `responseResult` | Evidence |
|---|---|---|
| Sign-in with a wrong password | `succeeded: false`, `errorCode: 1002`, `jwt: null` and every other login field `null` | `login` 1 |
| `pages.create` at a `locale` + `path` that already exists | `succeeded: false`, `errorCode: 6002`, `page: null` | `errors` 1 |
| `users.create` with an email an existing user has | `succeeded: false`, `errorCode: 1004` | `users` 4 |

### 6.2 GraphQL errors

`pages.single` with an unknown id (`flows/errors.json` step 2) answers, inside
the batch:

```json
{ "errors": [ { "message": "<sentence>",
    "locations": [ { "line": 3, "column": 5 } ],
    "path": ["pages", "single"],
    "extensions": { "code": "INTERNAL_SERVER_ERROR",
      "exception": { "code": 6003, "message": "<sentence>", "stack": "<text>", "stacktrace": ["<line>", "..."] } } } ],
  "data": { "pages": { "single": null } } }
```

- `locations` is the line and column (1-based) of the failing field in the
  document the client sent: `single` is on line 3, column 5 of that document.
  Compute it from the document text.
- `extensions.code` is `"INTERNAL_SERVER_ERROR"` and `extensions.exception.code`
  the numeric application error code 6003 (page not found).
- `stack` and `stacktrace` are diagnostic text; the rebuild's own (never the
  original's file paths).
- The other operations in the same batch still answer normally (step 2's
  `system.info`).

## 7. Translation catalogues

`localization.translations` returns the UI strings of one namespace. Seven
namespaces were requested (`common`, `auth`, `editor`, `tags`, `admin`,
`history`, `profile`), each with a fixed number of entries (173, 73, 136, 17,
495, 4, 39). Keys are dotted identifiers (`actions.add`, `restore.confirmTitle`)
that the client looks up; they may be reused. **Values are the original's UI
text and must not be copied**: a rebuild writes its own wording (or derives a
readable label from the key). Values may contain `{{placeholders}}` that the
client fills in; keep any placeholder a key's value needs. A rebuild returns,
for each namespace, one entry per key the recorded responses list.

## 8. Not determined

- What a guest (no token) or a non-administrator may not do: no access error
  was observed. Inferred: page, user and group writes and the user list
  require the administrator.
- Token renewal: the token lives 30 minutes and no flow ran that long; how the
  original renews it (if at all) was not observed.
- Validation rules beyond the three failures in 6.1 (empty title, invalid
  path, unknown tag characters), and `pages.update` moving a page to a path
  that is taken.
- Search ranking, suggestions, and whether path is searched.
- `pages.history` paging (`offsetPage`, `offsetSize`) beyond the first page,
  and `actionType` values other than `"initial"`.
- `comments.create` replies (`replyTo` other than 0) and guest comments.
- Private pages, publish windows, locales other than `"en"`.
- Group membership changes, user updates and deletion.

## 9. How parity is checked

The parity suite replays `flows/index.json` order against one fresh instance of
the rebuild: setup (credentials come from the environment or are random), then
every step in order, binding ids and echoed `updatedAt` values from responses
(`bind`) into later variables (`{ "$var": ... }`; `checkoutDate` carries the
page's `updatedAt`). A step is one HTTP request; for GraphQL that is the whole
batch. A step passes when:

1. the status code matches;
2. the content type matches (ignoring parameters);
3. every key in the recorded JSON body exists with the same JSON type, in
   every result of the batch (a recorded `null` accepts any value; ids,
   timestamps, URLs and the keys in `flows/index.json` `volatileKeys` are not
   compared);
4. values the client itself sent earlier in the flow (titles, descriptions,
   paths, tag names, comment text, user names)
   come back unchanged. Strings the server produced (display names, rendered
   comment HTML, messages) are not compared. Lists of records (pages, tags,
   comments, users, groups, translation entries, history trail) have the
   recorded size. Counts are compared exactly: `total`, `totalHits`,
   `pagesTotal`, `usersTotal`, `groupsTotal`, `tagsTotal`. Lists of plain values
   (`searchTags`, a page's `tags`) need not have the recorded size, but an
   element the client sent earlier (a tag name) must match at its position, so
   the order of tag names matters;
5. every boolean has the recorded value (`succeeded`, `isPublished`,
   `checkConflicts`, `isSystem`, ...). In a failure result (`succeeded: false`)
   and in a result with `errors`, every number (`errorCode`, the error's
   line, column and numeric code) and the string `code` must match too.

A password written `<redacted:secret:other>` is not the account's password
(a wrong-password attempt, or the password chosen for a new user); the runner
sends a different one. An email written `<redacted:email:N>` is another
person's address, the same one for the same N. Extra keys in the rebuild's
responses do not fail a step.
