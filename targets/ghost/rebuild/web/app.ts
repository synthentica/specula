// Pressloft admin UI: a framework-free single-page app talking to /app/api/admin with the session cookie.

const API = '/app/api/admin';

interface Tag { id: string; name: string; slug: string; description: string | null; visibility?: string; count?: { posts: number } }
interface Post {
  id: string;
  title: string;
  status: string;
  lexical: string | null;
  mobiledoc: string | null;
  excerpt: string | null;
  updated_at: string;
  published_at: string | null;
  tags: Tag[];
  authors?: { name: string }[];
}
interface Member { id: string; name: string | null; email: string; note: string | null; status: string; created_at: string; subscribed?: boolean; avatar_image?: string; newsletters?: { id: string }[] }
interface Setting { key: string; value: unknown }

interface ApiErrorItem { message?: string; context?: string | null; type?: string; property?: string | null; code?: string | null }

class HttpError extends Error {
  status: number;
  type: string | null;
  property: string | null;
  code: string | null;
  constructor(status: number, message: string, item: ApiErrorItem = {}) {
    super(message);
    this.status = status;
    this.type = item.type ?? null;
    this.property = item.property ?? null;
    this.code = item.code ?? null;
  }
}

/** Turns an API error into a sentence for the person using the admin. */
function readableError(status: number, item: ApiErrorItem): string {
  if (item.code === 'PASSWORD_INCORRECT') return 'That password is not right. Check it and try again.';
  if (status === 422 && item.property === 'email' && /already/i.test(`${item.message ?? ''} ${item.context ?? ''}`)) {
    return 'A reader with this email address is already on your list.';
  }
  if (status === 404) return 'We could not find that. It may have been deleted.';
  if (status === 403) return 'Your session has ended. Please log in again.';
  const parts = [item.message, item.context].filter((p): p is string => !!p && p.trim() !== '');
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return parts.length ? parts.join(' ') : `The request failed (status ${status}).`;
}

// ---- API client --------------------------------------------------------------------------

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text && (res.headers.get('content-type') ?? '').includes('json')) data = JSON.parse(text);
  if (!res.ok) {
    const item = (data as { errors?: ApiErrorItem[] } | null)?.errors?.[0] ?? {};
    throw new HttpError(res.status, readableError(res.status, item), item);
  }
  return data as T;
}

const POST_INCLUDE = '?formats=mobiledoc,lexical&include=tags,authors,authors.roles,tiers,post_revisions';

// ---- editor documents ----------------------------------------------------------------------

interface LexNode { type?: string; text?: string; children?: LexNode[] }

function textFromLexical(lexical: string | null): string {
  if (!lexical) return '';
  try {
    const root = (JSON.parse(lexical) as { root?: LexNode }).root;
    const lines: string[] = [];
    for (const block of root?.children ?? []) {
      const parts: string[] = [];
      const walk = (n: LexNode) => {
        if (typeof n.text === 'string') parts.push(n.text);
        (n.children ?? []).forEach(walk);
      };
      walk(block);
      lines.push(parts.join(''));
    }
    return lines.join('\n').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

function lexicalFromText(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const paragraphs = (lines.length ? lines : ['']).map((line) => ({
    children: line ? [{ detail: 0, format: 0, mode: 'normal', style: '', text: line, type: 'extended-text', version: 1 }] : [],
    direction: line ? 'ltr' : null,
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
  }));
  return JSON.stringify({ root: { children: paragraphs, direction: lines.length ? 'ltr' : null, format: '', indent: 0, type: 'root', version: 1 } });
}

// ---- DOM helpers ---------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'value') (el as HTMLInputElement).value = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Pressloft's own line icons (24×24 grid, drawn with the current text colour). */
const ICONS: Record<string, string[]> = {
  pen: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  sliders: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 5v4', 'M9 15v4'],
  doc: ['M6 3h8l5 5v13H6z', 'M14 3v5h5', 'M9 13h7', 'M9 17h5'],
  tag: ['M3 11V4a1 1 0 0 1 1-1h7l10 10-8 8z', 'M7.5 7.5h.01'],
  people: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20c.5-3.6 3.2-6 6.5-6s6 2.4 6.5 6', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.4c2 .8 3.2 2.8 3.5 5.6'],
  plus: ['M12 5v14', 'M5 12h14'],
  chevronDown: ['M6 9l6 6 6-6'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  arrowLeft: ['M15 6l-6 6 6 6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  sort: ['M8 4v16', 'M4 16l4 4 4-4', 'M16 20V4', 'M12 8l4-4 4 4'],
  logout: ['M14 4h5v16h-5', 'M10 8l-4 4 4 4', 'M6 12h10'],
  panel: ['M4 4h16v16H4z', 'M15 4v16'],
  dot: ['M12 12h.01'],
};

function icon(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Pressloft's mark: a rounded square with a folded "P". */
function logoMark(size = 28): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'mark');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('width', '32');
  rect.setAttribute('height', '32');
  rect.setAttribute('rx', '8');
  rect.setAttribute('fill', '#2f6f5e');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M10 8h8a6 6 0 0 1 0 12h-4v5h-4z');
  path.setAttribute('fill', '#ffffff');
  svg.append(rect, path);
  return svg;
}

const root = document.getElementById('root')!;
function mount(...nodes: Node[]): void {
  closeMenus();
  root.replaceChildren(...nodes);
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, label), input);
}

