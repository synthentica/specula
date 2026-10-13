# Parity: rebuild

**Passes 121/121 recorded behaviours (100%)** against http://127.0.0.1:4471, 2026-10-12T09:09:50.762Z.

Checked 3858 response keys, 71 list sizes, 225 values (echoed, totals, error codes) and 240 true/false flags.

Each behaviour is one recorded request replayed in order on a fresh instance, or one of 12 messages the server pushed over a WebSocket (it passes when a message of the recorded kind arrives on the flow's socket and compares the same way). A step passes when the status code and content type match, every recorded response key exists with the same JSON type, lists of records have the recorded size, values the client sent come back unchanged, booleans match, and error codes match. Ids, timestamps and other volatile values are not compared.

| Flow | Passed |
|---|---|
| register | 13/13 |
| create-project | 3/3 |
| add-tasks | 6/6 |
| edit-task | 8/8 |
| labels | 7/7 |
| search | 2/2 |
| delete-task | 8/8 |
| upcoming-overview | 2/2 |
| logout-login | 12/12 |
| errors | 31/31 |
| kanban | 10/10 |
| token-refresh | 19/19 |

Pushed realtime messages: 12/12.

## Failures

_None._
