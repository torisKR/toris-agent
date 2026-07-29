import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultTools } from '../src/core/tools.js';

/**
 * `createDefaultTools` is the whole blast radius of a chat session: it is the
 * only place the model can touch the disk or the shell. These tests pin the two
 * properties that keep that safe — paths cannot escape the workspace, and the
 * mutating tools stay behind an approval gate — plus the process-control
 * contract that the native layer exists to provide.
 */

/** Fresh workspace + the tool table pointed at it. */
async function withWorkspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toris-tools-')));
  const tools = createDefaultTools({ cwd: root });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, tools, byName, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('mutating tools stay behind the approval gate', async () => {
  const { tools, cleanup } = await withWorkspace();
  try {
    const gated = tools
      .filter((t) => t.needsApproval)
      .map((t) => t.name)
      .sort();
    // If this drifts, the autonomy level silently stops gating side effects.
    assert.deepEqual(gated, ['run_command', 'write_file']);

    const readOnly = tools
      .filter((t) => !t.needsApproval)
      .map((t) => t.name)
      .sort();
    assert.deepEqual(readOnly, ['list_files', 'read_file']);
  } finally {
    await cleanup();
  }
});

test('every tool declares a name, description and schema', async () => {
  const { tools, cleanup } = await withWorkspace();
  try {
    for (const tool of tools) {
      assert.ok(tool.name, 'tool needs a name');
      assert.ok(tool.description?.length > 20, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} needs an object schema`);
      assert.equal(typeof tool.run, 'function', `${tool.name} needs a run()`);
    }
  } finally {
    await cleanup();
  }
});

test('read_file returns file contents', async () => {
  const { root, byName, cleanup } = await withWorkspace();
  try {
    await writeFile(join(root, 'hello.txt'), 'well hello', 'utf8');
    assert.equal(await byName.read_file.run({ path: 'hello.txt' }), 'well hello');
  } finally {
    await cleanup();
  }
});

test('relative traversal cannot escape the workspace', async () => {
  const { byName, cleanup } = await withWorkspace();
  try {
    await assert.rejects(
      () => byName.read_file.run({ path: '../../etc/passwd' }),
      /E_PATH_ESCAPE|outside the workspace/,
    );
  } finally {
    await cleanup();
  }
});

test('an absolute path cannot escape the workspace', async () => {
  const { byName, cleanup } = await withWorkspace();
  try {
    await assert.rejects(
      () => byName.read_file.run({ path: '/etc/passwd' }),
      /E_PATH_ESCAPE|outside the workspace/,
    );
  } finally {
    await cleanup();
  }
});

test('write_file cannot plant a file outside the workspace', async () => {
  const { byName, cleanup } = await withWorkspace();
  try {
    await assert.rejects(
      () => byName.write_file.run({ path: '../escaped.txt', content: 'nope' }),
      /E_PATH_ESCAPE|outside the workspace/,
    );
  } finally {
    await cleanup();
  }
});

test('list_files cannot enumerate outside the workspace', async () => {
  const { byName, cleanup } = await withWorkspace();
  try {
    await assert.rejects(
      () => byName.list_files.run({ path: '..' }),
      /E_PATH_ESCAPE|outside the workspace/,
    );
  } finally {
    await cleanup();
  }
});

test('write_file creates missing parent directories', async () => {
  const { byName, cleanup } = await withWorkspace();
  try {
    const out = await byName.write_file.run({ path: 'a/b/c.txt', content: 'deep' });
    assert.match(out, /Wrote 4 bytes/);
    assert.equal(await byName.read_file.run({ path: 'a/b/c.txt' }), 'deep');
  } finally {
    await cleanup();
  }
});

test('list_files marks directories and hides git internals', async () => {
  const { root, byName, cleanup } = await withWorkspace();
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'readme.md'), '', 'utf8');

    const listing = (await byName.list_files.run({})).split('\n');
    assert.deepEqual(listing, ['readme.md', 'src/']);
  } finally {
    await cleanup();
  }
});

test('run_command reports exit code and stdout', async () => {
  const { byName, cleanup } = await withWorkspace();
  try {
    const out = await byName.run_command.run({ command: 'echo hi from the shell' });
    assert.match(out, /exit code: 0/);
    assert.match(out, /hi from the shell/);
  } finally {
    await cleanup();
  }
});

test('run_command surfaces a failure instead of throwing', async () => {
  const { byName, cleanup } = await withWorkspace();
  try {
    // A failing command is data the model must see, not an exception.
    const out = await byName.run_command.run({ command: 'echo boom >&2; exit 3' });
    assert.match(out, /exit code: 3/);
    assert.match(out, /boom/);
  } finally {
    await cleanup();
  }
});

test('run_command runs inside the workspace, not the process cwd', async () => {
  const { root, byName, cleanup } = await withWorkspace();
  try {
    const out = await byName.run_command.run({
      command: 'node -e "console.log(process.cwd())"',
    });
    assert.match(out, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await cleanup();
  }
});

test('run_command reports a timeout rather than hanging', async () => {
  const { byName, cleanup } = await withWorkspace();
  try {
    const out = await byName.run_command.run({ command: 'sleep 30', timeoutMs: 400 });
    assert.match(out, /timed out after 400ms/);
  } finally {
    await cleanup();
  }
});

test('a timed-out command leaves no orphaned grandchild', async () => {
  const { byName, cleanup } = await withWorkspace();
  const marker = `toris-tools-orphan-${process.pid}`;
  try {
    // `sh -c` spawns node as a grandchild. Killing only the shell strands it,
    // which is exactly the leak the native process-group layer prevents.
    await byName.run_command.run({
      command: `node -e "setTimeout(()=>{},60000)" ${marker}`,
      timeoutMs: 500,
    });
    await new Promise((r) => setTimeout(r, 600));

    let survivors = '';
    try {
      survivors = execSync(`ps -eo pid,command | grep -F '${marker}' | grep -v grep`, {
        encoding: 'utf8',
      }).trim();
    } catch {
      survivors = ''; // grep exits 1 when nothing matched — that is the pass case.
    }
    assert.equal(survivors, '', `orphaned process survived:\n${survivors}`);
  } finally {
    try {
      execSync(`pkill -f '${marker}'`, { stdio: 'ignore' });
    } catch {
      /* nothing left to kill */
    }
    await cleanup();
  }
});

test('oversized output keeps the tail, where the error is', async () => {
  const { byName, cleanup } = await withWorkspace();
  try {
    const out = await byName.run_command.run({
      command:
        "node -e \"console.log('FIRST_SENTINEL');" +
        "for(let i=0;i<9000;i++)console.log('x'.repeat(20));" +
        "console.log('LAST_SENTINEL')\"",
      timeoutMs: 20_000,
    });

    // A build log ends with the reason it failed; the head is just noise.
    assert.match(out, /LAST_SENTINEL/, 'the tail must survive truncation');
    assert.ok(!out.includes('FIRST_SENTINEL'), 'the head should have been dropped');
    assert.match(out, /truncated/);
  } finally {
    await cleanup();
  }
});

test('read_file refuses a file past the read limit', async () => {
  const { root, byName, cleanup } = await withWorkspace();
  try {
    await writeFile(join(root, 'big.bin'), 'z'.repeat(300 * 1024), 'utf8');
    const out = await byName.read_file.run({ path: 'big.bin' });
    assert.match(out, /larger than the \d+ byte read limit/);
  } finally {
    await cleanup();
  }
});
