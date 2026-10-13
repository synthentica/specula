// Listwell frontend: hash-routed pages built with plain DOM calls.

import * as api from './api.ts';
import type { Label, Project, Task } from './api.ts';
import { clear, closePopover, emptyIllustration, formatDate, formatDateTime, h, icon, isBlankHtml, logoMark, popover, sanitizeHtml, textOn, toast } from './ui.ts';

const app = document.getElementById('app')!;
const PRIORITIES = ['None', 'Low', 'Normal', 'High', 'Urgent', 'Critical'];
const LABEL_COLOURS = ['2a9d8f', 'e76f51', '6c5ce7', 'f4a261', '3a86ff', 'd62828', '588157', 'b5179e'];

interface State {
  user: api.CurrentUser | null;
  projects: Project[];
  stopRealtime: (() => void) | null;
  refreshTimer: number | undefined;
}
const state: State = { user: null, projects: [], stopRealtime: null, refreshTimer: undefined };

// ---- session ------------------------------------------------------------------------------

function scheduleRefresh(): void {
  window.clearTimeout(state.refreshTimer);
  const token = api.getToken();
  if (!token) return;
  // Renew shortly before the access token runs out: a minute early, or a quarter of its lifetime when it is short.
  const left = api.tokenExpiry(token) - Date.now();
  const wait = Math.max(1_000, left - Math.min(60_000, left / 4));
  state.refreshTimer = window.setTimeout(async () => {
    if (await api.refreshToken()) scheduleRefresh();
  }, wait);
}

async function startSession(): Promise<void> {
  // Refresh right after signing in so the refresh cookie is proven to work, then keep renewing.
  await api.refreshToken();
  scheduleRefresh();
  state.user = await api.currentUser();
  await loadProjects();
  state.stopRealtime?.();
  state.stopRealtime = api.connectRealtime((event) => {
    if (event === 'notification.created') toast('You have a new notification.');
  });
}

function endSession(): void {
  window.clearTimeout(state.refreshTimer);
  state.stopRealtime?.();
  state.stopRealtime = null;
  state.user = null;
  state.projects = [];
}

api.whenSignedOut(() => {
  endSession();
  location.hash = '#/signin';
});

async function loadProjects(): Promise<void> {
  const page = await api.listProjects();
  state.projects = page.items;
}

const realProjects = () => state.projects.filter((p) => p.id > 0 && !p.is_archived);
const projectTitle = (id: number) => state.projects.find((p) => p.id === id)?.title ?? `Project ${id}`;
const defaultProjectId = () => {
  const preferred = state.user?.settings?.default_project_id;
  return realProjects().find((p) => p.id === preferred)?.id ?? realProjects()[0]?.id;
};

// ---- router -------------------------------------------------------------------------------

type Page = (params: string[], query: URLSearchParams) => Promise<Node> | Node;
const routes: [RegExp, Page, boolean][] = [
  [/^\/signin$/, () => authPage('signin'), false],
  [/^\/signup$/, () => authPage('signup'), false],
  [/^\/?$/, () => homePage(), true],
  [/^\/upcoming$/, (_p, q) => upcomingPage(q), true],
  [/^\/projects$/, () => projectsPage(), true],
  [/^\/projects\/new$/, () => newProjectPage(), true],
  [/^\/projects\/(-?\d+)$/, (p, q) => projectPage(Number(p[0]), q), true],
  [/^\/projects\/(\d+)\/table$/, (p) => tablePage(Number(p[0])), true],
  [/^\/projects\/(\d+)\/timeline$/, (p) => timelinePage(Number(p[0])), true],
  [/^\/projects\/(\d+)\/board$/, (p) => boardPage(Number(p[0])), true],
  [/^\/tasks\/(\d+)$/, (p) => taskPage(Number(p[0])), true],
  [/^\/labels$/, () => labelsPage(), true],
  [/^\/search$/, (_p, q) => searchPage(q), true],
];

let renderSeq = 0;
async function render(): Promise<void> {
  const seq = ++renderSeq;
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path = '/', search = ''] = raw.split('?');
  const query = new URLSearchParams(search);
  const match = routes.find(([re]) => re.test(path));
  if (!match) {
    location.hash = '#/';
    return;
  }
  const [re, page, needsAuth] = match;
  const params = path.match(re)!.slice(1);
  if (needsAuth && !api.getToken()) {
    location.hash = '#/signin';
    return;
  }
  if (!needsAuth && api.getToken() && state.user) {
    location.hash = '#/';
    return;
  }
  try {
    if (needsAuth && !state.user) await startSession();
    const content = await page(params, query);
    if (seq !== renderSeq) return;
    closePopover();
    clear(app, needsAuth ? shell(content, path) : content);
    app.querySelector<HTMLElement>('[autofocus]')?.focus();
  } catch (error) {
    if (seq !== renderSeq) return;
    if (error instanceof api.ApiError && error.status === 401) return;
    clear(app, needsAuth && state.user ? shell(errorBox(error), path) : errorBox(error));
  }
}

function errorBox(error: unknown): HTMLElement {
  const notFound = error instanceof api.ApiError && (error.code === api.ErrorCodes.TaskNotFound || error.status === 404);
  return h(
    'section',
    { class: 'surface error-box', role: 'alert' },
    h('h2', null, notFound ? 'Nothing here' : 'That did not work'),
    h('p', null, error instanceof Error ? error.message : String(error)),
    h('a', { href: '#/' }, 'Go to the start page'),
  );
}

function go(hash: string): void {
  if (location.hash === hash) void render();
  else location.hash = hash;
}

// ---- layout -------------------------------------------------------------------------------

const SIDEBAR_KEY = 'listwell.sidebar';
function sidebarHidden(): boolean {
  try {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved) return saved === 'hidden';
  } catch {
    // Storage may be unavailable; fall back to the screen width.
  }
  return window.matchMedia('(max-width: 760px)').matches;
}
function setSidebarHidden(hidden: boolean): void {
  document.body.classList.toggle('sidebar-hidden', hidden);
  try {
    localStorage.setItem(SIDEBAR_KEY, hidden ? 'hidden' : 'shown');
  } catch {
    // Not remembered; it still toggles.
  }
}

