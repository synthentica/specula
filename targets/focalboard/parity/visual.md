# Visual check: rebuild

**Looks 98/100 like the UI spec** over 1 view, against http://localhost:4714, 2026-10-12T17:43:44.312Z.

Each view is opened with the data the recorded flows leave behind and compared with `spec/ui/views.json`: layout 40 % (regions and where components sit on the first screen), components 30 % (count, size, style) and style 30 % (page colours, accent, font, radius). Boxes and computed styles only; text and images are not compared. This score is separate from behavioural parity.

| View | Score | Layout | Components | Style |
|---|---|---|---|---|
| board | **98** | 99 | 94 | 100 |

## Largest differences

### board

- button: typical size 99×32, spec 24×24
