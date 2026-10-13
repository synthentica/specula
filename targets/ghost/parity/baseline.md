# Parity: baseline

**Passes 151/151 recorded behaviours (100%)** against http://localhost:2368, 2026-10-12T09:06:51.710Z.

Checked 9032 response keys, 223 list sizes, 323 values (echoed, totals, error codes) and 1052 true/false flags.

Each behaviour is one recorded request replayed in order on a fresh instance. A step passes when the status code and content type match, every recorded response key exists with the same JSON type, lists of records have the recorded size, values the client sent come back unchanged, booleans match, and error codes match. Ids, timestamps and other volatile values are not compared.

| Flow | Passed |
|---|---|
| setup | 10/10 |
| create-post | 13/13 |
| publish-post | 9/9 |
| tags | 23/23 |
| members | 16/16 |
| settings | 16/16 |
| posts-list | 7/7 |
| delete-post | 19/19 |
| logout-login | 13/13 |
| errors | 10/10 |
| session-expired | 15/15 |

## Failures

_None._
