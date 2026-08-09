import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { HttpError, Router, assertStudioMutation, readJson, resolveStaticFile } from '../src/studio/http.js';

function request(body, headers = {}) {
  const stream = Readable.from(body == null ? [] : [body]);
  stream.method = 'POST';
  stream.headers = headers;
  return stream;
}

test('readJson accepts bounded objects and rejects malformed or oversized input', async () => {
  assert.deepEqual(await readJson(request('{"title":"ok"}'), { limitBytes: 64 }), { title: 'ok' });
  await assert.rejects(readJson(request('{oops'), { limitBytes: 64 }), (error) => error instanceof HttpError && error.status === 400);
  await assert.rejects(readJson(request('x'.repeat(65)), { limitBytes: 64 }), (error) => error instanceof HttpError && error.status === 413);
});

test('mutations require the exact local origin and session token', () => {
  const valid = request(null, { origin: 'http://127.0.0.1:5824', 'x-toris-studio-token': 'secret' });
  assert.doesNotThrow(() => assertStudioMutation(valid, { token: 'secret' }));
  assert.throws(() => assertStudioMutation(request(null, { origin: 'http://localhost:5824', 'x-toris-studio-token': 'secret' }), { token: 'secret' }), /origin/);
  assert.throws(() => assertStudioMutation(request(null, { origin: 'http://127.0.0.1:5824' }), { token: 'secret' }), /token/);
});

test('GET and HEAD remain readable without mutation credentials', () => {
  for (const method of ['GET', 'HEAD']) {
    const input = request(null);
    input.method = method;
    assert.doesNotThrow(() => assertStudioMutation(input, { token: 'secret' }));
  }
});

test('Router matches fixed and named routes without accepting extra path segments', () => {
  const router = new Router();
  const handler = () => 'ok';
  router.add('GET', '/api/contents/:id', handler);
  assert.deepEqual(router.match('GET', '/api/contents/cnt_1'), { handler, params: { id: 'cnt_1' } });
  assert.equal(router.match('GET', '/api/contents/cnt_1/more'), null);
  assert.equal(router.match('POST', '/api/contents/cnt_1'), null);
});

test('static file resolution stays inside the configured public directory', () => {
  const root = '/tmp/toris-studio-public';
  assert.equal(resolveStaticFile(root, '/assets/app.js'), join(root, 'assets/app.js'));
  assert.throws(() => resolveStaticFile(root, '/../package.json'), /path/);
  assert.throws(() => resolveStaticFile(root, '/%2e%2e/package.json'), /path/);
});
