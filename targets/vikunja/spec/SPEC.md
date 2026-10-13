# Task manager: rebuild specification

This folder describes a web task manager as it was observed from the browser:
12 recorded user flows, 109 API exchanges. It is everything a rebuild may use.

| File | What it holds |
|---|---|
| `SPEC.md` | This document: features, behaviour, data model, what was not observed |
| `openapi.yaml` / `openapi.json` | OpenAPI 3.1 for the 27 observed operations, with schemas inferred from real responses |
| `realtime.json` | WebSocket message shapes |
| `flows/*.json` | The recorded flows as request/response steps; the parity suite replays them |

**Observed** means a recorded request or response shows it (each claim names a
flow step, `flows/<flow>.json` step *n*, counted from 1). **Inferred** means it
follows from observations but was not seen directly. Anything else is unknown
and listed at the end. `x-observed-values` in the OpenAPI document lists values
that were seen, not a closed enum.

UI labels in `flows/*.json` (`action.target.name`) describe the original UI so
the flows are readable. A rebuild uses its own wording, name and look.

## 1. Scope

Build: registration, login, logout, token refresh, projects (create, list, read),
tasks (bulk create, list per project view, list across projects with search and
filters, read, update with JSON Patch, mark done, delete), labels (create, list,
attach to a task), task comments (create, list), kanban buckets (list with
their tasks, create, move a task between buckets, the done bucket), current
user, server info, a generated avatar, notifications (list, always empty in the
recordings), the WebSocket handshake, and the error responses in section 5.1.

Observed but not built (shapes unknown or not exercised): sharing, teams,
attachments, reminders, time tracking, webhooks,
migrations, admin, project archiving. Their fields appear in responses
(for example `attachments`, `reminders`, `bucket_id`) and must be returned with
the default values shown in the flows.

## 2. API conventions (observed)

- Base path `/api/v2`. JSON in and out (`application/json`), except the JSON
  Patch request (`application/json-patch+json`), the avatar (`image/svg+xml`)
  and `DELETE` (204, empty body).
- Every JSON object response starts with a `$schema` field: an absolute URL
  `<origin>/api/v2/schemas/<TypeName>.json`. Clients ignore it; the parity check
  ignores its value.
- Lists are paginated envelopes: `{ $schema, items, total, page, per_page, total_pages }`
  (`flows/register.json` step 8). `page` starts at 1; `per_page` defaults to 50
  for tasks and labels, 20 was requested for notifications. An empty list is
  `items: []`, `total_pages: 0`.
- "No date" is the zero time `0001-01-01T00:00:00Z`, not `null`
  (`done_at`, `due_date`, `start_date`, `end_date` on a new task,
  `flows/add-tasks.json` step 1). Timestamps are RFC 3339 UTC.
- Empty collections on a single resource are often `null` rather than `[]`
  (`labels`, `reminders`, `attachments`, `reactions`, `related_tasks` on a new
  task); `assignees` was `[]`. Keep the same choice per field: the flows show it.
- Responses carry `X-Request-Id`; login responses carry `X-Ratelimit-Limit`
  (10), `X-Ratelimit-Remaining` and `X-Ratelimit-Reset` (observed, optional for
  parity). CORS headers are present.
- Embedded users (`owner`, `created_by`, `author`) are the short form
  `{ id, name, username, created, updated }`.
- Errors are `application/problem+json`:
  `{ $schema, title, status, detail, code }` where `title` is the HTTP reason
  phrase, `status` repeats the HTTP status, `detail` is a human sentence (use
  your own wording) and `code` is a numeric error code the client relies on
  (section 5.1, `flows/errors.json`).

## 3. Authentication (observed)

1. `POST /register` with `{ username, email, password, language }` → 201 and the
   short user (`flows/register.json` step 2). The client then logs in.
2. `POST /login` with `{ username, password }` (optionally `long_token: false`)
   → 200 `{ $schema, token }`. `token` is a JWT signed HS256, lifetime 600 s, with
   claims `exp, iat, id, is_admin, jti, sid, type, username`. The response also
   sets a refresh cookie: `HttpOnly; SameSite=Lax; Max-Age=259200` (3 days),
   scoped with `Path=/api/v2/user/token/refresh` (a second copy is set for a
   legacy `/api/v1/...` path) (`flows/register.json` step 3,
   `flows/logout-login.json` step 2).