function shell(content: Node, path: string): HTMLElement {
  const user = state.user!;
  document.body.classList.toggle('sidebar-hidden', sidebarHidden());
  const projectMatch = /^\/projects\/(-?\d+)/.exec(path);
  const currentProject = projectMatch ? Number(projectMatch[1]) : undefined;

  const menuItem = (href: string, iconName: string, label: string, active: boolean) =>
    h('li', null, h('a', { href, class: active ? 'menu-link active' : 'menu-link', 'aria-current': active ? 'page' : undefined }, h('span', { class: 'menu-icon' }, icon(iconName, 18)), h('span', { class: 'menu-text' }, label)));

  const projectItem = (p: Project) => {
    const more = h('button', { type: 'button', class: 'icon-btn project-more', 'aria-label': `Views of ${p.title}` }, icon('dots', 20));
    const panel = viewMenu(p, 'project-panel');
    popover(more, panel);
    const colour = /^[0-9a-fA-F]{6}$/.test(p.hex_color) ? `#${p.hex_color}` : '';
    return h(
      'li',
      { class: 'project-item' },
      h(
        'a',
        { href: `#/projects/${p.id}`, class: currentProject === p.id ? 'menu-link project-link active' : 'menu-link project-link', 'aria-current': currentProject === p.id ? 'page' : undefined },
        projectDot(p.id < 0, colour),
        h('span', { class: 'menu-text' }, p.title),
      ),
      more,
      panel,
    );
  };

  const shown = currentProject !== undefined ? state.projects.find((p) => p.id === currentProject) : undefined;
  const titleMore = shown && h('button', { type: 'button', class: 'icon-btn topbar-btn', 'aria-label': `Views of ${shown.title}` }, icon('dots', 20));
  const titlePanel = shown && viewMenu(shown, 'title-panel');
  if (titleMore && titlePanel) popover(titleMore, titlePanel);

  const help = h('button', { type: 'button', class: 'icon-btn help-btn', 'aria-label': 'Keyboard shortcuts' }, icon('help', 20));
  const helpPanel = h(
    'div',
    { class: 'popover-panel help-panel' },
    h('p', { class: 'popover-title' }, 'Keyboard shortcuts'),
    h('dl', { class: 'shortcuts' }, SHORTCUTS.map(([key, what]) => [h('dt', null, h('kbd', null, key)), h('dd', null, what)])),
  );
  popover(help, helpPanel);

  const toggle = h('button', { type: 'button', class: 'icon-btn menu-toggle', 'aria-label': 'Show or hide the sidebar', onclick: () => setSidebarHidden(!document.body.classList.contains('sidebar-hidden')) }, icon('menu', 22));

  const bell = h('button', { type: 'button', class: 'icon-btn topbar-btn', 'aria-label': 'Notifications' }, icon('bell', 20));
  const bellPanel = h('div', { class: 'popover-panel notifications-panel' }, h('p', { class: 'muted' }, 'Checking…'));
  popover(bell, bellPanel, async () => {
    try {
      const page = await api.listNotifications();
      clear(bellPanel, h('p', { class: 'popover-title' }, 'Notifications'), h('p', { class: 'muted' }, page.total ? `${page.total} new` : 'You are all caught up.'));
    } catch {
      clear(bellPanel, h('p', { class: 'muted' }, 'Notifications could not be loaded.'));
    }
  });

  const userBtn = h(
    'button',
    { type: 'button', class: 'user-btn', 'aria-label': 'Account' },
    h('img', { src: api.avatarUrl(user.username, 40), alt: '', width: 40, height: 40, class: 'avatar' }),
    h('span', { class: 'username' }, user.name || user.username),
    icon('chevron', 16),
  );
  const userPanel = h(
    'div',
    { class: 'popover-panel user-panel' },
    h('p', { class: 'muted small' }, 'Signed in as ', h('strong', null, user.username)),
    h('a', { href: '#/labels', class: 'popover-item' }, icon('tag', 16), 'Labels'),
    h(
      'button',
      {
        type: 'button',
        class: 'popover-item',
        id: 'sign-out',
        onclick: async () => {
          try {
            await api.signOut();
          } catch {
            // Signed out locally either way.
          }
          endSession();
          toast('Signed out. See you soon.');
          go('#/signin');
        },
      },
      icon('logout', 16),
      'Sign out',
    ),
  );
  popover(userBtn, userPanel);

  return h(
    'div',
    { class: 'layout' },
    h(
      'header',
      { class: 'topbar' },
      h('a', { href: '#/', class: 'logo', 'aria-label': 'Listwell, start page' }, logoMark(32), h('span', { class: 'wordmark' }, 'Listwell')),
      toggle,
      h('div', { class: 'topbar-title' }, h('span', { class: 'topbar-title-text' }, currentProject !== undefined ? projectTitle(currentProject) : ''), titleMore && h('div', { class: 'popover-wrap' }, titleMore, titlePanel)),
      h('button', { type: 'button', class: 'icon-btn topbar-btn', 'aria-label': 'Find tasks', onclick: () => go('#/search') }, icon('search', 20)),
      h('div', { class: 'popover-wrap' }, bell, bellPanel),
      h('div', { class: 'popover-wrap' }, userBtn, userPanel),
    ),
    h(
      'aside',
      { class: 'sidebar' },
      h(
        'nav',
        { 'aria-label': 'Main' },
        h(
          'ul',
          { class: 'menu' },
          menuItem('#/', 'home', 'Open tasks', path === '/' || path === ''),
          menuItem('#/upcoming', 'calendar', 'Coming up', path === '/upcoming'),
          menuItem('#/projects', 'folder', 'Projects', path === '/projects' || path === '/projects/new'),
          menuItem('#/labels', 'tag', 'Labels', path === '/labels'),
          menuItem('#/search', 'search', 'Search', path === '/search'),
        ),
      ),
      h('nav', { 'aria-label': 'Projects', class: 'project-nav' }, h('ul', { class: 'menu' }, state.projects.filter((p) => !p.is_archived).map(projectItem))),
      h('a', { href: '#/projects/new', class: 'menu-link new-project-link' }, h('span', { class: 'menu-icon' }, icon('plus', 18)), h('span', { class: 'menu-text' }, 'New project')),
    ),
    h('main', { class: 'main', id: 'content' }, content),
    h('div', { class: 'help-wrap' }, help, helpPanel),
  );
}

