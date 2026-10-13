// Domain operations and the JSON shapes the API returns.

import type { UserRow } from './auth.ts';
import { all, normalizeDate, nowIso, one, run, tx, ZERO_TIME } from './db.ts';
import { evaluate, FilterError, FilterValueError, parseFilter, validateFilter, type FilterSubject, type Node } from './filter.ts';
import { ErrorCode, fail, HttpError } from './http.ts';

// ---- rows -----------------------------------------------------------------------------

export interface ProjectRow {
  id: number;
  title: string;
  description: string;
  identifier: string;
  hex_color: string;
  parent_project_id: number;
  owner_id: number;
  is_archived: number;
  is_favorite: number;
  position: number;
  created: string;
  updated: string;
}

export interface FilterRow {
  id: number;
  owner_id: number;
  title: string;
  description: string;
  filter: string;
  created: string;
  updated: string;
}

export interface ViewRow {
  id: number;
  project_id: number;
  title: string;
  view_kind: string;
  filter: string | null;
  position: number;
  bucket_configuration_mode: string;
  default_bucket_id: number;
  done_bucket_id: number;
  created: string;
  updated: string;
}

export interface BucketRow {
  id: number;
  project_view_id: number;
  title: string;
  limit: number;
  position: number;
  created_by: number;
  created: string;
  updated: string;
}

export interface TaskRow {
  id: number;
  project_id: number;
  title: string;
  description: string;
  done: number;
  done_at: string;
  due_date: string;
  start_date: string;
  end_date: string;
  priority: number;
  percent_done: number;
  hex_color: string;
  repeat_after: number;
  repeat_mode: number;
  is_favorite: number;
  cover_image_attachment_id: number;
  index: number;
  created_by: number;
  created: string;
  updated: string;
}

export interface LabelRow {
  id: number;
  title: string;
  description: string;
  hex_color: string;
  created_by: number;
  created: string;
  updated: string;
}

export interface CommentRow {
  id: number;
  task_id: number;
  author_id: number;
  comment: string;
  created: string;
  updated: string;
}

// ---- wording of default records (this product's own) ---------------------------------

const DEFAULT_PROJECT_TITLE = 'Personal';
const OPEN_FILTER_TITLE = 'Everything open';
const VIEW_SPECS: { title: string; kind: string; position: number }[] = [
  { title: 'List', kind: 'list', position: 100 },
  { title: 'Timeline', kind: 'gantt', position: 200 },
  { title: 'Grid', kind: 'table', position: 300 },
  { title: 'Board', kind: 'kanban', position: 400 },
];
const BUCKET_TITLES = ['Backlog', 'Underway', 'Finished'];
const LIST_VIEW_FILTER = { s: '', sort_by: null, order_by: null, filter: 'done = false', filter_include_nulls: false };

export const PROJECT_POSITION_STEP = 65536;
export const TASK_POSITION_START = 65536;
export const MAX_PERMISSION_ADMIN = 2;

// ---- users ----------------------------------------------------------------------------

export interface ShortUser {
  id: number;
  name: string;
  username: string;
  created: string;
  updated: string;
}

export function shortUser(u: UserRow): ShortUser {
  return { id: u.id, name: u.name, username: u.username, created: u.created, updated: u.updated };
}

const userCache = new Map<number, UserRow>();
export function userById(id: number): UserRow | undefined {
  const cached = userCache.get(id);
  if (cached) return cached;
  const u = one<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (u) userCache.set(id, u);
  return u;
}
export function forgetUser(id: number): void {
  userCache.delete(id);
}

function shortUserById(id: number): ShortUser | null {
  const u = userById(id);
  return u ? shortUser(u) : null;
}

export function fullUser(u: UserRow) {
  return {
    ...shortUser(u),
    settings: {
      name: u.name,
      email_reminders_enabled: false,
      discoverable_by_name: false,
      discoverable_by_email: false,
      overdue_tasks_reminders_enabled: true,
      overdue_tasks_reminders_time: '9:00',
      default_project_id: u.default_project_id,
      week_start: u.week_start,
      language: u.language,
      timezone: u.timezone,
      frontend_settings: null,
      extra_settings_links: null,
    },
    deletion_scheduled_at: ZERO_TIME,
    is_local_user: true,
    auth_provider: 'local',
    is_admin: false,
  };
}

