// The /api/v2 routes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  accessTokenTtl,
  authenticate,
  createSession,
  endSession,
  hashPassword,
  LONG_TOKEN_SECONDS,
  rateLimit,
  REFRESH_COOKIE,
  REFRESH_SECONDS,
  refreshCookie,
  rotateSession,
  signToken,
  type UserRow,
  verifyPassword,
} from './auth.ts';
import { all, nowIso, one, run } from './db.ts';
import { avatarSvg } from './avatar.ts';
import { cookies, ErrorCode, fail, HttpError, isObject, originOf, readBody, sendEmpty, sendJson, sendText } from './http.ts';
import { applyPatch } from './patch.ts';
import {
  bucketOfView,
  bucketsOf,
  type BucketRow,
  type CommentRow,
  createBucket,
  createProject,
  createTasks,
  deleteTask,
  filtersOf,
  fullUser,
  type LabelRow,
  ownedFilter,
  ownedProject,
  ownedTask,
  projectsOf,
  queryTasks,
  registerUser,
  serializeBucket,
  serializeComment,
  serializeFilterProject,
  serializeLabel,
  serializeProject,
  serializeTask,
  shortUser,
  type TaskInput,
  moveTaskToBucket,
  type TaskQuery,
  type TaskRow,
  setTaskPosition,
  touchTask,
  updateTask,
  type ViewRow,
} from './model.ts';

