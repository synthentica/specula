// Redaction applied in memory before anything is written to disk.
// Secrets are replaced with typed placeholders ("<redacted:jwt>") so the shape of
// the data survives for analysis while the values do not.

const SENSITIVE_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-refresh-token',
  'x-amz-security-token',
]);
const SENSITIVE_HEADER_PATTERN = /^x-(csrf|xsrf)/i;

const SENSITIVE_KEY_PATTERN =
  /^(pass|passwd|pwd|.*password.*|.*token.*|.*secret.*|jwt|.*session.*|api[-_]?key|apikey|otp|passcode|pin|totp_?(secret|passcode|url)|auth(orization)?|cookie|.*csrf.*|.*xsrf.*|private[-_]?key|.*credential.*|code_?verifier|client_?secret|signature|sig)$/i;
const NUMERIC_SECRET_KEY_PATTERN = /^(otp|passcode|pin|totp_?passcode)$/i;
const SENSITIVE_QUERY_PATTERN = /^(.*token.*|code|state|key|api[-_]?key|sig|signature|secret|password|session.*|auth)$/i;

// Fields that name the person behind an account object (one that also holds the account's email address).
const IDENTITY_KEYS = /^(name|username|login|nickname|handle|display_?name|full_?name|first_?name|last_?name|preferred_?username)$/i;
// A sign-in method linked to the account: `{ providerId: "github", accountId: "<the provider's user id>" }`.
const PROVIDER_KEYS = /^(provider|provider_?id)$/i;
const PROVIDER_ACCOUNT_KEYS = /^(account_?id|provider_?account_?id|provider_?user_?id)$/i;
const LOCAL_PROVIDERS = /^(credentials?|email|password)$/i;
// Network addresses a server recorded about the client (a session's `ipAddress`).
const IP_KEYS = /^(ip|ip_?addr(ess)?|last_?ip|remote_?addr(ess)?|client_?ip)$/i;

// `GA1.1.1234567890.1700000000` or `1.1.1234567890.1700000000`: version prefix, then a random number and a timestamp.
const VERSIONED_COOKIE_ID = /^[A-Za-z]*\d+\.\d+\.(\d+\.\d+)$/;

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const FILE_EXTENSIONS = 'png|jpe?g|gif|svg|webp|avif|ico|js|mjs|css|map|woff2?|ttf|json|html?';
const EMAIL_PATTERN = new RegExp(
  `[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?!(?:${FILE_EXTENSIONS})\\b)[A-Za-z]{2,24}\\b`,
  'g',
);

export interface RedactionOptions {
  extraHeaders?: string[];
  extraKeys?: string[];
  /** Literal values (e.g. the test account name) scrubbed everywhere as <redacted:pii>. */
  values?: string[];
  /**
   * The test account's password, known only for the capture run (never written). A password field holding
   * any other value becomes <redacted:secret:other>, so a replay can tell a wrong-password attempt apart.
   */
  accountSecret?: string;
  /**
   * The test account's email address. When set, it becomes <redacted:email> and every other address
   * <redacted:email:2>, <redacted:email:3>, ... (one number per address), so a replay can tell users apart.
   */
  accountEmail?: string;
}

export interface Leak {
  kind: 'jwt' | 'email' | 'secret' | 'pii';
  /** Where in the serialized text the leak starts. Never the value itself. */
  offset: number;
}

export class Redactor {
  #extraHeaders: Set<string>;
  #extraKeys: Set<string>;
  #pii: string[];
  #accountSecret: string | undefined;
  #accountEmail: string | undefined;
  #otherEmails = new Map<string, number>();
  /** Exact secret values learned from headers/cookies/token fields during this capture. */
  #secrets = new Set<string>();

  constructor(options: RedactionOptions = {}) {
    this.#extraHeaders = new Set((options.extraHeaders ?? []).map((h) => h.toLowerCase()));
    this.#extraKeys = new Set((options.extraKeys ?? []).map((k) => k.toLowerCase()));
    this.#pii = (options.values ?? []).filter((v) => v.length >= 3);
    this.#accountSecret = options.accountSecret || undefined;
    this.#accountEmail = options.accountEmail?.toLowerCase() || undefined;
  }

  /** Placeholder for a value under a sensitive key: jwt, the account's secret, or another password. */
  #secretPlaceholder(key: string, value: string): string {
    if (looksLikeJwt(value)) return '<redacted:jwt>';
    if (this.#accountSecret !== undefined && /pass|pwd/i.test(key) && value !== this.#accountSecret) return '<redacted:secret:other>';
    return '<redacted:secret>';
  }

  /** Remembers a secret value so it is also scrubbed wherever else it appears (URLs, bodies). */
  learnSecret(value: string | undefined): void {
    if (value && value.length >= 8) this.#secrets.add(value);
  }

