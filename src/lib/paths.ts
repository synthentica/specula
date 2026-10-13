// URL path templating: /api/v2/projects/2/views/9/tasks -> /api/v2/projects/{projectId}/views/{viewId}/tasks

const NUMERIC = /^-?\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
// Random base32/base36 ids (`b1dooum4safgcuf5za47ebg3gaa`): lowercase letters and digits, at least two of each.
const RANDOM_ID = /^(?=(?:[a-z]*\d){2})(?=(?:\d*[a-z]){2})[a-z0-9]{20,32}$/;
// Random base62 slugs (`e6yGJpWYlZJne8Ja`, nanoid-style): mixed case with digits, so camelCase words do not match.
const RANDOM_SLUG = /^(?=(?:[^0-9]*\d){2})(?=(?:[^A-Z]*[A-Z]){2})(?=(?:[^a-z]*[a-z]){2})[A-Za-z0-9_-]{10,32}$/;
const REDACTED = /^(<|%3C)redacted(:|%3A)/i;
const TEMPLATE = /^(\{[^}]*\}|\$\{[^}]*\}|:[A-Za-z_]\w*)$/;

/** True when a single segment looks like an identifier rather than a resource name. */
export function isParamSegment(segment: string): boolean {
  return NUMERIC.test(segment) || UUID.test(segment) || LONG_HEX.test(segment) || RANDOM_ID.test(segment) || RANDOM_SLUG.test(segment) || REDACTED.test(segment) || TEMPLATE.test(segment);
}

/** True for values that look like record ids: positive integers, UUIDs, long hex ids (such as 24-hex ObjectIds), random base32 ids and base62 slugs. */
export function isIdValue(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  return typeof value === 'string' && (UUID.test(value) || LONG_HEX.test(value) || RANDOM_ID.test(value) || RANDOM_SLUG.test(value));
}

export function singular(word: string): string {
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/(ss|us)$/.test(word)) return word;
  return word.replace(/s$/, '');
}

export function camel(word: string): string {
  return word.replace(/[-_]+(\w)/g, (_, c: string) => c.toUpperCase());
}

/** Names a parameter after the segment before it ("projects" -> "projectId"). */
export function paramName(previous: string | undefined, used: Set<string>): string {
  let base = previous && !isParamSegment(previous) ? `${camel(singular(previous))}Id` : 'id';
  if (base === 'Id') base = 'id';
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}

/** Templates one concrete path on its own (no cross-sample inference). */
export function templatePath(pathname: string): string {
  const segments = pathname.split('/');
  const used = new Set<string>();
  return segments
    .map((segment, i) => (i > 0 && segment && isParamSegment(segment) ? `{${paramName(segments[i - 1], used)}}` : segment))
    .join('/');
}

/** Normalizes code-side path strings (`/tasks/${id}`, `/tasks/:id`, `/tasks/{id}`) for comparison with observed templates. */
export function shapeOf(path: string): string {
  return path
    .split('?')[0]!
    .split('/')
    .map((segment, i) => (i > 0 && segment && isParamSegment(segment) ? '{}' : segment.replace(/\$\{[^}]*\}|\{[^}]*\}/g, '{}')))
    .join('/')
    .replace(/\/+$/, '');
}
