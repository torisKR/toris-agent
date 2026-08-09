import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentStore } from '../src/studio/content-store.js';
import { RenderService } from '../src/studio/render-service.js';

test('render service materialises an ID-scoped plan and stores passing quality evidence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-render-service-'));
  const contents = await new ContentStore(home, { idFactory: () => 'cnt_source' }).init();
  const original = join(home, 'studio', 'content', 'cnt_source', 'original', 'source.mp4');
  const calls = [];
  try {
    await writeFile(original, 'source', { flag: 'wx' }).catch(async () => {
      const { mkdir } = await import('node:fs/promises'); await mkdir(join(home, 'studio', 'content', 'cnt_source', 'original'), { recursive: true }); await writeFile(original, 'source');
    });
    await contents.create({ kind: 'video', title: 'source', media: { name: 'source.mp4', path: original, mime: 'video/mp4', size: 6, sha256: 'source-hash' } });
    const service = new RenderService({
      home,
      contents,
      pythonPath: '/fixed/python',
      bundleRoot: '/fixed/bundle',
      runAutoShorts: async (options) => {
        calls.push(options);
        if (options.args[0] === 'render') {
          const output = options.args.at(-1);
          await writeFile(output, 'rendered-video');
          return { status: 'rendered', output, duration: 15, segments: 1 };
        }
        return { status: 'quality_checked', passed: true, rules: [{ name: 'resolution', measured: '1080x1920', expected: '1080x1920', passed: true }] };
      },
    });
    const result = await service.render({ contentId: 'cnt_source', title: 'QA render', text: '검토 가능한 렌더', targetDuration: 15 });
    assert.equal(result.status, 'awaiting_review');
    assert.equal(result.quality.passed, true);
    assert.equal(result.media.path.startsWith(join(home, 'studio', 'content', 'cnt_source', 'render')), true);
    assert.deepEqual(calls.map((call) => call.args[0]), ['render', 'quality']);
    const plan = JSON.parse(await readFile(join(home, 'studio', 'content', 'cnt_source', 'plan', 'plan.json'), 'utf8'));
    assert.equal(plan.segments[0].source, original);
    assert.equal(plan.target_duration, 15);
    const rerendered = await service.render({ contentId: 'cnt_source', title: 'QA rerender', text: '원본으로 다시 렌더', targetDuration: 15 });
    const secondPlan = JSON.parse(await readFile(join(home, 'studio', 'content', 'cnt_source', 'plan', 'plan.json'), 'utf8'));
    assert.equal(secondPlan.segments[0].source, original);
    assert.equal(rerendered.render.sourceMedia.path, original);
    assert.deepEqual(calls.map((call) => call.args[0]), ['render', 'quality', 'render', 'quality']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('render service rejects media paths outside TORIS_HOME before spawning Python', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-render-boundary-'));
  const contents = await new ContentStore(home, { idFactory: () => 'cnt_bad' }).init();
  let called = false;
  try {
    await contents.create({ kind: 'video', title: 'bad', media: { name: 'bad.mp4', path: '/tmp/outside.mp4', mime: 'video/mp4' } });
    const service = new RenderService({ home, contents, runAutoShorts: async () => { called = true; } });
    await assert.rejects(service.render({ contentId: 'cnt_bad', title: 'x', text: 'x', targetDuration: 15 }), /outside/);
    assert.equal(called, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
