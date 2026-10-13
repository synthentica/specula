# Visual check: rebuild

**Looks 96/100 like the UI spec** over 5 views, against http://localhost:4711, 2026-10-12T17:43:02.447Z.

Each view is opened with the data the recorded flows leave behind and compared with `spec/ui/views.json`: layout 40 % (regions and where components sit on the first screen), components 30 % (count, size, style) and style 30 % (page colours, accent, font, radius). Boxes and computed styles only; text and images are not compared. This score is separate from behavioural parity.

| View | Score | Layout | Components | Style |
|---|---|---|---|---|
| board | **97** | 95 | 99 | 100 |
| overview | **97** | 94 | 99 | 100 |
| projects | **97** | 94 | 98 | 100 |
| task | **94** | 90 | 93 | 100 |
| upcoming | **97** | 93 | 99 | 100 |

## Largest differences

### board

_None._

### overview

_None._

### projects

- list-item: font weight 600, spec 400

### task

- card: border all #e5e7eb, spec none
- badge: text transform uppercase, spec none

### upcoming

_None._
