# Visual check: before

**Looks 50/100 like the UI spec** over 1 view, against http://localhost:4714, 2026-10-12T17:45:32.117Z.

Each view is opened with the data the recorded flows leave behind and compared with `spec/ui/views.json`: layout 40 % (regions and where components sit on the first screen), components 30 % (count, size, style) and style 30 % (page colours, accent, font, radius). Boxes and computed styles only; text and images are not compared. This score is separate from behavioural parity.

| View | Score | Layout | Components | Style |
|---|---|---|---|---|
| board | **50** | 41 | 39 | 75 |

## Largest differences

### board

- topbar: missing (spec 240×0×1040×137 at x,y,w,h)
- badge: none, spec has 1
- card: background #fbfaf6, spec none
- input: 1 on the view, spec 6
- sidebar: background #fbfaf6, spec #1e325c
- link: none, spec has 2
- font system-ui, spec Open Sans
- card: typical size 260×138, spec 260×52
