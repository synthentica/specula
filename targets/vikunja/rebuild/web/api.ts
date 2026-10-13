// API client: bearer token in localStorage, refresh cookie handled by the browser.

export const API = '/api/v2';
const TOKEN_KEY = 'token';

export interface ShortUser {
  id: number;
  name: string;
  username: string;
  created: string;
  updated: string;
}

export interface CurrentUser extends ShortUser {
  settings: { default_project_id: number; language: string; timezone: string; week_start: number };
}

export interface View {
  id: number;
  title: string;
  project_id: number;
  view_kind: 'list' | 'gantt' | 'table' | 'kanban';
  position: number;
  default_bucket_id: number;
  done_bucket_id: number;
}

export interface Project {
  id: number;
  title: string;
  description: string;
  identifier: string;
  hex_color: string;
  is_archived: boolean;
  position: number;
  views: View[];
}

export interface Label {
  id: number;
  title: string;
  description: string;
  hex_color: string;
}

export interface Bucket {
  id: number;
  title: string;
  project_view_id: number;
  position: number;
  count: number;
  limit: number;
}

export interface BucketWithTasks extends Bucket {
  tasks?: Task[];
}

export interface Task {
  id: number;
  title: string;
  description: string;
  project_id: number;
  done: boolean;
  done_at: string;
  due_date: string;
  start_date: string;
  end_date: string;
  priority: number;
  percent_done: number;
  hex_color: string;
  repeat_after: number;
  repeat_mode: number;
  is_favorite: boolean;
  identifier: string;
  index: number;
  labels: Label[] | null;
  buckets?: Bucket[];
  comment_count?: number;
  position: number;
  created: string;
  updated: string;
}

