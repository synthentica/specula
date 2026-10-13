// Pagegrove web UI: a framework-free single-page app on top of POST /graphql (bearer token) and
// POST /finalize. Routes live in the URL hash: #/, #/tags, #/view/<path>, #/new, #/edit/<id>,
// #/history/<id>, #/version/<pageId>/<versionId>, #/search/<text>, #/people, #/signin, #/setup.

const TOKEN_KEY = 'pagegrove.token';

// ---- types -------------------------------------------------------------------------------

interface Claims { id: number; name: string; email: string; grp: number[]; exp: number }
interface ResponseResult { succeeded: boolean; errorCode: number; slug: string; message: string }
interface PageItem { id: number; path: string; title: string; description: string; tags: string[]; updatedAt: string }
interface Page extends PageItem {
  locale: string;
  content: string;
  render: string;
  createdAt: string;
  authorName: string;
  creatorName: string;
}
interface Comment { id: number; render: string; authorName: string; createdAt: string }
interface Trail { versionId: number; authorName: string; actionType: string; valueBefore: string | null; valueAfter: string | null; versionDate: string }
interface Version { versionId: number; pageId: number; title: string; path: string; description: string; render: string; content: string; authorName: string; versionDate: string; createdAt: string; tags: string[] }
interface UserItem { id: number; name: string; email: string; isSystem: boolean; isActive: boolean; createdAt: string; lastLoginAt: string | null }
interface Group { id: number; name: string; isSystem: boolean }

// ---- token storage -----------------------------------------------------------------------

function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage may be unavailable (private mode); the session then lasts until the page reloads.
  }
  memoryToken = token;
}
let memoryToken: string | null = loadToken();

function claims(): Claims | null {
  if (!memoryToken) return null;
  try {
    const part = memoryToken.split('.')[1] ?? '';
    const bytes = Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
    const c = JSON.parse(new TextDecoder().decode(bytes)) as Claims;
    if (c.exp * 1000 <= Date.now()) {
      saveToken(null);
      return null;
    }
    return c;
  } catch {
    saveToken(null);
    return null;
  }
}
const isMaintainer = () => !!claims()?.grp.includes(1);

// ---- API ---------------------------------------------------------------------------------

class ApiProblem extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (claims() && memoryToken) headers.Authorization = `Bearer ${memoryToken}`;
  const res = await fetch('/graphql', { method: 'POST', headers, body: JSON.stringify([{ operationName: null, variables, extensions: {}, query }]) });
  const renewed = res.headers.get('X-Pagegrove-Token');
  if (renewed) saveToken(renewed);
  if (!res.ok) throw new ApiProblem(`The server answered with status ${res.status}.`, 'HTTP');
  const [result] = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] }[];
  if (result?.errors?.length) {
    const first = result.errors[0]!;
    throw new ApiProblem(first.message, first.extensions?.code ?? 'ERROR');
  }
  return result!.data as T;
}

function expectOk(r: ResponseResult): void {
  if (!r.succeeded) throw new ApiProblem(r.message, String(r.errorCode));
}

// ---- DOM helpers -------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, string | boolean | EventListener | undefined> = {}, ...children: (Child | Child[])[]): HTMLElement {
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

function html(markup: string): HTMLElement {
  const box = h('div', { class: 'prose' });
  box.innerHTML = markup; // server-rendered Markdown: text is escaped there, raw HTML never passes
  return box;
}

// Pagegrove's own line icons (24×24, stroked).
const ICONS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  dots: 'M12 5.5v.01M12 12v.01M12 18.5v.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20.5c1.4-3.8 4.4-5.8 8-5.8s6.6 2 8 5.8',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c1-3.5 3.4-5.5 6.5-5.5s5.5 2 6.5 5.5M16 4.6a3.4 3.4 0 0 1 0 6.3M18 14.6c1.9.8 3 2.5 3.5 5.4',
  tag: 'M3.5 12.5V4h8.5l9 9-8.5 8.5-9-9ZM8 8.5v.01',
  home: 'M3 11.5 12 4l9 7.5M5.5 10v10h5v-6h3v6h5V10',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20.5 20.5',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4',
  history: 'M12 7.5V12l3 2M4 12a8 8 0 1 0 2.4-5.7M4 4.5v4h4',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  code: 'M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5',
  compare: 'M4 8h13l-3.5-3.5M20 16H7l3.5 3.5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3.2-3.2a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3.2 3.2a4 4 0 0 0 5.7 5.7l1-1',
  print: 'M7 9V3.5h10V9M7 17H4v-7.5h16V17h-3M7 13.5h10V21H7v-7.5Z',
  grid: 'M4 4h7v7H4V4ZM13 4h7v7h-7V4ZM4 13h7v7H4v-7ZM13 13h7v7h-7v-7Z',
  list: 'M9 6h12M9 12h12M9 18h12M4 6v.01M4 12v.01M4 18v.01',
  trash: 'M4 7h16M9.5 7V4h5v3M6.5 7l1 13h9l1-13',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  login: 'M14 4h5v16h-5M9 8l4 4-4 4M13 12H3',
  book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15ZM5 19.5A1.5 1.5 0 0 0 6.5 21H19',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  back: 'M19 12H5M11 6l-6 6 6 6',
};
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name: string, size = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `ico${size ? ` ${size}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  if (name === 'dots') path.setAttribute('stroke-width', '3');
  svg.append(path);
  return svg;
}

const root = document.getElementById('root')!;

function when(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

const pageHref = (path: string) => `#/view/${path.split('/').map(encodeURIComponent).join('/')}`;
const tagHref = (tag: string) => `#/tags/${encodeURIComponent(tag)}`;

function notice(text: string, kind: 'error' | 'info' = 'error'): HTMLElement {
  return h('p', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint ? h('small', {}, hint) : null);
}

function tagChips(tags: string[]): HTMLElement {
  return h('ul', { class: 'chips' }, tags.map((t) => h('li', {}, h('a', { href: tagHref(t) }, `#${t}`))));
}

// ---- layout ------------------------------------------------------------------------------

/** What the app bar can offer for the page on screen. */
interface PageContext { id: number; path: string; title: string }

interface ShellOptions {
  /** 'nav': the blue navigation drawer; 'none': no drawer; or a drawer element of the view's own (300px wide). */
  side?: 'nav' | 'none' | HTMLElement;
  page?: PageContext;
  mainClass?: string;
}

function closeMenus(): void {
  for (const m of document.querySelectorAll<HTMLElement>('.menu')) {
    m.hidden = true;
    m.previousElementSibling?.setAttribute('aria-expanded', 'false');
  }
}
document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
});