  /**
   * A cookie value, plus the bare id inside a versioned browser id (`GA1.1.<id>`, `1.1.<id>`): ad and
   * analytics tags send that id in their own URLs (`auid=`, `cid=`), where the full value never appears.
   */
  #learnCookie(value: string | undefined): void {
    this.learnSecret(value);
    const id = value?.match(VERSIONED_COOKIE_ID)?.[1];
    if (id) this.learnSecret(id);
  }

  isSensitiveHeader(name: string): boolean {
    const lower = name.toLowerCase();
    return SENSITIVE_HEADERS.has(lower) || SENSITIVE_HEADER_PATTERN.test(lower) || this.#extraHeaders.has(lower);
  }

  isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY_PATTERN.test(key) || this.#extraKeys.has(key.toLowerCase());
  }

  /** Learns secrets from a header without redacting (call for every header before redacting anything). */
  learnFromHeader(name: string, value: string): void {
    const lower = name.toLowerCase();
    if (lower === 'cookie') {
      for (const part of value.split(';')) this.#learnCookie(part.split('=').slice(1).join('=').trim());
    } else if (lower === 'set-cookie') {
      for (const line of value.split('\n')) this.#learnCookie(line.split(';')[0]?.split('=').slice(1).join('=').trim());
    } else if (lower === 'authorization' || lower === 'proxy-authorization') {
      const [, credentials] = value.split(/\s+/, 2);
      this.learnSecret(credentials ?? value);
    } else if (this.isSensitiveHeader(name)) {
      this.learnSecret(value);
    }
  }

  /** Learns secret query values (API keys, signed-URL tokens) without redacting. */
  learnFromUrl(raw: string): void {
    try {
      for (const [key, value] of new URL(raw).searchParams) if (SENSITIVE_QUERY_PATTERN.test(key) || this.isSensitiveKey(key)) this.learnSecret(value);
    } catch {
      // Not an absolute URL: nothing to learn.
    }
  }

  /** Remembers a personal value (the account's name, a linked provider's user id) so it is scrubbed everywhere. */
  learnPii(value: string | undefined): void {
    if (value && value.length >= 4 && !value.includes('@') && !this.#pii.includes(value)) this.#pii.push(value);
  }

  /**
   * Learns the account's own identifiers from an object that describes it: the name fields next to the
   * account's email (any email when the account's is not configured), and the user id of a linked sign-in
   * provider. Nobody has to list them in `redact.values` first.
   */
  #learnIdentity(object: Record<string, unknown>): void {
    const email = Object.entries(object).find(([k, v]) => /^e-?mail$/i.test(k) && typeof v === 'string')?.[1] as string | undefined;
    if (email && (this.#accountEmail === undefined || email.toLowerCase() === this.#accountEmail)) {
      for (const [key, child] of Object.entries(object)) if (IDENTITY_KEYS.test(key) && typeof child === 'string') this.learnPii(child);
    }
    const provider = Object.entries(object).find(([k, v]) => PROVIDER_KEYS.test(k) && typeof v === 'string')?.[1] as string | undefined;
    if (provider && !LOCAL_PROVIDERS.test(provider)) {
      for (const [key, child] of Object.entries(object)) if (PROVIDER_ACCOUNT_KEYS.test(key) && (typeof child === 'string' || typeof child === 'number') && String(child).length >= 6) this.learnPii(String(child));
    }
  }

  /** Learns secret string values under sensitive keys of a JSON document, and the account's own identifiers. */
  learnFromJson(value: unknown): void {
    if (Array.isArray(value)) value.forEach((v) => this.learnFromJson(v));
    else if (value && typeof value === 'object') {
      this.#learnIdentity(value as Record<string, unknown>);
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && this.isSensitiveKey(key)) this.learnSecret(child);
        else this.learnFromJson(child);
      }
    } else if (typeof value === 'string') {
      for (const match of value.matchAll(JWT_PATTERN)) this.learnSecret(match[0]);
    }
  }

  header(name: string, value: string): string {
    const lower = name.toLowerCase();
    if (lower === 'cookie') {
      return value
        .split(';')
        .map((part) => `${part.split('=')[0]?.trim()}=<redacted:cookie>`)
        .join('; ');
    }
    if (lower === 'set-cookie') {
      return value
        .split('\n')
        .map((line) => {
          const [pair, ...attributes] = line.split(';');
          const cookieName = pair?.split('=')[0]?.trim();
          return [`${cookieName}=<redacted:cookie>`, ...attributes.map((a) => a.trim())].join('; ');
        })
        .join('\n');
    }
    if (lower === 'authorization' || lower === 'proxy-authorization') {
      const [scheme, credentials] = value.split(/\s+/, 2);
      if (!credentials) return '<redacted:credentials>';
      const kind = /^basic$/i.test(scheme ?? '') ? 'basic' : looksLikeJwt(credentials) ? 'jwt' : 'token';
      return `${scheme} <redacted:${kind}>`;
    }
    if (this.isSensitiveHeader(name)) return `<redacted:${looksLikeJwt(value) ? 'jwt' : 'header'}>`;
    return this.string(value);
  }

  url(raw: string): string {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return this.string(raw);
    }
    if (parsed.protocol === 'data:') return 'data:<omitted>';
    for (const [key, value] of [...parsed.searchParams.entries()]) {
      if (SENSITIVE_QUERY_PATTERN.test(key) || this.isSensitiveKey(key)) {
        this.learnSecret(value);
        parsed.searchParams.set(key, `<redacted:query>`);
      }
    }
    if (parsed.username || parsed.password) {
      parsed.username = 'redacted';
      parsed.password = '';
    }
    // URLSearchParams percent-encodes the placeholder; restore it for readability.
    return this.string(parsed.toString().replaceAll('%3Credacted%3Aquery%3E', '<redacted:query>'));
  }

  /** Redacts a request or response body according to its MIME type. */
  body(text: string, mimeType = ''): string {
    const mime = mimeType.toLowerCase();
    if (mime.includes('json') || /^\s*[[{]/.test(text)) {
      try {
        return JSON.stringify(this.json(JSON.parse(text)));
      } catch {
        // Not JSON after all; fall through to plain-text redaction.
      }
    }
    if (mime.includes('x-www-form-urlencoded')) {
      const params = new URLSearchParams(text);
      for (const [key, value] of [...params.entries()]) {
        params.set(key, this.isSensitiveKey(key) ? this.#secretPlaceholder(key, value) : this.string(value));
      }
      return params.toString().replaceAll('%3Credacted%3Asecret%3Aother%3E', '<redacted:secret:other>').replaceAll('%3Credacted%3Asecret%3E', '<redacted:secret>').replaceAll('%3Credacted%3Ajwt%3E', '<redacted:jwt>');
    }
    return this.string(text);
  }

  json(value: unknown, key?: string): unknown {
    if (key !== undefined && IP_KEYS.test(key) && typeof value === 'string' && value) return '<redacted:ip>';
    if (key !== undefined && this.isSensitiveKey(key)) {
      if (typeof value === 'string') return value === '' ? '' : this.#secretPlaceholder(key, value);
      if (typeof value === 'number' && NUMERIC_SECRET_KEY_PATTERN.test(key)) return 0;
    }
    if (Array.isArray(value)) return value.map((v) => this.json(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.json(v, k);
      return out;
    }
    if (typeof value === 'string') return this.#hasSensitiveQuery(value) ? this.url(value) : this.string(value);
    return value;
  }

  /** True for an absolute URL inside a body that carries a token in its query (unsubscribe links, signed URLs). */
  #hasSensitiveQuery(text: string): boolean {
    if (!/^https?:\/\/\S*\?/.test(text)) return false;
    try {
      return [...new URL(text).searchParams.keys()].some((k) => SENSITIVE_QUERY_PATTERN.test(k) || this.isSensitiveKey(k));
    } catch {
      return false;
    }
  }

  string(text: string): string {
    let out = text.replace(JWT_PATTERN, '<redacted:jwt>').replace(EMAIL_PATTERN, (email) => this.#emailPlaceholder(email));
    for (const secret of this.#secrets) if (out.includes(secret)) out = out.split(secret).join('<redacted:secret>');
    for (const value of this.#pii) if (out.includes(value)) out = out.split(value).join('<redacted:pii>');
    return out;
  }

  #emailPlaceholder(email: string): string {
    const lower = email.toLowerCase();
    if (this.#accountEmail === undefined || lower === this.#accountEmail) return '<redacted:email>';
    let n = this.#otherEmails.get(lower);
    if (n === undefined) this.#otherEmails.set(lower, (n = this.#otherEmails.size + 2));
    return `<redacted:email:${n}>`;
  }

  /** Final safety net: scans serialized output for anything that still looks secret. */
  findLeaks(serialized: string): Leak[] {
    const leaks: Leak[] = [];
    for (const match of serialized.matchAll(JWT_PATTERN)) leaks.push({ kind: 'jwt', offset: match.index ?? 0 });
    for (const match of serialized.matchAll(EMAIL_PATTERN)) leaks.push({ kind: 'email', offset: match.index ?? 0 });
    for (const secret of [...this.#secrets, ...(this.#accountSecret ? [this.#accountSecret] : [])]) {
      const index = serialized.indexOf(secret);
      if (index >= 0) leaks.push({ kind: 'secret', offset: index });
    }
    for (const value of this.#pii) {
      const index = serialized.indexOf(value);
      if (index >= 0) leaks.push({ kind: 'pii', offset: index });
    }
    return leaks;
  }
}

export function looksLikeJwt(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/.test(value);
}

/** Decodes the non-secret parts of a JWT: algorithm, claim names and lifetime. Never the signature or claim values. */
export interface JwtInfo {
  alg?: string;
  typ?: string;
  claimNames: string[];
  lifetimeSec?: number;
}

export function describeJwt(token: string): JwtInfo | undefined {
  const [header, payload] = token.split('.');
  if (!header || !payload) return undefined;
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string; typ?: string };
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const lifetimeSec = typeof p.exp === 'number' && typeof p.iat === 'number' ? p.exp - p.iat : undefined;
    return { alg: h.alg, typ: h.typ, claimNames: Object.keys(p).sort(), lifetimeSec };
  } catch {
    return undefined;
  }
}
