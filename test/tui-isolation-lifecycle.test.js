import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const cli = resolve('bin/toris.js');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'toris-tui-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await Promise.all([mkdir(project), mkdir(home), mkdir(bin)]);
  const calls = join(root, 'calls.jsonl');
  const executable = join(bin, 'local-fakecodex');
  await writeFile(executable, `#!${process.execPath}\nconst {appendFileSync,writeFileSync}=require('node:fs');
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({cwd:process.cwd()})+'\\n');
writeFileSync('edited.txt', 'synthetic local change\\n');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic local reply'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));\n`);
  await chmod(executable, 0o755);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: project, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  await writeFile(join(project, 'base.txt'), 'base\n');
  git('add', 'base.txt');
  git('-c', 'user.name=Local QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'fixture');
  await writeFile(join(home, 'config.json'), JSON.stringify({
    defaultAutonomy: 'L2', knowledge: { autoRetrieve: false },
    providers: { codex: { bin: 'local-fakecodex', enabled: true } },
    models: { profiles: { local: { provider: 'codex-cli', model: 'auto' } }, routing: { chat: 'local' } },
  }));
  return { home, project, env, git, calls };
}

/** Send a command only once the real REPL is ready for it. */
function conversation({ home, project, env }, commands, flags = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, 'chat', '--home', home, '--no-color', ...flags],
      { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let pending = ''; let next = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`REPL did not finish: ${stdout}`)); }, 5000);
    child.stdout.on('data', chunk => {
      const text = String(chunk); stdout += text; pending += text;
      if (pending.endsWith('> ') && next < commands.length) {
        pending = '';
        child.stdin.write(`${commands[next++]}\n`);
      }
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, sent: next }); });
  });
}

for (const action of ['discard', 'apply']) {
  test(`live /${action} ends the CLI session with restart guidance and no later model calls`, async t => {
    const f = await fixture(t);
    const result = await conversation(f, ['make a local change', `/${action}`, 'later model turn', 'q']);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Restart toris/i);
    assert.equal(result.sent, 2, 'session closes before asking for another model turn');
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 1);
    assert.equal(f.git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
    if (action === 'discard') {
      assert.equal(f.git('status', '--porcelain'), '');
      assert.equal(await readFile(join(f.project, 'edited.txt'), 'utf8').catch(() => null), null);
    } else {
      assert.equal(await readFile(join(f.project, 'edited.txt'), 'utf8'), 'synthetic local change\n');
    }
  });
}

test('offline /discard reports no live isolation and keeps local commands usable', async t => {
  const f = await fixture(t);
  const result = await conversation(f, ['/discard', '/status', 'q'], ['--offline']);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /no.*(?:live.*)?isolat/i);
  assert.match(result.stdout, /Solo workspace/);
  assert.equal(result.sent, 3);
  assert.equal(await readFile(f.calls, 'utf8').catch(() => null), null);
  assert.equal(f.git('status', '--porcelain'), '');
});
