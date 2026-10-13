import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeJwt, Redactor } from '../src/lib/redact.ts';

// Synthetic, unsigned test token: {"alg":"HS256","typ":"JWT"}.{"sub":"1","iat":1000,"exp":4600}.sig
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiaWF0IjoxMDAwLCJleHAiOjQ2MDB9.c2lnbmF0dXJl';

test('authorization header keeps the scheme and marks the token kind', () => {
  const r = new Redactor();
  assert.equal(r.header('Authorization', `Bearer ${JWT}`), 'Bearer <redacted:jwt>');
  assert.equal(r.header('authorization', 'Bearer opaque-token-123'), 'Bearer <redacted:token>');
  assert.equal(r.header('Authorization', 'Basic dXNlcjpwYXNz'), 'Basic <redacted:basic>');
});

test('cookies keep names and attributes, never values', () => {
  const r = new Redactor();
  assert.equal(r.header('Cookie', 'sid=abc123; theme=dark'), 'sid=<redacted:cookie>; theme=<redacted:cookie>');
  assert.equal(r.header('Set-Cookie', 'sid=abc123; Path=/; HttpOnly; SameSite=Lax'), 'sid=<redacted:cookie>; Path=/; HttpOnly; SameSite=Lax');
});

test('JSON bodies: sensitive keys redacted, shape and non-secret types preserved', () => {
  const r = new Redactor();
  const out = JSON.parse(
    r.body(JSON.stringify({ username: 'u', password: 'hunter22', token: JWT, totp_enabled: true, nested: { refresh_token: 'x'.repeat(20), count: 3 } }), 'application/json'),
  );
  assert.deepEqual(out, { username: 'u', password: '<redacted:secret>', token: '<redacted:jwt>', totp_enabled: true, nested: { refresh_token: '<redacted:secret>', count: 3 } });
});

test('learned secrets are scrubbed everywhere, including URLs', () => {
  const r = new Redactor();
  r.learnFromHeader('Authorization', 'Bearer opaque-token-abcdef');
  assert.equal(r.url('http://x.test/api/feed?format=ics&t=opaque-token-abcdef'), 'http://x.test/api/feed?format=ics&t=<redacted:secret>');
  assert.equal(r.url('http://x.test/cb?code=abc&state=def&page=2'), 'http://x.test/cb?code=<redacted:query>&state=<redacted:query>&page=2');
});

test('the bare id inside a versioned tracking cookie is scrubbed from tag URLs', () => {
  const r = new Redactor();
  r.learnFromHeader('Cookie', '_gcl_au=1.1.1234567890.1700000000; _ga=GA1.1.987654321.1700000001');
  assert.equal(
    r.url('https://ads.example.test/collect?auid=1234567890.1700000000&cid=987654321.1700000001&en=page_view'),
    'https://ads.example.test/collect?auid=<redacted:secret>&cid=<redacted:secret>&en=page_view',
  );
});

test('camelCase password fields are redacted, and the account password never passes the leak scan', () => {
  const r = new Redactor({ accountSecret: 'Parity-Pass-2026' });
  assert.deepEqual(r.json({ adminEmail: 'a@example.org', adminPassword: 'Parity-Pass-2026', adminPasswordConfirm: 'Parity-Pass-2026' }), {
    adminEmail: '<redacted:email>',
    adminPassword: '<redacted:secret>',
    adminPasswordConfirm: '<redacted:secret>',
  });
  assert.equal(r.findLeaks('{"note":"Parity-Pass-2026"}')[0]?.kind, 'secret');
});

test('a key seen in a later URL query is scrubbed from an earlier page body', () => {
  const r = new Redactor();
  r.learnFromUrl('http://x.test/api/content/settings/?key=957d4ca4123e2382');
  assert.equal(r.string('<script data-key="957d4ca4123e2382"></script>'), '<script data-key="<redacted:secret>"></script>');
});

test('emails and configured PII values are replaced; asset names are not mistaken for emails', () => {
  const r = new Redactor({ values: ['wp-tester'] });
  assert.equal(r.string('Hi wp-tester <someone@example.org>'), 'Hi <redacted:pii> <<redacted:email>>');
  assert.equal(r.string('/img/logo@2x.png'), '/img/logo@2x.png');
});