function menuButton(label: string, iconName: string, items: Child[]): HTMLElement {
  const menu = h('div', { class: 'menu', role: 'menu', hidden: true }, ...items);
  const button = h(
    'button',
    {
      type: 'button',
      class: 'tb-btn icon',
      title: label,
      'aria-label': label,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onclick: ((e: Event) => {
        e.stopPropagation();
        const open = menu.hidden;
        closeMenus();
        menu.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
      }) as EventListener,
    },
    icon(iconName),
  );
  return h('div', { class: 'menu-wrap' }, button, menu);
}

function menuLink(href: string, iconName: string, text: string): HTMLElement {
  return h('a', { class: 'menu-item', role: 'menuitem', href }, icon(iconName, 'sm'), text);
}

async function deletePage(page: PageContext): Promise<void> {
  if (!confirm(`Delete “${page.title}”? Its history and comments go with it.`)) return;
  try {
    const r = await gql<{ pages: { delete: { responseResult: ResponseResult } } }>('mutation ($id: Int!) { pages { delete(id: $id) { responseResult { succeeded errorCode slug message } } } }', { id: page.id });
    expectOk(r.pages.delete.responseResult);
    location.hash = '#/';
  } catch (error) {
    alert((error as Error).message);
  }
}

function topbar(opts: ShellOptions): HTMLElement {
  const me = claims();
  const search = h('input', { type: 'search', name: 'q', placeholder: ' ', 'aria-label': 'Find a page', autocomplete: 'off' }) as HTMLInputElement;
  search.value = decodeURIComponent(location.hash.match(/^#\/search\/(.*)$/)?.[1] ?? '');
  const actions: Child[] = [];
  const add = (el: HTMLElement) => {
    if (actions.length) actions.push(h('hr', { class: 'vdiv' }));
    actions.push(el);
  };
  if (me) {
    add(h('button', { type: 'button', class: 'tb-btn icon', title: 'New page', 'aria-label': 'New page', onclick: (() => (location.hash = '#/new')) as EventListener }, icon('plus')));
    if (opts.page) {
      const p = opts.page;
      add(
        menuButton('Page actions', 'dots', [
          menuLink(pageHref(p.path), 'eye', 'Read this page'),
          menuLink(`#/edit/${p.id}`, 'pencil', 'Edit'),
          menuLink(`#/history/${p.id}`, 'history', 'History'),
          menuLink(`#/new?path=${encodeURIComponent(`${p.path}/`)}`, 'plus', 'New subpage'),
          isMaintainer() ? h('button', { type: 'button', class: 'menu-item danger', role: 'menuitem', onclick: (() => void deletePage(p)) as EventListener }, icon('trash', 'sm'), 'Delete') : null,
        ]),
      );
    }
    if (isMaintainer()) add(h('a', { class: 'tb-btn icon', href: '#/people', title: 'People', 'aria-label': 'People' }, icon('people')));
    add(
      menuButton(`Account: ${me.name}`, 'user', [
        h('div', { class: 'menu-head' }, h('strong', {}, me.name), h('span', {}, me.email)),
        h('button', { type: 'button', class: 'menu-item', role: 'menuitem', onclick: signOut as EventListener }, icon('logout', 'sm'), 'Sign out'),
      ]),
    );
  } else {
    if (opts.page) add(h('a', { class: 'tb-btn icon', href: `#/history/${opts.page.id}`, title: 'History', 'aria-label': 'History' }, icon('history')));
    add(h('a', { class: 'tb-btn', href: `#/signin?next=${encodeURIComponent(location.hash)}` }, 'Sign in'));
  }
  return h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'tb-brand' }, h('a', { class: 'brand', href: '#/' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), h('span', {}, 'Pagegrove'))),
    h(
      'div',
      { class: 'tb-search' },
      h(
        'form',
        {
          role: 'search',
          onsubmit: ((e: Event) => {
            e.preventDefault();
            if (search.value.trim()) location.hash = `#/search/${encodeURIComponent(search.value.trim())}`;
          }) as EventListener,
        },
        h('label', { class: 'tb-field mfield' }, icon('search'), search, h('span', { class: 'mlabel', 'aria-hidden': 'true' }, 'Find a page…')),
        h('a', { class: 'tb-round', href: '#/tags', title: 'Browse by tag', 'aria-label': 'Browse by tag' }, icon('tag')),
      ),
    ),
    h('div', { class: 'tb-actions' }, actions),
  );
}

function navDrawer(): HTMLElement {
  const hash = location.hash || '#/';
  return h(
    'aside',
    { class: 'side', 'aria-label': 'Navigation' },
    h(
      'div',
      { class: 'side-strip' },
      h('a', { class: 'sbtn icon', href: pageHref('home'), title: 'Home page', 'aria-label': 'Home page' }, icon('home')),
      h('a', { class: 'sbtn wide', href: '#/' }, icon('book', 'sm'), 'All pages'),
    ),
    h('hr', { class: 'rule' }),
    h('nav', { class: 'side-list' }, h('a', { class: `side-link${hash.startsWith('#/tags') ? ' on' : ''}`, href: '#/tags' }, icon('tag'), 'Browse by tag')),
  );
}

function shell(title: string, content: Child[], opts: ShellOptions = {}): void {
  const side = opts.side ?? 'nav';
  const drawer = side === 'nav' ? navDrawer() : side === 'none' ? null : side;
  const mainClass = ['main', side === 'none' ? 'no-side' : side === 'nav' ? '' : 'wide-side', opts.mainClass ?? ''].filter(Boolean).join(' ');
  const footer = h('footer', { class: 'foot' }, 'Pagegrove · a wiki for your team · ', h('a', { href: '#/' }, 'All pages'));
  document.title = title ? `${title} · Pagegrove` : 'Pagegrove';
  root.replaceChildren(topbar(opts), ...(drawer ? [drawer] : []), h('main', { class: mainClass }, ...content), footer);
}

function signOut(): void {
  saveToken(null);
  location.href = '/logout';
}

function needSignIn(): boolean {
  if (claims()) return false;
  location.hash = `#/signin?next=${encodeURIComponent(location.hash)}`;
  return true;
}

// ---- setup and sign-in -------------------------------------------------------------------

