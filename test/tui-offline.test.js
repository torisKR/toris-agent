import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/core/store.js';

const bin = fileURLToPath(new URL('../bin/toris.js', import.meta.url));

test('an offline terminal handles local commands and recovers from errors without a model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'toris-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const home = join(root, 'home');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(\'verified offline\')"' } }));
  const child = spawn(process.execPath, [bin, 'chat', '--offline', '--home', home, '--no-color'], {
    cwd, env: { ...process.env, TORIS_CODEX_BIN: join(root, 'missing'), TORIS_CLAUDE_BIN: join(root, 'also-missing') }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const commands = ['hello model', '/diff missing', '/status', '/plan add a health endpoint', '/check', '/receipt', '/exit'];
  let output = ''; let stderr = ''; let pending = ''; let sent = 0;
  child.stdout.on('data', data => {
    const text = data.toString(); output += text; pending += text;
    if (pending.endsWith('> ') && sent < commands.length) {
      pending = ''; child.stdin.write(commands[sent++] + '\n');
    }
  });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timeout);
  assert.equal(code, 0, stderr + output);
  assert.equal(sent, commands.length, 'every local command reached the prompt');
  assert.match(output, /offline/i);
  assert.match(output, /No patch matching/);
  assert.match(output, /Solo workspace/);
  assert.match(output, /PASS.*npm run test/);
  assert.match(output, /Receipt run_/);
  const runs = await new Store(home).listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].dryRun, true);
  assert.equal(runs[0].providerAvailable, false);
});

test('offline execution is refused unless it is a dry run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'toris-offline-exec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [bin, 'run', 'edit the app', '--offline', '--home', root, '--json'], { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.match(JSON.parse(child.stdout).error.message, /offline.*dry-run/i);
  assert.equal((await new Store(root).listRuns()).length, 0);
});
