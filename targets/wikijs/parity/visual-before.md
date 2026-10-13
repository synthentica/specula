# Visual check: before

**Looks 32/100 like the UI spec** over 4 views, against http://localhost:4713, 2026-10-12T17:45:24.401Z.

Each view is opened with the data the recorded flows leave behind and compared with `spec/ui/views.json`: layout 40 % (regions and where components sit on the first screen), components 30 % (count, size, style) and style 30 % (page colours, accent, font, radius). Boxes and computed styles only; text and images are not compared. This score is separate from behavioural parity.

| View | Score | Layout | Components | Style |
|---|---|---|---|---|
| history | **27** | 31 | 17 | 30 |
| home | **34** | 35 | 37 | 30 |
| page | **39** | 36 | 41 | 41 |
| tags | **28** | 25 | 22 | 36 |

## Largest differences

### history

- card: none, spec has 4
- footer: missing (spec 0×768×1280×32 at x,y,w,h)
- table: none, spec has 1
- accent colour #1976d2 not used
- font Iowan Old Style, spec Roboto
- main text colour #5f6b63, spec #000000de
- badge: none, spec has 2
- input: background #f7f3ea, spec none

### home

- card: none, spec has 10
- sidebar: missing (spec 0×64×256×736 at x,y,w,h)
- accent colour #1976d2 not used
- font Iowan Old Style, spec Roboto
- main text colour #5f6b63, spec #000000de
- input: background #f7f3ea, spec none
- button: background #2e6b4f, spec none
- topbar: background #fffdf8, spec #000000

### page

- card: none, spec has 10
- sidebar: missing (spec 0×64×256×736 at x,y,w,h)
- accent colour #1976d2 not used
- main text colour #5f6b63, spec #000000de
- footer: box 169,345,942,35, spec 0,768,1280,32 (x,y,w,h)
- input: background #f7f3ea, spec none
- button: background #2e6b4f, spec none
- topbar: background #fffdf8, spec #000000

### tags

- card: none, spec has 3
- column: none, spec has 1
- sidebar: missing (spec 0×64×300×736 at x,y,w,h)
- footer: missing (spec 0×768×1280×32 at x,y,w,h)
- accent colour #1976d2 not used
- main text colour #5f6b63, spec #000000de
- input: background #f7f3ea, spec none
- button: background #e3efe6, spec none
