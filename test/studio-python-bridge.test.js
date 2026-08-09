import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAutoShorts, runProcess } from '../src/studio/python-bridge.js';

test('runProcess uses stdin JSON and parses the final stdout object', async () => {
  const result = await runProcess({
    bin: process.execPath,
    args: ['-e', "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>console.log(JSON.stringify({received:JSON.parse(data),ok:true})))"],
    input: { contentId: 'cnt_1' },
    timeoutMs: 2_000,
  });
  assert.deepEqual(result, { received: { contentId: 'cnt_1' }, ok: true });
});

test('runProcess rejects non-zero exits with a bounded stderr tail', async () => {
  await assert.rejects(runProcess({
    bin: process.execPath,
    args: ['-e', "process.stderr.write('x'.repeat(200));process.exit(2)"],
    maxOutputBytes: 64,
  }), (error) => error.code === 'PYTHON_EXIT' && error.exitCode === 2 && error.stderr.length === 64);
});

test('runProcess kills commands that exceed the timeout', async () => {
  await assert.rejects(runProcess({
    bin: process.execPath,
    args: ['-e', 'setTimeout(()=>{}, 10_000)'],
    timeoutMs: 40,
  }), (error) => error.code === 'PYTHON_TIMEOUT');
});

test('runProcess rejects output beyond the configured cap', async () => {
  await assert.rejects(runProcess({
    bin: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(65))"],
    maxOutputBytes: 64,
  }), (error) => error.code === 'PYTHON_OUTPUT_LIMIT');
});

test('spawn options are always shell-free with an explicit cwd and environment', async () => {
  let captured;
  const spawn = (bin, args, options) => {
    captured = { bin, args, options };
    return {
      stdin: { end() {} },
      stdout: { on() {} },
      stderr: { on() {} },
      once(event, handler) { if (event === 'close') queueMicrotask(() => handler(0, null)); },
      kill() {},
    };
  };
  await runProcess({ bin: '/fixed/python', args: ['-m', 'auto_shorts'], cwd: '/fixed/project', env: { SAFE: '1' }, spawn });
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.cwd, '/fixed/project');
  assert.equal(captured.options.env.SAFE, '1');
  assert.deepEqual(captured.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(captured.options.detached, process.platform !== 'win32');
});

test('timeout terminates the detached process group on POSIX', async () => {
  if (process.platform === 'win32') return;
  let killed;
  const spawn = () => ({
    pid: 321,
    stdin: { end() {} },
    stdout: { on() {} },
    stderr: { on() {} },
    once() {},
    kill() { throw new Error('single-process fallback should not run'); },
  });
  await assert.rejects(runProcess({
    bin: '/fixed/python',
    spawn,
    kill: (pid, signal) => { killed = { pid, signal }; },
    timeoutMs: 10,
  }), (error) => error.code === 'PYTHON_TIMEOUT');
  assert.deepEqual(killed, { pid: -321, signal: 'SIGKILL' });
});

test('auto_shorts runs without writing Python bytecode into the bundled source', async () => {
  let captured;
  const spawn = (bin, args, options) => {
    captured = { bin, args, options };
    return {
      stdin: { end() {} },
      stdout: { on() {} },
      stderr: { on() {} },
      once(event, handler) { if (event === 'close') queueMicrotask(() => handler(0, null)); },
      kill() {},
    };
  };
  await runAutoShorts({ pythonPath: '/fixed/python', projectRoot: '/fixed/bundle', spawn });
  assert.equal(captured.options.env.PYTHONDONTWRITEBYTECODE, '1');
});
