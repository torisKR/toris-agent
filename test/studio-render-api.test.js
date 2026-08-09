import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';

test('render API queues bundled render and persists quality evidence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-render-api-'));
  const calls = [];
  const studio = await createStudioServer({
    home, host: '127.0.0.1', port: 0, token: 'token', pythonPath: '/fixed/python', bundleRoot: '/fixed/bundle',
    runAutoShorts: async (options) => {
      calls.push(options.args[0]);
      if (options.args[0] === 'render') { await writeFile(options.args.at(-1), 'rendered'); return { status: 'rendered', duration: 15, segments: 1 }; }
      return { status: 'quality_checked', passed: true, rules: [{ name: 'duration', measured: 15, expected: '15-60s', passed: true }] };
    },
  });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  const mutate = (body, type = 'application/json') => ({ method: 'POST', headers: { origin: base, 'x-toris-studio-token': 'token', 'content-type': type }, body });
  try {
    const content = await (await fetch(`${base}/api/contents`, mutate(JSON.stringify({ kind: 'video', title: 'source' })))).json();
    const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);
    await fetch(`${base}/api/contents/${content.id}/upload`, mutate(mp4, 'video/mp4'));
    const response = await fetch(`${base}/api/renders`, mutate(JSON.stringify({ contentId: content.id, title: 'QA render', text: '검토 가능한 렌더', targetDuration: 15 })));
    assert.equal(response.status, 202);
    const job = await response.json();
    let current;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      current = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
      if (current.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(current.status, 'succeeded');
    assert.deepEqual(calls, ['render', 'quality']);
    const rendered = await (await fetch(`${base}/api/contents/${content.id}`)).json();
    assert.equal(rendered.status, 'awaiting_review');
    assert.equal(rendered.quality.passed, true);
    assert.equal((await (await fetch(`${base}/api/contents/${content.id}/quality`)).json()).passed, true);
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
});
