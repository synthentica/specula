# Visual check: before

**Looks 46/100 like the UI spec** over 4 views, against http://localhost:4712, 2026-10-12T17:44:59.859Z.

Each view is opened with the data the recorded flows leave behind and compared with `spec/ui/views.json`: layout 40 % (regions and where components sit on the first screen), components 30 % (count, size, style) and style 30 % (page colours, accent, font, radius). Boxes and computed styles only; text and images are not compared. This score is separate from behavioural parity.

| View | Score | Layout | Components | Style |
|---|---|---|---|---|
| editor | **46** | 36 | 52 | 51 |
| members | **45** | 42 | 37 | 58 |
| posts | **52** | 57 | 41 | 57 |
| tags | **39** | 33 | 23 | 63 |

## Largest differences

### editor

- font Iowan Old Style, spec Inter
- main text colour #6f675d, spec #15171a
- button: background none, spec #ffffff
- input: background #fffdf9, spec none
- most used radius 999px, spec 6px
- sidebar: present, the spec view has none
- button: border all #2f6f5e, spec none
- input: border all #e2dbcf, spec none

### members

- column: none, spec has 2
- font Iowan Old Style, spec Inter
- main text colour #6f675d, spec #15171a
- button: background #2f6f5e, spec none
- row: background none, spec #ffffff
- heading: 1 on the view, spec 5
- list-item: none, spec has 9
- avatar: none, spec has 2

### posts

- font Iowan Old Style, spec Inter
- main text colour #6f675d, spec #15171a
- button: background #2f6f5e, spec #ffffff
- avatar: none, spec has 2
- most used radius 999px, spec 6px
- heading: typical size 160×33, spec 524×21
- heading: 1 on the view, spec 3
- button: text colour #ffffff, spec #394047

### tags

- topbar: missing (spec 320×0×960×100 at x,y,w,h)
- tabs: none, spec has 1
- font Iowan Old Style, spec Inter
- main text colour #6f675d, spec #15171a
- badge: none, spec has 1
- button: background #2f6f5e, spec none
- list-item: none, spec has 9
- avatar: none, spec has 2