/** Creates the account, its default project and its "everything open" saved filter. */
export function registerUser(input: { username: string; email: string; passwordHash: string; language: string }): UserRow {
  return tx(() => {
    const now = nowIso();
    const id = run('INSERT INTO users (username, email, password_hash, language, created, updated) VALUES (?, ?, ?, ?, ?, ?)', input.username, input.email, input.passwordHash, input.language, now, now);
    const projectId = insertProject(id, { title: DEFAULT_PROJECT_TITLE });
    run('UPDATE users SET default_project_id = ? WHERE id = ?', projectId, id);
    insertSavedFilter(id, OPEN_FILTER_TITLE, 'done = false');
    return one<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
  });
}

// ---- projects and views ---------------------------------------------------------------

function insertViews(projectId: number, ownerId: number, listFilter: object | null): void {
  const now = nowIso();
  for (const spec of VIEW_SPECS) {
    const filter = spec.kind === 'list' && listFilter ? JSON.stringify(listFilter) : null;
    const mode = spec.kind === 'kanban' ? 'manual' : 'none';
    const viewId = run(
      'INSERT INTO views (project_id, title, view_kind, filter, position, bucket_configuration_mode, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      projectId,
      spec.title,
      spec.kind,
      filter,
      spec.position,
      mode,
      now,
      now,
    );
    if (spec.kind === 'kanban') {
      const ids = BUCKET_TITLES.map((title, i) => run('INSERT INTO buckets (project_view_id, title, position, created_by, created, updated) VALUES (?, ?, ?, ?, ?, ?)', viewId, title, (i + 1) * 100, ownerId, now, now));
      run('UPDATE views SET default_bucket_id = ?, done_bucket_id = ? WHERE id = ?', ids[0]!, ids[2]!, viewId);
    }
  }
}

export interface ProjectInput {
  title: string;
  description?: string;
  identifier?: string;
  hex_color?: string;
  parent_project_id?: number;
  is_archived?: boolean;
  is_favorite?: boolean;
  position?: number;
}

export function insertProject(ownerId: number, input: ProjectInput): number {
  const now = nowIso();
  const maxPos = one<{ m: number | null }>('SELECT MAX(position) AS m FROM projects WHERE owner_id = ?', ownerId)?.m ?? 0;
  const position = input.position && input.position > 0 ? input.position : maxPos + PROJECT_POSITION_STEP;
  const id = run(
    'INSERT INTO projects (title, description, identifier, hex_color, parent_project_id, owner_id, is_archived, is_favorite, position, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    input.title,
    input.description ?? '',
    input.identifier ?? '',
    input.hex_color ?? '',
    input.parent_project_id ?? 0,
    ownerId,
    input.is_archived ?? false,
    input.is_favorite ?? false,
    position,
    now,
    now,
  );
  insertViews(id, ownerId, LIST_VIEW_FILTER);
  return id;
}

export function createProject(ownerId: number, input: ProjectInput): number {
  return tx(() => insertProject(ownerId, input));
}

function insertSavedFilter(ownerId: number, title: string, filter: string): number {
  const now = nowIso();
  const id = run('INSERT INTO saved_filters (owner_id, title, filter, created, updated) VALUES (?, ?, ?, ?, ?)', ownerId, title, filter, now, now);
  insertViews(filterProjectId(id), ownerId, null);
  return id;
}

export const filterProjectId = (filterId: number) => -(filterId + 1);
export const projectFilterId = (projectId: number) => -projectId - 1;

export function serializeView(v: ViewRow) {
  return {
    id: v.id,
    title: v.title,
    project_id: v.project_id,
    view_kind: v.view_kind,
    filter: v.filter ? (JSON.parse(v.filter) as object) : null,
    position: v.position,
    bucket_configuration_mode: v.bucket_configuration_mode,
    bucket_configuration: null,
    default_bucket_id: v.default_bucket_id,
    done_bucket_id: v.done_bucket_id,
    updated: v.updated,
    created: v.created,
  };
}

