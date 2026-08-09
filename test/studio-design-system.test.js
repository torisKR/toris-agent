import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../src/studio/server.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('DESIGN.md fixes product states, responsive widths, and the publication boundary', async () => {
  const design = await readFile(join(root, 'DESIGN.md'), 'utf8');
  for (const term of ['127.0.0.1:5824', '360–767', '768–1279', '1280+', 'awaiting_review', 'quality_failed', 'submitted', 'live verified', 'PUBLISH <contentId>']) {
    assert.match(design, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('primitive showcase contains the full state and control vocabulary', async () => {
  const html = await readFile(join(root, 'src/studio/ui/design-system.html'), 'utf8');
  const css = `${await readFile(join(root, 'src/studio/ui/tokens.css'), 'utf8')}\n${await readFile(join(root, 'src/studio/ui/components.css'), 'utf8')}`;
  for (const primitive of ['button', 'input', 'textarea', 'select', 'card', 'badge', 'tabs', 'toast', 'dialog', 'progress', 'skeleton', 'empty-state', 'media-frame', 'quality-row']) {
    assert.match(html, new RegExp(`data-primitive="${primitive}"`));
  }
  for (const token of ['--canvas', '--panel', '--accent', '--verified', '--review', '--failure']) assert.match(css, new RegExp(token));
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
});

test('design-system route serves fixed local assets with a restrictive CSP', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-design-route-'));
  const studio = await createStudioServer({ home, host: '127.0.0.1', port: 0, token: 'token' });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    const page = await fetch(`${base}/design-system`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /Toris Studio primitives/);
    assert.equal((await fetch(`${base}/assets/tokens.css`)).status, 200);
    assert.equal(page.headers.has('access-control-allow-origin'), false);
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
});
