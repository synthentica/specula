// Tackboard web UI: a framework-free single-page app on top of /api/v2 (bearer token) and the /ws
// socket. Routes live in the URL hash: #/ (board list) and #/board/<id>.

const TOKEN_KEY = 'tackboard.token';
const TEAM = '0';

// ---- types -------------------------------------------------------------------------------

interface User { id: string; username: string }
interface CardOption { id: string; value: string; color: string }
interface CardProperty { id: string; name: string; type: string; options: CardOption[] }
interface Board { id: string; teamId: string; title: string; icon: string; isTemplate: boolean; cardProperties: CardProperty[]; createAt: number; updateAt: number }
interface Block { id: string; parentId: string; boardId: string; type: string; title: string; fields: Record<string, unknown> | null; createAt: number; updateAt: number; deleteAt: number; createdBy: string }

// ---- state -------------------------------------------------------------------------------

let token: string | null = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  // Storage may be unavailable (private mode); the session then lasts until the page reloads.
}
let me: User | null = null;
let boards: Board[] = [];
let board: Board | null = null;
let blocks: Block[] = [];
let openCardId: string | null = null;
let dragCardId: string | null = null;

function saveToken(value: string | null): void {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // see above
  }
}

// ---- API ---------------------------------------------------------------------------------

class ApiProblem extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/v2${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiProblem(data.error ?? `The server answered with status ${res.status}.`, res.status);
  return data;
}

/** A client id for new records; the server replaces it with its own. */
function tempId(kind: string): string {
  const alphabet = 'abcdefghijkmnopqrstuwxyz13456789';
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return kind + Array.from(bytes, (b) => alphabet[b & 31]).join('');
}

// ---- DOM helpers -------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
type Attr = string | boolean | EventListener | undefined;
function h(tag: string, attrs: Record<string, Attr> = {}, ...children: (Child | Child[])[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const root = document.getElementById('root')!;
const dialog = document.getElementById('card-dialog') as HTMLDialogElement;

function flash(text: string): void {
  const el = h('p', { class: 'toast', role: 'alert' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

/** Runs an action and shows its failure instead of throwing. */
function attempt(fn: () => Promise<unknown>): void {
  fn().catch((error: unknown) => {
    if (error instanceof ApiProblem && error.status === 401) {
      saveToken(null);
      me = null;
      renderAuth('Your session has ended. Sign in again.');
      return;
    }
    flash(error instanceof Error ? error.message : String(error));
  });
}

/**
 * An always-visible inline text field (it reads as plain text until focused): saves on Enter or when it
 * loses focus, Escape puts the old value back.
 */
function inlineInput(value: string, placeholder: string, save: (next: string) => Promise<unknown>, cls = ''): HTMLInputElement {
  const input = h('input', { class: `inline ${cls}`, value, placeholder, 'aria-label': placeholder, spellcheck: 'false' }) as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = value;
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    const next = input.value.trim();
    if (next !== value) {
      value = next;
      attempt(() => save(next));
    }
  });
  return input;
}

/** Small line icons drawn for Tackboard (stroke follows the text colour). */
function icon(name: 'signout' | 'view' | 'chevron', size: number): SVGSVGElement {
  const paths: Record<string, string> = {
    signout: 'M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10M14 8l4 4-4 4M18 12H9',
    view: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z',
    chevron: 'M8 10l4 4 4-4',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]!);
  svg.append(path);
  return svg;
}


// ---- realtime ----------------------------------------------------------------------------

let socket: WebSocket | null = null;
let socketRetry = 1000;

function connectSocket(): void {
  if (!token || socket) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket = ws;
  ws.addEventListener('open', () => {
    socketRetry = 1000;
    ws.send(JSON.stringify({ action: 'AUTH', token }));
    ws.send(JSON.stringify({ action: 'SUBSCRIBE_TEAM', teamId: TEAM }));
  });
  ws.addEventListener('message', (ev) => {
    try {
      onPush(JSON.parse(String(ev.data)) as Record<string, unknown>);
    } catch {
      // ignore anything that is not JSON
    }
  });
  ws.addEventListener('close', () => {
    if (socket === ws) socket = null;
    if (token && me) setTimeout(connectSocket, (socketRetry = Math.min(socketRetry * 2, 30000)));
  });
}

function disconnectSocket(): void {
  const ws = socket;
  socket = null;
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'UNSUBSCRIBE_TEAM', teamId: TEAM }));
  ws.close();
}