export function viewsOf(projectId: number): ViewRow[] {
  return all<ViewRow>('SELECT * FROM views WHERE project_id = ? ORDER BY position, id', projectId);
}

export function serializeProject(p: ProjectRow, maxPermission: number | null = MAX_PERMISSION_ADMIN) {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    identifier: p.identifier,
    hex_color: p.hex_color,
    parent_project_id: p.parent_project_id,
    owner: shortUserById(p.owner_id),
    is_archived: p.is_archived === 1,
    background_information: null,
    background_blur_hash: '',
    is_favorite: p.is_favorite === 1,
    position: p.position,
    views: viewsOf(p.id).map(serializeView),
    max_permission: maxPermission,
    created: p.created,
    updated: p.updated,
  };
}

export function serializeFilterProject(f: FilterRow) {
  const id = filterProjectId(f.id);
  return {
    id,
    title: f.title,
    description: f.description,
    identifier: '',
    hex_color: '',
    parent_project_id: 0,
    owner: shortUserById(f.owner_id),
    is_archived: false,
    background_information: null,
    background_blur_hash: '',
    is_favorite: false,
    position: 0,
    views: viewsOf(id).map(serializeView),
    max_permission: MAX_PERMISSION_ADMIN,
    created: f.created,
    updated: f.updated,
  };
}

export function ownedProject(user: UserRow, id: number): ProjectRow {
  const p = one<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
  if (!p) fail(404, 'The project does not exist.');
  if (p.owner_id !== user.id) fail(403, 'You do not have access to this project.');
  return p;
}

export function ownedFilter(user: UserRow, projectId: number): FilterRow {
  const f = one<FilterRow>('SELECT * FROM saved_filters WHERE id = ?', projectFilterId(projectId));
  if (!f) fail(404, 'The project does not exist.');
  if (f.owner_id !== user.id) fail(403, 'You do not have access to this project.');
  return f;
}

export function projectsOf(user: UserRow, includeArchived: boolean): ProjectRow[] {
  return all<ProjectRow>(`SELECT * FROM projects WHERE owner_id = ? ${includeArchived ? '' : 'AND is_archived = 0'} ORDER BY position, id`, user.id);
}

export function filtersOf(user: UserRow): FilterRow[] {
  return all<FilterRow>('SELECT * FROM saved_filters WHERE owner_id = ? ORDER BY id', user.id);
}

// ---- buckets --------------------------------------------------------------------------

export function serializeBucket(b: BucketRow, withCreator: boolean) {
  const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM task_buckets WHERE bucket_id = ?', b.id)?.n ?? 0;
  return {
    id: b.id,
    title: b.title,
    project_view_id: b.project_view_id,
    limit: b.limit,
    count,
    position: b.position,
    created: b.created,
    updated: b.updated,
    created_by: withCreator ? shortUserById(b.created_by) : null,
  };
}

export function bucketsOf(viewId: number): BucketRow[] {
  return all<BucketRow>('SELECT * FROM buckets WHERE project_view_id = ? ORDER BY position, id', viewId);
}

export const BUCKET_POSITION_STEP = 100;

export function bucketOfView(view: ViewRow, bucketId: number): BucketRow {
  const b = one<BucketRow>('SELECT * FROM buckets WHERE id = ? AND project_view_id = ?', bucketId, view.id);
  if (!b) fail(404, 'This board has no column with that id.');
  return b;
}

/** Adds a column at the end of a board view. */
export function createBucket(user: UserRow, view: ViewRow, title: string): BucketRow {
  const max = one<{ m: number | null }>('SELECT MAX(position) AS m FROM buckets WHERE project_view_id = ?', view.id)?.m ?? 0;
  const now = nowIso();
  const id = run('INSERT INTO buckets (project_view_id, title, position, created_by, created, updated) VALUES (?, ?, ?, ?, ?, ?)', view.id, title, max + BUCKET_POSITION_STEP, user.id, now, now);
  return one<BucketRow>('SELECT * FROM buckets WHERE id = ?', id)!;
}

