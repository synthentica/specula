import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphqlLabel, graphqlRequests, normalizeDocument, operationKey, parseOperation } from '../src/lib/graphql.ts';

const CREATE = `mutation ($content: String!, $tags: [String]!, $title: String!) {
  pages {
    create(content: $content, tags: $tags, title: $title) {
      responseResult { succeeded errorCode __typename }
      page { id updatedAt __typename }
      __typename
    }
    __typename
  }
}`;

test('an anonymous operation is named by its type and namespace field, and variables know their field', () => {
  const op = parseOperation(CREATE)!;
  assert.equal(op.type, 'mutation');
  assert.deepEqual(op.fields, ['pages.create']);
  assert.deepEqual(op.args.map((a) => [a.variable, a.argument, a.field.join('.')]), [
    ['content', 'content', 'pages.create'],
    ['tags', 'tags', 'pages.create'],
    ['title', 'title', 'pages.create'],
  ]);
  assert.equal(operationKey({ query: CREATE, operationName: null }), 'mutation pages.create');
  assert.equal(operationKey({ query: CREATE, operationName: 'CreatePage' }), 'CreatePage');
});

test('shorthand queries, literal arguments, aliases, fragments and nested variables', () => {
  const op = parseOperation(`{ authentication { activeStrategies(enabledOnly: true) { key } } system { info { pagesTotal } } }`)!;
  assert.equal(op.type, 'query');
  assert.deepEqual(op.fields, ['authentication.activeStrategies', 'system.info']);
  const nested = parseOperation(`query Find($q: String, $ids: [Int]) { # comment
    hits: search(filter: { text: $q, any: [$ids] }) @include(if: true) { ... on Page { id } }
  }`)!;
  assert.equal(nested.name, 'Find');
  assert.deepEqual(nested.fields, ['search']);
  assert.deepEqual(nested.args.map((a) => [a.variable, a.argument]), [['q', 'text'], ['ids', 'any']]);
});

test('batched bodies, labels and normalized documents', () => {
  const batch = [{ query: CREATE, variables: {} }, { query: '{ pages { tags { tag } } }' }];
  assert.equal(graphqlRequests(batch)?.length, 2);
  assert.equal(graphqlRequests({ title: 'not graphql' }), undefined);
  assert.equal(graphqlLabel(JSON.stringify(batch)), 'mutation pages.create + query pages.tags');
  assert.equal(graphqlLabel('{"title":"x"}'), undefined);
  assert.equal(normalizeDocument('query ($id: Int!) {\n  pages {\n    single(id: $id) { id }\n  }\n}'), 'query($id:Int!){pages{single(id:$id){id}}}');
});