function onPush(msg: Record<string, unknown>): void {
  if (msg.action === 'UPDATE_BOARD') {
    const b = msg.board as Board;
    if (b.isTemplate) return;
    const i = boards.findIndex((x) => x.id === b.id);
    if (i >= 0) boards[i] = b;
    else boards.push(b);
    if (board?.id === b.id) board = b;
    render();
  } else if (msg.action === 'UPDATE_BLOCK') {
    const b = msg.block as Block;
    if (board?.id !== b.boardId) return;
    blocks = blocks.filter((x) => x.id !== b.id);
    if (!b.deleteAt) blocks.push(b);
    if (b.deleteAt && openCardId === b.id) closeCard();
    render();
  } else if (msg.action === 'UPDATE_BOARD_CATEGORY' || msg.action === 'UPDATE_MEMBER') {
    attempt(loadBoards);
  }
}

// ---- data --------------------------------------------------------------------------------

async function loadBoards(): Promise<void> {
  boards = await api<Board[]>('GET', `/teams/${TEAM}/boards`);
  render();
}

async function openBoard(id: string): Promise<void> {
  const list = await api<Block[]>('GET', `/boards/${encodeURIComponent(id)}/blocks?all=true`);
  board = boards.find((b) => b.id === id) ?? null;
  blocks = list;
  render();
}

const statusProperty = (b: Board) => b.cardProperties.find((p) => p.type === 'select');
const viewOf = () => blocks.find((b) => b.type === 'view' && b.parentId !== '') ?? blocks.find((b) => b.type === 'view');
const cardsOf = () => blocks.filter((b) => b.type === 'card');
const fieldsOf = (b: Block) => b.fields ?? {};
const listOf = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function orderedCards(): Block[] {
  const order = listOf(fieldsOf(viewOf() ?? ({ fields: {} } as Block)).cardOrder);
  const rank = (c: Block) => {
    const i = order.indexOf(c.id);
    return i < 0 ? order.length + c.createAt / 1e15 : i;
  };
  return cardsOf().sort((a, b) => rank(a) - rank(b));
}

function statusOf(card: Block, prop: CardProperty | undefined): string {
  const props = fieldsOf(card).properties as Record<string, unknown> | undefined;
  const value = prop && props ? props[prop.id] : undefined;
  return typeof value === 'string' && prop?.options.some((o) => o.id === value) ? value : '';
}

// ---- actions -----------------------------------------------------------------------------

async function createBoard(title: string): Promise<void> {
  const boardId = tempId('b');
  const now = Date.now();
  const out = await api<{ boards: Board[] }>('POST', '/boards-and-blocks', {
    boards: [{ id: boardId, teamId: TEAM, channelId: '', type: 'P', minimumRole: '', title, description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, properties: {}, cardProperties: [{ id: tempId('a'), name: 'Status', type: 'select', options: [] }], createAt: now, updateAt: now, deleteAt: 0 }],
    blocks: [
      {
        id: tempId('v'),
        schema: 1,
        boardId,
        parentId: boardId,
        type: 'view',
        title: 'Columns',
        fields: { viewType: 'board', sortOptions: [], visiblePropertyIds: [], visibleOptionIds: [], hiddenOptionIds: [], collapsedOptionIds: [], filter: { operation: 'and', filters: [] }, cardOrder: [], columnWidths: {}, columnCalculations: {}, kanbanCalculations: {}, defaultTemplateId: '' },
        createAt: now,
        updateAt: now,
        deleteAt: 0,
      },
    ],
  });
  const created = out.boards[0];
  if (!created) return;
  if (!boards.some((b) => b.id === created.id)) boards.push(created);
  location.hash = `#/board/${created.id}`;
}

async function saveStatusOptions(options: CardOption[]): Promise<void> {
  if (!board) return;
  const prop = statusProperty(board);
  if (!prop) return;
  board = await api<Board>('PATCH', `/boards/${board.id}`, { updatedCardProperties: [{ ...prop, options }], deletedCardProperties: [] });
  render();
}

