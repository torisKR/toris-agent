import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KnowledgeStore, searchIndex, matchDomains } from '../src/core/knowledge/index.js';

test('search ranks domain tags and titles above excerpt noise', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-knowledge-search-'));
  try {
    const store = new KnowledgeStore({ home });
    await store.init({ seed: true });
    const hits = searchIndex(await store.loadIndex(), 'flutter play release');
    assert.ok(hits.length > 0);
    assert.ok(hits.some((hit) => hit.domain === 'flutter-android'));
    const seo = searchIndex(await store.loadIndex(), 'SEO GEO listing');
    assert.ok(seo.some((hit) => hit.domain === 'product-growth'));
    const empty = searchIndex(await store.loadIndex(), '');
    assert.deepEqual(empty, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('matchDomains pins active slugs and keyword overlap', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-knowledge-match-'));
  try {
    const store = new KnowledgeStore({ home });
    await store.init({ seed: true });
    const domains = await store.listDomains();
    const matched = matchDomains(domains, 'expo motion android', { active: ['toris-ops'] });
    assert.equal(matched[0].slug, 'toris-ops');
    assert.ok(matched.some((domain) => domain.slug === 'expo-android'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Korean query hits the solo-revenue pack', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-knowledge-ko-'));
  try {
    const store = new KnowledgeStore({ home });
    await store.init({ seed: true });
    const hits = searchIndex(await store.loadIndex(), '수익화');
    assert.ok(hits.some((hit) => hit.domain === 'solo-revenue'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
