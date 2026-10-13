// HAR 1.2 types plus the underscore-prefixed extensions specula adds
// (HAR allows custom fields that start with "_").

import type { JwtInfo } from './redact.ts';

export interface HarHeader {
  name: string;
  value: string;
}

export interface StackFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface Initiator {
  type: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  /** Synchronous frames first, then async parents, each group introduced by its description. */
  stack?: { description?: string; frames: StackFrame[] }[];
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    queryString: HarHeader[];
    cookies: never[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    cookies: never[];
    content: { size: number; mimeType: string; text?: string; encoding?: string; comment?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _requestId: string;
  _resourceType: string;
  /** Wall-clock milliseconds since epoch when the request was issued. */
  _wallTimeMs: number;
  _initiator?: Initiator;
  _failed?: string;
}

export interface Har {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    pages: never[];
    entries: HarEntry[];
    comment?: string;
  };
}

/** One line of <flow>.events.jsonl. `t` is wall-clock ms since epoch. */
export type CaptureEvent =
  | { t: number; type: 'action'; id: string; kind: string; target: ActionTarget; key?: string; valueInfo?: { type: string; length: number }; url: string }
  | { t: number; type: 'navigation'; url: string; sameDocument: boolean }
  | { t: number; type: 'ws-open'; requestId: string; url: string }
  | { t: number; type: 'ws-frame'; requestId: string; direction: 'sent' | 'received'; opcode: number; payload: string; truncated?: boolean }
  | { t: number; type: 'ws-close'; requestId: string }
  | { t: number; type: 'sse'; requestId: string; eventName: string; data: string }
  | { t: number; type: 'capture-start' | 'capture-stop'; url: string };

export interface ActionTarget {
  tag: string;
  role?: string;
  name?: string;
  id?: string;
  testId?: string;
  type?: string;
  href?: string;
  selector: string;
}

export interface ScriptRecord {
  url: string;
  sha256: string;
  file: string;
  length: number;
  sourceMapUrl?: string;
  sourceMapFile?: string;
  firstParty: boolean;
  /** Third-party script kept because it issued requests to the target (app code on a CDN). */
  callsTarget?: boolean;
}

export interface AuthFacts {
  authorization: { scheme: string; count: number; firstEntry: number; jwt?: JwtInfo }[];
  cookiesSent: string[];
  cookiesSet: { name: string; attributes: string[]; entry: number }[];
  csrfHeaders: string[];
  tokenFieldsInResponses: { entry: number; path: string; kind: 'jwt' | 'opaque' }[];
}

export function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}