async function addCard(optionId: string): Promise<void> {
  if (!board) return;
  const prop = statusProperty(board);
  const now = Date.now();
  const [card] = await api<Block[]>('POST', `/boards/${board.id}/blocks`, [
    { id: tempId('c'), schema: 1, boardId: board.id, parentId: board.id, type: 'card', title: '', fields: { icon: '', properties: prop && optionId ? { [prop.id]: optionId } : {}, contentOrder: [], isTemplate: false }, createAt: now, updateAt: now, deleteAt: 0 },
  ]);
  if (!card) return;
  upsert(card);
  const view = viewOf();
  if (view) await api('PATCH', `/boards/${board.id}/blocks/${view.id}`, { updatedFields: { cardOrder: [...listOf(fieldsOf(view).cardOrder), card.id] } });
  openCard(card.id);
}

async function moveCard(cardId: string, optionId: string): Promise<void> {
  if (!board) return;
  const prop = statusProperty(board);
  const card = blocks.find((b) => b.id === cardId);
  if (!prop || !card) return;
  const properties = { ...((fieldsOf(card).properties as Record<string, string> | undefined) ?? {}) };
  if (optionId) properties[prop.id] = optionId;
  else delete properties[prop.id];
  await api('PATCH', `/boards/${board.id}/blocks/${cardId}`, { updatedFields: { properties }, deletedFields: [] });
}

async function deleteCard(cardId: string): Promise<void> {
  if (!board || !confirm('Delete this card and everything on it?')) return;
  await api('DELETE', `/boards/${board.id}/blocks/${cardId}`);
  const view = viewOf();
  if (view) await api('PATCH', `/boards/${board.id}/blocks/${view.id}`, { updatedFields: { cardOrder: listOf(fieldsOf(view).cardOrder).filter((id) => id !== cardId) } });
  closeCard();
}

function upsert(block: Block): void {
  blocks = blocks.filter((b) => b.id !== block.id);
  blocks.push(block);
}

async function signOut(): Promise<void> {
  disconnectSocket();
  await api('POST', '/logout').catch(() => undefined);
  saveToken(null);
  me = null;
  boards = [];
  board = null;
  blocks = [];
  renderAuth();
}

// ---- screens -----------------------------------------------------------------------------

function renderAuth(message = ''): void {
  let mode: 'signin' | 'signup' = 'signin';
  const draw = () => {
    const err = h('p', { class: 'notice', role: 'alert', hidden: !message }, message);
    const username = h('input', { name: 'username', autocomplete: 'username', required: true }) as HTMLInputElement;
    const email = h('input', { name: 'email', type: 'email', autocomplete: 'email', required: mode === 'signup' }) as HTMLInputElement;
    const password = h('input', { name: 'password', type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true, minlength: mode === 'signup' ? '8' : undefined }) as HTMLInputElement;
    const form = h(
      'form',
      { class: 'auth-card' },
      h('img', { src: '/assets/icon.svg', alt: '', class: 'mark' }),
      h('h1', {}, mode === 'signin' ? 'Sign in to Tackboard' : 'Create your Tackboard account'),
      err,
      h('label', { class: 'field' }, h('span', {}, 'Username'), username),
      mode === 'signup' ? h('label', { class: 'field' }, h('span', {}, 'Email'), email) : null,
      h('label', { class: 'field' }, h('span', {}, 'Password'), password),
      h('button', { class: 'primary', type: 'submit' }, mode === 'signin' ? 'Sign in' : 'Create account'),
      h(
        'button',
        {
          class: 'link',
          type: 'button',
          onclick: () => {
            mode = mode === 'signin' ? 'signup' : 'signin';
            message = '';
            draw();
          },
        },
        mode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in',
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      (async () => {
        if (mode === 'signup') await api('POST', '/register', { email: email.value, username: username.value, password: password.value, token: '' });
        const out = await api<{ token: string }>('POST', '/login', { username: username.value, password: password.value, type: 'normal' });
        saveToken(out.token);
        await start();
      })().catch((error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
        err.textContent = message;
        err.hidden = false;
      });
    });
    root.replaceChildren(h('main', { class: 'auth' }, form));
    username.focus();
  };
  draw();
}

let renderPending = false;

// View preferences of this browser tab (not saved on the server).
let query = '';
let hideEmpty = false;
let sortByTitle = false;
let categoryOpen = true;
let addingBoard = false;
let newMenuOpen = false;
let mainEl: HTMLElement | null = null;

