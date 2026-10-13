# Inferred spec vs. real API

Truth: Vikunja API (OpenAPI 3.1.0, version v2.7.0). Inferred: spec/openapi.json.

## Summary

| Metric | Value |
|---|---|
| Operations in the real API | 202 |
| Operations inferred | 27 |
| Inferred operations that exist in the real API (precision) | 27/27 (100%) |
| Share of the real API exercised by the recorded flows | 13% |
| Response fields found, on matched operations (recall) | 347/387 (90%) |
| Inferred response fields that exist in the real schema (precision) | 347/356 (97%) |
| Field type agreement | 328/328 (100%) |
| Request body fields found | 40/100 (40%) |
| Query parameters found | 33/59 (56%) |

Field recall is limited by what the app sent and received: optional fields that were never present in a response cannot be inferred. Fields of paginated lists are compared as `items[].field`; a field only ever observed as `null` has no comparable type.

## Matched operations

| Operation | Response fields found | Missing (sample) | Extra in inferred | Type mismatches | Query params |
|---|---|---|---|---|---|
| `DELETE /tasks/{}` | 0/0 |  |  |  | 0/0 |
| `GET /avatar/{}` | 0/0 |  |  |  | 1/1 |
| `GET /info` | 22/22 |  |  |  | 0/0 |
| `GET /labels` | 12/12 |  |  |  | 1/4 |
| `GET /notifications` | 5/10 | items[].created, items[].id, items[].name, items[].notification, items[].read_at |  |  | 2/3 |
| `GET /projects` | 21/22 | items[].subscription |  |  | 3/6 |
| `GET /projects/{}` | 16/17 | subscription |  |  | 0/1 |
| `GET /projects/{}/views/{}/buckets` | 15/15 |  |  |  | 0/3 |
| `GET /projects/{}/views/{}/buckets/tasks` | 12/12 |  |  |  | 6/10 |
| `GET /projects/{}/views/{}/tasks` | 37/41 | items[].comments, items[].deleted_at, items[].is_unread, items[].time_entries_count | items[].max_permission |  | 8/10 |
| `GET /tasks` | 37/41 | items[].comments, items[].deleted_at, items[].is_unread, items[].time_entries_count | items[].max_permission |  | 9/10 |
| `GET /tasks/{}` | 33/37 | comments, deleted_at, is_unread, time_entries_count |  |  | 1/2 |
| `GET /tasks/{}/comments` | 5/11 | items[].author, items[].comment, items[].created, items[].id, items[].reactions, items[].updated |  |  | 2/5 |
| `GET /user` | 10/13 | bot_owner_id, email, pending_email |  |  | 0/0 |
| `PATCH /tasks/{}` | 32/36 | comments, deleted_at, is_unread, time_entries_count | max_permission |  | 0/0 |
| `POST /labels` | 7/7 |  |  |  | 0/1 |
| `POST /login` | 1/1 |  |  |  | 0/0 |
| `POST /logout` | 1/2 | oidc_logout_url |  |  | 0/0 |
| `POST /projects` | 16/17 | subscription |  |  | 0/1 |
| `POST /projects/{}/tasks/bulk` | 33/37 | tasks[].comments, tasks[].deleted_at, tasks[].is_unread, tasks[].time_entries_count | tasks[].max_permission |  | 0/1 |
| `POST /projects/{}/views/{}/buckets` | 10/10 |  |  |  | 0/0 |
| `POST /register` | 5/7 | bot_owner_id, email | auth_provider, deletion_scheduled_at, is_admin, is_local_user |  | 0/0 |
| `POST /tasks/{}/comments` | 6/6 |  |  |  | 0/1 |
| `POST /tasks/{}/labels` | 2/2 |  |  |  | 0/0 |
| `POST /user/token/refresh` | 1/1 |  |  |  | 0/0 |
| `PUT /projects/{}/views/{}/buckets/{}/tasks` | 5/5 |  |  |  | 0/0 |
| `PUT /tasks/{}/position` | 3/3 |  |  |  | 0/0 |

## Request bodies

Only fields the app actually sent can be inferred. Real schemas often accept optional fields the UI never sent in the recorded flows, and some reuse the full resource schema as input, so server-set fields (id, created, ...) show up here as not sent.

| Operation | Fields found | Not sent in recordings | Sent but not in the real schema |
|---|---|---|---|
| `PATCH /tasks/{}` | 3/4 | from |  |
| `POST /labels` | 2/7 | created, created_by, description, id, updated |  |
| `POST /login` | 3/4 | totp_passcode |  |
| `POST /projects` | 8/17 | background_blur_hash, background_information, created, id, max_permission, owner, subscription, updated +1 |  |
| `POST /projects/{}/tasks/bulk` | 14/37 | tasks[].assignees, tasks[].attachments, tasks[].buckets, tasks[].comment_count, tasks[].comments, tasks[].created, tasks[].created_by, tasks[].deleted_at +15 |  |
| `POST /projects/{}/views/{}/buckets` | 1/10 | count, created, created_by, id, limit, position, project_view_id, tasks +1 |  |
| `POST /register` | 4/5 | invite_token |  |
| `POST /tasks/{}/comments` | 1/6 | author, created, id, reactions, updated |  |
| `POST /tasks/{}/labels` | 1/2 | created |  |
| `PUT /projects/{}/views/{}/buckets/{}/tasks` | 1/5 | bucket, bucket_id, project_view_id, task |  |
| `PUT /tasks/{}/position` | 2/3 | task_id |  |

## Inferred but not in the real spec

_None._

## Real operations never exercised, by tag

- user: 27
- admin: 14
- sharing: 14
- migration: 12
- webhooks: 10
- auth: 9
- time-entries: 9
- tasks: 9
- teams: 9
- labels: 7
- projects: 6
- project_views: 6
- bots: 6
- filters: 5
- assignees: 4
- task: 4
- task_comments: 4
- notifications: 3
- project: 3
- tokens: 3
- reactions: 3
- service: 2
- subscriptions: 2
- sessions: 2
- mcp: 1
- api: 1