3. Every other API call sends `Authorization: Bearer <token>`. The client keeps
   the token in `localStorage` under `token`.
4. `POST /user/token/refresh` sends only the refresh cookie (no bearer) and
   returns a new `{ $schema, token }` and sets a fresh cookie
   (`flows/register.json` step 10). The client calls it shortly after login and
   again whenever its token is about to expire, so after an idle period it
   refreshes before its next request (`flows/token-refresh.json` steps 11 and
   13: each comes after a pause longer than the token lifetime). Refresh must
   work with an expired access token, and the new token must be accepted at once.
   The rotated cookie replaces the old one.
   - The access-token lifetime is 600 s by default. It must be configurable at
     start-up with the environment variable `ACCESS_TOKEN_TTL` (seconds): the
     token-refresh flow was recorded with a 15 s lifetime and the parity run
     starts the rebuild with `ACCESS_TOKEN_TTL=15`.
5. `POST /logout` with the bearer → 200 `{ $schema, message }` and clears the
   cookie with `Max-Age=0` (`flows/logout-login.json` step 1).
6. Wrong password: `POST /login` → 403 with code 1011
   (`flows/errors.json` step 15).
7. Inferred: requests without a valid bearer get 401. The client refreshes
   before expiry, so no 401 was recorded; return a problem+json body with code
   11 for an expired token (the client's retry logic looks for 11).

## 4. Data model (observed, from responses)

Full field lists and types are in `openapi.yaml` under `components.schemas`.

**User** (`GET /user`): `id, name, username, created, updated, settings,
deletion_scheduled_at, is_local_user, auth_provider, is_admin`. `settings` holds
`default_project_id` (the user's default project), `language`, `timezone`,
`week_start`, reminder switches and `frontend_settings` (null).

**Project**: `id, title, description, identifier, hex_color, parent_project_id,
owner, is_archived, is_favorite, position, views, background_information,
background_blur_hash, max_permission, created, updated`.
- Registration creates one default project for the user (id 1 in a fresh
  instance; name it yourself) and points `settings.default_project_id` at it.
- Creating a project creates four views in this order (`flows/create-project.json`
  step 1): `list` (position 100, `filter.filter = "done = false"`), `gantt` (200),
  `table` (300), `kanban` (400, `bucket_configuration_mode: "manual"`). The
  kanban view gets three buckets (positions 100, 200, 300; to do, in progress,
  done) and stores the first and third as `default_bucket_id` and
  `done_bucket_id`. Other views have `bucket_configuration_mode: "none"` and
  zero bucket ids.
- Project `position` grew by 65536 per project (65536, 131072).

**Task**: `id, title, description, project_id, done, done_at, due_date,
start_date, end_date, priority, percent_done, hex_color, repeat_after,
repeat_mode, reminders, assignees, labels, attachments, related_tasks,
cover_image_attachment_id, is_favorite, identifier, index, bucket_id, buckets,
position, reactions, created_by, created, updated`. Lists add
`comment_count` (requested with `expand=comment_count`; `expand=is_unread` added
nothing observable), and single reads add `buckets`, `subscription` and
`max_permission` (`flows/edit-task.json` step 1).
- `index` counts per project from 1; `identifier` is `#<index>` when the project
  has no identifier.
- In a project's list view, the newest task has the lowest `position`
  (65536, 32768, 16384 for the 1st, 2nd and 3rd task; `flows/add-tasks.json`
  step 6) and lists sort by `position` ascending, so new tasks appear first.
- Marking done sets `done: true` and `done_at` to the current time
  (`flows/edit-task.json` step 8); not done keeps the zero time.

**Bucket**: `id, title, project_view_id, limit, count, position, created_by,
created, updated`. `count` is the number of tasks in the bucket.
- Every task of a project sits in exactly one bucket of each kanban view. New
  tasks go to the view's `default_bucket_id`.
- Marking a task done (`PATCH`, `done: true`) also moves it to the view's
  `done_bucket_id` (the task marked done in `flows/edit-task.json` is in the
  done bucket in `flows/kanban.json` step 3), and moving a task into the done bucket marks it done
  (`done: true`, `done_at` now; `flows/kanban.json` step 9). Moving it to
  another bucket leaves `done` false (steps 5, 7).
- A new bucket is appended after the existing ones (its `position` is higher;
  `flows/kanban.json` step 4).

**Label**: `id, title, description, hex_color, created_by, created, updated`.
Attaching returns `{ label_id, created }`.

**Comment**: `id, comment` (HTML string as sent), `author, reactions, created, updated`.

**Notification** list: always empty in the recordings; item shape unknown.

## 5. Behaviour by operation

| Operation | Behaviour | Evidence |
|---|---|---|
| `GET /info` | Public. Server version, frontend URL, max file size, `max_items_per_page`, 15 feature switches, `auth.local.enabled/registration_enabled`, lists of providers. Booleans are compared (section 8), so return the recorded switch values even for features the rebuild leaves out. | `register` step 1 |
| `POST /register` | Creates the user and the default project. 201. | `register` step 2 |
| `POST /login`, `/logout`, `/user/token/refresh` | See section 3. | |
| `GET /user` | Current user with settings. | `register` step 4 |
| `GET /avatar/{username}?size=48` | An SVG avatar generated from the username. | `register` step 5 |
| `GET /projects?is_archived=true&expand=permissions&page=1` | All projects of the user, each with its `views`, in a paginated envelope. | `register` step 6 |
| `POST /projects` | Creates a project with its views and buckets (section 4). 201 with the full project. | `create-project` step 1 |
| `GET /projects/{projectId}` | One project with views. | `create-project` step 2 |
| `GET /projects/{projectId}/views/{viewId}/tasks` | Tasks of the project, filtered by the view's filter (the list view hides done tasks) and by query parameters `filter`, `q`, `sort_by`, `order_by`, `page`; `expand=comment_count,is_unread,subtasks` adds fields. | `add-tasks` step 2 |
| `GET /projects/{projectId}/views/{viewId}/buckets` | Buckets of a kanban view. | `edit-task` step 2 |
| `GET /projects/{projectId}/views/{viewId}/buckets/tasks` | The view's buckets in `position` order, each with its `tasks` (same task shape as lists, in task `position` order). A bucket without tasks has no `tasks` key. Query parameters as for the task list, plus `per_page` (tasks per bucket). | `kanban` step 3 |
| `POST /projects/{projectId}/views/{viewId}/buckets` | Body `{ title }`. 201 with the bucket (`limit` 0, `count` 0, full `created_by`). | `kanban` step 4 |
| `PUT /projects/{projectId}/views/{viewId}/buckets/{bucketId}/tasks` | Body `{ task_id }`. Moves the task into the bucket (section 4). 200 `{ bucket_id, bucket, task_id, project_view_id, task }`: `bucket` is the target bucket with its new `count` and `created_by: null`; `task` is the full task after the move (its `bucket_id` field reads 0 here). | `kanban` steps 5, 7, 9 |
| `PUT /tasks/{taskId}/position` | Body `{ project_view_id, position }`. Stores the task's position in that view. Sent `position: 0` came back as a large positive number (inferred: 0 means "let the server place it"). 200 `{ task_id, project_view_id, position }`. | `kanban` steps 6, 8, 10 |
| `POST /projects/{projectId}/tasks/bulk` | Body `{ tasks: [ {title, ...} ] }`. Creates tasks in order; 201 `{ $schema, tasks: [...] }` with full tasks. | `add-tasks` step 1 |
| `GET /tasks` | Tasks across all projects. Parameters as for the view list, plus `per_page`. `q` matches the title (case-insensitive substring is enough for the recordings); `sort_by`/`order_by` may repeat and pair up by position. | `search` steps 1-2, `upcoming-overview` |
| `GET /tasks/{taskId}?expand=reactions,is_unread,buckets` | One task; `buckets` lists the kanban buckets the task is in. | `edit-task` step 1 |
| `PATCH /tasks/{taskId}` | JSON Patch (RFC 6902). The client sends `add` ops for every editable field, not only the changed ones. Apply them and return the full task. | `edit-task` steps 5, 8 |
| `DELETE /tasks/{taskId}` | 204. Later lists no longer contain the task. | `delete-task` step 5 |
| `GET/POST /tasks/{taskId}/comments` | List (paginated, `order_by`) and create `{ comment }`. | `edit-task` steps 3, 6 |
| `POST /labels`, `GET /labels` | Create `{ title, hex_color }` (hex without `#`), list the user's labels. | `labels` steps 4-5 |
| `POST /tasks/{taskId}/labels` | Body `{ label_id }`, 201. Afterwards the task's `labels` contains the label. | `labels` step 6 |
| `GET /notifications?page&per_page` | Paginated, empty. | `register` step 8 |

### 5.1 Errors (observed)

| Situation | Response | Evidence |
|---|---|---|
| `GET /tasks/{taskId}` for a deleted or unknown task | 404, code 4002 | `errors` steps 6, 9 |
| A task list with a filter value of the wrong type (`priority > urgent`) | 400, code 4019 | `errors` steps 12-13 |
| `POST /login` with a wrong password | 403, code 1011 | `errors` step 15 |
| `POST /register` with a username that exists | 400, code 1001 | `errors` step 17 |

All use the problem+json body from section 2.

### Filter expressions (observed)

`filter` is a small expression language: `done = false`,
`done = false && due_date < '<ISO time>' && due_date > '<ISO time>'`, or empty.
Inferred grammar: comparisons `field op value` with `=`, `!=`, `<`, `>`, `<=`,
`>=`, joined by `&&` / `||`; values are booleans, numbers or quoted strings.
A task with the zero `due_date` does not match a `due_date` range
(`filter_include_nulls=false`). `filter_timezone` was `GMT`. A value that does
not fit the field's type (a word for the numeric `priority`) is a 400
(section 5.1).

## 6. Realtime (observed)

WebSocket at `/api/v2/ws` (`realtime.json`). After connecting, the client sends
`{ action: "auth", token }` and receives `{ action: "auth.success", success: true }`,
then sends `{ action: "subscribe", event }` for `timer.created`, `timer.updated`,
`timer.deleted` and `notification.created`. No event arrived during the
recordings, so event payloads are unknown. A rebuild accepts the handshake and
subscriptions; sending events is optional.

## 7. Not determined

- Validation rules beyond the four errors in section 5.1.
- Permission rules beyond "a user sees their own projects, tasks and labels"
  (inferred). Access to another user's data was not tried: recordings use one
  account only.
- The server's answer to an expired token: the client never sent one.
- Bucket limits, moving a task out of the done bucket, reordering inside a bucket.
- Reminders, repeats, attachments, sharing, teams: fields exist, behaviour unknown.
- Notification and WebSocket event payloads.
- Search details beyond a title substring match; ranking for `sort_by=relevance`.

## 8. How parity is checked

The parity suite replays `flows/index.json` order against one fresh instance of
the rebuild: register (credentials come from the environment), then every step
in order, binding ids from responses (`bind`) into later paths, bodies and
query strings (`{ "var": ... }`, `{ "$var": ... }`, `{ "$template": ... }`;
`{{now:<seconds>:<format>}}` in a template is the replay time shifted as in the
recording). A step passes when:

1. the status code matches;
2. the content type matches (ignoring parameters; not checked for 204);
3. every key in the recorded JSON body exists with the same JSON type
   (a recorded `null` accepts any value; ids, timestamps, `$schema` and other
   volatile values are not compared);
4. values the client itself sent earlier in the flow (titles, descriptions,
   priorities, label ids) come back unchanged (strings the server
   had already shown before the client sent them back are not compared), and lists of
   records (`items`, `views`, `tasks` in buckets, embedded objects) have the
   recorded size, as does `total`. Lists of plain values, such as capability
   names in `/info`, are compared by element type only;
5. every boolean has the recorded value (`done`, `is_archived`, feature
   switches in `/info`), and in error responses (status 400 or higher) every
   number does too (`status`, `code`).

A step with `pauseMs` waits that long first: the recording was idle for longer
than the token lifetime there. A password written `<redacted:secret:other>` is
not the account's password (a wrong-password attempt); the runner sends a wrong
one. Extra keys in the rebuild's responses do not fail a step.
