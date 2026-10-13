# Visual check: before

**Looks 54/100 like the UI spec** over 5 views, against http://localhost:4711, 2026-10-12T17:44:49.379Z.

Each view is opened with the data the recorded flows leave behind and compared with `spec/ui/views.json`: layout 40 % (regions and where components sit on the first screen), components 30 % (count, size, style) and style 30 % (page colours, accent, font, radius). Boxes and computed styles only; text and images are not compared. This score is separate from behavioural parity.

| View | Score | Layout | Components | Style |
|---|---|---|---|---|
| board | **54** | 58 | 45 | 58 |
| overview | **54** | 51 | 52 | 60 |
| projects | **55** | 52 | 53 | 60 |
| task | **52** | 54 | 40 | 60 |
| upcoming | **54** | 53 | 48 | 60 |

## Largest differences

### board

- tabs: none, spec has 1
- accent colour #126cfd not used
- column: 1 on the view, spec 4
- button: background #e3f1ee, spec none
- column: background #e3f1ee, spec none
- badge: background #1f7a6d, spec #00db60
- button: 2 on the view, spec 17
- card: typical size 256×128, spec 300×50

### overview

- accent colour #126cfd not used
- button: background #e3f1ee, spec none
- button: 2 on the view, spec 10
- list-item: none, spec has 8
- font system-ui, spec Open Sans
- input: border all #e2e0d8, spec all #126cfd
- avatar: corner radius 50px, spec 100px
- button: typical size 215×41, spec 40×40

### projects

- accent colour #126cfd not used
- card: typical size 269×58, spec 174×150
- button: background #e3f1ee, spec none
- button: 3 on the view, spec 12
- list-item: none, spec has 11
- font system-ui, spec Open Sans
- card: border all #e2e0d8, spec none
- avatar: corner radius 50px, spec 100px

### task

- card: none, spec has 3
- accent colour #126cfd not used
- button: background #1f7a6d, spec none
- badge: background #1f7a6d, spec #00db60
- input: background #ffffff, spec none
- button: 6 on the view, spec 60
- tabs: 1 on the view, spec 8
- list-item: none, spec has 8

### upcoming

- accent colour #126cfd not used
- button: background #e3f1ee, spec none
- button: 2 on the view, spec 9
- list-item: none, spec has 8
- font system-ui, spec Open Sans
- avatar: corner radius 50px, spec 100px
- button: typical size 215×41, spec 40×40
- heading: font size 12px, spec 32px