export const API_PREFIX = '/api/v2';
export const VERSION = '0.1.0';
const MAX_PER_PAGE = 50;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  origin: string;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
const route = (method: string, path: string, handler: Handler) => {
  const pattern = new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`);
  routes.push({ method, pattern, handler });
};

const schema = (ctx: Ctx, name: string) => `${ctx.origin}${API_PREFIX}/schemas/${name}.json`;

function intParam(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^-?\d+$/.test(raw)) fail(400, `"${name}" must be a number.`);
  return Number(raw);
}

function pageParams(url: URL, defaultPerPage = MAX_PER_PAGE): { page: number; perPage: number } {
  const rawPage = url.searchParams.get('page');
  const rawPer = url.searchParams.get('per_page');
  const page = rawPage && /^\d+$/.test(rawPage) && Number(rawPage) > 0 ? Number(rawPage) : 1;
  let perPage = rawPer && /^\d+$/.test(rawPer) && Number(rawPer) > 0 ? Number(rawPer) : defaultPerPage;
  if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
  return { page, perPage };
}

function envelope<T>(ctx: Ctx, name: string, items: T[], page: number, perPage: number, total = items.length, alreadySliced = false) {
  const slice = alreadySliced ? items : items.slice((page - 1) * perPage, page * perPage);
  return { $schema: schema(ctx, name), items: slice, total, page, per_page: perPage, total_pages: total === 0 ? 0 : Math.ceil(total / perPage) };
}

async function jsonBody(ctx: Ctx): Promise<Record<string, unknown>> {
  const body = await readBody(ctx.req);
  if (!isObject(body)) fail(400, 'Expected a JSON object in the request body.');
  return body;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

// ---- public ---------------------------------------------------------------------------

route('GET', '/info', (ctx) => {
  // Feature switches mirror the recorded server (the parity check compares every boolean); see README.
  sendJson(ctx.res, 200, {
    $schema: schema(ctx, 'ServerInfo'),
    version: VERSION,
    frontend_url: `${ctx.origin}/`,
    motd: '',
    link_sharing_enabled: true,
    max_file_size: '0MB',
    max_items_per_page: MAX_PER_PAGE,
    available_migrators: [],
    task_attachments_enabled: true,
    enabled_background_providers: [],
    totp_enabled: true,
    legal: { imprint_url: '', privacy_policy_url: '' },
    caldav_enabled: true,
    auth: { local: { enabled: true, registration_enabled: true }, ldap: { enabled: false }, openid_connect: { enabled: false, providers: null } },
    email_reminders_enabled: true,
    user_deletion_enabled: true,
    task_comments_enabled: true,
    demo_mode_enabled: false,
    webhooks_enabled: true,
    public_teams_enabled: false,
    allow_icon_changes: false,
    enabled_pro_features: [],
    concurrent_writes: false,
  });
});

route('GET', '/avatar/:name', (ctx) => {
  const size = Math.min(1024, Math.max(8, Number(ctx.url.searchParams.get('size')) || 64));
  sendText(ctx.res, 200, 'image/svg+xml', avatarSvg(decodeURIComponent(ctx.params[0]!), size), { 'Cache-Control': 'public, max-age=3600' });
});

route('POST', '/register', async (ctx) => {
  const body = await jsonBody(ctx);
  const username = str(body.username).trim();
  const email = str(body.email).trim();
  const password = str(body.password);
  const language = str(body.language, 'en') || 'en';
  if (!username || username.length > 250 || /\s/.test(username)) fail(400, 'Choose a username without spaces (up to 250 characters).');
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(400, 'Enter a valid email address.');
  if (password.length < 8 || password.length > 250) fail(400, 'The password needs at least 8 characters.');
  if (one('SELECT id FROM users WHERE username = ?', username)) fail(400, 'Someone already uses that username. Please pick a different one.', ErrorCode.UsernameTaken);
  if (one('SELECT id FROM users WHERE lower(email) = lower(?)', email)) fail(400, 'That email address is already registered.');
  const user = registerUser({ username, email, passwordHash: hashPassword(password), language });
  sendJson(ctx.res, 201, { $schema: schema(ctx, 'User'), ...shortUser(user) });
});

route('POST', '/login', async (ctx) => {
  const limit = rateLimit(`login:${ctx.req.socket.remoteAddress ?? ''}`);
  ctx.res.setHeader('X-Ratelimit-Limit', String(limit.limit));
  ctx.res.setHeader('X-Ratelimit-Remaining', String(limit.remaining));
  ctx.res.setHeader('X-Ratelimit-Reset', String(limit.reset));
  if (!limit.allowed) fail(429, 'Too many sign-in attempts. Please wait a minute.');
  const body = await jsonBody(ctx);
  const username = str(body.username).trim();
  const password = str(body.password);
  const user = one<UserRow>('SELECT * FROM users WHERE username = ? OR lower(email) = lower(?)', username, username);
  if (!user || !verifyPassword(password, user.password_hash)) fail(403, 'That username and password do not match an account.', ErrorCode.WrongCredentials);
  const longLived = body.long_token === true;
  const { sid, refresh } = createSession(user.id, longLived);
  ctx.res.setHeader('Set-Cookie', refreshCookie(refresh, REFRESH_SECONDS));
  sendJson(ctx.res, 200, { $schema: schema(ctx, 'Token'), token: signToken(user, sid, longLived ? LONG_TOKEN_SECONDS : accessTokenTtl()) });
});

route('POST', '/user/token/refresh', (ctx) => {
  const raw = cookies(ctx.req).get(REFRESH_COOKIE);
  const next = raw ? rotateSession(raw) : undefined;
  if (!next) {
    ctx.res.setHeader('Set-Cookie', refreshCookie('', 0));
    fail(401, 'No valid session to refresh. Please sign in again.');
  }
  const user = one<UserRow>('SELECT * FROM users WHERE id = ?', next.userId);
  if (!user) fail(401, 'The account no longer exists.');
  ctx.res.setHeader('Set-Cookie', refreshCookie(next.refresh, REFRESH_SECONDS));
  sendJson(ctx.res, 200, { $schema: schema(ctx, 'Token'), token: signToken(user, next.sid, next.longLived ? LONG_TOKEN_SECONDS : accessTokenTtl()) });
});

// ---- authenticated ----------------------------------------------------------------------

route('POST', '/logout', (ctx) => {
  const { claims } = authenticate(ctx.req);
  endSession(claims.sid);
  ctx.res.setHeader('Set-Cookie', refreshCookie('', 0));
  sendJson(ctx.res, 200, { $schema: schema(ctx, 'Message'), message: 'You are now signed out.' });
});

route('GET', '/user', (ctx) => {
  const { user } = authenticate(ctx.req);
  sendJson(ctx.res, 200, { $schema: schema(ctx, 'CurrentUser'), ...fullUser(user) });
});

route('GET', '/notifications', (ctx) => {
  authenticate(ctx.req);
  const { page, perPage } = pageParams(ctx.url);
  sendJson(ctx.res, 200, envelope(ctx, 'PaginatedNotification', [], page, perPage));
});

// projects

route('GET', '/projects', (ctx) => {
  const { user } = authenticate(ctx.req);
  const { page, perPage } = pageParams(ctx.url);
  const includeArchived = ctx.url.searchParams.get('is_archived') === 'true';
  const projects = projectsOf(user, includeArchived);
  const items: unknown[] = projects.slice((page - 1) * perPage, page * perPage).map((p) => serializeProject(p));
  // Saved filters appear as pseudo projects (negative ids) after the real ones, on the first page.
  if (page === 1) items.push(...filtersOf(user).map(serializeFilterProject));
  sendJson(ctx.res, 200, envelope(ctx, 'PaginatedProject', items, page, perPage, projects.length, true));
});

route('POST', '/projects', async (ctx) => {
  const { user } = authenticate(ctx.req);
  const body = await jsonBody(ctx);
  const title = str(body.title).trim();
  if (!title) fail(400, 'A project needs a title.');
  if (title.length > 250) fail(400, 'The project title is too long (250 characters at most).');
  const parent = typeof body.parent_project_id === 'number' ? body.parent_project_id : 0;
  if (parent) ownedProject(user, parent);
  const identifier = str(body.identifier).trim();
  if (identifier.length > 10) fail(400, 'The identifier can have at most 10 characters.');
  const id = createProject(user.id, {
    title,
    description: str(body.description),
    identifier,
    hex_color: str(body.hex_color).replace(/^#/, ''),
    parent_project_id: parent,
    is_archived: body.is_archived === true,
    is_favorite: body.is_favorite === true,
    position: typeof body.position === 'number' ? body.position : 0,
  });
  sendJson(ctx.res, 201, { $schema: schema(ctx, 'Project'), ...serializeProject(ownedProject(user, id), null) });
});

route('GET', '/projects/:id', (ctx) => {
  const { user } = authenticate(ctx.req);
  const id = intParam(ctx.params[0], 'projectId');
  const body = id < 0 ? serializeFilterProject(ownedFilter(user, id)) : serializeProject(ownedProject(user, id));
  sendJson(ctx.res, 200, { $schema: schema(ctx, 'Project'), ...body });
});

function viewOf(user: UserRow, projectRaw: string | undefined, viewRaw: string | undefined): { view: ViewRow; projectIds?: number[]; savedFilter?: string } {
  const projectId = intParam(projectRaw, 'projectId');
  const viewId = intParam(viewRaw, 'viewId');
  let savedFilter: string | undefined;
  let projectIds: number[] | undefined;
  if (projectId < 0) savedFilter = ownedFilter(user, projectId).filter;
  else projectIds = [ownedProject(user, projectId).id];
  const view = one<ViewRow>('SELECT * FROM views WHERE id = ? AND project_id = ?', viewId, projectId);
  if (!view) fail(404, 'The view does not exist in this project.');
  return { view, ...(projectIds ? { projectIds } : {}), ...(savedFilter !== undefined ? { savedFilter } : {}) };
}

function taskQueryFrom(url: URL): TaskQuery {
  const sp = url.searchParams;
  return {
    filter: sp.get('filter') ?? '',
    includeNulls: sp.get('filter_include_nulls') === 'true',
    q: sp.get('q') ?? sp.get('s') ?? '',
    sortBy: sp.getAll('sort_by'),
    orderBy: sp.getAll('order_by'),
  };
}

const expands = (url: URL) => new Set(url.searchParams.getAll('expand').flatMap((e) => e.split(',')));

/** Tasks of a view, filtered by the view's own filter and the request's filter, q and sort parameters. */
function viewTaskQuery(ctx: Ctx, user: UserRow, view: ViewRow, projectIds: number[] | undefined, savedFilter: string | undefined): TaskRow[] {
  const query = taskQueryFrom(ctx.url);
  const viewFilter = view.filter ? (JSON.parse(view.filter) as { filter?: string; filter_include_nulls?: boolean }) : undefined;
  const base: TaskQuery = {
    ...query,
    ...(projectIds ? { projectIds } : {}),
    viewId: view.id,
    sortBy: query.sortBy.length ? query.sortBy : ['position'],
  };
  if (viewFilter?.filter) base.viewFilter = { filter: viewFilter.filter, includeNulls: viewFilter.filter_include_nulls === true };
  else if (savedFilter) base.viewFilter = { filter: savedFilter, includeNulls: false };
  return queryTasks(user, base);
}

/** A board's columns in position order, each with its matching tasks (no `tasks` key when it has none). */
function bucketsWithTasks(ctx: Ctx, user: UserRow, view: ViewRow, tasks: TaskRow[], page: number, perPage: number) {
  const placement = new Map(all<{ task_id: number; bucket_id: number }>('SELECT task_id, bucket_id FROM task_buckets WHERE project_view_id = ?', view.id).map((r) => [r.task_id, r.bucket_id]));
  const commentCount = expands(ctx.url).has('comment_count');
  return bucketsOf(view.id).map((b) => {
    const inBucket = tasks.filter((t) => (placement.get(t.id) ?? view.default_bucket_id) === b.id).slice((page - 1) * perPage, page * perPage);
    const bucket: Record<string, unknown> = serializeBucket(b, true);
    if (inBucket.length) bucket.tasks = inBucket.map((t) => serializeTask(t, { viewId: view.id, commentCount, userId: user.id, bucketId: b.id }));
    return bucket;
  });
}

function kanbanView(user: UserRow, projectRaw: string | undefined, viewRaw: string | undefined) {
  const found = viewOf(user, projectRaw, viewRaw);
  if (found.view.view_kind !== 'kanban') fail(400, 'Only board views have columns.');
  return found;
}

route('GET', '/projects/:id/views/:view/tasks', (ctx) => {
  const { user } = authenticate(ctx.req);
  const { view, projectIds, savedFilter } = viewOf(user, ctx.params[0], ctx.params[1]);
  const { page, perPage } = pageParams(ctx.url);
  const tasks = viewTaskQuery(ctx, user, view, projectIds, savedFilter);
  if (view.view_kind === 'kanban') {
    // Board views answer with their columns, each holding the matching tasks it contains.
    const buckets = bucketsWithTasks(ctx, user, view, tasks, 1, perPage);
    sendJson(ctx.res, 200, envelope(ctx, 'PaginatedBucketWithTasks', buckets, page, perPage));
    return;
  }
  const shape = { viewId: view.id, commentCount: expands(ctx.url).has('comment_count'), userId: user.id };
  const slice = tasks.slice((page - 1) * perPage, page * perPage).map((t) => serializeTask(t, shape));
  sendJson(ctx.res, 200, envelope(ctx, 'PaginatedTask', slice, page, perPage, tasks.length, true));
});

route('GET', '/projects/:id/views/:view/buckets', (ctx) => {
  const { user } = authenticate(ctx.req);
  const { view } = viewOf(user, ctx.params[0], ctx.params[1]);
  const { page, perPage } = pageParams(ctx.url);
  const buckets: BucketRow[] = view.view_kind === 'kanban' ? bucketsOf(view.id) : [];
  sendJson(ctx.res, 200, envelope(ctx, 'PaginatedBucket', buckets.map((b) => serializeBucket(b, true)), page, perPage));
});

route('POST', '/projects/:id/views/:view/buckets', async (ctx) => {
  const { user } = authenticate(ctx.req);
  const { view } = kanbanView(user, ctx.params[0], ctx.params[1]);
  const body = await jsonBody(ctx);
  const title = str(body.title).trim();
  if (!title) fail(400, 'A column needs a title.');
  if (title.length > 250) fail(400, 'The column title is too long (250 characters at most).');
  sendJson(ctx.res, 201, { $schema: schema(ctx, 'Bucket'), ...serializeBucket(createBucket(user, view, title), true) });
});

route('GET', '/projects/:id/views/:view/buckets/tasks', (ctx) => {
  const { user } = authenticate(ctx.req);
  const { view, projectIds, savedFilter } = kanbanView(user, ctx.params[0], ctx.params[1]);
  const { page, perPage } = pageParams(ctx.url, 25);
  const tasks = viewTaskQuery(ctx, user, view, projectIds, savedFilter);
  const items = bucketsWithTasks(ctx, user, view, tasks, page, perPage);
  sendJson(ctx.res, 200, { $schema: schema(ctx, 'BucketsWithTasks'), items, total: items.length });
});

route('PUT', '/projects/:id/views/:view/buckets/:bucket/tasks', async (ctx) => {
  const { user } = authenticate(ctx.req);
  const { view } = kanbanView(user, ctx.params[0], ctx.params[1]);
  const bucket = bucketOfView(view, intParam(ctx.params[2], 'bucketId'));
  const body = await jsonBody(ctx);
  if (typeof body.task_id !== 'number' || !Number.isInteger(body.task_id)) fail(400, '"task_id" must be a task id.');
  const moved = moveTaskToBucket(user, view, bucket, ownedTask(user, body.task_id));
  sendJson(ctx.res, 200, {
    $schema: schema(ctx, 'TaskBucket'),
    bucket_id: bucket.id,
    bucket: serializeBucket(bucket, false),
    task_id: moved.id,
    project_view_id: view.id,
    task: serializeTask(moved, { single: true, buckets: false, userId: user.id }),
  });
});

route('POST', '/projects/:id/tasks/bulk', async (ctx) => {
  const { user } = authenticate(ctx.req);
  const project = ownedProject(user, intParam(ctx.params[0], 'projectId'));
  const body = await jsonBody(ctx);
  if (!Array.isArray(body.tasks) || body.tasks.length === 0) fail(400, 'Send at least one task in "tasks".');
  if (body.tasks.length > 100) fail(400, 'At most 100 tasks can be created at once.');
  const inputs = body.tasks.map((t) => {
    if (!isObject(t)) fail(400, 'Each entry in "tasks" must be an object.');
    return t as TaskInput;
  });
  const created = createTasks(user, project.id, inputs);
  sendJson(ctx.res, 201, { tasks: created.map((t) => serializeTask(t, { relatedNull: true, userId: user.id })) });
});

// tasks

route('GET', '/tasks', (ctx) => {
  const { user } = authenticate(ctx.req);
  const { page, perPage } = pageParams(ctx.url);
  const tasks = queryTasks(user, taskQueryFrom(ctx.url));
  const shape = { commentCount: expands(ctx.url).has('comment_count'), userId: user.id };
  const slice = tasks.slice((page - 1) * perPage, page * perPage).map((t) => serializeTask(t, shape));
  sendJson(ctx.res, 200, envelope(ctx, 'PaginatedTask', slice, page, perPage, tasks.length, true));
});

route('GET', '/tasks/:id', (ctx) => {
  const { user } = authenticate(ctx.req);
  const task = ownedTask(user, intParam(ctx.params[0], 'taskId'));
  const exp = expands(ctx.url);
  sendJson(ctx.res, 200, { $schema: schema(ctx, 'Task'), ...serializeTask(task, { single: true, commentCount: exp.has('comment_count'), userId: user.id }) });
});

route('PATCH', '/tasks/:id', async (ctx) => {
  const { user } = authenticate(ctx.req);
  const task = ownedTask(user, intParam(ctx.params[0], 'taskId'));
  const body = await readBody(ctx.req);
  const current = serializeTask(task, { single: true, buckets: false, userId: user.id });
  let next: Record<string, unknown>;
  if (Array.isArray(body)) next = applyPatch(current, body);
  else if (isObject(body)) next = { ...current, ...body };
  else fail(400, 'Send a JSON Patch document (an array of operations).');
  const input: TaskInput = {};
  for (const key of ['title', 'description', 'done', 'due_date', 'start_date', 'end_date', 'priority', 'percent_done', 'hex_color', 'repeat_after', 'repeat_mode', 'is_favorite', 'cover_image_attachment_id', 'project_id'] as const) {
    if (next[key] !== current[key]) input[key] = next[key];
  }
  const updated = updateTask(user, task, input);
  sendJson(ctx.res, 200, serializeTask(updated, { single: true, buckets: false, userId: user.id }));
});

route('DELETE', '/tasks/:id', (ctx) => {
  const { user } = authenticate(ctx.req);
  deleteTask(ownedTask(user, intParam(ctx.params[0], 'taskId')));
  sendEmpty(ctx.res, 204);
});

route('PUT', '/tasks/:id/position', async (ctx) => {
  const { user } = authenticate(ctx.req);
  const task = ownedTask(user, intParam(ctx.params[0], 'taskId'));
  const body = await jsonBody(ctx);
  if (typeof body.project_view_id !== 'number' || !Number.isInteger(body.project_view_id)) fail(400, '"project_view_id" must be a view id.');
  if (typeof body.position !== 'number' || !Number.isFinite(body.position)) fail(400, '"position" must be a number.');
  const view = one<ViewRow>('SELECT * FROM views WHERE id = ?', body.project_view_id);
  if (!view) fail(404, 'There is no view with that id.');
  const position = setTaskPosition(task, view, body.position);
  sendJson(ctx.res, 200, { $schema: schema(ctx, 'TaskPosition'), task_id: task.id, project_view_id: view.id, position });
});

route('GET', '/tasks/:id/comments', (ctx) => {
  const { user } = authenticate(ctx.req);
  const task = ownedTask(user, intParam(ctx.params[0], 'taskId'));
  const { page, perPage } = pageParams(ctx.url);
  const desc = (ctx.url.searchParams.get('order_by') ?? 'asc').toLowerCase() === 'desc';
  const rows = all<CommentRow>(`SELECT * FROM comments WHERE task_id = ? ORDER BY created ${desc ? 'DESC' : 'ASC'}, id ${desc ? 'DESC' : 'ASC'}`, task.id);
  sendJson(ctx.res, 200, envelope(ctx, 'PaginatedComment', rows.map(serializeComment), page, perPage));
});

route('POST', '/tasks/:id/comments', async (ctx) => {
  const { user } = authenticate(ctx.req);
  const task = ownedTask(user, intParam(ctx.params[0], 'taskId'));
  const body = await jsonBody(ctx);
  const comment = str(body.comment);
  if (!comment.trim()) fail(400, 'A comment cannot be empty.');
  if (comment.length > 20000) fail(400, 'The comment is too long.');
  const now = nowIso();
  const id = run('INSERT INTO comments (task_id, author_id, comment, created, updated) VALUES (?, ?, ?, ?, ?)', task.id, user.id, comment, now, now);
  sendJson(ctx.res, 201, serializeComment(one<CommentRow>('SELECT * FROM comments WHERE id = ?', id)!));
});

route('POST', '/tasks/:id/labels', async (ctx) => {
  const { user } = authenticate(ctx.req);
  const task = ownedTask(user, intParam(ctx.params[0], 'taskId'));
  const body = await jsonBody(ctx);
  if (typeof body.label_id !== 'number') fail(400, '"label_id" must be a number.');
  const label = one<LabelRow>('SELECT * FROM labels WHERE id = ?', body.label_id);
  if (!label) fail(404, 'The label does not exist.');
  if (label.created_by !== user.id) fail(403, 'You do not have access to this label.');
  if (one('SELECT id FROM label_tasks WHERE label_id = ? AND task_id = ?', label.id, task.id)) fail(400, 'The task already has this label.');
  const now = nowIso();
  run('INSERT INTO label_tasks (label_id, task_id, created) VALUES (?, ?, ?)', label.id, task.id, now);
  touchTask(task.id);
  sendJson(ctx.res, 201, { label_id: label.id, created: now });
});

// labels

route('GET', '/labels', (ctx) => {
  const { user } = authenticate(ctx.req);
  const { page, perPage } = pageParams(ctx.url);
  const s = (ctx.url.searchParams.get('s') ?? '').toLowerCase();
  const rows = all<LabelRow>('SELECT * FROM labels WHERE created_by = ? ORDER BY id', user.id).filter((l) => !s || l.title.toLowerCase().includes(s));
  sendJson(ctx.res, 200, envelope(ctx, 'PaginatedLabel', rows.map(serializeLabel), page, perPage));
});

route('POST', '/labels', async (ctx) => {
  const { user } = authenticate(ctx.req);
  const body = await jsonBody(ctx);
  const title = str(body.title).trim();
  if (!title) fail(400, 'A label needs a title.');
  if (title.length > 250) fail(400, 'The label title is too long.');
  const hex = str(body.hex_color).replace(/^#/, '');
  if (hex && !/^([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(hex)) fail(400, '"hex_color" must be a hex colour.');
  const now = nowIso();
  const id = run('INSERT INTO labels (title, description, hex_color, created_by, created, updated) VALUES (?, ?, ?, ?, ?, ?)', title, str(body.description), hex, user.id, now, now);
  sendJson(ctx.res, 201, serializeLabel(one<LabelRow>('SELECT * FROM labels WHERE id = ?', id)!));
});

// ---- dispatch ---------------------------------------------------------------------------

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname.slice(API_PREFIX.length) || '/';
  let methodMismatch = false;
  for (const r of routes) {
    const m = path.match(r.pattern);
    if (!m) continue;
    if (r.method !== req.method) {
      methodMismatch = true;
      continue;
    }
    await r.handler({ req, res, url, params: m.slice(1), origin: originOf(req) });
    return;
  }
  if (methodMismatch) throw new HttpError(405, 'This method is not allowed here.');
  throw new HttpError(404, 'Not found.');
}
