# Parity: baseline

**Passes 461/461 recorded behaviours (100%)** against http://localhost:8000, 2026-10-12T09:05:39.950Z.

Checked 46179 response keys, 2045 list sizes, 483 values (echoed, totals, error codes) and 1653 true/false flags.

Each behaviour is one recorded request replayed in order on a fresh instance, or one of 29 messages the server pushed over a WebSocket (it passes when a message of the recorded kind arrives on the flow's socket and compares the same way). A step passes when the status code and content type match, every recorded response key exists with the same JSON type, lists of records have the recorded size, values the client sent come back unchanged, booleans match, and error codes match. Ids, timestamps and other volatile values are not compared.

| Flow | Passed |
|---|---|
| register | 18/18 |
| create-board | 55/55 |
| groups | 63/63 |
| add-cards | 57/57 |
| edit-card | 49/49 |
| move-card | 43/43 |
| delete-card | 41/41 |
| errors | 63/63 |
| logout-login | 72/72 |

Pushed realtime messages: 29/29.

## Failures

_None._
