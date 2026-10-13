# Visual check: rebuild

**Looks 93/100 like the UI spec** over 4 views, against http://localhost:4713, 2026-10-12T17:43:36.671Z.

Each view is opened with the data the recorded flows leave behind and compared with `spec/ui/views.json`: layout 40 % (regions and where components sit on the first screen), components 30 % (count, size, style) and style 30 % (page colours, accent, font, radius). Boxes and computed styles only; text and images are not compared. This score is separate from behavioural parity.

| View | Score | Layout | Components | Style |
|---|---|---|---|---|
| history | **96** | 94 | 95 | 100 |
| home | **95** | 89 | 96 | 100 |
| page | **97** | 97 | 94 | 100 |
| tags | **83** | 82 | 67 | 100 |

## Largest differences

### history

- button: text colour #757575, spec #ffffff
- link: corner radius 50px, spec 0px
- button: corner radius 50px, spec 4px

### home

- avatar: border all #607d8b, spec none
- avatar: 1 on the view, spec 3
- link: text transform none, spec uppercase

### page

- button: background #e0e0e0, spec none
- list-item: typical size 134×28, spec 24×21

### tags

- column: none, spec has 1
- divider: border r #ffffff1f, spec t #0000001f
- button: text colour #ffffff, spec #000000de
- link: corner radius 4px, spec 50px
- button: corner radius 4px, spec 28px
- link: text transform none, spec uppercase
- link: typical size 72×34, spec 48×48
- divider: typical size 284×50, spec 284×1
