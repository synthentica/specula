# Team boards: rebuild specification

This folder describes the backend of a self-hosted kanban board app (boards
with cards grouped by a status property, card descriptions and comments, board
templates, and live updates over a WebSocket) as it was observed from the
browser: 9 recorded user flows, 432 HTTP exchanges and 53 WebSocket messages (24 sent, 29 pushed).
It is everything a rebuild may use.

| File | What it holds |
|---|---|
| `SPEC.md` | This document: features, behaviour, data model, what was not observed |
| `openapi.yaml` / `openapi.json` | OpenAPI 3.1 for the 24 observed HTTP operations, with schemas inferred from the recorded bodies |
| `realtime.json` | The WebSocket channel: the message kinds the client sent and the server pushed, with their shapes |
| `flows/*.json` | The recorded flows as steps; the parity suite replays them, including the WebSocket messages |

**Observed** means a recorded request, response or socket message shows it
(each claim names a flow step, `flows/<flow>.json` step *n*, counted from 1).
**Inferred** means it follows from observations but was not seen directly.
Anything else is unknown and listed in section 9.

UI labels in `flows/*.json` (`action.target.name`) describe the original UI so
the flows are readable. A rebuild uses its own name, wording and look. Text the
original ships with (template titles, descriptions, card and checklist content,
the default category's name, option labels of the templates) appears in
recorded responses; a rebuild returns **its own text** in the same shapes
(section 5 says which few values must stay as they are).

## 1. Scope

Build: sign-up of the first user, sign-in with username and password, sign-out,
the current user and their (empty) settings list, client configuration, the
single built-in team, board templates and their blocks, the user's board
categories, creating a board together with its first view, renaming a board and
editing its card properties (the status groups), cards (create, rename, set a
property, delete), card content (a text block) and comments, board members,
user lookups, usage limits, and the WebSocket that pushes every change to
subscribed clients.

Observed but not built beyond the recorded responses: board sharing, joining a
board (only the "not found" answer was seen), team settings, file uploads,
other view types, and multi-user boards.

## 2. API conventions (observed)

- Base path `/api/v2`; JSON in and out (`application/json`), also for errors.
- Every request carries `X-Requested-With: XMLHttpRequest`. The original
  refuses an API request without it (400, a CSRF check; seen while exploring,
  not in a flow). The parity suite sends it on every request
  (`headers` in `flows/index.json`), so a rebuild may require it or not.
- Authentication is an opaque session token in `Authorization: Bearer <token>`
  (section 3). There are no cookies.
- Ids are random strings of 27 lowercase letters and digits whose first letter
  tells the kind: `u` user, `b` board, `c` card, `v` view, `a` content/comment,
  `7` category (`register` step 18; `create-board` step 24). Card property and
  option ids are whatever the client generated (random 27-character strings or
  UUIDs) and are kept as sent (`groups` steps 42, 48).
- Times are integers, milliseconds since the epoch (`createAt`, `updateAt`;
  `create_at`, `update_at` on users). `deleteAt` / `delete_at` is `0` for live
  records.
- The client generates ids for new boards and blocks, but **the server replaces
  them** with its own and returns the stored records (`create-board` step 24,
  `add-cards` step 42). Later requests use the server's ids.
- Errors are `{ "error": "<message>", "errorCode": <HTTP status> }`
  (section 7). The message is the original's wording; a rebuild may use its
  own, but `errorCode` must equal the status.
- Writes that only change something (block patches, deletes, sign-out,
  sign-up) answer `200` with `{}`.

## 3. Sign-up, sign-in and the session (observed)

- `POST /register` `{ email, username, password, token: "" }` creates the first
  user and answers `{}` (`register` step 4). Once a user exists, sign-up without
  a team sign-up token fails: 401 `{ error, errorCode: 401 }` (`errors` step 31).
- `POST /login` `{ username, password, type: "normal" }` answers
  `{ "token": "<session token>" }` (`register` step 5). A wrong password: 401
  (`logout-login` step 44).
- Requests without a token to `/users/me` and `/users/me/config` answer 401
  (`register` steps 1-2); `/clientConfig` needs no token.
- `POST /logout` with the token answers `{}` (`logout-login` step 42). Inferred:
  the token stops working.
- The parity suite signs up with the username `owner` (as recorded), a random
  password and a random email address.

## 4. Data model (observed, from responses)

### 4.1 User

`{ id, username, nickname, firstname, lastname, create_at, update_at,
delete_at, is_bot, is_guest, roles }`; names other than `username` are `""`,
`is_bot` and `is_guest` are `false`, `roles` is `""` (`register` step 6). The
email address is never returned.

### 4.2 Team

There is exactly one team, id `"0"`: `{ id: "0", title: "", signupToken,
settings: {}, modifiedBy: "", updateAt }` (`register` step 11). `signupToken`
is a secret string. `GET /teams` lists it alone; `GET /teams/0` returns it.

### 4.3 Board

`{ id, teamId: "0", channelId: "", createdBy, modifiedBy, type, minimumRole:
"", title, description, icon, showDescription, isTemplate, templateVersion,
properties, cardProperties, createAt, updateAt, deleteAt }`.

- `type` is `"P"` for a user's board and `"O"` for a template.
- `cardProperties` is the list of card fields:
  `{ id, name, type, options: [ { id, value, color } ] }`. `type` is one of
  `select`, `multiSelect`, `person`, `multiPerson`, `text`, `number`, `date`,
  `checkbox`, `url`, `email`, `phone`, `createdBy`, `createdTime`, `updatedBy`,
  `updatedTime`. Only `select` and `multiSelect` have options; `color` is a
  palette name such as `propColorDefault`. The status groups of a kanban board
  are the options of its first `select` property.
- `properties` is an object; templates carry `{ trackingTemplateId: <32 hex> }`.

### 4.4 Block

Everything on a board is a block: `{ id, parentId, boardId, createdBy,
modifiedBy, schema: 1, type, title, fields, createAt, updateAt, deleteAt }`.
Requests also carry `limited: false`, which responses leave out.

| `type` | `parentId` | `title` | `fields` |
|---|---|---|---|
| `view` | the board | view name | `{ viewType, cardOrder, sortOptions, visiblePropertyIds, visibleOptionIds, hiddenOptionIds, collapsedOptionIds, filter: { operation, filters }, columnWidths, columnCalculations, kanbanCalculations, defaultTemplateId }` |
| `card` | the board | card title | `{ icon, properties, contentOrder, isTemplate }` |
| `text` | a card | the text | `{}` |
| `comment` | a card | the comment | `{}` |
| `checkbox` | a card | label | `{ value }` (boolean) |
| `divider` | a card | `""` | `{}` |

- `cardOrder` lists card ids in board order; `contentOrder` lists a card's
  content block ids. A card's `properties` maps a card property id to an option
  id (`edit-card` step 42).
- Observed quirk: the first view created with a board keeps the **client's**
  temporary board id as `parentId` while `boardId` is the real one
  (`create-board` step 24). `parentId` is not compared, so either is fine.

### 4.5 Membership, category

- Board member: `{ boardId, userId, roles: "", minimumRole: "", schemeAdmin,
  schemeEditor, schemeCommenter, schemeViewer, synthetic }`. The creator of a
  board is its admin and editor (`true, true, false, false`, `synthetic:
  false`; `create-board` step 35).
- Category (the sidebar group of a user's boards): `{ id, name, userID,
  teamID, createAt, updateAt, deleteAt, collapsed, sorting: "", type,
  boardMetadata: [], sortOrder }`. Each user has one `type: "system"` category,
  created the first time the categories are listed after sign-in
  (`register` step 18); a rebuild names it in its own words.

### 4.6 Seed state (observed)

A fresh instance holds the team, no users, no boards and **13 board
templates** (`register` step 15). The templates' structure is part of the
contract (list sizes and booleans are compared, section 10): the number of
templates, and for each template, in order, the number of card properties,
each property's `type` and its number of options. Read them from the recorded
response; write your own titles, descriptions, icons, property names and option
labels. Every template has `showDescription: true`, `isTemplate: true`,
`type: "O"`, `createdBy` / `modifiedBy` `"system"`.

The client also opens the blocks of the first template (`register` step 19):
35 blocks, one `view`, 4 `card`s and their content (15 `checkbox` with
`value: false`, 10 `text`, 5 `divider`). Each card's `properties` sets two
properties; the view's `fields` has the keys listed in 4.4. A rebuild seeds a
first template with the same block types, counts and field keys, with its own
text.

## 5. Behaviour by operation

| Operation | Behaviour (observed) |
|---|---|
| `GET /clientConfig` | `{ telemetry: false, telemetryid: "", enablePublicSharedBoards: false, teammateNameDisplay: "username", featureFlags: {}, maxFileSize: 0 }` |
| `GET /users/me` | The signed-in user (4.1) |
| `GET /users/me/config` | `[]` |
| `GET /users/me/memberships` | The user's board memberships (4.5); `[]` before any board |
| `GET /users/{id}` | One user |
| `POST /users` `[userId, ...]` | The users with those ids, as a list |
| `GET /teams/0/users?search=&exclude_bots=true` | The team's users |
| `GET /teams`, `GET /teams/0` | The team (4.2) |
| `GET /teams/0/boards` | The boards the user is a member of (not templates) |
| `GET /teams/0/templates` | The 13 templates (4.6) |
| `GET /teams/0/categories` | The user's categories, creating the system category on first call |
| `GET /limits` | `{ cards: 0, used_cards: 0, card_limit_timestamp: 0, views: 0 }` |
| `POST /boards-and-blocks` `{ boards: [board], blocks: [view] }` | Stores the board with a new id (creator = the user, member as admin) and the blocks with new ids pointing at it; answers `{ boards, blocks }` as stored (`create-board` step 24) |
| `PATCH /boards/{id}` | Partial update; answers the whole board. `{ title }` renames (`create-board` step 49). `{ updatedCardProperties: [property], deletedCardProperties: [ids], updatedProperties, deletedProperties }`: each listed property replaces the stored property with the same id, options included (`groups` steps 42-57) |
| `GET /boards/{id}/blocks?all=true` | All live blocks of the board, in no particular order |
| `GET /boards/{id}/members` | The board's members |
| `POST /boards/{id}/blocks` `[block]` | Stores new blocks with new ids; `parentId` from the request (a card's id for content and comments); answers the stored blocks as a list (`add-cards` step 42, `edit-card` steps 44, 47) |
| `PATCH /boards/{id}/blocks/{blockId}` | `{ title }` renames; `{ updatedFields: {...}, deletedFields: [keys] }` sets / removes top-level keys of `fields` (`cardOrder`, `contentOrder`, `properties` are replaced whole). Answers `{}` |
| `DELETE /boards/{id}/blocks/{blockId}` | Deletes the block; answers `{}`; it no longer appears in the board's blocks (`delete-card` step 42) |
| `POST /boards/{id}/join` | Unknown board: 404 (`errors` step 25) |
| `POST /logout` | `{}` |

**Values that must stay as recorded.** The parity suite compares a string in a
response when the client sent that same string earlier (section 10). In the
templates and their blocks this applies to a few generic values: a property
named `Status`, an option labelled `Doing`, the property types `select` and
`text`, the block types `card`, `view` and `text`, the view type `board`, the
filter operation `and`, and the team id `"0"`. Keep these exact values where
the recorded templates have them; everything else is yours to word.

## 6. Realtime (observed)

One WebSocket at `/ws` (not under `/api/v2`), JSON text frames.

The client sends (`register` steps 8, 17; `logout-login` step 43):

- `{ "action": "AUTH", "token": "<session token>" }` right after connecting;
- `{ "action": "SUBSCRIBE_TEAM", "teamId": "0" }` to receive the team's changes;
- `{ "action": "UNSUBSCRIBE_TEAM", "teamId": "0" }` when signing out.

The server answers none of these. After every change it pushes one message per
changed record to every socket that authenticated and subscribed to the team,
**including the socket of the client that made the change**. Each message has
`action` and `teamId: "0"`:

| `action` | Payload key | Sent when |
|---|---|---|
| `UPDATE_BOARD` | `board` (4.3) | a board is created or patched, also by a patch that changes nothing (`create-board` steps 24, 25, 49; `groups` steps 42-57) |
| `UPDATE_BLOCK` | `block` (4.4) | a block is created, patched or deleted; one message per block (`add-cards` steps 42-50) |
| `UPDATE_MEMBER` | `member` (4.5) | a member is added (the creator, on board creation) |
| `UPDATE_CATEGORY` | `category` (4.5) | the system category is created (`register` step 18; its `sortOrder` here is `10`) |
| `UPDATE_BOARD_CATEGORY` | `blockCategories: [ { boardID, categoryID, hidden: false } ]` | a new board is filed under the user's category |

A deleted block is pushed as a tombstone: `{ id, boardId, parentId: "",
createdBy: "", modifiedBy: "", schema: 0, type: "", title: "", fields: null,
createAt: 0, updateAt: <now>, deleteAt: <now> }` (`delete-card` step 42).

Board creation pushes, in order: `UPDATE_BOARD`, one `UPDATE_BLOCK` per block,
`UPDATE_MEMBER`, `UPDATE_BOARD_CATEGORY` (`create-board` step 24).

## 7. Errors (observed)

| Situation | Status | Step |
|---|---|---|
| No token on `/users/me` (and `/users/me/config`) | 401 | `register` 1 |
| Sign-up when a user exists, without a sign-up token | 401 | `errors` 31 |
| Wrong password | 401 | `logout-login` 44 |
| Blocks of, or joining, a board that does not exist | 404 | `errors` 24, 25 |

All are `{ "error": "<message>", "errorCode": <status> }`.

## 8. Recorded flows

| Flow | What the user did |
|---|---|
| `register` | Opened the app, signed up, landed on the template picker |
| `create-board` | Created an empty board and named it |
| `groups` | Added three status groups and named them |
| `add-cards` | Added three cards and titled them |
| `edit-card` | Set a card's status, wrote a description and a comment |
| `move-card` | Dragged a card to another status column |
| `delete-card` | Deleted a card |
| `errors` | Opened a missing board, tried a second sign-up, signed in again |
| `logout-login` | Signed out, tried a wrong password, signed in |

The client re-reads the user, team, boards, templates, memberships and limits
on every page load, so these GETs repeat in every flow.

## 9. Not determined

- Permissions: what a second user, a guest or a viewer may do; boards are only
  ever touched by their creator.
- Whether the old token is refused after sign-out.
- Validation: empty titles, unknown property ids, blocks of an unknown type.
- Deleting a card with content: whether its text and comments go too.
- Board deletion, archiving, duplication, creating a board from a template,
  sharing, other view types (table, gallery, calendar).
- Socket behaviour for a bad or missing `AUTH` token, for a socket that never
  subscribes, and pushes to other users' sockets.

## 10. How parity is checked

The parity suite replays `flows/index.json` order against one fresh instance of
the rebuild, sending `X-Requested-With: XMLHttpRequest` on every request. Ids
from responses are bound (`bind`) into later requests (`{ "$var": ... }`); an
id taken from a list is bound by a distinguishing field when one exists
(`$[?title="Write announcement"].id`), else by position.

Each HTTP step and each expected pushed message is one behaviour. For
WebSocket steps (`send`), the runner opens one socket per flow at the flow's
first `send`, sends the recorded message (the `AUTH` token is the current
session token) and collects everything the server pushes. Each `receive` after
a step is a behaviour: after the flow's last step (and up to 2 s more), it
passes when a pushed message of the same `action` arrived that compares the
same way as a response body does (below). Pushes may arrive in any order and
need not follow their step immediately; extra pushes do not fail.

An HTTP step passes when:

1. the status code matches;
2. the content type matches (ignoring parameters);
3. every key in the recorded JSON body exists with the same JSON type (a
   recorded `null` accepts any value; ids, timestamps, URLs and the keys in
   `flows/index.json` `volatileKeys` are not compared);
4. values the client itself sent earlier (board and card titles, option
   labels, comment text, block types, `"0"`) come back unchanged; strings the
   server wrote are not compared. Lists of records (templates, blocks, card
   properties, options, members, users, categories) have the recorded size. A
   list whose recorded order follows no field (blocks) passes in any order as
   long as each recorded element matches a different returned one;
5. every boolean has the recorded value (`isTemplate`, `showDescription`,
   `schemeAdmin`, a checkbox's `value`, `telemetry`, ...). In an error body,
   `errorCode` must match.

A password written `<redacted:secret:other>` is not the account's (a
wrong-password attempt); the runner sends a different one. An email written
`<redacted:email:N>` is another person's address. Extra keys in the rebuild's
responses do not fail a step.