/** The column a task sits in on a board view (the default column when it was never placed). */
export function bucketIdOfTask(view: ViewRow, taskId: number): number {
  return one<{ bucket_id: number }>('SELECT bucket_id FROM task_buckets WHERE task_id = ? AND project_view_id = ?', taskId, view.id)?.bucket_id ?? view.default_bucket_id;
}

/**
 * Moves a task into a column of a board view. Moving into the done column finishes the task; moving a
 * finished task into any other column reopens it.
 */
export function moveTaskToBucket(user: UserRow, view: ViewRow, bucket: BucketRow, task: TaskRow): TaskRow {
  if (view.project_id !== task.project_id) fail(400, 'The task belongs to a different project than this board.');
  const toDone = view.done_bucket_id !== 0 && bucket.id === view.done_bucket_id;
  const isDone = task.done === 1;
  let current = task;
  if (toDone && !isDone) current = updateTask(user, task, { done: true });
  else if (!toDone && isDone) current = updateTask(user, task, { done: false });
  run('INSERT OR REPLACE INTO task_buckets (task_id, project_view_id, bucket_id) VALUES (?, ?, ?)', task.id, view.id, bucket.id);
  return current;
}

/** Stores a task's position in a view; 0 places it after every other task of that view. */
export function setTaskPosition(task: TaskRow, view: ViewRow, position: number): number {
  if (view.project_id !== task.project_id) fail(400, 'The task belongs to a different project than this view.');
  let pos = position;
  if (pos <= 0) {
    const max = one<{ m: number | null }>('SELECT MAX(position) AS m FROM task_positions WHERE project_view_id = ? AND task_id != ?', view.id, task.id)?.m ?? 0;
    pos = max + TASK_POSITION_START;
  }
  run('INSERT OR REPLACE INTO task_positions (task_id, project_view_id, position) VALUES (?, ?, ?)', task.id, view.id, pos);
  return pos;
}

// ---- labels ---------------------------------------------------------------------------

export function serializeLabel(l: LabelRow) {
  return { id: l.id, title: l.title, description: l.description, hex_color: l.hex_color, created_by: shortUserById(l.created_by), created: l.created, updated: l.updated };
}

function labelsOfTask(taskId: number): LabelRow[] {
  return all<LabelRow>('SELECT l.* FROM labels l JOIN label_tasks lt ON lt.label_id = l.id WHERE lt.task_id = ? ORDER BY lt.id', taskId);
}

// ---- tasks ----------------------------------------------------------------------------

export interface TaskShape {
  /** Position in a specific view (list responses); otherwise 0. */
  viewId?: number;
  commentCount?: boolean;
  /** Single-task reads: subscription, buckets, max_permission. */
  single?: boolean;
  buckets?: boolean;
  /** Bulk-create responses report related_tasks as null; reads report an object. */
  relatedNull?: boolean;
  /** Board listings report the column the task sits in. */
  bucketId?: number;
  userId: number;
}

function identifierOf(task: TaskRow): string {
  const p = one<{ identifier: string }>('SELECT identifier FROM projects WHERE id = ?', task.project_id);
  return p?.identifier ? `${p.identifier}-${task.index}` : `#${task.index}`;
}

