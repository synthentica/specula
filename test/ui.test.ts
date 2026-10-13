import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUiSpec, colorSimilarity, deltaE, scoreView } from '../src/lib/ui.ts';
import type { UiSnapshot } from '../src/lib/ui-probe.ts';

function snapshot(overrides: { sidebarBg?: string; cardBg?: string; cardShadow?: string; font?: string; cards?: number; sidebar?: boolean } = {}): UiSnapshot {
  const cards = overrides.cards ?? 4;
  const cardBg = overrides.cardBg ?? '#ffffff';
  const card = (i: number) => ({ kind: 'card' as const, rect: [320 + i * 310, 160, 300, 80] as [number, number, number, number], style: { background: cardBg, radius: 4, ...(overrides.cardShadow === 'none' ? {} : { shadow: overrides.cardShadow ?? '#0000001f 0px 1px 3px 0px' }), fontFamily: overrides.font ?? 'Open Sans', fontSize: 14, fontWeight: 400 } });
  return {
    url: '/projects/{projectId}',
    viewport: { width: 1280, height: 800 },
    documentHeight: 800,
    page: { background: '#f3f4f6', color: '#374151', fontFamily: overrides.font ?? 'Open Sans', fontSize: 16, lineHeight: 24 },
    regions: [
      { role: 'topbar', rect: [0, 0, 1280, 64], style: { background: '#f3f4f6' } },
      ...(overrides.sidebar === false ? [] : [{ role: 'sidebar' as const, rect: [0, 64, 300, 736] as [number, number, number, number], style: { background: overrides.sidebarBg ?? '#f3f4f6' } }]),
      { role: 'main', rect: [300, 64, 980, 736], style: { background: '#f3f4f6' } },
    ],
    components: [
      ...Array.from({ length: cards }, (_, i) => card(i)),
      { kind: 'button', variant: 'filled', rect: [320, 90, 80, 32], style: { background: '#126cfd', color: '#ffffff', radius: 4, fontSize: 14, fontWeight: 700 } },
      { kind: 'heading', variant: 'h1', rect: [320, 20, 400, 32], style: { color: '#363636', fontSize: 28, fontWeight: 400, fontFamily: 'Quicksand' } },
    ],
    usage: {
      text: [['#374151', 200], ['#6b7280', 60], ['#126cfd', 20]],
      background: [['#f3f4f6', 9000], [cardBg, 960], ['#126cfd', 25]],
      border: [['#e5e7eb', 4]],
      fontFamily: [[overrides.font ?? 'Open Sans', 260], ['Quicksand', 20]],
      fontSize: [['16', 200], ['14', 60], ['28', 20]],
      fontWeight: [['400', 240], ['700', 40]],
      radius: [['4', 6]],
      shadow: [['#0000001f 0px 1px 3px 0px', 4]],
      spacing: [['8', 20], ['16', 10]],
    },
  };
}

test('colour distance', () => {
  assert.equal(deltaE('#ffffff', '#ffffff'), 0);
  assert.ok(deltaE('#ffffff', '#000000') > 99);
  assert.equal(colorSimilarity('#126cfd', '#126cfd'), 1);
  assert.equal(colorSimilarity('#126cfd', undefined), 0);
});

test('tokens: page, surface, text, muted text, accent and font come from the snapshots', () => {
  const spec = buildUiSpec([{ name: 'board', route: '/projects/{projectId}', seedFlow: 'kanban', snapshot: snapshot() }]);
  const t = spec.tokens;
  assert.equal(t.color.page, '#f3f4f6');
  assert.equal(t.color.surface, '#ffffff');
  assert.equal(t.color.text, '#374151');
  assert.equal(t.color.textMuted, '#6b7280');
  assert.equal(t.color.accent, '#126cfd');
  assert.equal(t.font.family, 'Open Sans');
  assert.equal(t.font.headingFamily, 'Quicksand');
  assert.equal(t.radius.base, 4);
  assert.equal(t.shadow.card, '#0000001f 0px 1px 3px 0px');
  const view = spec.views[0]!;
  assert.equal(view.components.card?.count, 4);
  assert.deepEqual(view.components.card?.size, [300, 80]);
  assert.equal(view.seedFlow, 'kanban');
});

test('a view scores 100 against itself and less the further it drifts', () => {
  const spec = buildUiSpec([{ name: 'board', route: '/', snapshot: snapshot() }]);
  const view = spec.views[0]!;
  assert.equal(scoreView(view, spec.tokens, snapshot()).score, 100);
  const restyled = scoreView(view, spec.tokens, snapshot({ cardBg: '#e3f1ee', cardShadow: 'none', sidebarBg: '#ffffff' }));
  const unlike = scoreView(view, spec.tokens, snapshot({ cardBg: '#e3f1ee', cardShadow: 'none', sidebarBg: '#ffffff', font: 'Georgia', cards: 0, sidebar: false }));
  assert.ok(restyled.score < 100 && restyled.score > unlike.score, `${restyled.score} vs ${unlike.score}`);
  assert.ok(restyled.notes.some((n) => n.startsWith('card: no shadow')), restyled.notes.join('; '));
  assert.ok(unlike.notes.some((n) => n.startsWith('sidebar: missing')), unlike.notes.join('; '));
});