function setupView(): void {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' }) as HTMLInputElement;
  const pass = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }) as HTMLInputElement;
  const again = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }) as HTMLInputElement;
  const site = h('input', { type: 'url', required: true, value: location.origin }) as HTMLInputElement;
  const msg = h('div');
  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: (async (e: Event) => {
        e.preventDefault();
        msg.replaceChildren();
        if (pass.value !== again.value) return msg.append(notice('The two passwords are not the same.'));
        const res = await fetch('/finalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminEmail: email.value, adminPassword: pass.value, adminPasswordConfirm: again.value, siteUrl: site.value, telemetry: false }) });
        const out = (await res.json()) as { ok: boolean; error?: string };
        if (!out.ok) return msg.append(notice(out.error ?? 'Setup did not finish.'));
        location.hash = '#/signin?fresh=1';
      }) as EventListener,
    },
    h('h1', {}, 'Plant your wiki'),
    h('p', { class: 'muted' }, 'Create the maintainer account. You can invite everyone else afterwards.'),
    field('Your email', email),
    field('Password', pass, 'At least 8 characters.'),
    field('Password again', again),
    field('Address of this wiki', site),
    msg,
    h('button', { type: 'submit', class: 'btn' }, 'Finish setup'),
  );
  root.replaceChildren(h('main', { class: 'main no-side' }, h('div', { class: 'content narrow' }, form)));
  document.title = 'Set up · Pagegrove';
}

async function signInView(params: URLSearchParams): Promise<void> {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' }) as HTMLInputElement;
  const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password' }) as HTMLInputElement;
  const msg = h('div', {}, params.get('fresh') ? notice('Your wiki is ready. Sign in with the account you just made.', 'info') : null);
  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: (async (e: Event) => {
        e.preventDefault();
        msg.replaceChildren();
        try {
          const data = await gql<{ authentication: { login: { responseResult: ResponseResult; jwt: string | null } } }>(
            'mutation ($username: String!, $password: String!, $strategy: String!) { authentication { login(username: $username, password: $password, strategy: $strategy) { responseResult { succeeded errorCode slug message } jwt } } }',
            { username: email.value, password: pass.value, strategy: 'local' },
          );
          expectOk(data.authentication.login.responseResult);
          saveToken(data.authentication.login.jwt);
          const next = params.get('next');
          location.hash = next && next.startsWith('#/') && !next.startsWith('#/signin') ? next : '#/';
        } catch (error) {
          msg.append(notice((error as Error).message));
        }
      }) as EventListener,
    },
    h('h1', {}, 'Welcome back'),
    field('Email', email),
    field('Password', pass),
    msg,
    h('button', { type: 'submit', class: 'btn' }, 'Sign in'),
    h('p', { class: 'muted small' }, h('a', { href: '#/' }, 'Keep reading without an account')),
  );
  shell('Sign in', [h('div', { class: 'content narrow' }, form)], { side: 'none' });
}

// ---- pages -------------------------------------------------------------------------------

const LIST_QUERY = 'query ($tags: [String!], $locale: String) { pages { list(tags: $tags, locale: $locale) { id locale path title description createdAt updatedAt tags } } }';

function pageTable(pages: PageItem[]): HTMLElement {
  if (!pages.length) return h('p', { class: 'empty' }, 'No pages here yet.');
  const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path));
  return h(
    'ul',
    { class: 'pages' },
    sorted.map((p) => {
      const depth = p.path.split('/').length - 1;
      return h(
        'li',
        { style: `--depth:${depth}` },
        h('a', { href: pageHref(p.path) }, h('strong', {}, p.title), h('code', {}, `/${p.path}`)),
        p.description ? h('p', { class: 'muted' }, p.description) : null,
        h('div', { class: 'meta' }, p.tags.length ? tagChips(p.tags) : null, h('span', {}, `Updated ${when(p.updatedAt)}`)),
      );
    }),
  );
}

async function homeView(): Promise<void> {
  const data = await gql<{ pages: { list: PageItem[] } }>(LIST_QUERY, { locale: null });
  const hasHome = data.pages.list.some((p) => p.path === 'home');
  shell('Pages', [
    h(
      'div',
      { class: 'content' },
      h('div', { class: 'heading' }, h('h1', {}, 'All pages'), claims() ? h('a', { class: 'btn', href: hasHome ? '#/new' : '#/new?path=home' }, icon('plus', 'sm'), hasHome ? 'New page' : 'Write the home page') : null),
      hasHome ? h('p', { class: 'lede' }, 'Start at the ', h('a', { href: pageHref('home') }, 'home page'), ', or browse everything by path below.') : null,
      pageTable(data.pages.list),
    ),
  ]);
}