function notice(message: string, kind: 'ok' | 'error' = 'ok'): HTMLElement {
  return h('div', { class: kind === 'error' ? 'notice error' : 'notice', role: kind === 'error' ? 'alert' : 'status' }, message);
}

function when(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function day(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function initials(text: string): string {
  const parts = text.trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

// ---- drop-down menus -----------------------------------------------------------------------

interface MenuOption { label: string; href: string; current: boolean }

let openMenu: HTMLElement | null = null;
function closeMenus(): void {
  if (openMenu) openMenu.hidden = true;
  openMenu = null;
}
document.addEventListener('click', (event) => {
  if (openMenu && !(event.target instanceof Node && openMenu.parentElement?.contains(event.target))) closeMenus();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenus();
});

/** An outline button that opens a short list of links (a filter or sort choice). */
function dropdown(label: string, options: MenuOption[]): HTMLElement {
  const menu = h('div', { class: 'menu', role: 'menu', hidden: true }, ...options.map((o) => h('a', { href: o.href, role: 'menuitem', class: o.current ? 'current' : undefined, onclick: closeMenus }, o.label)));
  const button = h('button', {
    class: 'btn outline', type: 'button', 'aria-haspopup': 'menu',
    onclick: () => {
      const wasOpen = openMenu === menu;
      closeMenus();
      if (!wasOpen) {
        menu.hidden = false;
        openMenu = menu;
      }
    },
  }, label, icon('chevronDown', 12));
  return h('div', { class: 'dropdown' }, button, menu);
}

// ---- app shell -----------------------------------------------------------------------------

let siteTitle = '';
let me: { name: string; email: string } | null = null;
let readerCount: number | null = null;

function shell(current: string, ...content: Child[]): HTMLElement {
  const item = (href: string, label: string, key: string, iconName: string, ...extra: Child[]) =>
    h('li', {}, h('a', { href, class: current === key ? 'nav-link current' : 'nav-link', 'aria-current': current === key ? 'page' : undefined }, icon(iconName), h('span', {}, label), ...extra));
  const sub = (href: string, label: string, key: string) => h('a', { href, class: current === key ? 'nav-sub current' : 'nav-sub', 'aria-current': current === key ? 'page' : undefined }, label);
  const isPosts = current === 'posts' || current.startsWith('posts-');
  return h(
    'div',
    { class: 'shell' },
    h(
      'nav',
      { class: 'sidebar', 'aria-label': 'Main' },
      h('div', { class: 'side-head' }, h('a', { class: 'brand', href: '#/posts/drafts', title: 'Pressloft' }, logoMark(), h('span', { class: 'site-name' }, siteTitle || 'Pressloft'))),
      h('ul', { class: 'nav-group' }, item('#/editor/new', 'Start a post', 'new', 'pen'), item('#/settings', 'Site details', 'settings', 'sliders')),
      h(
        'ul',
        { class: 'nav-group' },
        h(
          'li',
          { class: 'nav-parent' },
          h('a', { href: '#/posts/drafts', class: isPosts ? 'nav-link current' : 'nav-link' }, icon('doc'), h('span', {}, 'Writing desk')),
          h('a', { href: '#/editor/new', class: 'nav-add', title: 'Start a post', 'aria-label': 'Start a post' }, icon('plus')),
          h('div', { class: 'nav-subs' }, sub('#/posts/drafts', 'In progress', 'posts-drafts'), sub('#/posts/published', 'Live', 'posts-published'), sub('#/posts/all', 'Everything', 'posts-all')),
        ),
      ),
      h(
        'ul',
        { class: 'nav-group' },
        item('#/tags', 'Topics', 'tags', 'tag'),
        item('#/members', 'Readers', 'members', 'people', readerCount !== null && current !== 'members' ? h('span', { class: 'count', title: `${readerCount} readers` }, String(readerCount)) : null),
      ),
      h(
        'div',
        { class: 'side-foot' },
        me ? h('div', { class: 'me', title: me.email }, h('span', { class: 'me-avatar' }, initials(me.name || me.email)), h('span', { class: 'me-name' }, me.name || me.email)) : h('span'),
        h('button', { class: 'btn text', type: 'button', onclick: signOut }, icon('logout'), 'Log out'),
      ),
    ),
    h('main', { class: 'main' }, ...content),
  );
}

function pageHead(title: string, ...actions: Child[]): HTMLElement {
  return h('div', { class: 'page-head' }, h('h2', { class: 'page-title' }, title), h('div', { class: 'actions' }, ...actions));
}

/** Navigates to a hash route; re-renders when the hash is already current. */
function go(hash: string): void {
  if (location.hash === hash) void route();
  else location.hash = hash;
}

async function signOut(): Promise<void> {
  await api('DELETE', '/session').catch(() => undefined);
  me = null;
  go('#/signin');
}

/** A hash route worth returning to after signing in (not the sign-in or setup screens). */
function returnTarget(hash: string): string | null {
  if (!/^#\/[\w/-]*$/.test(hash)) return null;
  const screen = hash.slice(2).split('/')[0] ?? '';
  return screen === '' || screen === 'signin' || screen === 'setup' ? null : hash;
}

/** Sends a signed-out visitor to the sign-in screen, remembering the page they asked for. */
function requireSignIn(): void {
  const next = returnTarget(location.hash);
  location.replace(next ? `#/signin?next=${encodeURIComponent(next)}` : '#/signin');
}

async function loadSiteTitle(): Promise<void> {
  const data = await api<{ site: { title: string } }>('GET', '/site/');
  siteTitle = data.site.title;
  document.title = `${siteTitle} · Pressloft admin`;
}

async function loadReaderCount(): Promise<void> {
  const data = await api<{ meta?: { pagination?: { total?: number } } }>('GET', '/members/?limit=1&page=1');
  readerCount = data.meta?.pagination?.total ?? null;
}

// ---- screens -------------------------------------------------------------------------------

function authScreen(...content: Node[]): void {
  mount(h('div', { class: 'auth' }, h('div', { class: 'auth-brand' }, logoMark(32), h('span', {}, 'Pressloft')), h('div', { class: 'card auth-card' }, ...content)));
}

function setupScreen(): void {
  const name = h('input', { type: 'text', name: 'name', autocomplete: 'name', required: true });
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'email', required: true });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'new-password', minlength: '8', required: true });
  const title = h('input', { type: 'text', name: 'site-title', required: true, placeholder: 'e.g. The Weekly Margin' });
  const status = h('div');
  const form = h(
    'form',
    {
      onsubmit: async (event: Event) => {
        event.preventDefault();
        status.replaceChildren();
        try {
          await api('POST', '/authentication/setup/', { setup: [{ name: name.value, email: email.value, password: password.value, blogTitle: title.value }] });
          await api('POST', '/session', { username: email.value, password: password.value });
          go('#/posts/drafts');
        } catch (error) {
          status.replaceChildren(notice((error as Error).message, 'error'));
        }
      },
    },
    h('h1', {}, 'Welcome to Pressloft'),
    h('p', { class: 'muted' }, 'Create the owner account and name your site. You can change the name later.'),
    status,
    field('Site name', title),
    field('Your full name', name),
    field('Email address', email),
    field('Password (8 characters or more)', password),
    h('button', { class: 'btn primary wide', type: 'submit' }, 'Create my site'),
  );
  authScreen(form);
}

