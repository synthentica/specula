# Tackboard

Tackboard is a small team kanban app: boards whose cards are grouped into columns by a status
field, card descriptions and comments, a gallery of board templates, and live updates over a
WebSocket. It was built only from `../spec/` (SPEC.md, openapi.yaml, realtime.json, flows/).

## Run

```sh
# fresh instance (state lives in memory and is gone when the process stops)
PORT=4459 DB_PATH=:memory: node targets/focalboard/rebuild/server.ts

# persistent instance
PORT=4459 DB_PATH=/path/to/tackboard.db node targets/focalboard/rebuild/server.ts
```

- Web UI: <http://localhost:4459/>. The first visit offers to create the first account.
- API: JSON under `/api/v2` (bearer session tokens, `X-Requested-With: XMLHttpRequest` on every call);
  realtime socket at `/ws`.
- `PORT` defaults to 4459 and `DB_PATH` to `:memory:`.
- Node 22.18 or newer; no npm dependencies (`node:http`, `node:sqlite`, `node:crypto`, `node:module`).
- Type-check from the repo root: `npx tsc -p targets/focalboard/rebuild`.
- Parity: start a fresh instance, then
  `node src/parity.ts --target focalboard --base-url http://127.0.0.1:4459 --label rebuild`.
  Result: **461/461** (432 HTTP steps and 29 pushed socket messages), see `../parity/report.md`.

## Layout

| Path | What it holds |
|---|---|
| `server.ts` | HTTP server: `/api/v2` (JSON bodies, CSRF header check, bearer token), the `/ws` upgrade, UI shell and assets (TypeScript served as JavaScript via `stripTypeScriptTypes`), the generated SVG mark |
| `lib/api.ts` | Every route: sign-up, sign-in/out, users, the team, templates, categories, boards and blocks, members, limits; pushes each change to the socket |
| `lib/ws.ts` | A minimal RFC 6455 server: handshake, masked client frames, fragments, ping/pong, close; `AUTH` / `SUBSCRIBE_TEAM` / `UNSUBSCRIBE_TEAM` and the per-team fan-out |
| `lib/store.ts` | Tables on `node:sqlite` (`DatabaseSync`): users, sessions, boards, blocks, members, categories and the boards filed under them; record ids |
| `lib/templates.ts` | The 13 seed templates in Tackboard's own words, and the sample cards of the first one |
| `lib/auth.ts` | scrypt password hashes and opaque session tokens |
| `web/index.html`, `web/app.ts`, `web/styles.css` | The web UI: sign up / sign in / sign out, board list, new board, rename board, add / rename / remove status groups, add cards, rename and move them (drag and drop, the status menu or the New ▾ menu), rename the view, search cards, hide empty groups, sort cards by title, copy a link to the board, description and comments, delete a card, live updates from the socket. Laid out after `../spec/UI.md`: navy sidebar, white top bar with the board title and view toolbar, columns of shadowed cards |
| `tsconfig.json` | Strict type-check settings for all of the above |

## Behaviour choices where the spec is silent

- **Seed data**: 13 templates (`type: "O"`, created by `"system"`) with the recorded number of card
  fields, their types and option counts, in order; titles, descriptions, icons, field names and
  option labels are Tackboard's own. The generic values the spec asks to keep stay (`Status`, the
  `Doing` option, type names, `and`, team `"0"`). The first template has a view, four cards and 30
  content blocks (10 text, 5 dividers, 15 unchecked to-dos); the recording shows five groups of
  content for four cards, so the last sample card carries two sections. The other templates have one
  board view each. `trackingTemplateId` is an MD5 of the template's title.
- **Sign-up**: the first account needs no invitation; later ones need the team's `signupToken`
  (else 401). Usernames are up to 64 letters, digits, `.`, `-`, `_` or `@`; a valid email address and a
  password of 8+ characters are required; a taken username or email is a 400. Sign-in accepts the
  username or the email address.
- **Sessions** are random tokens stored in the database, valid until sign-out, which also stops any
  socket that authenticated with that token from receiving pushes.
- **Ids**: 27 characters, a kind letter (`u`, `b`, `c`, `v`, `a`, `7`) and 26 random characters.
  Client ids of boards and blocks are replaced; a `parentId`, `cardOrder` or `contentOrder` entry
  naming another record of the same request is rewritten to the new id (so a board's first view
  points at the real board). Card field and option ids are kept as sent.
- **Permissions**: templates are readable by every signed-in user; a board is readable by its members
  and writable by its admins and editors (403 otherwise). Joining an existing open (`type: "O"`)
  board makes the user an editor; joining a private board or a template is a 403.
- **Deleting a card** also deletes its content and comments; one tombstone is pushed per block. View
  `cardOrder` lists are left to the client, as recorded.
- **Socket**: messages are never answered. A bad `AUTH` token leaves the socket unauthenticated, and
  `SUBSCRIBE_TEAM` before a good `AUTH` is ignored. Board and block changes go to the sockets of the
  board's members (every user for templates); category messages only to their owner.
- **Category**: each user's system category is called "My boards" (`sortOrder: 0`), created on the
  first category listing or the first new board, whichever comes first.
- **Errors** are `{ error, errorCode }` with Tackboard's own messages; unknown API paths are 404, a
  known path with another method 405, a missing CSRF header or unreadable JSON 400.
- **Not built**: board deletion, sharing, team settings, file uploads, view types other than the
  kanban board, creating a board from a template in the UI.
