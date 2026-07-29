import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, join } from 'node:path';
import { TorisError } from './errors.js';
import { spawnCaptured } from '../native/index.js';

/**
 * The default tool set given to a chat session.
 *
 * Every path is forced back inside the workspace root: a model that asks for
 * `../../.ssh/id_rsa` gets a refusal, not a file. Anything that mutates the
 * machine is marked `needsApproval` so the harness can gate it by autonomy level.
 */

const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Resolve `p` under `root`, refusing anything that escapes it. */
function safeResolve(root, p) {
  const full = resolve(root, p ?? '.');
  const rel = relative(root, full);
  if (rel.startsWith('..') || resolve(root, rel) !== full) {
    throw new TorisError(
      `Path "${p}" resolves outside the workspace (${root}). Refusing.`,
      'E_PATH_ESCAPE',
    );
  }
  return full;
}

// Keep the TAIL: a failing build puts its error on the last line, and the
// first 30k of a webpack log tells you nothing about why it broke.
const truncate = (s) =>
  s.length > MAX_OUTPUT_CHARS ? `…[truncated]\n${s.slice(-MAX_OUTPUT_CHARS)}` : s;

/**
 * Run a shell command and always resolve — a failure is data, not an exception.
 *
 * Delegates to the native process-control layer so that a timeout kills the
 * whole process group. `exec` only kills the shell it spawned, which leaves
 * `npm run dev` style grandchildren holding the port after the agent moves on.
 */
async function runCommand(command, { cwd, timeout }) {
  const result = await spawnCaptured(command, {
    cwd,
    timeoutMs: timeout,
    maxOutputBytes: 10 * 1024 * 1024,
  });
  return {
    exitCode: result.exitCode ?? 0,
    killed: result.timedOut,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  };
}

/**
 * @param {{cwd?:string}} [opts]
 * @returns {Array<object>} tools in the shape createChatSession expects
 */
export function createDefaultTools({ cwd = process.cwd() } = {}) {
  const root = resolve(cwd);

  return [
    {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the workspace. Use this before editing anything so you ' +
        'are editing what is actually on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
        },
        required: ['path'],
      },
      run: async ({ path }) => {
        const full = safeResolve(root, path);
        const buf = await readFile(full);
        if (buf.byteLength > MAX_READ_BYTES) {
          return `File is ${buf.byteLength} bytes, larger than the ${MAX_READ_BYTES} byte read limit. Read it in pieces with a command instead.`;
        }
        return buf.toString('utf8');
      },
    },

    {
      name: 'list_files',
      description: 'List entries in a workspace directory. Directories are suffixed with "/".',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory, defaults to the root' } },
      },
      run: async ({ path = '.' }) => {
        const full = safeResolve(root, path);
        const entries = await readdir(full, { withFileTypes: true });
        return entries
          .filter((e) => !e.name.startsWith('.git'))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n');
      },
    },

    {
      name: 'write_file',
      description:
        'Create or overwrite a workspace file. Parent directories are created. This overwrites ' +
        'the whole file, so read it first unless you are creating it.',
      needsApproval: true,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      run: async ({ path, content }) => {
        const full = safeResolve(root, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content ?? '', 'utf8');
        return `Wrote ${Buffer.byteLength(content ?? '')} bytes to ${join('.', relative(root, full))}`;
      },
    },

    {
      name: 'run_command',
      description:
        'Run a shell command in the workspace. Returns exit code, stdout and stderr. Prefer ' +
        'this for builds, tests and git; it is how you verify your own work.',
      needsApproval: true,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeoutMs: { type: 'number', description: 'Defaults to 120000' },
        },
        required: ['command'],
      },
      run: async ({ command, timeoutMs }) => {
        const result = await runCommand(command, {
          cwd: root,
          timeout: timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        });
        if (result.killed) {
          return `Command timed out after ${timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS}ms.\n${result.stdout}${result.stderr}`;
        }
        return [
          `exit code: ${result.exitCode}`,
          result.stdout && `stdout:\n${result.stdout}`,
          result.stderr && `stderr:\n${result.stderr}`,
        ]
          .filter(Boolean)
          .join('\n');
      },
    },
  ];
}