function render(): void {
  if (!me) return;
  // Do not replace an input the user is typing in; draw once it loses focus.
  const active = document.activeElement;
  if (active && root.contains(active) && active.matches('input, textarea, select')) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const help = location.hash === '#/help';
  mainEl = h('main', { class: 'content' }, board ? lanes(board) : welcome(help));
  root.replaceChildren(h('div', { class: 'layout' }, sidebar(), h('div', { class: 'workspace' }, topbar(), mainEl)));
  if (addingBoard) root.querySelector<HTMLInputElement>('.new-board input')?.focus();
  if (openCardId) renderCard();
}

/** Redraws only the board columns (while the search field keeps its focus). */
function renderLanes(): void {
  if (mainEl && board) mainEl.replaceChildren(lanes(board));
}

function sidebar(): HTMLElement {
  const view = board ? viewOf() : undefined;
  const list = h(
    'ul',
    { class: 'board-list', id: 'board-list', hidden: !categoryOpen },
    boards.length
      ? boards.map((b) =>
          h(
            'li',
            {},
            h('button', { type: 'button', class: `board-item${board?.id === b.id ? ' active' : ''}`, 'aria-current': board?.id === b.id ? 'true' : undefined, onclick: () => (location.hash = `#/board/${b.id}`) }, h('span', { class: 'board-icon', 'aria-hidden': 'true' }, b.icon || '▤'), h('span', { class: 'label' }, b.title || 'Untitled board')),
            board?.id === b.id && view ? h('ul', { class: 'view-list' }, h('li', { class: 'view-item', 'aria-current': 'page' }, icon('view', 18), h('span', { class: 'label' }, view.title || 'Board view'))) : null,
          ),
        )
      : h('li', { class: 'empty' }, 'No boards yet.'),
  );
  return h(
    'nav',
    { class: 'sidebar', 'aria-label': 'Boards' },
    h(
      'div',
      { class: 'sidebar-head' },
      h('button', { type: 'button', class: 'brand', title: 'All boards', onclick: () => (location.hash = '#/') }, h('span', { class: 'mark', 'aria-hidden': 'true' }), h('span', {}, 'Tackboard')),
      h('button', { type: 'button', class: 'side-icon', title: `Sign out ${me?.username ?? ''}`, 'aria-label': 'Sign out', onclick: () => attempt(signOut) }, icon('signout', 24)),
    ),
    h('p', { class: 'whoami' }, `Signed in as ${me?.username ?? ''}`),
    h(
      'div',
      { class: 'category' },
      h('button', { type: 'button', class: `category-toggle${categoryOpen ? ' open' : ''}`, 'aria-expanded': String(categoryOpen), 'aria-controls': 'board-list', onclick: () => ((categoryOpen = !categoryOpen), render()) }, icon('chevron', 16), h('span', {}, 'My boards')),
      list,
    ),
    addingBoard ? newBoardForm() : null,
    h('div', { class: 'sidebar-foot' }, h('button', { type: 'button', class: 'add-board', onclick: () => ((addingBoard = true), render()) }, '+ Add board')),
  );
}

function newBoardForm(): HTMLElement {
  const input = h('input', { name: 'title', placeholder: 'Board name', 'aria-label': 'New board name', required: true }) as HTMLInputElement;
  const form = h('form', { class: 'new-board' }, input, h('button', { type: 'submit', class: 'primary' }, 'Create'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      addingBoard = false;
      input.blur();
    }
  });
  input.addEventListener('blur', () =>
    setTimeout(() => {
      if (!form.contains(document.activeElement) && !input.value.trim()) {
        addingBoard = false;
        render();
      }
    }, 0),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = input.value.trim();
    addingBoard = false;
    input.blur();
    if (title) attempt(() => createBoard(title));
  });
  return form;
}

function topLinks(): HTMLElement {
  return h('div', { class: 'top-links' }, h('a', { class: 'top-link', href: '#/' }, 'All boards'), h('a', { class: 'top-link', href: '#/help', title: 'How Tackboard works', 'aria-label': 'Help' }, '?'));
}