let resultsLayout: 'grid' | 'list' = (() => {
  try {
    return localStorage.getItem('pagegrove.tagsLayout') === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
})();

// Pagegrove's own empty-state picture: a few labels hanging from a branch.
const TAGS_ART = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><circle cx="128" cy="128" r="112" fill="#e3f2fd"/><path d="M40 70c40 18 136 18 176 0" fill="none" stroke="#90a4ae" stroke-width="6" stroke-linecap="round"/><g stroke="#90a4ae" stroke-width="3"><path d="M78 80v28M128 84v50M178 80v20"/></g><g><rect x="52" y="106" width="52" height="64" rx="10" fill="#1976d2"/><circle cx="78" cy="120" r="5" fill="#e3f2fd"/><rect x="62" y="136" width="32" height="6" rx="3" fill="#bbdefb"/><rect x="62" y="148" width="22" height="6" rx="3" fill="#bbdefb"/></g><g><rect x="102" y="132" width="52" height="64" rx="10" fill="#ff9800"/><circle cx="128" cy="146" r="5" fill="#fff3e0"/><rect x="112" y="162" width="32" height="6" rx="3" fill="#ffe0b2"/><rect x="112" y="174" width="18" height="6" rx="3" fill="#ffe0b2"/></g><g><rect x="152" y="98" width="52" height="64" rx="10" fill="#607d8b"/><circle cx="178" cy="112" r="5" fill="#eceff1"/><rect x="162" y="128" width="32" height="6" rx="3" fill="#cfd8dc"/><rect x="162" y="140" width="26" height="6" rx="3" fill="#cfd8dc"/></g></svg>')}`;

async function tagsView(selectedText: string): Promise<void> {
  const selected = selectedText ? selectedText.split(',').map(decodeURIComponent).filter(Boolean) : [];
  const tagData = await gql<{ pages: { tags: { tag: string; title: string }[] } }>('{ pages { tags { tag title } } }');
  const list = selected.length ? (await gql<{ pages: { list: PageItem[] } }>(LIST_QUERY, { locale: null, tags: selected })).pages.list : [];
  const toggle = (t: string) => {
    const next = selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t];
    return `#/tags/${next.map(encodeURIComponent).join(',')}`;
  };

  const drawer = h(
    'aside',
    { class: 'side light', 'aria-label': 'Tags' },
    h(
      'div',
      { class: 'side-panel' },
      h('a', { class: 'side-link', href: '#/' }, icon('book'), 'All pages'),
      h('hr', { class: 'rule' }),
      h('div', { class: 'side-caption' }, 'Tags'),
      tagData.pages.tags.length
        ? h('ul', { class: 'tag-pick' }, tagData.pages.tags.map((t) => h('li', {}, h('a', { href: toggle(t.tag), class: selected.includes(t.tag) ? 'on' : '', 'aria-pressed': selected.includes(t.tag) ? 'true' : 'false' }, `#${t.title}`))))
        : h('p', { class: 'side-hint' }, 'No tags yet. Add some when you write a page.'),
      h('hr', { class: 'rule' }),
      selected.length ? h('p', { class: 'side-hint' }, h('a', { href: '#/tags' }, 'Clear the selection')) : h('p', { class: 'side-hint' }, 'Pick tags to see the pages that carry all of them.'),
    ),
  );

  const filter = h('input', { type: 'text', placeholder: ' ', 'aria-label': 'Filter by title' }) as HTMLInputElement;
  const sort = h(
    'select',
    { class: 'sort', 'aria-label': 'Order by' },
    h('option', { value: 'title' }, 'Order by title'),
    h('option', { value: 'updated' }, 'Order by last change'),
    h('option', { value: 'path' }, 'Order by path'),
  ) as HTMLSelectElement;
  const gridBtn = h('button', { type: 'button', title: 'Show as cards', 'aria-label': 'Show as cards' }, icon('grid'));
  const listBtn = h('button', { type: 'button', title: 'Show as a list', 'aria-label': 'Show as a list' }, icon('list'));
  const results = h('div');

  const render = () => {
    gridBtn.setAttribute('aria-pressed', String(resultsLayout === 'grid'));
    listBtn.setAttribute('aria-pressed', String(resultsLayout === 'list'));
    if (!selected.length) {
      results.replaceChildren(
        h('div', { class: 'tags-empty' }, h('img', { src: TAGS_ART, alt: '', width: '256', height: '256' }), h('p', {}, tagData.pages.tags.length ? 'Pick one or more tags on the left to see the pages that carry all of them.' : 'No tags yet. Add some when you write a page.')),
      );
      return;
    }
    const needle = filter.value.trim().toLowerCase();
    const shown = list
      .filter((p) => !needle || p.title.toLowerCase().includes(needle))
      .sort((a, b) => (sort.value === 'updated' ? b.updatedAt.localeCompare(a.updatedAt) : sort.value === 'path' ? a.path.localeCompare(b.path) : a.title.localeCompare(b.title)));
    const heading = h('h2', {}, `Pages tagged ${selected.map((t) => `#${t}`).join(' + ')}`);
    if (!shown.length) return results.replaceChildren(h('div', { class: 'tags-results' }, heading, h('p', { class: 'empty' }, needle ? 'No page title matches the filter.' : 'No page carries all of these tags.')));
    results.replaceChildren(
      h(
        'div',
        { class: 'tags-results' },
        heading,
        resultsLayout === 'list'
          ? pageTable(shown)
          : h(
              'div',
              { class: 'result-grid' },
              shown.map((p) => h('article', { class: 'card' }, h('a', { href: pageHref(p.path) }, p.title), h('div', { class: 'meta' }, h('code', {}, `/${p.path}`)), p.description ? h('p', { class: 'muted small' }, p.description) : null, tagChips(p.tags), h('div', { class: 'meta' }, `Updated ${when(p.updatedAt)}`))),
            ),
      ),
    );
  };
  const setLayout = (layout: 'grid' | 'list') => {
    resultsLayout = layout;
    try {
      localStorage.setItem('pagegrove.tagsLayout', layout);
    } catch {
      // Not remembered in private mode.
    }
    render();
  };
  gridBtn.addEventListener('click', () => setLayout('grid'));
  listBtn.addEventListener('click', () => setLayout('list'));
  filter.addEventListener('input', render);
  sort.addEventListener('change', render);
  render();

  shell(
    'Tags',
    [
      h('h1', { class: 'visually-hidden' }, 'Browse by tag'),
      h('div', { class: 'tags-toolbar' }, h('label', { class: 'filter-card mfield' }, filter, h('span', { class: 'mlabel', 'aria-hidden': 'true' }, 'Filter by title…'), icon('search', 'sm')), h('hr', { class: 'vdiv' }), sort, h('div', { class: 'view-toggle', role: 'group', 'aria-label': 'Layout' }, gridBtn, listBtn)),
      h('hr', { class: 'rule' }),
      results,
    ],
    { side: drawer, mainClass: 'tags-main' },
  );
}

const PAGE_FIELDS = 'id locale path title description content render tags createdAt updatedAt authorName creatorName';

function crumbsBar(path: string): HTMLElement {
  const parts = path.split('/');
  return h(
    'nav',
    { class: 'crumbs-bar', 'aria-label': 'Breadcrumbs' },
    h(
      'ol',
      { class: 'crumbs' },
      h('li', {}, h('a', { class: 'crumb-home', href: pageHref('home'), title: 'Home page', 'aria-label': 'Home page' }, icon('home', 'xs'))),
      parts.map((seg, i) => h('li', {}, h('a', { href: pageHref(parts.slice(0, i + 1).join('/')), 'aria-current': i === parts.length - 1 ? 'page' : undefined }, seg))),
    ),
  );
}

function pcard(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'pcard', 'aria-label': title }, h('div', { class: 'pcard-title' }, title), ...children);
}