test('URLs inside JSON bodies lose token query parameters and keep the rest', () => {
  const r = new Redactor();
  const out = JSON.parse(r.body(JSON.stringify({ unsubscribe_url: 'http://localhost:1/unsubscribe/?uuid=abc&key=deadbeef00', avatar: 'https://img.test/a.png?s=250' }), 'application/json'));
  assert.equal(out.unsubscribe_url, 'http://localhost:1/unsubscribe/?uuid=abc&key=<redacted:query>');
  assert.equal(out.avatar, 'https://img.test/a.png?s=250');
});

test('form bodies are redacted per field', () => {
  const r = new Redactor();
  assert.equal(r.body('user=a&password=b', 'application/x-www-form-urlencoded'), 'user=a&password=<redacted:secret>');
});

test('a password other than the account secret keeps a distinct placeholder', () => {
  const r = new Redactor({ accountSecret: 'Right-Pass-1' });
  assert.deepEqual(r.json({ username: 'a', password: 'Right-Pass-1' }), { username: 'a', password: '<redacted:secret>' });
  assert.deepEqual(r.json({ password: 'Wrong-Pass-1', token: 'opaque-abc' }), { password: '<redacted:secret:other>', token: '<redacted:secret>' });
  assert.equal(r.body('user=a&password=Wrong-Pass-1', 'application/x-www-form-urlencoded'), 'user=a&password=<redacted:secret:other>');
  assert.deepEqual(new Redactor().json({ password: 'Wrong-Pass-1' }), { password: '<redacted:secret>' });
});

test('leak scan finds anything left over', () => {
  const r = new Redactor({ values: ['wp-tester'] });
  r.learnSecret('super-secret-value');
  const leaks = r.findLeaks(`{"a":"${JWT}","b":"x@y.io","c":"super-secret-value","d":"wp-tester"}`).map((l) => l.kind);
  assert.deepEqual(leaks.sort(), ['email', 'jwt', 'pii', 'secret']);
  assert.deepEqual(r.findLeaks('{"a":"<redacted:jwt>"}'), []);
});

test('describeJwt exposes only algorithm, claim names and lifetime', () => {
  assert.deepEqual(describeJwt(JWT), { alg: 'HS256', typ: 'JWT', claimNames: ['exp', 'iat', 'sub'], lifetimeSec: 3600 });
});

test('other people\'s email addresses get a stable number, the account keeps the plain placeholder', () => {
  const r = new Redactor({ accountEmail: 'Owner@example.org' });
  assert.deepEqual(r.json({ owner: 'owner@example.org', invited: 'robin@example.org', again: 'Robin@example.org', third: 'kim@example.org' }), {
    owner: '<redacted:email>',
    invited: '<redacted:email:2>',
    again: '<redacted:email:2>',
    third: '<redacted:email:3>',
  });
  assert.equal(new Redactor().string('robin@example.org'), '<redacted:email>');
});

test("the account's own name and a linked provider's user id are learned and scrubbed everywhere", () => {
  const r = new Redactor({ accountEmail: 'me@example.test' });
  const me = { id: 'u1', name: 'quietfox77', email: 'me@example.test', username: 'me@example.test', image: 'https://avatars.example.test/u/90817263?v=4' };
  const accounts = [{ providerId: 'github', accountId: '90817263', userId: 'u1' }, { providerId: 'credential', accountId: 'u1', userId: 'u1' }];
  const teammate = { name: 'Someone Else', email: 'other@example.test' };
  for (const doc of [me, accounts, teammate]) r.learnFromJson(doc);
  // An earlier page that named the account before any of the JSON above was seen.
  const page = r.body('<p>Signed in as quietfox77</p>', 'text/html');
  assert.equal(page, '<p>Signed in as <redacted:pii></p>');
  const out = JSON.parse(r.body(JSON.stringify({ me, accounts, teammate }), 'application/json'));
  assert.equal(out.me.name, '<redacted:pii>');
  assert.equal(out.me.image, 'https://avatars.example.test/u/<redacted:pii>?v=4');
  assert.equal(out.accounts[0].accountId, '<redacted:pii>');
  assert.equal(out.accounts[1].accountId, 'u1', 'a local sign-in method keeps its own id');
  assert.equal(out.teammate.name, 'Someone Else', "another person's name is not the account's");
  assert.deepEqual(r.findLeaks(JSON.stringify(out)), []);
  const session = JSON.parse(r.body(JSON.stringify({ session: { ipAddress: '198.51.100.7', userAgent: 'Mozilla/5.0' } }), 'application/json'));
  assert.deepEqual(session, { session: { ipAddress: '<redacted:ip>', userAgent: 'Mozilla/5.0' } }, 'the client address a session recorded');
});