/** A dropdown listing a project's views. */
function viewMenu(p: Project, cls: string): HTMLElement {
  const views = p.id > 0 && p.views?.length ? projectViews(p) : [{ href: `#/projects/${p.id}`, title: 'List', kind: 'list' as const }];
  const icons: Record<api.View['view_kind'], string> = { list: 'list', gantt: 'calendar', table: 'table', kanban: 'board' };
  return h('div', { class: `popover-panel ${cls}` }, views.map((v) => h('a', { href: v.href, class: 'popover-item' }, icon(icons[v.kind], 16), v.title)));
}

// ---- keyboard shortcuts ----------------------------------------------------------------------

const SHORTCUTS: [string, string][] = [
  ['/', 'Find tasks'],
  ['n', 'Add a task'],
  ['u', 'Coming up'],
  ['p', 'Projects'],
  ['Esc', 'Close a menu'],
];

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !state.user) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (e.key === '/') {
    e.preventDefault();
    go('#/search');
  } else if (e.key === 'n') {
    const quick = document.getElementById('quick-add');
    e.preventDefault();
    if (quick) quick.focus();
    else go('#/');
  } else if (e.key === 'u') go('#/upcoming');
  else if (e.key === 'p') go('#/projects');
});

/** A project's marker in the sidebar: a filled dot, or a ring for a saved filter. */
function projectDot(isFilter: boolean, colour: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'project-dot');
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', '6');
  dot.setAttribute('cy', '6');
  dot.setAttribute('r', isFilter ? '4.5' : '5.5');
  dot.setAttribute('fill', isFilter ? 'none' : colour || 'currentColor');
  if (isFilter) {
    dot.setAttribute('stroke', 'currentColor');
    dot.setAttribute('stroke-width', '2');
  }
  svg.appendChild(dot);
  return svg;
}

// ---- auth ---------------------------------------------------------------------------------

function authPage(mode: 'signin' | 'signup'): HTMLElement {
  const isUp = mode === 'signup';
  const username = h('input', { id: 'username', name: 'username', class: 'input', autocomplete: 'username', required: true, autofocus: true });
  const email = h('input', { id: 'email', name: 'email', type: 'email', class: 'input', autocomplete: 'email', required: true });
  const password = h('input', { id: 'password', name: 'password', type: 'password', class: 'input', autocomplete: isUp ? 'new-password' : 'current-password', required: true, minlength: isUp ? 8 : undefined });
  const message = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn primary wide', id: 'auth-submit' }, isUp ? 'Create my account' : 'Sign in');
  const form = h(
    'form',
    {
      class: 'surface auth-card',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        message.textContent = '';
        submit.disabled = true;
        try {
          if (isUp) await api.signUp(username.value.trim(), email.value.trim(), password.value);
          else await api.signIn(username.value.trim(), password.value);
          go('#/');
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('h1', { class: 'auth-title' }, isUp ? 'Start organising' : 'Welcome back'),
    h('p', { class: 'muted' }, isUp ? 'Make an account to keep your projects and to-dos in one place.' : 'Sign in to pick up where you left off.'),
    h('label', { for: 'username', class: 'field-label' }, isUp ? 'Username' : 'Username or email'),
    username,
    isUp && h('label', { for: 'email', class: 'field-label' }, 'Email'),
    isUp && email,
    h('label', { for: 'password', class: 'field-label' }, 'Password'),
    password,
    isUp && h('small', { class: 'muted' }, 'At least 8 characters.'),
    message,
    submit,
    h('p', { class: 'switch' }, isUp ? 'Already registered? ' : 'New here? ', h('a', { href: isUp ? '#/signin' : '#/signup' }, isUp ? 'Sign in instead' : 'Create an account')),
  );
  return h('div', { class: 'auth-wrap' }, h('div', { class: 'logo big' }, logoMark(40), h('span', { class: 'wordmark' }, 'Listwell')), form);
}

// ---- shared pieces -------------------------------------------------------------------------

function labelBadge(l: Label): HTMLElement {
  const hex = /^[0-9a-fA-F]{6}$/.test(l.hex_color) ? l.hex_color : /^[0-9a-fA-F]{3}$/.test(l.hex_color) ? l.hex_color.replace(/./g, '$&$&') : '9ca3af';
  return h('span', { class: 'badge label-badge', style: `background:#${hex};color:${textOn(hex)}` }, l.title);
}

function doneBadge(): HTMLElement {
  return h('span', { class: 'badge done-badge' }, 'Done');
}

function emptyState(title: string, hint: string): HTMLElement {
  return h('div', { class: 'empty-state' }, h('h3', { class: 'empty-title' }, title), h('p', { class: 'muted' }, hint), emptyIllustration());
}

function pageTitle(text: string): HTMLElement {
  return h('h1', { class: 'page-title' }, text);
}

function taskRow(task: Task, opts: { showProject?: boolean; onChange?: () => void } = {}): HTMLElement {
  const box = h('input', {
    type: 'checkbox',
    class: 'check-input',
    checked: task.done,
    'aria-label': task.done ? `Reopen ${task.title}` : `Finish ${task.title}`,
    onchange: async () => {
      try {
        await api.saveTask({ ...task, done: box.checked });
        toast(box.checked ? 'Nicely done.' : 'Task reopened.');
        opts.onChange?.();
      } catch (error) {
        box.checked = !box.checked;
        toast((error as Error).message, 'error');
      }
    },
  });
  const overdue = api.hasDate(task.due_date) && new Date(task.due_date) < new Date() && !task.done;
  return h(
    'li',
    { class: task.done ? 'task-row done' : 'task-row', 'data-task-id': task.id },
    box,
    h(
      'div',
      { class: 'task-main' },
      opts.showProject && h('a', { href: `#/projects/${task.project_id}`, class: 'task-project' }, projectTitle(task.project_id)),
      h('a', { href: `#/tasks/${task.id}`, class: 'task-title' }, task.title),
      (task.labels ?? []).map(labelBadge),
      task.done && doneBadge(),
    ),
    h(
      'div',
      { class: 'task-meta' },
      task.priority >= 3 && h('span', { class: `prio prio-${task.priority}` }, icon('flag', 14), PRIORITIES[task.priority]),
      api.hasDate(task.due_date) && h('span', { class: overdue ? 'due overdue' : 'due' }, icon('clock', 14), formatDate(task.due_date)),
      (task.comment_count ?? 0) > 0 && h('span', { class: 'meta-comments', title: 'Comments' }, icon('comment', 14), String(task.comment_count)),
      h('span', { class: 'meta-id' }, task.identifier),
    ),
  );
}

function taskList(tasks: Task[], opts: { showProject?: boolean; onChange?: () => void } = {}): HTMLElement {
  return h('ul', { class: 'task-list surface' }, tasks.map((t) => taskRow(t, opts)));
}

/** The add-a-task bar: one task per line, Enter adds. */
function quickAdd(projectId: number, onAdded: () => void, placeholder = 'Add a task… (one per line, Enter adds)'): HTMLElement {
  const quick = h('textarea', { id: 'quick-add', class: 'input add-task-input', rows: 1, placeholder, 'aria-label': 'New task', autofocus: true });
  const addTasks = async () => {
    const titles = quick.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!titles.length) return;
    try {
      await api.createTasks(projectId, titles);
      quick.value = '';
      toast(titles.length === 1 ? 'Task added.' : `${titles.length} tasks added.`);
      onAdded();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };
  quick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void addTasks();
    }
  });
  return h(
    'form',
    {
      class: 'add-task',
      onsubmit: (e: Event) => {
        e.preventDefault();
        void addTasks();
      },
    },
    h('div', { class: 'add-task-field' }, h('span', { class: 'add-task-icon' }, icon('plus', 16)), quick),
    h('button', { type: 'submit', class: 'btn primary', id: 'quick-add-submit' }, 'Add'),
  );
}

