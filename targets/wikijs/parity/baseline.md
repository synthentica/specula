# Parity: baseline

**Passes 52/52 recorded behaviours (100%)** against http://localhost:3000, 2026-10-12T09:07:10.531Z.

Checked 3565 response keys, 80 list sizes, 97 values (echoed, totals, error codes) and 58 true/false flags.

Each behaviour is one recorded request replayed in order on a fresh instance. A step passes when the status code and content type match, every recorded response key exists with the same JSON type, lists of records have the recorded size, values the client sent come back unchanged, booleans match, and error codes match. Ids, timestamps and other volatile values are not compared.

| Flow | Passed |
|---|---|
| setup | 3/3 |
| login | 2/2 |
| create-home | 5/5 |
| create-pages | 10/10 |
| edit-page | 4/4 |
| comments | 3/3 |
| browse | 4/4 |
| search | 3/3 |
| history | 2/2 |
| users | 5/5 |
| delete-page | 4/4 |
| errors | 2/2 |
| logout-login | 5/5 |

## Failures

_None._