async function pageView(path: string): Promise<void> {
  let page: Page;
  try {
    page = (await gql<{ pages: { singleByPath: Page } }>(`query ($locale: String!, $path: String!) { pages { singleByPath(locale: $locale, path: $path) { ${PAGE_FIELDS} } } }`, { locale: 'en', path })).pages.singleByPath;
  } catch {
    shell('Not found', [h('div', { class: 'content' }, h('div', { class: 'card' }, h('h1', {}, 'Nothing grows here yet'), h('p', {}, `There is no page at /${path}.`), claims() ? h('a', { class: 'btn', href: `#/new?path=${encodeURIComponent(path)}` }, 'Write this page') : h('a', { href: '#/' }, 'Back to all pages')))]);
    return;
  }
  const me = claims();
  const copied = h('span', { class: 'visually-hidden', role: 'status' });
  const side = h(
    'div',
    { class: 'page-side' },
    pcard('Last edited by', h('div', { class: 'pcard-strong' }, page.authorName), h('div', { class: 'pcard-meta' }, when(page.updatedAt))),
    pcard(
      'Tags',
      h('div', { class: 'chip-row' }, page.tags.map((t) => h('a', { class: 'chip', href: tagHref(t) }, `#${t}`)), h('a', { class: 'chip icon-only', href: '#/tags', title: 'Browse all tags', 'aria-label': 'Browse all tags' }, icon('tag', 'sm'))),
    ),
    pcard(
      'Versions',
      h('div', { class: 'pcard-meta', title: `Created ${when(page.createdAt)}` }, `Created by ${page.creatorName}`),
      h(
        'div',
        { class: 'pcard-actions' },
        h('button', { type: 'button', class: 'btn sm outline', onclick: (() => (location.hash = `#/history/${page.id}`)) as EventListener }, 'View history'),
        me ? h('button', { type: 'button', class: 'btn sm outline', onclick: (() => (location.hash = `#/edit/${page.id}`)) as EventListener }, 'Edit') : null,
      ),
    ),
    pcard('Address', h('code', {}, `/${page.path}`), h('div', { class: 'pcard-meta' }, `Language: ${page.locale}`)),
    h(
      'div',
      { class: 'share' },
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          title: 'Copy a link to this page',
          'aria-label': 'Copy a link to this page',
          onclick: (async () => {
            try {
              await navigator.clipboard.writeText(location.href);
              copied.textContent = 'Link copied.';
            } catch {
              prompt('Copy this link:', location.href);
            }
          }) as EventListener,
        },
        icon('link'),
      ),
      h('button', { type: 'button', class: 'icon-btn', title: 'Print this page', 'aria-label': 'Print this page', onclick: (() => window.print()) as EventListener }, icon('print')),
      copied,
    ),
  );
  const comments = h('section', { class: 'comments', 'aria-label': 'Discussion' });
  const context: PageContext = { id: page.id, path: page.path, title: page.title };
  shell(
    page.title,
    [
      page.path === 'home' ? null : crumbsBar(page.path),
      page.path === 'home' ? null : h('hr', { class: 'rule' }),
      h(
        'div',
        { class: 'page-body' },
        side,
        h(
          'article',
          { class: 'page-main' },
          h('header', { class: 'page-head' }, h('div', { class: 'page-title' }, page.title), page.description ? h('div', { class: 'page-desc' }, page.description) : null),
          h('hr', { class: 'rule' }),
          html(page.render),
          comments,
        ),
      ),
      me ? h('button', { type: 'button', class: 'fab', title: 'Edit this page', 'aria-label': 'Edit this page', onclick: (() => (location.hash = `#/edit/${page.id}`)) as EventListener }, icon('pencil')) : null,
    ],
    { page: context },
  );
  await renderComments(comments, page);
}

async function renderComments(box: HTMLElement, page: Page): Promise<void> {
  const data = await gql<{ comments: { list: Comment[] } }>('query ($locale: String!, $path: String!) { comments { list(locale: $locale, path: $path) { id render authorName createdAt updatedAt } } }', { locale: page.locale, path: page.path });
  const list = data.comments.list;
  const text = h('textarea', { rows: '3', required: true, placeholder: 'Share a thought or ask a question (Markdown works)', 'aria-label': 'Your comment' }) as HTMLTextAreaElement;
  const textBox = h('label', { class: 'outlined' }, text);
  const msg = h('div');
  box.replaceChildren(
    h('div', { class: 'cm-head' }, icon('chat', 'sm'), h('span', {}, list.length ? `Discussion (${list.length})` : 'Discussion')),
    h(
      'div',
      { class: 'cm-body' },
      claims()
        ? h(
            'form',
            {
              class: 'reply',
              onsubmit: (async (e: Event) => {
                e.preventDefault();
                msg.replaceChildren();
                try {
                  const r = await gql<{ comments: { create: { responseResult: ResponseResult } } }>(
                    'mutation ($pageId: Int!, $replyTo: Int, $content: String!, $guestName: String, $guestEmail: String) { comments { create(pageId: $pageId, replyTo: $replyTo, content: $content, guestName: $guestName, guestEmail: $guestEmail) { responseResult { succeeded errorCode slug message } id } } }',
                    { pageId: page.id, replyTo: 0, content: text.value, guestName: '', guestEmail: '' },
                  );
                  expectOk(r.comments.create.responseResult);
                  await renderComments(box, page);
                } catch (error) {
                  msg.append(notice((error as Error).message));
                }
              }) as EventListener,
            },
            textBox,
            msg,
            h('div', { class: 'reply-row' }, h('button', { type: 'submit', class: 'btn' }, 'Post comment')),
          )
        : h('p', { class: 'muted' }, h('a', { href: `#/signin?next=${encodeURIComponent(location.hash)}` }, 'Sign in'), ' to join the discussion.'),
      h('hr', { class: 'rule' }),
      list.length
        ? h('ol', { class: 'thread' }, list.map((c) => h('li', { class: 'cm' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(c.authorName)), h('div', { class: 'cm-main' }, h('div', { class: 'cm-meta' }, h('strong', {}, c.authorName), h('span', {}, when(c.createdAt))), html(c.render)))))
        : h('p', { class: 'empty small' }, 'No comments yet.'),
    ),
  );
}