// ---- pages --------------------------------------------------------------------------------

async function homePage(): Promise<HTMLElement> {
  const page = await api.searchTasks({ filter: 'done = false', sort: [['due_date', 'asc'], ['id', 'desc']] });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const target = defaultProjectId();
  return h(
    'section',
    { class: 'page home' },
    pageTitle(`${greeting}, ${state.user?.name || state.user?.username}`),
    target !== undefined && quickAdd(target, () => void render(), `Add a task to ${projectTitle(target)}…`),
    h('h2', { class: 'section-title' }, 'Open tasks'),
    page.items.length
      ? [h('p', { class: 'muted count-line' }, page.total === 1 ? 'One open task across your projects.' : `${page.total} open tasks across your projects.`), taskList(page.items, { showProject: true, onChange: () => void render() })]
      : emptyState('Nothing open right now', 'Add a task above, or pick a project and jot something down.'),
  );
}

const RANGES = [7, 14, 30, 90];

async function upcomingPage(query: URLSearchParams): Promise<HTMLElement> {
  const days = Number(query.get('days')) || 7;
  const overdue = query.get('overdue') === '1';
  const now = new Date();
  const until = new Date(now.getTime() + days * 86400000);
  const filter = overdue ? `done = false && due_date < '${until.toISOString()}'` : `done = false && due_date < '${until.toISOString()}' && due_date > '${now.toISOString()}'`;
  const page = await api.searchTasks({ filter, sort: [['due_date', 'asc'], ['id', 'desc']] });

  const rangeBtn = h('button', { type: 'button', class: 'btn primary range-btn', id: 'range' }, icon('calendar', 16), `Next ${days} days`, icon('chevron', 16));
  const rangePanel = h(
    'div',
    { class: 'popover-panel range-panel', role: 'menu' },
    RANGES.map((d) => h('a', { href: `#/upcoming?days=${d}${overdue ? '&overdue=1' : ''}`, class: d === days ? 'popover-item active' : 'popover-item', role: 'menuitem' }, `Next ${d} days`)),
  );
  popover(rangeBtn, rangePanel);
  const box = h('input', { type: 'checkbox', class: 'check-input', id: 'show-overdue', checked: overdue, onchange: () => go(`#/upcoming?days=${days}${box.checked ? '&overdue=1' : ''}`) });

  const groups = new Map<string, Task[]>();
  for (const t of page.items) {
    const key = new Date(t.due_date).toDateString();
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return h(
    'section',
    { class: 'page upcoming' },
    pageTitle('Coming up'),
    h('div', { class: 'popover-wrap' }, rangeBtn, rangePanel),
    h('div', { class: 'checks' }, h('label', { class: 'check' }, box, 'Include overdue tasks')),
    page.items.length
      ? [...groups.entries()].map(([, tasks]) => h('div', { class: 'day-group' }, h('h3', { class: 'day-title' }, formatDate(tasks[0]!.due_date)), taskList(tasks, { showProject: true, onChange: () => void render() })))
      : emptyState('Nothing due in this period', 'Give a task a due date to see it here.'),
  );
}

async function projectsPage(): Promise<HTMLElement> {
  await loadProjects();
  return h(
    'section',
    { class: 'page projects' },
    h('div', { class: 'page-head' }, pageTitle('Projects'), h('a', { href: '#/projects/new', class: 'btn primary', id: 'new-project' }, icon('plus', 16), 'New project')),
    h(
      'ul',
      { class: 'project-grid' },
      state.projects.map((p) =>
        h(
          'li',
          { class: 'project-grid-item' },
          h(
            'a',
            { href: `#/projects/${p.id}`, class: 'project-card-link' },
            h(
              'article',
              { class: p.id < 0 ? 'project-card filter' : 'project-card', style: /^[0-9a-fA-F]{6}$/.test(p.hex_color) ? `border-top-color:#${p.hex_color}` : undefined },
              h('span', { class: 'project-card-title' }, p.title),
              p.description && h('span', { class: 'project-card-desc' }, p.description),
              p.id < 0 && h('span', { class: 'project-card-kind' }, icon('list', 16), 'Saved filter'),
              p.is_archived && h('span', { class: 'project-card-kind' }, 'Archived'),
            ),
          ),
        ),
      ),
    ),
  );
}

function newProjectPage(): HTMLElement {
  const title = h('input', { id: 'new-project-title', class: 'input', placeholder: 'For example: Garden makeover', required: true, maxlength: 250, autofocus: true });
  const description = h('input', { id: 'new-project-description', class: 'input', placeholder: 'Optional' });
  return h(
    'section',
    { class: 'page narrow' },
    h(
      'form',
      {
        class: 'surface form-card',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          try {
            const p = await api.createProject(title.value.trim(), description.value.trim());
            await loadProjects();
            toast(`Project “${p.title}” is ready.`);
            go(`#/projects/${p.id}`);
          } catch (error) {
            toast((error as Error).message, 'error');
          }
        },
      },
      h('h2', { class: 'form-card-title' }, 'New project'),
      h('div', { class: 'form-card-body' }, h('label', { for: 'new-project-title', class: 'field-label' }, 'Name'), title, h('label', { for: 'new-project-description', class: 'field-label' }, 'Description'), description),
      h('footer', { class: 'form-card-foot' }, h('a', { href: '#/projects', class: 'btn text' }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary', id: 'create-project' }, 'Create')),
    ),
  );
}

const VIEW_ROUTES: Record<api.View['view_kind'], string> = { list: '', gantt: '/timeline', table: '/table', kanban: '/board' };

/** The project's views, in their own order and with their own titles, linked to this app's pages. */
function projectViews(project: Project): { href: string; title: string; kind: api.View['view_kind'] }[] {
  return [...project.views]
    .filter((v) => v.view_kind in VIEW_ROUTES)
    .sort((a, b) => a.position - b.position)
    .map((v) => ({ href: `#/projects/${project.id}${VIEW_ROUTES[v.view_kind]}`, title: v.title || v.view_kind, kind: v.view_kind }));
}

function viewSwitcher(project: Project, active: api.View['view_kind']): HTMLElement {
  return h(
    'div',
    { class: 'view-switcher', role: 'tablist', 'aria-label': 'Project views' },
    projectViews(project).map((v) => h('a', { href: v.href, class: v.kind === active ? 'view-tab active' : 'view-tab', role: 'tab', 'aria-selected': v.kind === active ? 'true' : 'false' }, v.title)),
  );
}

async function projectPage(id: number, query: URLSearchParams): Promise<HTMLElement> {
  const project = await api.getProject(id);
  const showDone = query.get('done') === '1';
  // The list view hides finished tasks; the table view shows everything.
  const view = project.views.find((v) => v.view_kind === (showDone ? 'table' : 'list')) ?? project.views[0];
  if (!view) throw new Error('This project has no views.');
  const page = await api.viewTasks(project.id, view.id);
  const reload = () => void render();
  const toggle = h('input', { type: 'checkbox', class: 'check-input', id: 'show-done', checked: showDone, onchange: () => go(`#/projects/${id}${toggle.checked ? '?done=1' : ''}`) });

  return h(
    'section',
    { class: 'page project' },
    h('div', { class: 'project-head' }, id > 0 ? viewSwitcher(project, 'list') : h('h1', { class: 'page-title' }, project.title), h('label', { class: 'check' }, toggle, 'Show finished tasks')),
    project.description && h('p', { class: 'muted' }, project.description),
    id > 0 && quickAdd(project.id, reload),
    h('p', { class: 'muted count-line' }, page.total === 1 ? '1 task' : `${page.total} tasks`),
    page.items.length ? taskList(page.items, { showProject: id < 0, onChange: reload }) : emptyState(showDone ? 'This project has no tasks yet' : 'All clear', showDone ? 'Add a task above to get started.' : 'Add your first task above.'),
  );
}

async function tablePage(id: number): Promise<HTMLElement> {
  const project = await api.getProject(id);
  const view = project.views.find((v) => v.view_kind === 'table');
  if (!view) throw new Error('This project has no table.');
  const page = await api.viewTasks(project.id, view.id);
  return h(
    'section',
    { class: 'page project' },
    h('div', { class: 'project-head' }, viewSwitcher(project, 'table')),
    h('p', { class: 'muted count-line' }, page.total === 1 ? '1 task, finished ones included' : `${page.total} tasks, finished ones included`),
    h(
      'div',
      { class: 'surface table-wrap' },
      h(
        'table',
        { class: 'task-table' },
        h('thead', null, h('tr', null, ['#', 'Title', 'Priority', 'Due', 'Labels', 'Status'].map((c) => h('th', { scope: 'col' }, c)))),
        h(
          'tbody',
          null,
          page.items.map((t) =>
            h(
              'tr',
              { 'data-task-id': t.id },
              h('td', { class: 'muted' }, t.identifier),
              h('td', null, h('a', { href: `#/tasks/${t.id}` }, t.title)),
              h('td', null, PRIORITIES[t.priority] ?? ''),
              h('td', null, api.hasDate(t.due_date) ? formatDate(t.due_date) : ''),
              h('td', null, (t.labels ?? []).map(labelBadge)),
              h('td', null, t.done ? doneBadge() : h('span', { class: 'muted' }, 'Open')),
            ),
          ),
        ),
      ),
      !page.items.length && h('p', { class: 'muted table-empty' }, 'No tasks yet.'),
    ),
  );
}

async function timelinePage(id: number): Promise<HTMLElement> {
  const project = await api.getProject(id);
  const view = project.views.find((v) => v.view_kind === 'gantt');
  if (!view) throw new Error('This project has no timeline.');
  const page = await api.viewTasks(project.id, view.id);
  const dated = page.items.filter((t) => api.hasDate(t.due_date)).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const undated = page.items.filter((t) => !api.hasDate(t.due_date));
  const days = new Map<string, Task[]>();
  for (const t of dated) {
    const key = new Date(t.due_date).toDateString();
    days.set(key, [...(days.get(key) ?? []), t]);
  }
  const today = new Date().toDateString();
  return h(
    'section',
    { class: 'page project' },
    h('div', { class: 'project-head' }, viewSwitcher(project, 'gantt')),
    h('p', { class: 'muted count-line' }, dated.length === 1 ? 'One task with a due date.' : `${dated.length} tasks with a due date.`),
    dated.length
      ? h(
          'ol',
          { class: 'timeline' },
          [...days.values()].map((tasks) =>
            h(
              'li',
              { class: new Date(tasks[0]!.due_date).toDateString() === today ? 'timeline-day today' : 'timeline-day' },
              h('h3', { class: 'day-title' }, formatDate(tasks[0]!.due_date)),
              taskList(tasks, { onChange: () => void render() }),
            ),
          ),
        )
      : undated.length
        ? h('p', { class: 'muted' }, 'No task here has a due date yet. Give one a date to place it on the timeline.')
        : emptyState('Nothing on the timeline yet', 'Give tasks a due date to place them here.'),
    undated.length > 0 && [h('h2', { class: 'section-title' }, 'Without a date'), taskList(undated, { onChange: () => void render() })],
  );
}

async function boardPage(id: number): Promise<HTMLElement> {
  const project = await api.getProject(id);
  const view = project.views.find((v) => v.view_kind === 'kanban');
  if (!view) throw new Error('This project has no board.');
  const board = await api.boardBuckets(project.id, view.id);
  const buckets = board.items;
  const reload = () => void render();

  const move = async (taskId: number, bucketId: number, quiet = false) => {
    try {
      const result = await api.moveTaskToBucket(project.id, view.id, bucketId, taskId);
      // Put the task at the end of its new column.
      await api.setTaskPosition(taskId, view.id, 0);
      if (!quiet) toast(result.task.done ? `Moved to “${result.bucket.title}” and marked as finished.` : `Moved to “${result.bucket.title}”.`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
    reload();
  };

  const card = (task: Task, bucket: api.BucketWithTasks): HTMLElement => {
    const others = buckets.filter((b) => b.id !== bucket.id);
    const moveBtn = h('button', { type: 'button', class: 'icon-btn card-move', 'aria-label': `Move ${task.title} to another column` }, icon('dots', 16));
    const panel = h(
      'div',
      { class: 'popover-panel move-panel', role: 'menu' },
      h('p', { class: 'popover-title' }, 'Move to'),
      others.map((b) => h('button', { type: 'button', class: 'popover-item', role: 'menuitem', onclick: () => void move(task.id, b.id) }, b.title)),
    );
    popover(moveBtn, panel);
    const overdue = api.hasDate(task.due_date) && new Date(task.due_date) < new Date() && !task.done;
    return h(
      'li',
      {
        class: 'board-card-item',
        draggable: 'true',
        title: 'Drag to another column, or use the ⋯ menu',
        'data-task-id': task.id,
        ondragstart: (e: DragEvent) => {
          e.dataTransfer?.setData('text/plain', String(task.id));
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        },
      },
      h(
        'div',
        { class: task.done ? 'task-card done' : 'task-card' },
        (task.done || task.priority >= 3) && h('div', { class: 'card-badges' }, task.done && doneBadge(), task.priority >= 3 && h('span', { class: `prio prio-${task.priority}` }, icon('flag', 14), PRIORITIES[task.priority])),
        h('h3', { class: 'card-title' }, h('a', { href: `#/tasks/${task.id}` }, task.title)),
        (api.hasDate(task.due_date) || (task.labels ?? []).length > 0) &&
          h('div', { class: 'card-meta' }, api.hasDate(task.due_date) && h('span', { class: overdue ? 'due overdue' : 'due' }, icon('clock', 14), formatDate(task.due_date)), (task.labels ?? []).map(labelBadge)),
        h('div', { class: 'popover-wrap card-move-wrap' }, moveBtn, panel),
      ),
    );
  };

  const addTaskFooter = (bucket: api.BucketWithTasks): HTMLElement => {
    const input = h('input', { class: 'input', placeholder: 'Task title', 'aria-label': `New task in ${bucket.title}`, maxlength: 250, required: true });
    const form = h(
      'form',
      {
        class: 'column-add-form',
        hidden: true,
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const title = input.value.trim();
          if (!title) return;
          try {
            const created = await api.createTasks(project.id, [title]);
            const task = created.tasks[0];
            // New tasks land in the default column; move it here when this is another one.
            if (task && bucket.id !== view.default_bucket_id) await move(task.id, bucket.id, true);
            toast(`Added to “${bucket.title}”.`);
            reload();
          } catch (error) {
            toast((error as Error).message, 'error');
          }
        },
      },
      input,
      h('button', { type: 'submit', class: 'btn primary small' }, 'Add'),
    );
    const open = h('button', {
      type: 'button',
      class: 'btn text column-add',
      onclick: () => {
        open.hidden = true;
        form.hidden = false;
        input.focus();
      },
    }, icon('plus', 16), 'Add a task');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        form.hidden = true;
        open.hidden = false;
        open.focus();
      }
    });
    return h('div', { class: 'column-foot' }, open, form);
  };

  const column = (bucket: api.BucketWithTasks): HTMLElement => {
    const isDone = bucket.id === view.done_bucket_id;
    const col = h(
      'section',
      {
        class: 'board-column',
        'data-bucket-id': bucket.id,
        'aria-label': bucket.title,
        ondragover: (e: DragEvent) => {
          e.preventDefault();
          col.classList.add('drop-target');
        },
        ondragleave: () => col.classList.remove('drop-target'),
        ondrop: (e: DragEvent) => {
          e.preventDefault();
          col.classList.remove('drop-target');
          const taskId = Number(e.dataTransfer?.getData('text/plain'));
          const from = buckets.find((b) => (b.tasks ?? []).some((t) => t.id === taskId));
          if (taskId && from?.id !== bucket.id) void move(taskId, bucket.id);
        },
      },
      h(
        'header',
        { class: 'column-head' },
        h('h2', { class: 'column-title' }, bucket.title),
        isDone && h('span', { class: 'column-done', title: 'Tasks moved here are marked as finished' }, icon('check', 16)),
        h('span', { class: 'column-count', title: 'Tasks in this column' }, String(bucket.count)),
      ),
      h('ul', { class: 'column-cards' }, (bucket.tasks ?? []).map((t) => card(t, bucket))),
      addTaskFooter(bucket),
    );
    return col;
  };

  const newTitle = h('input', { id: 'new-bucket-title', class: 'input', placeholder: 'New column name', maxlength: 250, required: true, 'aria-label': 'New column name' });
  const addColumn = h(
    'form',
    {
      class: 'board-column board-new',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const title = newTitle.value.trim();
        if (!title) return;
        try {
          await api.createBucket(project.id, view.id, title);
          toast(`Column “${title}” added.`);
          reload();
        } catch (error) {
          toast((error as Error).message, 'error');
        }
      },
    },
    h('h2', { class: 'column-title' }, 'Add a column'),
    newTitle,
    h('button', { type: 'submit', class: 'btn primary', id: 'create-bucket' }, 'Add column'),
  );

  return h(
    'section',
    { class: 'page board-page' },
    h('div', { class: 'project-head' }, viewSwitcher(project, 'kanban')),
    h('div', { class: 'board' }, buckets.map(column), addColumn),
  );
}