function signinScreen(next: string | null): void {
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const status = h('div');
  const form = h(
    'form',
    {
      onsubmit: async (event: Event) => {
        event.preventDefault();
        status.replaceChildren();
        try {
          await api('POST', '/session', { username: email.value, password: password.value });
          go(next ?? '#/posts/drafts');
        } catch (error) {
          status.replaceChildren(notice((error as Error).message, 'error'));
          password.select();
        }
      },
    },
    h('h1', {}, 'Log in'),
    h('p', { class: 'muted' }, siteTitle ? `Manage ${siteTitle}.` : 'Manage your site.'),
    next ? notice('Log in to continue to the page you opened.') : null,
    status,
    field('Email address', email),
    field('Password', password),
    h('button', { class: 'btn primary wide', type: 'submit' }, 'Log in'),
  );
  authScreen(form);
}

const POST_TABS: Record<string, { label: string; status: string | null; empty: string }> = {
  drafts: { label: 'In progress', status: 'draft', empty: 'Nothing in progress. Start a post!' },
  published: { label: 'Live', status: 'published', empty: 'Nothing is live yet.' },
  all: { label: 'Everything', status: null, empty: 'No posts yet. Start a post!' },
};

async function postsScreen(tabArg: string, search: string): Promise<void> {
  const tab = tabArg in POST_TABS ? tabArg : 'drafts';
  const conf = POST_TABS[tab]!;
  const params = new URLSearchParams(search);
  const tagSlug = params.get('tag') ?? '';
  const oldest = params.get('order') === 'oldest';
  const dateField = conf.status === 'published' ? 'published_at' : 'updated_at';
  const order = `${dateField} ${oldest ? 'asc' : 'desc'}`;
  const filter = [conf.status ? `status:${conf.status}` : '', tagSlug ? `tag:${tagSlug}` : ''].filter(Boolean).join('+');
  const [data, tagData] = await Promise.all([
    api<{ posts: Post[] }>('GET', `/posts/?formats=mobiledoc,lexical&include=tags,authors&limit=50&page=1&order=${encodeURIComponent(order)}${filter ? `&filter=${encodeURIComponent(filter)}` : ''}`),
    api<{ tags: Tag[] }>('GET', '/tags/?limit=all&order=name%20asc'),
  ]);
  const link = (t: string, tag: string, old: boolean) => {
    const q = new URLSearchParams();
    if (tag) q.set('tag', tag);
    if (old) q.set('order', 'oldest');
    const qs = q.toString();
    return `#/posts/${t}${qs ? `?${qs}` : ''}`;
  };
  const currentTag = tagData.tags.find((t) => t.slug === tagSlug);
  const filters = h(
    'div',
    { class: 'filters' },
    dropdown(conf.label, Object.entries(POST_TABS).map(([key, c]) => ({ label: c.label, href: link(key, tagSlug, oldest), current: key === tab }))),
    dropdown(currentTag ? currentTag.name : 'All topics', [{ label: 'All topics', href: link(tab, '', oldest), current: !tagSlug }, ...tagData.tags.map((t) => ({ label: t.name, href: link(tab, t.slug, oldest), current: t.slug === tagSlug }))]),
    dropdown(oldest ? 'Oldest first' : 'Newest first', [{ label: 'Newest first', href: link(tab, tagSlug, false), current: !oldest }, { label: 'Oldest first', href: link(tab, tagSlug, true), current: oldest }]),
  );
  const items = data.posts.map((p) => {
    const live = p.status === 'published';
    return h(
      'li',
      { class: 'post-row' },
      h(
        'a',
        { class: 'item', href: `#/editor/${p.id}`, 'data-post-id': p.id },
        h('h3', { class: 'item-title' }, p.title),
        h('p', { class: 'item-byline' }, [p.authors?.length ? `By ${p.authors.map((a) => a.name).join(', ')}` : '', p.tags.length ? `in ${p.tags.map((t) => `#${t.name}`).join(', ')}` : ''].filter(Boolean).join(' ') || 'No topic yet'),
        h('p', { class: 'item-meta' }, h('span', { class: live ? 'state live' : 'state draft' }, live ? 'Live' : 'Draft'), live ? ` since ${when(p.published_at)}` : ` · edited ${when(p.updated_at)}`),
      ),
      h('div', { class: 'item-gap' }),
      h('a', { class: 'item-open', href: `#/editor/${p.id}`, 'aria-label': `Open ${p.title}`, tabindex: '-1' }, icon('arrowRight', 15)),
    );
  });
  mount(
    shell(
      `posts-${tab}`,
      pageHead('Writing desk', h('a', { class: 'btn primary', href: '#/editor/new' }, 'Start a post')),
      filters,
      items.length ? h('ul', { class: 'post-list', id: 'post-list' }, ...items) : h('div', { class: 'empty', id: 'post-list' }, conf.empty),
    ),
  );
}

function missingPostScreen(): void {
  mount(
    shell(
      'posts',
      pageHead('Post not found'),
      h(
        'div',
        { class: 'card', id: 'post-missing' },
        notice('This post does not exist any more. It may have been deleted, or the link is wrong.', 'error'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/posts/drafts' }, 'Back to the writing desk'), h('a', { class: 'btn outline', href: '#/editor/new' }, 'Start a post')),
      ),
    ),
  );
}

/** Lets a textarea grow with its text instead of scrolling. */
function autoGrow(area: HTMLTextAreaElement): void {
  const fit = () => {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  };
  area.addEventListener('input', fit);
  requestAnimationFrame(fit);
}

async function editorScreen(id: string): Promise<void> {
  let post: Post | null = null;
  if (id !== 'new') {
    try {
      post = (await api<{ posts: Post[] }>('GET', `/posts/${id}/${POST_INCLUDE}`)).posts[0] ?? null;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return missingPostScreen();
      throw error;
    }
    if (!post) return missingPostScreen();
  }
  const allTags = (await api<{ tags: Tag[] }>('GET', '/tags/?limit=all&order=name%20asc')).tags;
  let tags: Tag[] = post ? [...post.tags] : [];

  const title = h('textarea', { class: 'editor-title', name: 'title', rows: '1', placeholder: 'Give it a title', 'aria-label': 'Title' });
  title.value = post?.title ?? '';
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      body.focus();
    }
  });
  const body = h('div', { class: 'editor-body', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Body', 'data-placeholder': 'Write here. Each line becomes a paragraph.' });
  const markEmpty = () => body.classList.toggle('is-empty', !(body.textContent ?? '').trim());
  const bodyLines = (post ? textFromLexical(post.lexical) : '').split('\n').filter((l) => l.trim());
  body.replaceChildren(...bodyLines.map((line) => h('p', {}, line)));
  markEmpty();
  body.addEventListener('input', markEmpty);
  body.addEventListener('focus', () => document.execCommand('defaultParagraphSeparator', false, 'p'));
  // Plain text only: pasted formatting would not survive the paragraph model anyway.
  body.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
  });
  const bodyText = () => body.innerText.replace(/\u00a0/g, ' ');
  const status = h('div', { class: 'toasts' });
  const chips = h('div', { class: 'chips', id: 'tag-chips' });
  const panelChips = h('div', { class: 'chips' });
  const tagInput = h('input', { type: 'text', name: 'tag', list: 'tag-options', placeholder: 'Topic name', 'aria-label': 'Topic name' });
  const options = h('datalist', { id: 'tag-options' }, ...allTags.map((t) => h('option', { value: t.name })));

  const chip = (t: Tag) =>
    h('span', { class: 'chip' }, t.name, h('button', { type: 'button', 'aria-label': `Remove ${t.name}`, onclick: () => { tags = tags.filter((x) => x !== t); renderChips(); if (post) void save(post.status, 'Topic removed.'); } }, '×'));
  const renderChips = () => {
    chips.replaceChildren(...tags.map(chip));
    panelChips.replaceChildren(...tags.map(chip));
  };
  renderChips();

  const payload = (nextStatus: string) => ({
    title: title.value.trim() || '(Untitled)',
    lexical: lexicalFromText(bodyText()),
    status: nextStatus,
    tags: tags.map((t) => (t.id ? { id: t.id, name: t.name } : { name: t.name })),
  });

  async function save(nextStatus: string, message: string): Promise<void> {
    status.replaceChildren();
    try {
      if (!post) {
        const created = (await api<{ posts: Post[] }>('POST', `/posts/${POST_INCLUDE}`, { posts: [payload(nextStatus)] })).posts[0]!;
        post = created;
        history.replaceState(null, '', `#/editor/${created.id}`);
      } else {
        post = (await api<{ posts: Post[] }>('PUT', `/posts/${post.id}/${POST_INCLUDE}`, { posts: [{ ...payload(nextStatus), updated_at: post.updated_at }] })).posts[0]!;
      }
      tags = [...post.tags];
      renderChips();
      renderActions();
      status.replaceChildren(notice(message));
    } catch (error) {
      status.replaceChildren(notice((error as Error).message, 'error'));
    }
  }

  const deleteDraft = async () => {
    if (!post || !confirm('Delete this draft for good?')) return;
    try {
      await api('DELETE', `/posts/${post.id}/`);
      go('#/posts/drafts');
    } catch (error) {
      status.replaceChildren(notice((error as Error).message, 'error'));
    }
  };

  const panel = h('aside', { class: 'post-panel', 'aria-label': 'Post settings', hidden: true });
  const togglePanel = (open?: boolean) => {
    panel.hidden = open === undefined ? !panel.hidden : !open;
    if (!panel.hidden) tagInput.focus();
  };

  const actions = h('div', { class: 'editor-actions' });
  const stateLabel = h('span', { class: 'editor-state', id: 'post-state' });
  const panelDanger = h('div', { class: 'panel-danger' });
  function renderActions(): void {
    const isLive = post?.status === 'published';
    stateLabel.textContent = post ? (isLive ? `Live since ${when(post.published_at)}` : 'Draft — only staff can see it') : 'New draft — not saved yet';
    const buttons: (HTMLButtonElement | null)[] = [
      isLive
        ? h('button', { class: 'btn outline', type: 'button', title: 'Take the post off the site and keep it as a draft', onclick: () => save('draft', 'Moved back to drafts.') }, 'Unpublish')
        : h('button', { class: 'btn outline', type: 'button', onclick: () => save('draft', 'Draft saved.') }, 'Save draft'),
      isLive
        ? h('button', { class: 'btn text accent', type: 'button', onclick: () => save('published', 'Changes are live.') }, 'Update live post')
        : h('button', { class: 'btn text accent', type: 'button', onclick: () => save('published', 'Your post is live.') }, 'Publish now'),
      h('button', { class: 'btn outline icon-only', type: 'button', title: 'Post settings', 'aria-label': 'Post settings', onclick: () => togglePanel() }, icon('panel')),
    ];
    actions.replaceChildren(...buttons.filter((b): b is HTMLButtonElement => b !== null));
    panelDanger.replaceChildren(
      post && !isLive ? h('button', { class: 'btn danger', type: 'button', onclick: deleteDraft }, 'Delete draft') : h('p', { class: 'muted' }, isLive ? 'Live posts stay on the site.' : 'Save the draft first to be able to delete it.'),
    );
  }
  renderActions();

  const addTag = async () => {
    const name = tagInput.value.trim();
    if (!name) return;
    const existing = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) tags.push(existing ?? { id: '', name, slug: '', description: null });
    tagInput.value = '';
    renderChips();
    if (post) await save(post.status, 'Topic added.');
  };

  panel.append(
    h('div', { class: 'panel-head' }, h('h3', {}, 'Post settings'), h('button', { class: 'btn text', type: 'button', onclick: () => togglePanel(false) }, 'Close')),
    h('strong', { class: 'panel-label' }, 'Topics'),
    h('p', { class: 'muted' }, 'Pick an existing topic or type a new one.'),
    panelChips,
    h('div', { class: 'row' }, tagInput, options, h('button', { class: 'btn outline', type: 'button', onclick: addTag }, 'Add topic')),
    h('strong', { class: 'panel-label' }, 'Draft'),
    panelDanger,
  );

  mount(
    h(
      'main',
      { class: 'editor' },
      h('div', { class: 'editor-bar' }, h('div', { class: 'editor-left' }, h('a', { class: 'back', href: '#/posts/drafts' }, icon('arrowLeft', 12), 'Writing desk'), stateLabel), actions),
      h(
        'div',
        { class: 'editor-canvas' },
        h('div', { class: 'editor-topics' }, h('button', { class: 'btn text add-topic', type: 'button', onclick: () => togglePanel(true) }, icon('plus', 14), 'Add topic'), chips),
        title,
        body,
      ),
      panel,
      status,
    ),
  );
  autoGrow(title);
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void addTag();
    }
  });
  if (!post) title.focus();
}