async function editorView(id: number | null, params: URLSearchParams): Promise<void> {
  if (needSignIn()) return;
  let page: Page | null = null;
  if (id !== null) page = (await gql<{ pages: { single: Page } }>(`query ($id: Int!) { pages { single(id: $id) { ${PAGE_FIELDS} } } }`, { id })).pages.single;
  const loadedAt = page?.updatedAt ?? '';
  const title = h('input', { type: 'text', required: true, value: page?.title ?? '' }) as HTMLInputElement;
  const path = h('input', { type: 'text', required: true, value: page?.path ?? params.get('path') ?? '', placeholder: 'team/onboarding', pattern: '[^\\s?#%]+' }) as HTMLInputElement;
  const description = h('input', { type: 'text', value: page?.description ?? '' }) as HTMLInputElement;
  const tags = h('input', { type: 'text', value: (page?.tags ?? []).join(', '), list: 'tag-suggestions', placeholder: 'guide, onboarding' }) as HTMLInputElement;
  const suggestions = h('datalist', { id: 'tag-suggestions' });
  const content = h('textarea', { rows: '18', class: 'source', spellcheck: 'true' }) as HTMLTextAreaElement;
  content.value = page?.content ?? '# New page\n\nStart writing here.\n';
  const msg = h('div');

  tags.addEventListener('input', async () => {
    const last = tags.value.split(',').pop()?.trim() ?? '';
    if (!last) return;
    const data = await gql<{ pages: { searchTags: string[] } }>('query ($query: String!) { pages { searchTags(query: $query) } }', { query: last });
    const prefix = tags.value.includes(',') ? `${tags.value.slice(0, tags.value.lastIndexOf(',') + 1)} ` : '';
    suggestions.replaceChildren(...data.pages.searchTags.map((t) => h('option', { value: `${prefix}${t}` })));
  });

  const save = async (e: Event) => {
    e.preventDefault();
    msg.replaceChildren();
    const vars = {
      content: content.value,
      description: description.value,
      editor: 'markdown',
      isPrivate: false,
      isPublished: true,
      locale: 'en',
      path: path.value.trim().replace(/^\/+|\/+$/g, ''),
      publishEndDate: '',
      publishStartDate: '',
      scriptCss: '',
      scriptJs: '',
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      title: title.value,
    };
    try {
      if (page) {
        const conflict = await gql<{ pages: { checkConflicts: boolean } }>('query ($id: Int!, $checkoutDate: Date!) { pages { checkConflicts(id: $id, checkoutDate: $checkoutDate) } }', { id: page.id, checkoutDate: loadedAt });
        if (conflict.pages.checkConflicts && !confirm('Someone saved this page after you opened it. Save anyway and replace their changes?')) return;
        const r = await gql<{ pages: { update: { responseResult: ResponseResult } } }>(
          'mutation ($id: Int!, $content: String, $description: String, $editor: String, $isPrivate: Boolean, $isPublished: Boolean, $locale: String, $path: String, $publishEndDate: Date, $publishStartDate: Date, $scriptCss: String, $scriptJs: String, $tags: [String], $title: String) { pages { update(id: $id, content: $content, description: $description, editor: $editor, isPrivate: $isPrivate, isPublished: $isPublished, locale: $locale, path: $path, publishEndDate: $publishEndDate, publishStartDate: $publishStartDate, scriptCss: $scriptCss, scriptJs: $scriptJs, tags: $tags, title: $title) { responseResult { succeeded errorCode slug message } page { updatedAt } } } }',
          { id: page.id, ...vars },
        );
        expectOk(r.pages.update.responseResult);
      } else {
        const r = await gql<{ pages: { create: { responseResult: ResponseResult } } }>(
          'mutation ($content: String!, $description: String!, $editor: String!, $isPrivate: Boolean!, $isPublished: Boolean!, $locale: String!, $path: String!, $publishEndDate: Date, $publishStartDate: Date, $scriptCss: String, $scriptJs: String, $tags: [String]!, $title: String!) { pages { create(content: $content, description: $description, editor: $editor, isPrivate: $isPrivate, isPublished: $isPublished, locale: $locale, path: $path, publishEndDate: $publishEndDate, publishStartDate: $publishStartDate, scriptCss: $scriptCss, scriptJs: $scriptJs, tags: $tags, title: $title) { responseResult { succeeded errorCode slug message } page { id updatedAt } } } }',
          vars,
        );
        expectOk(r.pages.create.responseResult);
      }
      location.hash = pageHref(vars.path);
    } catch (error) {
      msg.append(notice((error as Error).message));
    }
  };

  shell(
    page ? `Editing ${page.title}` : 'New page',
    [
      h(
        'div',
        { class: 'content' },
        h(
          'form',
          { class: 'editor', onsubmit: save as EventListener },
          h('div', { class: 'heading' }, h('h1', {}, page ? 'Edit page' : 'New page'), h('div', { class: 'actions' }, h('a', { class: 'btn outline', href: page ? pageHref(page.path) : '#/' }, 'Cancel'), h('button', { type: 'submit', class: 'btn' }, page ? 'Save changes' : 'Create page'))),
          msg,
          h('div', { class: 'grid' }, field('Title', title), field('Path', path, 'Words joined by dashes; slashes make folders.')),
          field('Summary', description, 'One line shown in lists and search results.'),
          field('Tags', tags, 'Separate tags with commas.'),
          suggestions,
          field('Content (Markdown)', content),
        ),
      ),
    ],
    page ? { page: { id: page.id, path: page.path, title: page.title } } : {},
  );
}

// Line diff (longest common subsequence) between two Markdown sources.
type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; no: number | null };
function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.replace(/\n$/, '').split('\n') : [];
  const b = after ? after.replace(/\n$/, '').split('\n') : [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: 'same', text: b[j]!, no: j + 1 });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push({ kind: 'add', text: b[j]!, no: j + 1 });
      j++;
    } else {
      out.push({ kind: 'del', text: a[i]!, no: null });
      i++;
    }
  }
  return out;
}

function sourceTable(lines: DiffLine[]): HTMLElement {
  const marks = { same: ' ', add: '+', del: '−' } as const;
  return h(
    'table',
    { class: 'diff' },
    h('tbody', {}, lines.map((l) => h('tr', { class: l.kind }, h('td', { class: 'ln' }, l.no === null ? '' : String(l.no)), h('td', { class: 'mk', 'aria-label': l.kind === 'add' ? 'added' : l.kind === 'del' ? 'removed' : undefined }, marks[l.kind]), h('td', { class: 'code' }, l.text || ' ')))),
  );
}

