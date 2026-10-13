# Listwell

A small task manager: projects, tasks, labels, comments, search, an
upcoming view and a board (kanban) per project. It was built from the
written specification in `../spec/` only. The server uses Node built-ins and
has no npm dependencies.

## Run

From this folder (or pass the path to `server.ts` from anywhere):

```sh
node server.ts                                      # http://localhost:4456
PORT=5000 DB_PATH=:memory: node server.ts           # throwaway instance
PORT=4556 DB_PATH=:memory: ACCESS_TOKEN_TTL=15 node server.ts   # how the parity run starts it
```

- `PORT`: default `4456`.
- `DB_PATH`: default `rebuild/data/app.db`, created on first start. `:memory:`
  starts a fresh, empty instance.
- `ACCESS_TOKEN_TTL`: lifetime of an access token in seconds, default `600`.
  Must be a positive whole number; the server refuses to start otherwise.
  Long-lived tokens (`long_token: true`) last 30 days regardless.
- `JWT_SECRET` (optional): signing key for access tokens. Without it, a random
  key is generated and stored in the database.

Requires Node 22.18 or newer (TypeScript type stripping, `node:sqlite`).
Type-check with `npx tsc -p .` from this folder (TypeScript comes from the repository).

## Layout

| Path | Contents |
|---|---|
| `server.ts` | Entry point: reads the environment, starts the server |
| `lib/app.ts` | HTTP server, static files, WebSocket upgrade |
| `lib/api.ts` | The `/api/v2` routes |
| `lib/model.ts` | Projects, views, buckets (board columns), tasks, labels, comments and their JSON shapes |
| `lib/http.ts` | JSON and problem+json responses, error codes, body parsing, CORS |
| `lib/filter.ts` | The task filter language (`done = false && due_date < '…'`) |
| `lib/patch.ts` | JSON Patch (RFC 6902) |
| `lib/auth.ts` | scrypt passwords, HS256 tokens, refresh sessions, rate limit |
| `lib/ws.ts` | Minimal RFC 6455 WebSocket server |
| `lib/db.ts` | SQLite schema and helpers |
| `lib/avatar.ts` | Generated SVG avatars |
| `web/` | Frontend: plain TypeScript, served as JavaScript through `stripTypeScriptTypes` |

## What is implemented

- Accounts: sign up, sign in (bearer token, 600 s unless `ACCESS_TOKEN_TTL`
  says otherwise), refresh with an HttpOnly cookie scoped to
  `/api/v2/user/token/refresh` (3 days, rotated on every use; works with an
  expired access token, and the new token is valid at once), sign out (ends
  the session and clears the cookie), current user.
- Projects: create, list, read. Each project gets four views (list, timeline,
  grid, board), and the board gets three buckets. Every account starts with a
  default project and a saved filter of all open tasks, listed as a pseudo
  project with a negative id.
