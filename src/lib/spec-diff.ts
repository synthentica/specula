// Compares the inferred OpenAPI document with the real one (OpenAPI 3.x or Swagger 2.0).

import { shapeOf } from './paths.ts';

type Doc = Record<string, any>;

interface NormalizedOp {
  key: string;
  method: string;
  path: string;
  query: Set<string>;
  request: Map<string, string>;
  response: Map<string, string>;
  responseIsArray: boolean;
  tag: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function resolve(doc: Doc, schema: any, depth = 0): any {
  if (!schema || depth > 8) return schema;
  if (schema.$ref) {
    const path = String(schema.$ref).replace(/^#\//, '').split('/');
    let node: any = doc;
    for (const part of path) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return resolve(doc, node, depth + 1);
  }
  if (schema.allOf) {
    const merged: any = { type: 'object', properties: {} };
    for (const part of schema.allOf) Object.assign(merged.properties, resolve(doc, part, depth + 1)?.properties ?? {});
    return merged;
  }
  if (schema.anyOf || schema.oneOf) {
    const options = (schema.anyOf ?? schema.oneOf).map((s: any) => resolve(doc, s, depth + 1)).filter((s: any) => s && s.type !== 'null');
    return options[0] ?? schema;
  }
  return schema;
}

function typeOf(doc: Doc, schema: any): string {
  const s = resolve(doc, schema);
  if (!s) return 'unknown';
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type;
  // A field only ever seen as null has no comparable type.
  if (t === 'null') return 'unknown';
  if (t) return t === 'number' || t === 'integer' ? 'number' : t;
  if (s.properties) return 'object';
  if (s.items) return 'array';
  return 'unknown';
}

function fields(doc: Doc, schema: any): { props: Map<string, string>; isArray: boolean } {
  let s = resolve(doc, schema);
  let isArray = false;
  if (s && (s.type === 'array' || (Array.isArray(s.type) && s.type.includes('array')) || (!s.properties && s.items))) {
    isArray = true;
    s = resolve(doc, s.items);
  }
  const props = new Map<string, string>();
  const entries = Object.entries<any>(s?.properties ?? {}).filter(([k]) => k !== '$schema');
  for (const [k, v] of entries) props.set(k, typeOf(doc, v));
  // Pagination envelope (one array of objects next to scalar metadata): compare the items too, as `items[].field`.
  const arrays = entries.filter(([, v]) => typeOf(doc, v) === 'array');
  if (arrays.length === 1 && entries.every(([, v]) => typeOf(doc, v) !== 'object')) {
    const [key, schemaOfArray] = arrays[0]!;
    const item = resolve(doc, resolve(doc, schemaOfArray)?.items);
    for (const [k, v] of Object.entries<any>(item?.properties ?? {})) if (k !== '$schema') props.set(`${key}[].${k}`, typeOf(doc, v));
  }
  return { props, isArray };
}

function normalize(doc: Doc, apiPrefix: string): Map<string, NormalizedOp> {
  const swagger2 = !!doc.swagger;
  const serverPath = swagger2 ? (doc.basePath ?? '') : (() => {
    const url = doc.servers?.[0]?.url ?? '';
    try {
      return new URL(url, 'http://x').pathname;
    } catch {
      return url;
    }
  })();
  const out = new Map<string, NormalizedOp>();
  for (const [rawPath, item] of Object.entries<any>(doc.paths ?? {})) {
    let full = `${serverPath.replace(/\/$/, '')}${rawPath}`;
    if (apiPrefix && full.startsWith(apiPrefix)) full = full.slice(apiPrefix.length) || '/';
    const path = shapeOf(full) || '/';
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => resolve(doc, p));
      const query = new Set<string>(params.filter((p: any) => p?.in === 'query').map((p: any) => p.name));
      let requestSchema: any;
      if (swagger2) requestSchema = params.find((p: any) => p?.in === 'body')?.schema;
      else {
        const content = resolve(doc, op.requestBody)?.content ?? {};
        requestSchema = (content['application/json'] ?? Object.values(content)[0])?.schema;
      }
      const ok = Object.entries<any>(op.responses ?? {}).find(([code]) => /^2/.test(code))?.[1];
      let responseSchema: any;
      if (swagger2) responseSchema = resolve(doc, ok)?.schema;
      else {
        const content = resolve(doc, ok)?.content ?? {};
        responseSchema = (content['application/json'] ?? Object.values(content)[0])?.schema;
      }
      const response = fields(doc, responseSchema);
      const key = `${method.toUpperCase()} ${path}`;
      out.set(key, {
        key,
        method: method.toUpperCase(),
        path,
        query,
        request: fields(doc, requestSchema).props,
        response: response.props,
        responseIsArray: response.isArray,
        tag: op.tags?.[0] ?? path.split('/')[1] ?? '',
      });
    }
  }
  return out;
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');

export function diffSpecs(inferred: Doc, truth: Doc, options: { apiPrefix: string }) {
  const a = normalize(inferred, options.apiPrefix);
  const b = normalize(truth, options.apiPrefix);
  const matched = [...a.keys()].filter((k) => b.has(k));
  const extra = [...a.keys()].filter((k) => !b.has(k));
  const unobserved = [...b.keys()].filter((k) => !a.has(k));

  let respTruth = 0;
  let respFound = 0;
  let respInferred = 0;
  let typeAgree = 0;
  let typeCompared = 0;
  let reqTruth = 0;
  let reqFound = 0;
  let queryTruth = 0;
  let queryFound = 0;
  const rows: string[] = [];
  const requestRows: string[] = [];
  for (const key of matched.sort()) {
    const x = a.get(key)!;
    const y = b.get(key)!;
    const missing = [...y.response.keys()].filter((k) => !x.response.has(k));
    const additional = [...x.response.keys()].filter((k) => !y.response.has(k));
    const mismatched = [...x.response.keys()].filter((k) => y.response.has(k) && x.response.get(k) !== 'unknown' && y.response.get(k) !== 'unknown' && x.response.get(k) !== y.response.get(k));
    respTruth += y.response.size;
    respInferred += x.response.size;
    respFound += y.response.size - missing.length;
    for (const k of x.response.keys()) {
      if (!y.response.has(k) || x.response.get(k) === 'unknown' || y.response.get(k) === 'unknown') continue;
      typeCompared++;
      if (x.response.get(k) === y.response.get(k)) typeAgree++;
    }
    reqTruth += y.request.size;
    reqFound += [...y.request.keys()].filter((k) => x.request.has(k)).length;
    queryTruth += y.query.size;
    queryFound += [...y.query].filter((q) => x.query.has(q)).length;
    if (y.request.size || x.request.size) {
      const reqMissing = [...y.request.keys()].filter((k) => !x.request.has(k));
      const reqExtra = [...x.request.keys()].filter((k) => !y.request.has(k));
      requestRows.push(`| \`${key}\` | ${y.request.size - reqMissing.length}/${y.request.size} | ${reqMissing.slice(0, 8).join(', ')}${reqMissing.length > 8 ? ` +${reqMissing.length - 8}` : ''} | ${reqExtra.join(', ')} |`);
    }
    const shapeNote = x.responseIsArray !== y.responseIsArray ? ` array/object mismatch (inferred ${x.responseIsArray ? 'array' : 'object'})` : '';
    rows.push(
      `| \`${key}\` | ${y.response.size - missing.length}/${y.response.size} | ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` +${missing.length - 6}` : ''} | ${additional.slice(0, 4).join(', ')} | ${mismatched.map((k) => `${k} (${x.response.get(k)}≠${y.response.get(k)})`).join(', ')}${shapeNote} | ${[...y.query].filter((q) => x.query.has(q)).length}/${y.query.size} |`,
    );
  }

  const byTag = new Map<string, number>();
  for (const k of unobserved) {
    const tag = b.get(k)!.tag || 'other';
    byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
  }

  const summary = {
    truthOperations: b.size,
    inferredOperations: a.size,
    matchedOperations: matched.length,
    operationPrecision: pct(matched.length, a.size),
    observedShareOfTruth: pct(matched.length, b.size),
    responseFieldRecall: pct(respFound, respTruth),
    responseFieldPrecision: pct(respFound, respInferred),
    responseTypeAgreement: pct(typeAgree, typeCompared),
    requestFieldRecall: pct(reqFound, reqTruth),
    queryParamRecall: pct(queryFound, queryTruth),
  };

  const md = [
    '# Inferred spec vs. real API',
    '',
    `Truth: ${truth.info?.title ?? 'reference spec'} (${truth.openapi ? `OpenAPI ${truth.openapi}` : `Swagger ${truth.swagger}`}${truth.info?.version ? `, version ${truth.info.version}` : ''}). Inferred: spec/openapi.json.`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Operations in the real API | ${b.size} |`,
    `| Operations inferred | ${a.size} |`,
    `| Inferred operations that exist in the real API (precision) | ${matched.length}/${a.size} (${summary.operationPrecision}) |`,
    `| Share of the real API exercised by the recorded flows | ${summary.observedShareOfTruth} |`,
    `| Response fields found, on matched operations (recall) | ${respFound}/${respTruth} (${summary.responseFieldRecall}) |`,
    `| Inferred response fields that exist in the real schema (precision) | ${respFound}/${respInferred} (${summary.responseFieldPrecision}) |`,
    `| Field type agreement | ${typeAgree}/${typeCompared} (${summary.responseTypeAgreement}) |`,
    `| Request body fields found | ${reqFound}/${reqTruth} (${summary.requestFieldRecall}) |`,
    `| Query parameters found | ${queryFound}/${queryTruth} (${summary.queryParamRecall}) |`,
    '',
    'Field recall is limited by what the app sent and received: optional fields that were never present in a response cannot be inferred. Fields of paginated lists are compared as `items[].field`; a field only ever observed as `null` has no comparable type.',
    '',
    '## Matched operations',
    '',
    '| Operation | Response fields found | Missing (sample) | Extra in inferred | Type mismatches | Query params |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Request bodies',
    '',
    'Only fields the app actually sent can be inferred. Real schemas often accept optional fields the UI never sent in the recorded flows, and some reuse the full resource schema as input, so server-set fields (id, created, ...) show up here as not sent.',
    '',
    '| Operation | Fields found | Not sent in recordings | Sent but not in the real schema |',
    '|---|---|---|---|',
    ...requestRows,
    '',
    '## Inferred but not in the real spec',
    '',
    ...(extra.length ? extra.sort().map((k) => `- \`${k}\``) : ['_None._']),
    '',
    '## Real operations never exercised, by tag',
    '',
    ...[...byTag.entries()].sort((x, y) => y[1] - x[1]).map(([tag, n]) => `- ${tag}: ${n}`),
    '',
  ].join('\n');
  return { markdown: md, summary };
}