async function tagsScreen(message?: string, view = 'public'): Promise<void> {
  const tags = (await api<{ tags: Tag[] }>('GET', '/tags/?limit=all&order=name%20asc&include=count.posts')).tags;
  const internal = view === 'internal';
  const shown = tags.filter((t) => (t.visibility === 'internal') === internal);
  const segment = (key: string, label: string) =>
    h('button', { type: 'button', class: key === view ? 'seg current' : 'seg', 'aria-pressed': key === view ? 'true' : 'false', onclick: () => void tagsScreen(undefined, key) }, h('span', { class: 'seg-label' }, label));
  const rows = shown.map((t) => {
    const href = `#/posts/all?tag=${encodeURIComponent(t.slug)}`;
    const n = t.count?.posts ?? 0;
    return h(
      'li',
      { class: 'tag-row' },
      h('a', { class: 'cell cell-name', href }, h('h3', {}, t.name), t.description ? h('p', { class: 'item-excerpt' }, t.description) : null),
      h('a', { class: 'cell cell-slug', href, tabindex: '-1' }, t.slug),
      h('a', { class: 'cell cell-count', href, tabindex: '-1' }, `${n} ${n === 1 ? 'post' : 'posts'}`),
      h('a', { class: 'cell cell-go', href, 'aria-label': `Posts in ${t.name}` }, icon('arrowRight', 24)),
    );
  });
  mount(
    shell(
      'tags',
      h(
        'header',
        { class: 'topbar' },
        h('h2', { class: 'page-title' }, 'Topics'),
        h('div', { class: 'actions' }, h('div', { class: 'segmented', role: 'group', 'aria-label': 'Which topics' }, segment('public', 'Public topics'), segment('internal', 'Internal topics')), h('a', { class: 'btn primary', href: '#/tags/new' }, 'New topic')),
      ),
      message ? notice(message) : null,
      shown.length
        ? h('ul', { class: 'tag-list', id: 'tag-table' }, h('li', { class: 'tag-head' }, h('span', { class: 'cell cell-name' }, 'Topic'), h('span', { class: 'cell cell-slug' }, 'Slug'), h('span', { class: 'cell cell-count' }, 'Posts'), h('span', { class: 'cell cell-go' })), ...rows)
        : h('div', { class: 'empty' }, internal ? 'No internal topics. Tick “Internal topic” when you create one.' : 'No topics yet.'),
    ),
  );
}