export function serializeTask(t: TaskRow, shape: TaskShape) {
  const labels = labelsOfTask(t.id).map(serializeLabel);
  const out: Record<string, unknown> = {
    id: t.id,
    title: t.title,
    description: t.description,
    project_id: t.project_id,
    done: t.done === 1,
    done_at: t.done_at,
    due_date: t.due_date,
    reminders: null,
    repeat_after: t.repeat_after,
    repeat_mode: t.repeat_mode,
    priority: t.priority,
    start_date: t.start_date,
    end_date: t.end_date,
    assignees: [],
    labels: labels.length ? labels : null,
    hex_color: t.hex_color,
    percent_done: t.percent_done,
    identifier: identifierOf(t),
    index: t.index,
    related_tasks: shape.relatedNull ? null : {},
    attachments: null,
    cover_image_attachment_id: t.cover_image_attachment_id,
    is_favorite: t.is_favorite === 1,
  };
  if (shape.single) {
    const sub = one<{ id: number; entity: string; entity_id: number; created: string }>(
      "SELECT id, entity, entity_id, created FROM subscriptions WHERE entity = 'task' AND entity_id = ? AND user_id = ?",
      t.id,
      shape.userId,
    );
    out.subscription = sub ?? null;
  }
  out.created = t.created;
  out.updated = t.updated;
  out.bucket_id = shape.bucketId ?? 0;
  if (shape.single && shape.buckets !== false) {
    out.buckets = all<BucketRow>('SELECT b.* FROM buckets b JOIN task_buckets tb ON tb.bucket_id = b.id WHERE tb.task_id = ? ORDER BY b.project_view_id', t.id).map((b) => serializeBucket(b, false));
  }
  if (shape.commentCount) out.comment_count = one<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?', t.id)?.n ?? 0;
  let position = 0;
  if (shape.viewId !== undefined) position = one<{ position: number }>('SELECT position FROM task_positions WHERE task_id = ? AND project_view_id = ?', t.id, shape.viewId)?.position ?? 0;
  out.position = position;
  out.reactions = null;
  out.created_by = shortUserById(t.created_by);
  if (shape.single) out.max_permission = MAX_PERMISSION_ADMIN;
  return out;
}

export function ownedTask(user: UserRow, id: number): TaskRow {
  const t = one<TaskRow & { owner_id: number }>('SELECT t.*, p.owner_id AS owner_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?', id);
  if (!t) fail(404, 'There is no task with this id. It may have been deleted.', ErrorCode.TaskNotFound);
  if (t.owner_id !== user.id) fail(403, 'You do not have access to this task.');
  const { owner_id: _ignored, ...task } = t;
  return task;
}

/** Places a task in every view of its project: a new lowest position, and the default kanban bucket. */
function placeTask(taskId: number, projectId: number, done: boolean): void {
  for (const v of viewsOf(projectId)) {
    const min = one<{ m: number | null }>('SELECT MIN(position) AS m FROM task_positions WHERE project_view_id = ?', v.id)?.m;
    const position = min === null || min === undefined || min <= 0 ? TASK_POSITION_START : min / 2;
    run('INSERT OR REPLACE INTO task_positions (task_id, project_view_id, position) VALUES (?, ?, ?)', taskId, v.id, position);
    if (v.view_kind === 'kanban') {
      const bucket = done && v.done_bucket_id ? v.done_bucket_id : v.default_bucket_id;
      if (bucket) run('INSERT OR REPLACE INTO task_buckets (task_id, project_view_id, bucket_id) VALUES (?, ?, ?)', taskId, v.id, bucket);
    }
  }
}

export interface TaskInput {
  title?: unknown;
  description?: unknown;
  done?: unknown;
  due_date?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  priority?: unknown;
  percent_done?: unknown;
  hex_color?: unknown;
  repeat_after?: unknown;
  repeat_mode?: unknown;
  is_favorite?: unknown;
  cover_image_attachment_id?: unknown;
  project_id?: unknown;
}

interface CleanTask {
  title: string;
  description: string;
  done: boolean;
  due_date: string;
  start_date: string;
  end_date: string;
  priority: number;
  percent_done: number;
  hex_color: string;
  repeat_after: number;
  repeat_mode: number;
  is_favorite: boolean;
  cover_image_attachment_id: number;
}