function topbar(): HTMLElement {
  if (!board) return h('header', { class: 'topbar' }, topLinks(), h('div', { class: 'title-row' }, h('h1', { class: 'page-title' }, location.hash === '#/help' ? 'How Tackboard works' : 'All boards')));
  const b = board;
  const prop = statusProperty(b);
  const view = viewOf();
  const viewTitle = view
    ? inlineInput(view.title, 'Board view', async (title) => {
        await api('PATCH', `/boards/${b.id}/blocks/${view.id}`, { title });
        view.title = title;
        render();
      }, 'view-title')
    : null;
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search cards', 'aria-label': 'Search cards', value: query }) as HTMLInputElement;
  search.addEventListener('input', () => {
    query = search.value;
    renderLanes();
  });
  const groups = [{ id: '', label: `No ${prop?.name ?? 'status'}` }, ...(prop?.options ?? []).map((o) => ({ id: o.id, label: o.value || 'Untitled group' }))];
  return h(
    'header',
    { class: 'topbar' },
    topLinks(),
    h(
      'div',
      { class: 'title-row' },
      inlineInput(b.title, 'Untitled board', async (title) => {
        board = await api<Board>('PATCH', `/boards/${b.id}`, { title });
        render();
      }, 'board-title'),
      h('button', { type: 'button', class: 'primary share', onclick: () => attempt(copyLink) }, 'Copy link'),
    ),
    h(
      'div',
      { class: 'view-row' },
      viewTitle,
      viewTitle ? h('button', { type: 'button', class: 'tool icon-only', title: 'Rename view', 'aria-label': 'Rename view', onclick: () => viewTitle.focus() }, '✎') : null,
      h(
        'div',
        { class: 'tools' },
        h('button', { type: 'button', class: 'tool', onclick: () => attempt(() => saveStatusOptions([...(prop?.options ?? []), { id: tempId('a'), value: `Column ${(prop?.options.length ?? 0) + 1}`, color: 'propColorDefault' }])) }, '+ Add group'),
        h('button', { type: 'button', class: 'tool', 'aria-pressed': String(hideEmpty), onclick: () => ((hideEmpty = !hideEmpty), render()) }, hideEmpty ? 'Show empty groups' : 'Hide empty groups'),
        h('button', { type: 'button', class: 'tool', 'aria-pressed': String(sortByTitle), title: 'Sort cards by title', onclick: () => ((sortByTitle = !sortByTitle), render()) }, sortByTitle ? 'A–Z' : 'Sort'),
        search,
        h(
          'div',
          { class: 'new-split' },
          h('button', { type: 'button', class: 'new-card', title: 'New card without a group', onclick: () => attempt(() => addCard('')) }, h('span', { class: 'pill' }, 'New')),
          h('button', { type: 'button', class: 'new-menu', 'aria-label': 'New card in a group', 'aria-haspopup': 'menu', 'aria-expanded': String(newMenuOpen), onclick: () => ((newMenuOpen = !newMenuOpen), render()) }, '▾'),
          newMenuOpen
            ? h(
                'div',
                { class: 'menu', role: 'menu' },
                groups.map((g) => h('button', { type: 'button', role: 'menuitem', onclick: () => ((newMenuOpen = false), attempt(() => addCard(g.id))) }, g.label)),
              )
            : null,
        ),
      ),
    ),
  );
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    flash('Link to this board copied.');
  } catch {
    flash(`Copy this link: ${location.href}`);
  }
}

function welcome(help: boolean): HTMLElement {
  return h(
    'section',
    { class: 'welcome' },
    h('h2', {}, help ? 'Pin your work to a board' : boards.length ? 'Pick a board on the left' : 'Pin your work to a board'),
    h('p', {}, 'Add a board from the sidebar, add status groups as columns, then add cards and drag them along as work moves. Click a card to write a description or leave a comment.'),
  );
}