function newTagScreen(): void {
  const name = h('input', { type: 'text', name: 'tag-name', required: true });
  const description = h('input', { type: 'text', name: 'tag-description' });
  const internal = h('input', { type: 'checkbox', name: 'tag-internal' });
  const status = h('div');
  const form = h(
    'form',
    {
      class: 'card form-card',
      onsubmit: async (event: Event) => {
        event.preventDefault();
        try {
          await api('POST', '/tags/', { tags: [{ name: name.value, description: description.value || null, ...(internal.checked ? { visibility: 'internal' } : {}) }] });
          history.replaceState(null, '', '#/tags');
          await tagsScreen(`Topic “${name.value}” created.`, internal.checked ? 'internal' : 'public');
        } catch (error) {
          status.replaceChildren(notice((error as Error).message, 'error'));
        }
      },
    },
    status,
    field('Name', name),
    field('Short description (optional)', description),
    h('label', { class: 'check' }, internal, h('span', {}, 'Internal topic — used for sorting, never shown to readers')),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Create topic'), h('a', { class: 'btn outline', href: '#/tags' }, 'Cancel')),
  );
  mount(shell('tags', pageHead('New topic', h('a', { class: 'btn outline', href: '#/tags' }, icon('arrowLeft', 14), 'All topics')), form));
  name.focus();
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function membersScreen(message?: string): Promise<void> {
  const members = (await api<{ members: Member[] }>('GET', '/members/?include=newsletters,labels&order=created_at%20desc&limit=100&page=1')).members;
  readerCount = members.length;
  let oldestFirst = false;
  let query = '';

  const name = h('input', { type: 'text', name: 'member-name' });
  const email = h('input', { type: 'email', name: 'member-email', required: true });
  const note = h('input', { type: 'text', name: 'member-note' });
  const status = h('div', {}, message ? notice(message) : null);
  const form = h(
    'form',
    {
      class: 'column',
      id: 'add-reader',
      onsubmit: async (event: Event) => {
        event.preventDefault();
        try {
          await api('POST', '/members/?include=newsletters,labels', { members: [{ name: name.value, email: email.value, note: note.value || null, subscribed: true }] });
          await membersScreen(`${name.value || email.value} added.`);
        } catch (error) {
          status.replaceChildren(notice((error as Error).message, 'error'));
        }
      },
    },
    h('h3', {}, 'Add a reader'),
    h('p', { class: 'muted' }, 'They get your newsletter from the next issue on.'),
    field('Name', name),
    field('Email address', email),
    field('Private note (optional)', note),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add reader'),
  );

  const subscribed = members.filter((m) => m.subscribed !== false && (m.newsletters?.length ?? 1) > 0).length;
  const withNotes = members.filter((m) => m.note).length;
  const newest = members[0];
  const stat = (label: string, value: string) => h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, value), h('span', { class: 'stat-label' }, label));
  const glance = h(
    'section',
    { class: 'column' },
    h('h3', {}, 'At a glance'),
    h('p', { class: 'muted' }, 'Who reads your site right now.'),
    h('div', { class: 'stats' }, stat('readers in total', String(members.length)), stat('get the newsletter', String(subscribed)), stat('have a private note', String(withNotes))),
    newest ? h('p', { class: 'muted' }, `Newest reader: ${newest.name ?? newest.email}, joined ${day(newest.created_at)}.`) : h('p', { class: 'muted' }, 'No readers yet.'),
  );

  const tbody = h('tbody');
  const renderRows = () => {
    const q = query.trim().toLowerCase();
    const list = members.filter((m) => !q || `${m.name ?? ''} ${m.email} ${m.note ?? ''}`.toLowerCase().includes(q));
    if (oldestFirst) list.reverse();
    tbody.replaceChildren(
      ...(list.length
        ? list.map((m) =>
            h(
              'tr',
              {},
              h('td', {}, h('div', { class: 'who' }, h('span', { class: 'avatar' }, m.avatar_image ? h('img', { src: m.avatar_image, alt: '', width: '38', height: '38' }) : initials(m.name ?? m.email)), h('div', {}, h('h3', {}, m.name ?? '—'), h('div', { class: 'item-meta' }, m.email)))),
              h('td', {}, m.status === 'free' ? 'Free' : m.status),
              h('td', {}, m.subscribed === false || m.newsletters?.length === 0 ? 'Not subscribed' : 'Subscribed'),
              h('td', {}, day(m.created_at)),
              h('td', { class: 'muted' }, m.note ?? ''),
            ),
          )
        : [h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'No reader matches your search.'))]),
    );
  };
  renderRows();

  const search = h('input', { type: 'search', class: 'search', name: 'member-search', placeholder: 'Search readers', 'aria-label': 'Search readers', oninput: () => { query = search.value; renderRows(); } });
  const exportCsv = () => {
    const lines = [['name', 'email', 'plan', 'subscribed', 'joined', 'note'], ...members.map((m) => [m.name ?? '', m.email, m.status, m.subscribed === false ? 'no' : 'yes', m.created_at, m.note ?? ''])];
    const blob = new Blob([lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n'], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'readers.csv' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const sortButton = h('button', {
    class: 'btn outline icon-only', type: 'button', title: 'Newest first', 'aria-label': 'Change order',
    onclick: () => {
      oldestFirst = !oldestFirst;
      sortButton.title = oldestFirst ? 'Oldest first' : 'Newest first';
      renderRows();
    },
  }, icon('sort'));

  mount(
    shell(
      'members',
      pageHead(
        'Readers',
        h('button', { class: 'btn outline', type: 'button', onclick: exportCsv }, icon('download'), 'Export'),
        sortButton,
        h('a', { class: 'btn primary', href: '#/members', onclick: (e: Event) => { e.preventDefault(); name.focus(); form.scrollIntoView({ block: 'center' }); } }, 'Add a reader'),
      ),
      h('div', { class: 'toolbar' }, h('span', { class: 'muted' }, `${members.length} in total`), h('label', { class: 'search-wrap' }, icon('search'), search)),
      status,
      members.length
        ? h('table', { id: 'member-table' }, h('colgroup', {}, h('col', { style: 'width:360px' }), h('col', { style: 'width:101px' }), h('col', { style: 'width:125px' }), h('col', { style: 'width:119px' }), h('col')), h('thead', {}, h('tr', {}, h('th', {}, 'Reader'), h('th', {}, 'Plan'), h('th', {}, 'Newsletter'), h('th', {}, 'Joined'), h('th', {}, 'Note'))), tbody)
        : h('div', { class: 'empty' }, 'No readers yet.'),
      h('h2', { class: 'section-title' }, 'Your list'),
      h('div', { class: 'columns' }, form, glance),
    ),
  );
}

