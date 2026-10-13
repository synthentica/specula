# Visual check: rebuild

**Looks 91/100 like the UI spec** over 4 views, against http://localhost:4712, 2026-10-12T17:43:12.666Z.

Each view is opened with the data the recorded flows leave behind and compared with `spec/ui/views.json`: layout 40 % (regions and where components sit on the first screen), components 30 % (count, size, style) and style 30 % (page colours, accent, font, radius). Boxes and computed styles only; text and images are not compared. This score is separate from behavioural parity.

| View | Score | Layout | Components | Style |
|---|---|---|---|---|
| editor | **88** | 87 | 87 | 91 |
| members | **90** | 83 | 89 | 100 |
| posts | **94** | 90 | 94 | 99 |
| tags | **90** | 85 | 88 | 100 |

## Largest differences

### editor

- button: background none, spec #ffffff
- most used font size 18px, spec 14px
- link: 1 on the view, spec 3

### members

- button: background #ffffff, spec none
- input: 4 on the view, spec 1

### posts

_None._

### tags

- tabs: border b #ebeef0, spec none
- button: corner radius 6px, spec 999px
- link: corner radius 0px, spec 6px