function toLocalInput(iso: string): string {
  if (!api.hasDate(iso)) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A small rich-text editor: a formatting toolbar over an editable area. */
function richEditor(id: string, html: string, label: string, placeholder: string, note?: string): { root: HTMLElement; area: HTMLElement; value: () => string } {
  const area = h('div', { id, class: 'editor-area', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': label, 'data-placeholder': placeholder });
  area.append(sanitizeHtml(html));
  const syncEmpty = () => area.classList.toggle('is-empty', isBlankHtml(area.innerHTML));
  area.addEventListener('input', syncEmpty);
  syncEmpty();
  const tool = (name: string, title: string, run: () => void) =>
    h(
      'button',
      {
        type: 'button',
        class: 'tool-btn',
        title,
        'aria-label': title,
        onmousedown: (e: Event) => e.preventDefault(),
        onclick: () => {
          area.focus();
          run();
          syncEmpty();
        },
      },
      icon(name, 16),
    );
  const exec = (cmd: string, arg?: string) => () => document.execCommand(cmd, false, arg);
  const toolbar = h(
    'div',
    { class: 'editor-toolbar', role: 'toolbar', 'aria-label': `${label} formatting` },
    h('div', { class: 'tool-group' }, tool('bold', 'Bold', exec('bold')), tool('italic', 'Italic', exec('italic')), tool('underline', 'Underline', exec('underline')), tool('strike', 'Strikethrough', exec('strikeThrough'))),
    h('div', { class: 'tool-group' }, tool('heading', 'Heading', exec('formatBlock', 'h3')), tool('bullets', 'Bulleted list', exec('insertUnorderedList')), tool('numbers', 'Numbered list', exec('insertOrderedList'))),
    h('div', { class: 'tool-group' }, tool('quote', 'Quote', exec('formatBlock', 'blockquote')), tool('code', 'Code block', exec('formatBlock', 'pre')), tool('rule', 'Divider', exec('insertHorizontalRule'))),
    h('div', { class: 'tool-group' }, tool('undo', 'Undo', exec('undo')), tool('redo', 'Redo', exec('redo')), tool('eraser', 'Clear formatting', () => {
      document.execCommand('removeFormat');
      document.execCommand('formatBlock', false, 'p');
    })),
  );
  return { root: h('div', { class: 'editor' }, toolbar, area, note && h('p', { class: 'editor-note' }, note)), area, value: () => (isBlankHtml(area.innerHTML) ? '' : area.innerHTML) };
}

async function taskPage(id: number): Promise<HTMLElement> {
  const [task, comments, labels] = await Promise.all([api.getTask(id), api.listComments(id), api.listLabels()]);
  const reload = () => void render();

  const title = h('h1', { id: 'task-title', class: 'task-title-edit', contenteditable: 'plaintext-only', spellcheck: 'false', role: 'textbox', 'aria-label': 'Title' }, task.title);
  const description = richEditor('task-description', task.description, 'Description', 'Add details, links or notes', `Last changed ${formatDateTime(task.updated)}`);
  const priority = h(
    'select',
    { id: 'task-priority', class: 'input', 'aria-label': 'Priority' },
    PRIORITIES.map((p, i) => h('option', { value: String(i), selected: i === task.priority }, p)),
  );
  const due = h('input', { id: 'task-due', class: 'input', type: 'datetime-local', value: toLocalInput(task.due_date), 'aria-label': 'Due date' });

  const save = async (patch: Partial<Task>, message: string) => {
    try {
      await api.saveTask({ ...task, ...patch });
      toast(message);
      reload();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };
  const collect = (): Partial<Task> => ({
    title: (title.textContent ?? '').trim() || task.title,
    description: description.value(),
    priority: Number(priority.value),
    due_date: due.value ? new Date(due.value).toISOString() : api.ZERO_TIME,
  });

  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      title.blur();
    }
  });
  title.addEventListener('blur', () => {
    const next = (title.textContent ?? '').trim();
    if (!next) title.textContent = task.title;
    else if (next !== task.title) void save(collect(), 'Title saved.');
  });
  priority.addEventListener('change', () => void save(collect(), 'Priority saved.'));
  due.addEventListener('change', () => void save(collect(), due.value ? 'Due date saved.' : 'Due date removed.'));

  const attached = task.labels ?? [];
  const labelInput = h('input', { id: 'label-input', class: 'label-input', list: 'label-options', placeholder: 'Type to add a label', 'aria-label': 'Add a label', maxlength: 250 });
  const addLabel = async (e: Event) => {
    e.preventDefault();
    const name = labelInput.value.trim();
    if (!name) return;
    try {
      let label = labels.items.find((l) => l.title.toLowerCase() === name.toLowerCase());
      label ??= await api.createLabel(name, LABEL_COLOURS[Math.floor(Math.random() * LABEL_COLOURS.length)]!);
      if (attached.some((l) => l.id === label.id)) {
        toast('That label is already on this task.');
        return;
      }
      await api.attachLabel(task.id, label.id);
      toast(`Label “${label.title}” added.`);
      reload();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const comment = richEditor('comment-input', '', 'Comment', 'Write a comment');
  const addComment = async (e: Event) => {
    e.preventDefault();
    const html = comment.value();
    if (!html) return;
    try {
      await api.addComment(task.id, html);
      toast('Comment posted.');
      reload();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const action = (iconName: string, label: string, props: Record<string, unknown>) => h('button', { type: 'button', class: 'action-btn', ...props }, icon(iconName, 16), label);

  return h(
    'section',
    { class: 'surface task-detail' },
    h('button', { type: 'button', class: 'btn text back-btn', onclick: () => go(`#/projects/${task.project_id}`) }, icon('back', 16), 'Back to project'),
    h('div', { class: 'task-heading' }, h('div', { class: 'task-ident' }, h('span', { class: 'task-index' }, task.identifier), task.done && doneBadge()), title),
    h(
      'div',
      { class: 'task-layout' },
      h(
        'div',
        { class: 'task-main-col' },
        h(
          'div',
          { class: 'task-sub' },
          'In ',
          h('a', { href: `#/projects/${task.project_id}` }, projectTitle(task.project_id)),
          (task.buckets ?? []).map((b) => h('a', { href: `#/projects/${task.project_id}/board`, class: 'bucket-pill' }, `Board: ${b.title}`)),
          task.done && api.hasDate(task.done_at) && h('span', { class: 'small' }, `Finished ${formatDateTime(task.done_at)}`),
        ),
        h('div', { class: 'task-attrs' }, h('label', { class: 'attr' }, h('span', { class: 'attr-name' }, icon('flag', 16), 'Priority'), priority), h('label', { class: 'attr' }, h('span', { class: 'attr-name' }, icon('clock', 16), 'Due date'), due)),
        h(
          'div',
          { class: 'attr-block' },
          h('label', { class: 'attr-name', for: 'label-input' }, icon('tag', 16), 'Labels'),
          h(
            'form',
            { class: 'label-box', id: 'task-labels', onsubmit: addLabel },
            attached.map(labelBadge),
            labelInput,
            h('button', { type: 'submit', class: 'icon-btn small', id: 'add-label', 'aria-label': 'Add label' }, icon('plus', 16)),
            h(
              'datalist',
              { id: 'label-options' },
              labels.items.map((l) => h('option', { value: l.title })),
            ),
          ),
        ),
        h('h2', { class: 'section-head' }, icon('text', 20), 'Description'),
        h(
          'form',
          {
            class: 'description-form',
            onsubmit: (e: Event) => {
              e.preventDefault();
              void save(collect(), 'Changes saved.');
            },
          },
          description.root,
          h('button', { type: 'submit', class: 'btn primary', id: 'save-task' }, 'Save'),
        ),
        h('h2', { class: 'section-head comments-head' }, icon('comment', 20), `Comments (${comments.total})`),
        h(
          'ul',
          { class: 'comments', id: 'comments' },
          comments.items.map((c) =>
            h(
              'li',
              { class: 'comment' },
              h('img', { src: api.avatarUrl(c.author.username, 48), alt: '', width: 48, height: 48, class: 'avatar' }),
              h('div', { class: 'comment-body' }, h('div', { class: 'comment-head' }, h('strong', null, c.author.name || c.author.username), ' ', h('span', { class: 'muted' }, formatDateTime(c.created))), h('div', { class: 'comment-text' }, sanitizeHtml(c.comment))),
            ),
          ),
        ),
        h(
          'form',
          { class: 'comment comment-form', onsubmit: addComment },
          h('img', { src: api.avatarUrl(state.user!.username, 48), alt: '', width: 48, height: 48, class: 'avatar' }),
          h('div', { class: 'comment-new' }, comment.root, h('button', { type: 'submit', class: 'btn primary', id: 'post-comment' }, 'Comment')),
        ),
      ),
      h(
        'aside',
        { class: 'task-actions', 'aria-label': 'Task actions' },
        action(task.done ? 'back' : 'check', task.done ? 'Reopen task' : 'Mark as finished', {
          id: 'toggle-done',
          class: task.done ? 'action-btn' : 'action-btn success',
          onclick: () => void save({ ...collect(), done: !task.done }, task.done ? 'Task reopened.' : 'Marked as finished.'),
        }),
        action('link', 'Copy link', {
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(location.href);
              toast('Link copied.');
            } catch {
              toast('The link could not be copied. Copy it from the address bar instead.', 'error');
            }
          },
        }),
        action('board', 'Open board', { onclick: () => go(`#/projects/${task.project_id}/board`) }),
        action('trash', 'Delete', {
          id: 'delete-task',
          class: 'action-btn danger',
          onclick: async () => {
            if (!confirm('Delete this task for good?')) return;
            try {
              await api.deleteTask(task.id);
              toast('Task deleted.');
              go(`#/projects/${task.project_id}`);
            } catch (error) {
              toast((error as Error).message, 'error');
            }
          },
        }),
      ),
    ),
  );
}

async function labelsPage(): Promise<HTMLElement> {
  const labels = await api.listLabels();
  const name = h('input', { id: 'new-label-title', class: 'input', placeholder: 'Label name', maxlength: 250, required: true, 'aria-label': 'Label name' });
  return h(
    'section',
    { class: 'page labels' },
    pageTitle('Labels'),
    h('p', { class: 'muted' }, 'Labels group tasks across projects. Add them to a task from its page, or create one here.'),
    h(
      'form',
      {
        class: 'inline-form',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const title = name.value.trim();
          if (!title) return;
          try {
            await api.createLabel(title, LABEL_COLOURS[Math.floor(Math.random() * LABEL_COLOURS.length)]!);
            toast(`Label “${title}” created.`);
            void render();
          } catch (error) {
            toast((error as Error).message, 'error');
          }
        },
      },
      name,
      h('button', { type: 'submit', class: 'btn primary', id: 'create-label' }, 'Create label'),
    ),
    labels.items.length ? h('div', { class: 'surface label-cloud' }, labels.items.map(labelBadge)) : emptyState('No labels yet', 'Create one above or add one to a task.'),
  );
}

async function searchPage(query: URLSearchParams): Promise<HTMLElement> {
  const q = query.get('q') ?? '';
  const input = h('input', { type: 'search', id: 'search-input', class: 'input', value: q, placeholder: 'Search task titles', 'aria-label': 'Search', autofocus: true });
  const page = q ? await api.searchTasks({ q, sort: [['done', 'asc'], ['id', 'asc']] }) : null;
  return h(
    'section',
    { class: 'page search' },
    pageTitle('Find tasks'),
    h(
      'form',
      {
        class: 'inline-form search-form',
        role: 'search',
        onsubmit: (e: Event) => {
          e.preventDefault();
          go(`#/search?q=${encodeURIComponent(input.value.trim())}`);
        },
      },
      input,
      h('button', { type: 'submit', class: 'btn primary', id: 'search-submit' }, icon('search', 16), 'Search'),
    ),
    page &&
      h(
        'div',
        { id: 'search-results' },
        h('p', { class: 'muted count-line' }, page.total === 1 ? 'One match.' : `${page.total} matches.`),
        page.items.length ? taskList(page.items, { showProject: true, onChange: () => void render() }) : emptyState(`Nothing matches “${q}”`, 'Try a shorter or different word.'),
      ),
  );
}

// ---- start --------------------------------------------------------------------------------

window.addEventListener('hashchange', () => void render());
void render();