async function historyView(id: number): Promise<void> {
  const [pageData, hist] = await Promise.all([
    gql<{ pages: { single: Page } }>(`query ($id: Int!) { pages { single(id: $id) { ${PAGE_FIELDS} } } }`, { id }),
    gql<{ pages: { history: { trail: Trail[]; total: number } } }>('query ($id: Int!, $offsetPage: Int, $offsetSize: Int) { pages { history(id: $id, offsetPage: $offsetPage, offsetSize: $offsetSize) { trail { versionId authorId authorName actionType valueBefore valueAfter versionDate } total } } }', { id, offsetPage: 0, offsetSize: 100 }),
  ]);
  const page = pageData.pages.single;
  const trail = hist.pages.history.trail;
  const label: Record<string, string> = { initial: 'First', edit: 'Edited', move: 'Moved' };

  // Entry 0 is the page as it is now; the others are the stored versions, newest first.
  interface Entry { key: string; label: string; author: string; date: string; versionId: number | null; note: string }
  const entries: Entry[] = [
    { key: 'current', label: 'Current', author: page.authorName, date: page.updatedAt, versionId: null, note: '' },
    ...trail.map((t) => ({ key: `v${t.versionId}`, label: label[t.actionType] ?? t.actionType, author: t.authorName, date: t.versionDate, versionId: t.versionId, note: t.valueBefore && t.valueAfter ? `/${t.valueBefore} → /${t.valueAfter}` : '' })),
  ];
  const sources = new Map<string, string>([['current', page.content]]);
  const sourceOf = async (entry: Entry | undefined): Promise<string> => {
    if (!entry) return '';
    const known = sources.get(entry.key);
    if (known !== undefined) return known;
    const data = await gql<{ pages: { version: Version } }>('query ($pageId: Int!, $versionId: Int!) { pages { version(pageId: $pageId, versionId: $versionId) { versionId content } } }', { pageId: id, versionId: entry.versionId });
    sources.set(entry.key, data.pages.version.content);
    return data.pages.version.content;
  };
  const openHref = (entry: Entry) => (entry.versionId === null ? pageHref(page.path) : `#/version/${id}/${entry.versionId}`);

  const panel = h('section', { class: 'hist-panel', 'aria-live': 'polite' });
  const cards = new Map<string, HTMLElement>();
  const show = async (index: number, mode: 'changes' | 'source') => {
    const entry = entries[index]!;
    for (const [key, card] of cards) card.classList.toggle('on', key === entry.key);
    try {
      const after = await sourceOf(entry);
      const before = mode === 'changes' ? await sourceOf(entries[index + 1]) : null;
      const lines = before === null ? after.replace(/\n$/, '').split('\n').map((text, i): DiffLine => ({ kind: 'same', text, no: i + 1 })) : diffLines(before, after);
      const what = entry.versionId === null ? 'the current version' : `version ${entry.versionId}`;
      panel.replaceChildren(
        h(
          'div',
          { class: 'hist-panel-head' },
          h('div', {}, h('strong', {}, mode === 'changes' ? `Changes in ${what}` : `Source of ${what}`), h('span', {}, `${entry.author}, ${when(entry.date)}${mode === 'changes' && index === entries.length - 1 ? ' · everything is new in the first version' : ''}`)),
          h('a', { class: 'btn sm tint', href: openHref(entry) }, entry.versionId === null ? 'Open page' : 'Open version'),
        ),
        sourceTable(lines),
      );
    } catch (error) {
      panel.replaceChildren(notice((error as Error).message));
    }
  };

  const timeline = h(
    'div',
    { class: 'timeline' },
    h('span', { class: 'badge' }, day(page.updatedAt)),
    h(
      'ol',
      { 'aria-label': 'Versions, newest first' },
      entries.map((entry, index) => {
        const card = h(
          'div',
          { class: 'tl-card' },
          h('span', { class: 'tl-label', title: entry.note || undefined }, entry.label),
          h('hr', { class: 'vdiv' }),
          h('span', { class: 'tl-who', title: `${entry.author}, ${when(entry.date)}` }, `${entry.author} · ${day(entry.date)}`),
          h(
            'span',
            { class: 'tl-actions' },
            h('button', { type: 'button', class: 'icon-btn', title: 'Show the changes', 'aria-label': `Show the changes in ${entry.label.toLowerCase()} version`, onclick: (() => void show(index, 'changes')) as EventListener }, icon('compare', 'sm')),
            h('button', { type: 'button', class: 'icon-btn', title: 'Show the source', 'aria-label': `Show the source of ${entry.label.toLowerCase()} version`, onclick: (() => void show(index, 'source')) as EventListener }, icon('code', 'sm')),
            h('button', { type: 'button', class: 'icon-btn', title: 'Open', 'aria-label': `Open ${entry.label.toLowerCase()} version`, onclick: (() => (location.hash = openHref(entry))) as EventListener }, icon('eye', 'sm')),
          ),
        );
        cards.set(entry.key, card);
        return h('li', { class: `tl-item${index ? ' past' : ''}` }, h('span', { class: 'tl-dot', title: entry.author }, initials(entry.author).slice(0, 1)), card);
      }),
    ),
    h('span', { class: 'badge' }, `Page created ${day(page.createdAt)}`),
  );

  shell(
    `History of ${page.title}`,
    [
      h('div', { class: 'hist-head' }, h('div', {}, h('h1', { class: 'hist-title' }, 'History'), h('div', { class: 'hist-sub' }, `${page.title} · /${page.path}`)), h('a', { class: 'btn', href: pageHref(page.path) }, icon('back', 'sm'), 'Back to page')),
      h('div', { class: 'hist-body' }, timeline, panel),
      hist.pages.history.total === 0 ? h('p', { class: 'empty content' }, 'This page has not been edited since it was written.') : null,
    ],
    { side: 'none', page: { id: page.id, path: page.path, title: page.title } },
  );
  await show(0, 'changes');
}

async function versionView(pageId: number, versionId: number): Promise<void> {
  const data = await gql<{ pages: { version: Version } }>('query ($pageId: Int!, $versionId: Int!) { pages { version(pageId: $pageId, versionId: $versionId) { versionId pageId title path description render content authorName versionDate createdAt tags } } }', { pageId, versionId });
  const v = data.pages.version;
  shell(
    `${v.title} (old version)`,
    [
      h(
        'div',
        { class: 'content' },
        h('div', { class: 'version-note' }, notice(`You are reading an older version saved on ${when(v.versionDate)} by ${v.authorName}. It was replaced on ${when(v.createdAt)}.`, 'info')),
        h(
          'article',
          {},
          h('div', { class: 'heading' }, h('div', { class: 'page-title' }, v.title), h('div', { class: 'actions' }, h('a', { class: 'btn outline', href: `#/history/${pageId}` }, 'All versions'))),
          v.description ? h('p', { class: 'lede' }, v.description) : null,
          h('p', { class: 'muted small' }, h('code', {}, `/${v.path}`)),
          v.tags.length ? tagChips(v.tags) : null,
          h('hr', { class: 'rule' }),
          h('div', { style: 'height:24px' }),
          html(v.render),
          h('details', {}, h('summary', {}, 'Markdown source'), h('pre', { class: 'source' }, v.content)),
        ),
      ),
    ],
    { page: { id: pageId, path: v.path, title: v.title } },
  );
}