/** Validates editable task fields, falling back to `base` for missing ones. */
function cleanTask(input: TaskInput, base: CleanTask): CleanTask {
  const out = { ...base };
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) fail(400, 'A task needs a title.');
    if (input.title.length > 250) fail(400, 'The task title is too long (250 characters at most).');
    out.title = input.title;
  }
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') fail(400, 'The description must be text.');
    out.description = input.description;
  }
  if (input.done !== undefined && input.done !== null) {
    if (typeof input.done !== 'boolean') fail(400, '"done" must be true or false.');
    out.done = input.done;
  }
  for (const key of ['due_date', 'start_date', 'end_date'] as const) {
    if (input[key] === undefined) continue;
    const d = normalizeDate(input[key]);
    if (d === undefined) fail(400, `"${key}" is not a valid date.`);
    out[key] = d;
  }
  const int = (key: 'priority' | 'repeat_after' | 'repeat_mode' | 'cover_image_attachment_id', min: number, max: number) => {
    const v = input[key];
    if (v === undefined || v === null) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(400, `"${key}" must be a whole number between ${min} and ${max}.`);
    out[key] = v;
  };
  int('priority', 0, 5);
  int('repeat_after', 0, Number.MAX_SAFE_INTEGER);
  int('repeat_mode', 0, 2);
  int('cover_image_attachment_id', 0, Number.MAX_SAFE_INTEGER);
  if (input.percent_done !== undefined && input.percent_done !== null) {
    if (typeof input.percent_done !== 'number' || input.percent_done < 0 || input.percent_done > 100) fail(400, '"percent_done" is out of range.');
    out.percent_done = input.percent_done;
  }
  if (input.hex_color !== undefined && input.hex_color !== null) {
    if (typeof input.hex_color !== 'string' || !/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})?$/.test(input.hex_color)) fail(400, '"hex_color" must be a hex colour.');
    out.hex_color = input.hex_color.replace(/^#/, '');
  }
  if (input.is_favorite !== undefined && input.is_favorite !== null) {
    if (typeof input.is_favorite !== 'boolean') fail(400, '"is_favorite" must be true or false.');
    out.is_favorite = input.is_favorite;
  }
  return out;
}

const EMPTY_TASK: CleanTask = {
  title: '',
  description: '',
  done: false,
  due_date: ZERO_TIME,
  start_date: ZERO_TIME,
  end_date: ZERO_TIME,
  priority: 0,
  percent_done: 0,
  hex_color: '',
  repeat_after: 0,
  repeat_mode: 0,
  is_favorite: false,
  cover_image_attachment_id: 0,
};

