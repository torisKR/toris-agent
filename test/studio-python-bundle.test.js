import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'python', 'auto_shorts');

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else files.push(child);
  }
  return files;
}

test('the bundled auto_shorts engine contains the local render and draft contracts', async () => {
  const required = [
    'pyproject.toml',
    'src/auto_shorts/__main__.py',
    'src/auto_shorts/cli.py',
    'src/auto_shorts/media.py',
    'src/auto_shorts/models.py',
    'src/auto_shorts/publish.py',
    'src/auto_shorts/social_agents.py',
    'tests/test_media_smoke.py',
    'tests/test_publish.py',
    'tests/test_social_agents.py',
  ];
  await Promise.all(required.map((path) => access(join(bundle, path))));

  const metadata = JSON.parse(await readFile(join(bundle, 'BUNDLE.json'), 'utf8'));
  assert.equal(metadata.source, '/Users/toris/projects/auto_shorts');
  assert.equal(metadata.package, 'auto-shorts');
  assert.equal(metadata.version, '0.1.0');
});

test('the engine snapshot excludes runtime state and credentials', async () => {
  const files = (await walk(bundle)).map((path) => path.slice(bundle.length + 1));
  for (const forbidden of ['.venv', '.env', '__pycache__', '.egg-info', 'output/', 'assets/']) {
    assert.equal(files.some((path) => path.includes(forbidden)), false, forbidden);
  }
});