- Tasks: bulk create, lists per view (the list view hides finished tasks),
  lists across projects with `filter`, `q`, repeated `sort_by`/`order_by`,
  `page`/`per_page` and `expand=comment_count`. Also read, update with JSON
  Patch (or a plain JSON object), mark done (sets `done_at`, moves the task to
  the board's done bucket), delete, and store a task's position in a view
  (`PUT /tasks/{id}/position`).
- Boards: list a board's columns with their tasks
  (`GET …/views/{view}/buckets/tasks`), add a column (appended after the
  others), move a task to another column. Moving a task into the done column
  finishes it; finishing a task moves it there.
- Labels (create, list, attach to a task), comments (list, create), empty
  notifications, server info, SVG avatars.
- Realtime: `/api/v2/ws` accepts `auth` (answers `auth.success`) and `subscribe`.
- Frontend pages: sign up and sign in, open tasks (with quick add to the
  default project), coming up (next 7 to 90 days, with or without overdue
  tasks), all projects and new project, labels, project views switched with
  tabs (list with quick add, one task per line, and a "show finished" switch;
  timeline; grid as a table; board), task detail (title edited in place,
  rich-text description, priority, due date, finish/reopen, delete, labels,
  comments), a board per project (columns, add a task to a column, add a
  column, move a card by drag-and-drop or with its ⋯ menu), search, keyboard
  shortcuts (`/`, `n`, `u`, `p`), sign out. The look follows `../spec/UI.md`
  (fixed top bar and 300 px sidebar on a grey page, white cards with a soft
  shadow, blue accent, 4 px corners); there is a dark variant too. Errors are
  shown in plain words (wrong password, username taken, task not found). The
  client renews its token shortly before it expires and, after an idle
  period, before its next request.

## Choices where the specification is open

- Errors are `application/problem+json`:
  `{ $schema, title, status, detail, code }`, `title` being the HTTP reason
  phrase. Codes from the specification: 11 (missing, invalid or expired
  token, or an ended session; 401), 1001 (username taken; 400), 1011 (wrong
  username or password, also for an unknown user; 403), 4002 (task not
  found; 404), 4019 (filter value of the wrong type, such as
  `priority > urgent`; 400). Every other error uses `9000 + HTTP status`
  (for example 9400 for other validation errors, 9403 for another user's
  data, 9404, 9405, 9409 for a failed JSON Patch `test`, 9413, 9415, 9429
  for more than 10 sign-ins per minute from one address, 9500). A failed
  refresh is a 401 with 9401, so a client does not loop on code 11.
- Filters are checked before they run: an unknown field is a 400 (9400) and
  a value that does not fit the field's type is a 400 (4019), even when no
  task would be compared.
- `/info` reports the feature switches as they were recorded (link sharing,
  attachments, TOTP, CalDAV, email reminders, user deletion and webhooks on)
  because the parity check compares every boolean. This server does not
  implement those features; the frontend does not offer them.
- Board columns: a new column's position is the highest existing position
  plus 100. Moving a finished task out of the done column reopens it
  (`done: false`, `done_at` back to the zero time); the specification does
  not show this case. A task moved without a position call keeps its old
  position in the view.
- `PUT /tasks/{id}/position` with `position: 0` (or below) places the task
  after every other task of that view (highest position + 65536). The view
  must belong to the task's project.
- `GET …/buckets/tasks` answers `{ $schema, items, total }` (total = number of
  columns). `per_page` (default 25, at most 50) and `page` apply to the tasks
  of each column; a column without matching tasks has no `tasks` key, and
  `count` always counts all tasks in the column.
- A user sees only their own projects, tasks and labels.
- `q` matches task titles (case-insensitive substring). `sort_by=relevance` is
  ignored. Every sort ends with `id` ascending. Tasks without a date sort last
  in either direction.
- Filters support `= != < > <= >= like in` and `not in`, `&&`, `||` and
  parentheses. Fields: `done`, `priority`, `percent_done`, `due_date`,
  `start_date`, `end_date`, `done_at`, `created`, `updated`, `title`,
  `description`, `project`, `labels`, `assignees`, `index`, `id`,
  `is_favorite`, `repeat_after`. Date values can be ISO
  times or `now`, `now+7d`, `now-1w`. With `filter_include_nulls=false`, a task
  without a date never matches a date comparison.
- New tasks get the lowest position in every view of their project (65536,
  then half the current minimum), so they appear first.
- A board view's task list (`…/views/{view}/tasks` on a kanban view) answers
  with its columns, each holding its tasks, in a paginated envelope. The
  specification does not show this response.
- `/info` lists no migrators and no background providers.
- The avatar endpoint is public, because browsers load it with `<img>`, which
  cannot send a bearer token.
- No refresh cookie is set for a legacy `/api/v1` path, because there is no
  v1 API.

## Known gaps

- No project editing, archiving or deletion. No label removal, assignees,
  reminders, repeats, attachments, sharing or teams. Board columns cannot be
  renamed, reordered, limited or deleted, and cards cannot be reordered
  inside a column from the frontend.
- No realtime events are sent; notifications are always empty.
- The rate limit and the per-user caches live in memory.
- `/api/v2/schemas/*.json` URLs in `$schema` fields are identifiers only and
  are not served.