async function settingsScreen(message?: string): Promise<void> {
  const settings = (await api<{ settings: Setting[] }>('GET', '/settings/?group=site')).settings;
  const get = (key: string) => String(settings.find((s) => s.key === key)?.value ?? '');
  const title = h('input', { type: 'text', name: 'site-title', required: true, value: get('title') });
  const description = h('input', { type: 'text', name: 'site-description', value: get('description') });
  const status = h('div', {}, message ? notice(message) : null);
  const form = h(
    'form',
    {
      class: 'card form-card',
      onsubmit: async (event: Event) => {
        event.preventDefault();
        try {
          await api('PUT', '/settings/', { settings: [{ key: 'title', value: title.value }, { key: 'description', value: description.value }] });
          await loadSiteTitle();
          await settingsScreen('Site details saved.');
        } catch (error) {
          status.replaceChildren(notice((error as Error).message, 'error'));
        }
      },
    },
    h('h3', {}, 'Name and description'),
    h('p', { class: 'muted' }, 'Shown in the sidebar, the browser tab and to your readers.'),
    field('Site name', title),
    field('One-line description', description),
    h('button', { class: 'btn primary', type: 'submit' }, 'Save details'),
  );
  mount(shell('settings', pageHead('Site details'), status, form));
}

// ---- router --------------------------------------------------------------------------------

