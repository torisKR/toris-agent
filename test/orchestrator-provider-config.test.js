import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Orchestrator } from '../src/core/orchestrator.js';
import { ADAPTERS } from '../src/core/providers.js';

test('run provider resolution uses the configured CLI binary and preserves its adapter', async () => {
  const engine = new Orchestrator({
    config: { providers: { codex: { bin: 'custom-codex', enabled: true } } },
    detect: bin => bin === 'custom-codex',
  });
  const before = ADAPTERS.codex.bin;
  const result = await engine.resolveProvider('codex');
  assert.equal(result.available, true);
  assert.equal(result.adapter.name, 'codex');
  assert.equal(result.adapter.bin, 'custom-codex');
  assert.equal(result.adapter.args, ADAPTERS.codex.args);
  assert.equal(result.adapter.parse, ADAPTERS.codex.parse);
  assert.equal(ADAPTERS.codex.bin, before, 'the shared adapter is unchanged');
});

test('disabled implementer providers are skipped even if installed', async () => {
  const engine = new Orchestrator({
    config: { providers: { codex: { enabled: false }, claude: { enabled: true } } },
    detect: () => true,
  });
  const result = await engine.resolveProvider('codex');
  assert.equal(result.adapter.name, 'claude');
  assert.equal(result.available, true);
});

test('no enabled available CLI leaves a nonavailable adapter for deterministic planning', async () => {
  const engine = new Orchestrator({
    config: { providers: { codex: { bin: 'custom-codex', enabled: false }, claude: { enabled: false } } },
    detect: () => true,
  });
  const result = await engine.resolveProvider('codex');
  assert.equal(result.adapter.name, 'codex');
  assert.equal(result.available, false);
});

test('reviewer resolution uses its configured CLI binary', async () => {
  const engine = new Orchestrator({
    config: { providers: { claude: { bin: 'custom-claude', enabled: true } } },
    detect: bin => bin === 'custom-claude',
  });
  const reviewer = await engine.resolveReviewer('codex');
  assert.equal(reviewer?.name, 'claude');
  assert.equal(reviewer?.bin, 'custom-claude');
});

test('an explicitly disabled reviewer is not invoked', async () => {
  const engine = new Orchestrator({
    config: { providers: { claude: { enabled: false } } },
    detect: () => true,
  });
  assert.equal(await engine.resolveReviewer('codex'), null);
});

test('provider environment binary overrides retain precedence over config defaults', () => {
  const url = new URL('../src/core/orchestrator.js', import.meta.url).href;
  const code = `import {Orchestrator} from ${JSON.stringify(url)};
const engine=new Orchestrator({config:{providers:{codex:{bin:'codex',enabled:true}}},detect:bin=>bin==='environment-codex'});
const result=await engine.resolveProvider('codex');
console.log(JSON.stringify({available:result.available,bin:result.adapter.bin}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, TORIS_CODEX_BIN: 'environment-codex' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { available: true, bin: 'environment-codex' });
});