function lanes(b: Board): HTMLElement {
  const prop = statusProperty(b);
  const needle = query.trim().toLowerCase();
  let cards = orderedCards();
  if (sortByTitle) cards = [...cards].sort((x, y) => (x.title || 'Untitled').localeCompare(y.title || 'Untitled'));
  if (needle) cards = cards.filter((c) => (c.title || 'Untitled').toLowerCase().includes(needle));
  const columns: { id: string; label: string; option?: CardOption }[] = [{ id: '', label: `No ${prop?.name ?? 'status'}` }, ...(prop?.options ?? []).map((o) => ({ id: o.id, label: o.value, option: o }))];
  const shown = hideEmpty ? columns.filter((col) => cards.some((c) => statusOf(c, prop) === col.id)) : columns;
  return h(
    'div',
    { class: 'columns' },
    shown.length ? null : h('p', { class: 'empty-note' }, needle ? 'No cards match your search.' : 'Every group is empty.'),
    shown.map((col) => {
      const mine = cards.filter((c) => statusOf(c, prop) === col.id);
      const lane = h(
        'section',
        { class: `column ${col.option ? col.option.color : 'no-status'}`, 'aria-label': col.label || 'Untitled group' },
        h(
          'header',
          { class: 'column-head' },
          col.option
            ? inlineInput(col.option.value, 'Untitled group', (value) => saveStatusOptions((prop?.options ?? []).map((o) => (o.id === col.id ? { ...o, value } : o))), 'group-title')
            : h('span', { class: 'group-title static' }, col.label),
          h('span', { class: 'count', title: 'Cards in this group' }, String(mine.length)),
          col.option ? h('button', { type: 'button', class: 'col-btn', title: 'Remove this group', 'aria-label': `Remove group ${col.label}`, onclick: () => attempt(() => saveStatusOptions((prop?.options ?? []).filter((o) => o.id !== col.id))) }, '×') : h('span', {}),
          h('button', { type: 'button', class: 'col-btn', title: 'Add a card here', 'aria-label': `Add a card to ${col.label || 'this group'}`, onclick: () => attempt(() => addCard(col.id)) }, '+'),
        ),
        mine.length
          ? h(
              'ul',
              { class: 'cards' },
              mine.map((c) => {
                const comments = blocks.filter((x) => x.parentId === c.id && x.type === 'comment').length;
                const li = h(
                  'li',
                  { class: 'card', draggable: 'true', tabindex: '0', onclick: () => openCard(c.id), onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && openCard(c.id)) as EventListener },
                  h('span', { class: 'card-title' }, `${typeof fieldsOf(c).icon === 'string' && fieldsOf(c).icon ? `${String(fieldsOf(c).icon)} ` : ''}${c.title || 'Untitled'}`),
                  comments ? h('span', { class: 'comment-count', title: 'Comments' }, `💬 ${comments}`) : null,
                );
                li.addEventListener('dragstart', (e) => {
                  dragCardId = c.id;
                  e.dataTransfer?.setData('text/plain', c.id);
                });
                return li;
              }),
            )
          : null,
        h('button', { type: 'button', class: 'add-card', onclick: () => attempt(() => addCard(col.id)) }, '+ New'),
      );
      lane.addEventListener('dragover', (e) => {
        e.preventDefault();
        lane.classList.add('drop');
      });
      lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
      lane.addEventListener('drop', (e) => {
        e.preventDefault();
        lane.classList.remove('drop');
        const id = dragCardId ?? e.dataTransfer?.getData('text/plain');
        dragCardId = null;
        if (id) attempt(() => moveCard(id, col.id));
      });
      return lane;
    }),
  );
}


// ---- card dialog -------------------------------------------------------------------------

function openCard(id: string): void {
  openCardId = id;
  renderCard();
  if (!dialog.open) dialog.showModal();
}

function closeCard(): void {
  openCardId = null;
  if (dialog.open) dialog.close();
}

dialog.addEventListener('close', () => {
  openCardId = null;
});

