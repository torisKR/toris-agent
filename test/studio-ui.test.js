import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../src/studio/server.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('product shell contains queue, editor, media review, quality, and guarded publish regions', async () => {
  const html = await readFile(join(root, 'src/studio/ui/index.html'), 'utf8');
  for (const id of ['review-queue', 'content-workspace', 'post-form', 'video-import', 'media-preview', 'quality-panel', 'render-form', 'render-button', 'evidence-receipt', 'publish-dialog', 'live-status']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /PUBLISH &lt;contentId&gt;/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<meta name="description"/);
  assert.match(html, /<link rel="icon" href="\/assets\/favicon\.svg"/);
  assert.match(html, /class="brand-mark" aria-hidden="true"/);
  assert.match(html, /role="group" aria-label="콘텐츠 필터"/);
  assert.equal((html.match(/aria-pressed="(?:true|false)"/g) || []).length, 3);
  assert.equal((html.match(/aria-controls="review-queue"/g) || []).length, 3);
});

test('product assets use only local API paths and define all responsive shells', async () => {
  const js = await readFile(join(root, 'src/studio/ui/app.js'), 'utf8');
  const components = await readFile(join(root, 'src/studio/ui/components.css'), 'utf8');
  const css = await readFile(join(root, 'src/studio/ui/studio.css'), 'utf8');
  for (const path of ['/api/session', '/api/contents', '/api/renders', '/api/jobs', '/review', '/release-check', '/upload', '/media']) assert.match(js, new RegExp(path.replaceAll('/', '\\/')));
  assert.match(js, /event\.key !== 'Escape'/);
  assert.match(js, /setAttribute\('aria-pressed'/);
  assert.doesNotMatch(js, /https?:\/\//);
  assert.match(css, /grid-template-columns:\s*248px/);
  assert.match(css, /max-width:\s*1279px/);
  assert.match(css, /max-width:\s*767px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /min-height:\s*var\(--queue-reserve\)/);
  assert.doesNotMatch(`${components}\n${css}`, /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i);
});

test('root app and fixed product assets are served with CSP', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-ui-route-'));
  const studio = await createStudioServer({ home, host: '127.0.0.1', port: 0, token: 'token' });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /Toris Studio/);
    assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/studio.css`)).status, 200);
    assert.equal((await fetch(`${base}/assets/favicon.svg`)).status, 200);
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
});