export function createTasks(user: UserRow, projectId: number, inputs: TaskInput[]): TaskRow[] {
  const cleaned = inputs.map((input) => {
    if (input.title === undefined) fail(400, 'A task needs a title.');
    return cleanTask(input, EMPTY_TASK);
  });
  return tx(() =>
    cleaned.map((c) => {
      const now = nowIso();
      const index = (one<{ m: number | null }>('SELECT MAX("index") AS m FROM tasks WHERE project_id = ?', projectId)?.m ?? 0) + 1;
      const id = run(
        `INSERT INTO tasks (project_id, title, description, done, done_at, due_date, start_date, end_date, priority, percent_done, hex_color, repeat_after, repeat_mode, is_favorite, cover_image_attachment_id, "index", created_by, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        c.title,
        c.description,
        c.done,
        c.done ? now : ZERO_TIME,
        c.due_date,
        c.start_date,
        c.end_date,
        c.priority,
        c.percent_done,
        c.hex_color,
        c.repeat_after,
        c.repeat_mode,
        c.is_favorite,
        c.cover_image_attachment_id,
        index,
        user.id,
        now,
        now,
      );
      placeTask(id, projectId, c.done);
      run("INSERT INTO subscriptions (entity, entity_id, user_id, created) VALUES ('task', ?, ?, ?)", id, user.id, now);
      return one<TaskRow>('SELECT * FROM tasks WHERE id = ?', id)!;
    }),
  );
}

export function updateTask(user: UserRow, task: TaskRow, input: TaskInput): TaskRow {
  const base: CleanTask = {
    title: task.title,
    description: task.description,
    done: task.done === 1,
    due_date: task.due_date,
    start_date: task.start_date,
    end_date: task.end_date,
    priority: task.priority,
    percent_done: task.percent_done,
    hex_color: task.hex_color,
    repeat_after: task.repeat_after,
    repeat_mode: task.repeat_mode,
    is_favorite: task.is_favorite === 1,
    cover_image_attachment_id: task.cover_image_attachment_id,
  };
  const c = cleanTask(input, base);
  let projectId = task.project_id;
  if (input.project_id !== undefined && input.project_id !== null && input.project_id !== 0) {
    if (typeof input.project_id !== 'number') fail(400, '"project_id" must be a number.');
    if (input.project_id !== task.project_id) projectId = ownedProject(user, input.project_id).id;
  }
  return tx(() => {
    const now = nowIso();
    const wasDone = task.done === 1;
    const doneAt = c.done && !wasDone ? now : c.done ? task.done_at : ZERO_TIME;
    let index = task.index;
    if (projectId !== task.project_id) {
      index = (one<{ m: number | null }>('SELECT MAX("index") AS m FROM tasks WHERE project_id = ?', projectId)?.m ?? 0) + 1;
      run('DELETE FROM task_positions WHERE task_id = ?', task.id);
      run('DELETE FROM task_buckets WHERE task_id = ?', task.id);
    }
    run(
      `UPDATE tasks SET project_id = ?, title = ?, description = ?, done = ?, done_at = ?, due_date = ?, start_date = ?, end_date = ?, priority = ?, percent_done = ?, hex_color = ?,
       repeat_after = ?, repeat_mode = ?, is_favorite = ?, cover_image_attachment_id = ?, "index" = ?, updated = ? WHERE id = ?`,
      projectId,
      c.title,
      c.description,
      c.done,
      doneAt,
      c.due_date,
      c.start_date,
      c.end_date,
      c.priority,
      c.percent_done,
      c.hex_color,
      c.repeat_after,
      c.repeat_mode,
      c.is_favorite,
      c.cover_image_attachment_id,
      index,
      now,
      task.id,
    );
    if (projectId !== task.project_id) placeTask(task.id, projectId, c.done);
    else if (c.done !== wasDone) {
      // Done tasks live in the kanban "done" bucket; reopening returns them to the default bucket.
      for (const v of viewsOf(projectId).filter((x) => x.view_kind === 'kanban')) {
        const current = one<{ bucket_id: number }>('SELECT bucket_id FROM task_buckets WHERE task_id = ? AND project_view_id = ?', task.id, v.id)?.bucket_id;
        let target: number | undefined;
        if (c.done && v.done_bucket_id) target = v.done_bucket_id;
        else if (!c.done && (current === undefined || current === v.done_bucket_id)) target = v.default_bucket_id;
        if (target) run('INSERT OR REPLACE INTO task_buckets (task_id, project_view_id, bucket_id) VALUES (?, ?, ?)', task.id, v.id, target);
      }
    }
    return one<TaskRow>('SELECT * FROM tasks WHERE id = ?', task.id)!;
  });
}

export function deleteTask(task: TaskRow): void {
  tx(() => {
    run("DELETE FROM subscriptions WHERE entity = 'task' AND entity_id = ?", task.id);
    run('DELETE FROM tasks WHERE id = ?', task.id);
  });
}

export function touchTask(taskId: number): void {
  run('UPDATE tasks SET updated = ? WHERE id = ?', nowIso(), taskId);
}

// ---- task queries ---------------------------------------------------------------------

export interface TaskQuery {
  projectIds?: number[];
  viewFilter?: { filter: string; includeNulls: boolean };
  filter: string;
  includeNulls: boolean;
  q: string;
  sortBy: string[];
  orderBy: string[];
  viewId?: number;
}

function zeroToNull(v: string): number | null {
  return v === ZERO_TIME ? null : Date.parse(v);
}

function subjectOf(t: TaskRow, labelIds: number[], labelTitles: string[]): FilterSubject {
  return {
    num: { id: t.id, priority: t.priority, percent_done: t.percent_done, index: t.index, project: t.project_id, repeat_after: t.repeat_after },
    bool: { done: t.done === 1, is_favorite: t.is_favorite === 1 },
    date: { due_date: zeroToNull(t.due_date), start_date: zeroToNull(t.start_date), end_date: zeroToNull(t.end_date), done_at: zeroToNull(t.done_at), created: Date.parse(t.created), updated: Date.parse(t.updated) },
    text: { title: t.title, description: t.description },
    ids: { labels: labelIds, assignees: [] },
    idTitles: { labels: labelTitles },
  };
}

function parseOrFail(src: string): Node | undefined {
  try {
    const tree = parseFilter(src);
    validateFilter(tree);
    return tree;
  } catch (error) {
    if (error instanceof FilterValueError) fail(400, `This filter cannot be used. ${error.message}`, ErrorCode.FilterValueInvalid);
    if (error instanceof FilterError) fail(400, `This filter cannot be used. ${error.message}`);
    throw error;
  }
}

const SORTABLE = new Set(['id', 'title', 'description', 'done', 'done_at', 'due_date', 'start_date', 'end_date', 'priority', 'percent_done', 'position', 'created', 'updated', 'index', 'project_id', 'is_favorite']);

export function queryTasks(user: UserRow, query: TaskQuery): TaskRow[] {
  // Parse (and type-check) the filters first, so a bad filter fails even when there is nothing to filter.
  const viewTree = query.viewFilter ? parseOrFail(query.viewFilter.filter) : undefined;
  const tree = parseOrFail(query.filter);
  const projectIds = query.projectIds ?? projectsOf(user, false).map((p) => p.id);
  if (!projectIds.length) return [];
  const rows = all<TaskRow>(`SELECT * FROM tasks WHERE project_id IN (${projectIds.map(() => '?').join(',')})`, ...projectIds);
  const labelRows = all<{ task_id: number; label_id: number; title: string }>(
    `SELECT lt.task_id, lt.label_id, l.title FROM label_tasks lt JOIN labels l ON l.id = lt.label_id JOIN tasks t ON t.id = lt.task_id WHERE t.project_id IN (${projectIds.map(() => '?').join(',')})`,
    ...projectIds,
  );
  const q = query.q.trim().toLowerCase();
  let out: TaskRow[];
  try {
    out = rows.filter((t) => {
      const ls = labelRows.filter((l) => l.task_id === t.id);
      const subject = subjectOf(
        t,
        ls.map((l) => l.label_id),
        ls.map((l) => l.title),
      );
      if (viewTree && !evaluate(viewTree, subject, query.viewFilter!.includeNulls)) return false;
      if (tree && !evaluate(tree, subject, query.includeNulls)) return false;
      if (q && !t.title.toLowerCase().includes(q)) return false;
      return true;
    });
  } catch (error) {
    if (error instanceof FilterError) throw new HttpError(400, `Invalid filter: ${error.message}`);
    throw error;
  }

  const positions = new Map<number, number>();
  if (query.viewId !== undefined) {
    for (const r of all<{ task_id: number; position: number }>('SELECT task_id, position FROM task_positions WHERE project_view_id = ?', query.viewId)) positions.set(r.task_id, r.position);
  }
  const sorts = query.sortBy
    .map((field, i) => ({ field, desc: (query.orderBy[i] ?? 'asc').toLowerCase() === 'desc' }))
    .filter((s) => SORTABLE.has(s.field));
  const value = (t: TaskRow, field: string): number | string | null => {
    switch (field) {
      case 'position':
        return positions.get(t.id) ?? 0;
      case 'done_at':
      case 'due_date':
      case 'start_date':
      case 'end_date':
        return zeroToNull(t[field]);
      case 'created':
      case 'updated':
        return Date.parse(t[field]);
      case 'title':
      case 'description':
        return t[field].toLowerCase();
      case 'project_id':
        return t.project_id;
      default:
        return (t as unknown as Record<string, number>)[field] ?? 0;
    }
  };
  out.sort((a, b) => {
    for (const s of sorts) {
      const va = value(a, s.field);
      const vb = value(b, s.field);
      if (va === vb) continue;
      // Tasks without a date sort after those with one, whatever the direction.
      if (va === null) return 1;
      if (vb === null) return -1;
      const c = va < vb ? -1 : 1;
      return s.desc ? -c : c;
    }
    return a.id - b.id;
  });
  return out;
}

// ---- comments -------------------------------------------------------------------------

export function serializeComment(c: CommentRow) {
  return { id: c.id, comment: c.comment, author: shortUserById(c.author_id), reactions: null, created: c.created, updated: c.updated };
}