async function route(): Promise<void> {
  const [path = '', search = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [screen = '', arg = ''] = path.split('/');
  try {
    const setup = await api<{ setup: { status: boolean }[] }>('GET', '/authentication/setup/');
    if (!setup.setup[0]?.status) return setupScreen();
    await loadSiteTitle();
    if (screen === 'setup') {
      location.hash = '#/signin';
      return;
    }
    if (screen === 'signin') return signinScreen(returnTarget(new URLSearchParams(search).get('next') ?? ''));
    const user = (await api<{ users: { name: string; email: string }[] }>('GET', '/users/me/?include=roles')).users[0];
    me = user ? { name: user.name, email: user.email } : null;
    if (screen === 'editor') return await editorScreen(arg || 'new');
    await loadReaderCount().catch(() => undefined);
    if (screen === 'tags') return arg === 'new' ? newTagScreen() : await tagsScreen();
    if (screen === 'members') return await membersScreen();
    if (screen === 'settings') return await settingsScreen();
    return await postsScreen(arg || 'drafts', search);
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return requireSignIn();
    authScreen(h('h1', {}, 'Something went wrong'), notice((error as Error).message, 'error'), h('a', { class: 'btn outline', href: '#/posts/drafts' }, 'Back to the writing desk'));
  }
}

window.addEventListener('hashchange', () => void route());
void route();