export interface Comment {
  id: number;
  comment: string;
  author: ShortUser;
  created: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export const ZERO_TIME = '0001-01-01T00:00:00Z';
export const hasDate = (v: string | undefined) => !!v && !v.startsWith('0001-01-01');

/** Error codes the server sends in problem+json bodies that this client reacts to. */
export const ErrorCodes = { TokenInvalid: 11, UsernameTaken: 1001, WrongCredentials: 1011, TaskNotFound: 4002, FilterValueInvalid: 4019 } as const;

/** Friendlier wording for the errors people run into most. */
const FRIENDLY: Record<number, string> = {
  [ErrorCodes.WrongCredentials]: 'That username and password do not match. Check for typos and try again.',
  [ErrorCodes.UsernameTaken]: 'That username is already taken. Please choose another one.',
  [ErrorCodes.TaskNotFound]: 'This task could not be found. It may have been deleted.',
};

export class ApiError extends Error {
  status: number;
  code: number;
  constructor(status: number, message: string, code = 0) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function errorFrom(status: number, data: unknown): ApiError {
  const body = (data ?? {}) as { detail?: unknown; message?: unknown; code?: unknown };
  const code = typeof body.code === 'number' ? body.code : 0;
  const detail = typeof body.detail === 'string' ? body.detail : typeof body.message === 'string' ? body.message : '';
  return new ApiError(status, FRIENDLY[code] ?? (detail || `The request failed (${status}).`), code);
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable: the session lasts as long as the page.
  }
}

export function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

let onSignedOut: () => void = () => {};
export function whenSignedOut(fn: () => void): void {
  onSignedOut = fn;
}

let refreshing: Promise<boolean> | null = null;

/** Exchanges the refresh cookie for a new token. */
export function refreshToken(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API}/user/token/refresh`, { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return false;
      const body = (await res.json()) as { token: string };
      setToken(body.token);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  contentType?: string;
  auth?: boolean;
}

/** Remaining token validity (ms) below which the client renews the token before a request. */
const RENEW_MARGIN_MS = 5_000;

export async function request<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const auth = opts.auth !== false;
  // After an idle period the token may have run out: renew it before the request instead of failing first.
  const current = getToken();
  if (auth && current && tokenExpiry(current) - Date.now() < RENEW_MARGIN_MS) await refreshToken();
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/json';
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (res.status === 401 && auth && !retried) {
    if (await refreshToken()) return request<T>(path, opts, true);
    setToken(null);
    onSignedOut();
    throw new ApiError(401, 'Your session has ended. Please sign in again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) throw errorFrom(res.status, data);
  return data as T;
}

const qs = (pairs: [string, string | number][]) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

// ---- auth -----------------------------------------------------------------------------

export async function signIn(username: string, password: string): Promise<void> {
  const body = await request<{ token: string }>('/login', { method: 'POST', body: { username, password, long_token: false }, auth: false });
  setToken(body.token);
}

export async function signUp(username: string, email: string, password: string): Promise<void> {
  await request('/register', { method: 'POST', body: { username, email, password, language: navigator.language?.slice(0, 2) || 'en' }, auth: false });
  await signIn(username, password);
}

export async function signOut(): Promise<void> {
  try {
    await request('/logout', { method: 'POST' }, true);
  } finally {
    setToken(null);
  }
}

export const currentUser = () => request<CurrentUser>('/user');
export const avatarUrl = (username: string, size: number) => `${API}/avatar/${encodeURIComponent(username)}?size=${size}`;

// ---- projects -------------------------------------------------------------------------

export const listProjects = () => request<Page<Project>>('/projects?' + qs([['is_archived', 'true'], ['expand', 'permissions'], ['page', 1]]));
export const getProject = (id: number) => request<Project>(`/projects/${id}`);
export const createProject = (title: string, description = '') =>
  request<Project>('/projects', { method: 'POST', body: { title, description, hex_color: '', identifier: '', is_archived: false, is_favorite: false, parent_project_id: 0, position: 0 } });

export function viewTasks(projectId: number, viewId: number, page = 1) {
  return request<Page<Task>>(
    `/projects/${projectId}/views/${viewId}/tasks?` +
      qs([
        ['sort_by', 'position'],
        ['order_by', 'asc'],
        ['filter', ''],
        ['filter_include_nulls', 'false'],
        ['filter_timezone', 'UTC'],
        ['q', ''],
        ['expand', 'comment_count'],
        ['page', page],
      ]),
  );
}

export const createTasks = (projectId: number, titles: string[]) =>
  request<{ tasks: Task[] }>(`/projects/${projectId}/tasks/bulk`, {
    method: 'POST',
    body: { tasks: titles.map((title) => ({ title, description: '', done: false, priority: 0, project_id: projectId, reminders: [] })) },
  });

// ---- tasks ----------------------------------------------------------------------------

export interface TaskSearch {
  q?: string;
  filter?: string;
  sort?: [string, 'asc' | 'desc'][];
  page?: number;
  perPage?: number;
}

export function searchTasks(s: TaskSearch) {
  const pairs: [string, string | number][] = [];
  for (const [field] of s.sort ?? []) pairs.push(['sort_by', field]);
  for (const [, order] of s.sort ?? []) pairs.push(['order_by', order]);
  pairs.push(['filter', s.filter ?? ''], ['filter_include_nulls', 'false'], ['q', s.q ?? ''], ['expand', 'comment_count'], ['page', s.page ?? 1]);
  if (s.perPage) pairs.push(['per_page', s.perPage]);
  return request<Page<Task>>('/tasks?' + qs(pairs));
}

export const getTask = (id: number) => request<Task>(`/tasks/${id}?expand=buckets`);

/** Saves a task the way the server expects: a JSON Patch with every editable field. */
export function saveTask(task: Task) {
  const fields: [string, unknown][] = [
    ['title', task.title],
    ['description', task.description],
    ['done', task.done],
    ['due_date', task.due_date],
    ['start_date', task.start_date],
    ['end_date', task.end_date],
    ['priority', task.priority],
    ['hex_color', task.hex_color],
    ['percent_done', task.percent_done],
    ['repeat_after', task.repeat_after],
    ['repeat_mode', task.repeat_mode],
    ['is_favorite', task.is_favorite],
    ['project_id', task.project_id],
  ];
  return request<Task>(`/tasks/${task.id}`, { method: 'PATCH', contentType: 'application/json-patch+json', body: fields.map(([k, value]) => ({ op: 'add', path: `/${k}`, value })) });
}

export const deleteTask = (id: number) => request<void>(`/tasks/${id}`, { method: 'DELETE' });
export const listComments = (taskId: number) => request<Page<Comment>>(`/tasks/${taskId}/comments?order_by=asc&page=1`);
export const addComment = (taskId: number, html: string) => request<Comment>(`/tasks/${taskId}/comments`, { method: 'POST', body: { comment: html } });

// ---- labels ---------------------------------------------------------------------------

export const listNotifications = () => request<Page<{ id: number; name?: string; created?: string }>>('/notifications?page=1&per_page=20');
export const listLabels = () => request<Page<Label>>('/labels?page=1');
export const createLabel = (title: string, hex: string) => request<Label>('/labels', { method: 'POST', body: { title, hex_color: hex } });
export const attachLabel = (taskId: number, labelId: number) => request<{ label_id: number }>(`/tasks/${taskId}/labels`, { method: 'POST', body: { label_id: labelId } });

// ---- board (kanban) --------------------------------------------------------------------

export function boardBuckets(projectId: number, viewId: number) {
  return request<{ items: BucketWithTasks[]; total: number }>(
    `/projects/${projectId}/views/${viewId}/buckets/tasks?` +
      qs([
        ['filter', ''],
        ['filter_include_nulls', 'false'],
        ['q', ''],
        ['per_page', 50],
        ['expand', 'comment_count'],
      ]),
  );
}

export const createBucket = (projectId: number, viewId: number, title: string) => request<Bucket>(`/projects/${projectId}/views/${viewId}/buckets`, { method: 'POST', body: { title } });

export const moveTaskToBucket = (projectId: number, viewId: number, bucketId: number, taskId: number) =>
  request<{ bucket: Bucket; task: Task }>(`/projects/${projectId}/views/${viewId}/buckets/${bucketId}/tasks`, { method: 'PUT', body: { task_id: taskId } });

/** Position 0 lets the server put the task after all others in the view. */
export const setTaskPosition = (taskId: number, viewId: number, position: number) =>
  request<{ position: number }>(`/tasks/${taskId}/position`, { method: 'PUT', body: { project_view_id: viewId, position } });

// ---- realtime -------------------------------------------------------------------------

export function connectRealtime(onEvent: (event: string, data: unknown) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 1000;
  const open = () => {
    const token = getToken();
    if (stopped || !token) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API}/ws`);
    ws.onopen = () => ws?.send(JSON.stringify({ action: 'auth', token: getToken() }));
    ws.onmessage = (ev) => {
      let msg: { action?: string; success?: boolean; event?: string; data?: unknown };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.action === 'auth.success') {
        retry = 1000;
        for (const event of ['notification.created']) ws?.send(JSON.stringify({ action: 'subscribe', event }));
      } else if (msg.action === 'event' && msg.event) onEvent(msg.event, msg.data);
    };
    ws.onclose = () => {
      if (!stopped) setTimeout(open, (retry = Math.min(retry * 2, 30000)));
    };
  };
  open();
  return () => {
    stopped = true;
    ws?.close();
  };
}