async function searchView(text: string): Promise<void> {
  const data = await gql<{ pages: { search: { results: { id: number; title: string; description: string; path: string }[]; totalHits: number } } }>('query ($query: String!) { pages { search(query: $query) { results { id title description path locale } suggestions totalHits } } }', { query: text });
  const r = data.pages.search;
  shell(`Search: ${text}`, [
    h(
      'div',
      { class: 'content' },
      h('h1', {}, `Pages matching “${text}”`),
      h('p', { class: 'muted' }, r.totalHits === 1 ? 'One page found (titles, summaries and paths are searched).' : `${r.totalHits} pages found (titles, summaries and paths are searched).`),
      r.results.length
        ? h('ul', { class: 'pages' }, r.results.map((p) => h('li', {}, h('a', { href: pageHref(p.path) }, h('strong', {}, p.title), h('code', {}, `/${p.path}`)), p.description ? h('p', { class: 'muted' }, p.description) : null)))
        : h('p', { class: 'empty' }, 'Nothing matched. Try fewer or different words.'),
    ),
  ]);
}

// ---- people ------------------------------------------------------------------------------

async function peopleView(): Promise<void> {
  if (needSignIn()) return;
  if (!isMaintainer()) return shell('People', [h('div', { class: 'content' }, notice('Only maintainers can manage accounts.'))]);
  const data = await gql<{ users: { list: UserItem[] }; groups: { list: Group[] } }>('{ users { list { id name email providerKey isSystem isActive createdAt lastLoginAt } } groups { list { id name isSystem } } }');
  const name = h('input', { type: 'text', required: true }) as HTMLInputElement;
  const email = h('input', { type: 'email', required: true }) as HTMLInputElement;
  const pass = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }) as HTMLInputElement;
  const groupBoxes = data.groups.list.filter((g) => g.id !== 2).map((g) => ({ g, box: h('input', { type: 'checkbox', value: String(g.id) }) as HTMLInputElement }));
  const msg = h('div');
  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: (async (e: Event) => {
        e.preventDefault();
        msg.replaceChildren();
        try {
          const r = await gql<{ users: { create: { responseResult: ResponseResult } } }>(
            'mutation ($providerKey: String!, $email: String!, $name: String!, $passwordRaw: String, $groups: [Int]!, $mustChangePassword: Boolean, $sendWelcomeEmail: Boolean) { users { create(providerKey: $providerKey, email: $email, name: $name, passwordRaw: $passwordRaw, groups: $groups, mustChangePassword: $mustChangePassword, sendWelcomeEmail: $sendWelcomeEmail) { responseResult { succeeded errorCode slug message } } } }',
            { providerKey: 'local', email: email.value, name: name.value, passwordRaw: pass.value, groups: groupBoxes.filter((x) => x.box.checked).map((x) => x.g.id), mustChangePassword: false, sendWelcomeEmail: false },
          );
          expectOk(r.users.create.responseResult);
          await peopleView();
        } catch (error) {
          msg.append(notice((error as Error).message));
        }
      }) as EventListener,
    },
    h('h2', {}, 'Add a person'),
    h('div', { class: 'grid' }, field('Display name', name), field('Email', email)),
    field('First password', pass, 'Share it with them privately; at least 8 characters.'),
    groupBoxes.length ? h('fieldset', {}, h('legend', {}, 'Groups'), groupBoxes.map((x) => h('label', { class: 'check' }, x.box, ` ${x.g.name}`))) : null,
    msg,
    h('button', { type: 'submit', class: 'btn' }, 'Create account'),
  );
  shell('People', [
    h(
      'div',
      { class: 'content' },
      h('h1', {}, 'People'),
      h(
        'table',
        { class: 'people' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Joined'), h('th', {}, 'Last sign-in'))),
        h(
          'tbody',
          {},
          data.users.list.map((u) => h('tr', { class: u.isSystem ? 'system' : '' }, h('td', {}, u.name, u.isSystem ? h('span', { class: 'badge' }, 'built-in') : null, !u.isActive ? h('span', { class: 'badge' }, 'inactive') : null), h('td', {}, u.email), h('td', {}, when(u.createdAt)), h('td', {}, when(u.lastLoginAt)))),
        ),
      ),
      form,
    ),
  ]);
}

// ---- router ------------------------------------------------------------------------------

let setupKnown = false;

async function route(): Promise<void> {
  const hash = location.hash || '#/';
  const [routePath = '', query = ''] = hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const parts = routePath.split('/').filter(Boolean);
  try {
    if (!setupKnown) {
      const status = (await (await fetch('/status.json')).json()) as { setupDone: boolean };
      if (!status.setupDone) return setupView();
      setupKnown = true;
    }
    const [head, ...rest] = parts;
    if (!head) return await homeView();
    if (head === 'setup') {
      location.hash = '#/';
      return;
    }
    if (head === 'signin') return await signInView(params);
    if (head === 'tags') return await tagsView(rest.join('/'));
    if (head === 'view') return await pageView(rest.map(decodeURIComponent).join('/'));
    if (head === 'new') return await editorView(null, params);
    if (head === 'edit') return await editorView(Number(rest[0]), params);
    if (head === 'history') return await historyView(Number(rest[0]));
    if (head === 'version') return await versionView(Number(rest[0]), Number(rest[1]));
    if (head === 'search') return await searchView(decodeURIComponent(rest.join('/')));
    if (head === 'people') return await peopleView();
    shell('Not found', [h('div', { class: 'content' }, h('div', { class: 'card' }, h('h1', {}, 'Wrong turn'), h('p', {}, 'This address does not lead anywhere.'), h('a', { href: '#/' }, 'Back to all pages')))]);
  } catch (error) {
    const problem = error as ApiProblem;
    if (problem.code === 'FORBIDDEN' && !claims()) {
      location.hash = `#/signin?next=${encodeURIComponent(hash)}`;
      return;
    }
    shell('Problem', [h('div', { class: 'content' }, notice(problem.message || 'Something went wrong.'), h('p', {}, h('a', { href: '#/' }, 'Back to all pages')))]);
  }
}

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  void route();
});
void route();