function renderCard(): void {
  const card = blocks.find((b) => b.id === openCardId);
  if (!card || !board) return closeCard();
  // Keep what the user is typing: a push re-renders only when the dialog has no focused input.
  if (dialog.open && dialog.contains(document.activeElement) && document.activeElement?.matches('input, textarea')) return;
  const b = board;
  const prop = statusProperty(b);
  const order = listOf(fieldsOf(card).contentOrder);
  const description = blocks.find((x) => x.parentId === card.id && x.type === 'text' && order.includes(x.id)) ?? blocks.find((x) => x.parentId === card.id && x.type === 'text');
  const comments = blocks.filter((x) => x.parentId === card.id && x.type === 'comment').sort((x, y) => x.createAt - y.createAt);

  const title = h('input', { class: 'card-name', value: card.title, placeholder: 'Untitled', 'aria-label': 'Card title' }) as HTMLInputElement;
  title.addEventListener('change', () => attempt(() => api('PATCH', `/boards/${b.id}/blocks/${card.id}`, { title: title.value.trim() })));
  title.addEventListener('keydown', (e) => e.key === 'Enter' && title.blur());

  const status = h('select', { 'aria-label': prop?.name ?? 'Status' }, h('option', { value: '' }, `No ${prop?.name ?? 'status'}`), (prop?.options ?? []).map((o) => h('option', { value: o.id, selected: statusOf(card, prop) === o.id }, o.value))) as HTMLSelectElement;
  status.addEventListener('change', () => attempt(() => moveCard(card.id, status.value)));

  const desc = h('textarea', { rows: '5', placeholder: 'Add a description…', 'aria-label': 'Description' }) as HTMLTextAreaElement;
  desc.value = description?.title ?? '';
  desc.addEventListener('change', () =>
    attempt(async () => {
      const text = desc.value;
      if (description) return api('PATCH', `/boards/${b.id}/blocks/${description.id}`, { title: text });
      const now = Date.now();
      const [block] = await api<Block[]>('POST', `/boards/${b.id}/blocks`, [{ id: tempId('a'), schema: 1, boardId: b.id, parentId: card.id, type: 'text', title: text, fields: {}, createAt: now, updateAt: now, deleteAt: 0 }]);
      if (block) {
        upsert(block);
        await api('PATCH', `/boards/${b.id}/blocks/${card.id}`, { updatedFields: { contentOrder: [...order, block.id] } });
      }
    }),
  );

  const comment = h('textarea', { rows: '2', placeholder: 'Write a comment…', 'aria-label': 'New comment', required: true }) as HTMLTextAreaElement;
  const commentForm = h('form', { class: 'comment-form' }, comment, h('button', { type: 'submit', class: 'primary' }, 'Comment'));
  commentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = comment.value.trim();
    if (!text) return;
    attempt(async () => {
      const now = Date.now();
      const [block] = await api<Block[]>('POST', `/boards/${b.id}/blocks`, [{ id: tempId('a'), schema: 1, boardId: b.id, parentId: card.id, type: 'comment', title: text, fields: {}, createAt: now, updateAt: now, deleteAt: 0 }]);
      comment.value = '';
      if (block) upsert(block);
      comment.blur();
      renderCard();
    });
  });

  dialog.replaceChildren(
    h(
      'div',
      { class: 'card-detail' },
      h('header', {}, title, h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: closeCard }, '×')),
      h('label', { class: 'field inline' }, h('span', {}, prop?.name ?? 'Status'), status),
      h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
      h('h3', {}, 'Comments'),
      h('ul', { class: 'comments' }, comments.length ? comments.map((c) => h('li', {}, h('p', {}, c.title), h('small', {}, `${c.createdBy === me?.id ? me.username : 'Someone'} · ${new Date(c.createAt).toLocaleString()}`))) : h('li', { class: 'muted' }, 'No comments yet.')),
      commentForm,
      h('footer', {}, h('button', { type: 'button', class: 'danger', onclick: () => attempt(() => deleteCard(card.id)) }, 'Delete card')),
    ),
  );
}

// ---- routing and start -------------------------------------------------------------------

function route(): void {
  if (!me) return;
  const m = /^#\/board\/([\w-]+)$/.exec(location.hash);
  closeCard();
  newMenuOpen = false;
  if (!m || m[1] !== board?.id) query = '';
  if (m) attempt(() => openBoard(m[1]!));
  else {
    board = null;
    blocks = [];
    render();
  }
}

async function start(): Promise<void> {
  if (!token) return renderAuth();
  try {
    me = await api<User>('GET', '/users/me');
  } catch {
    saveToken(null);
    return renderAuth();
  }
  await api('GET', `/teams/${TEAM}/categories`);
  await loadBoards();
  connectSocket();
  route();
}

root.addEventListener('focusout', () => setTimeout(() => renderPending && render(), 0));
document.addEventListener('click', (e) => {
  if (newMenuOpen && !(e.target instanceof Element && e.target.closest('.new-split'))) {
    newMenuOpen = false;
    render();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && newMenuOpen) {
    newMenuOpen = false;
    render();
  }
});
window.addEventListener('hashchange', route);
attempt(start);
