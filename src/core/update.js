import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

/** Root of the installed package (this file lives at <root>/src/core/update.js). */
export const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const REGISTRY = 'https://registry.npmjs.org';
export const PACKAGE_NAME = 'toris-agent';
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Compare two semver-ish versions. Returns -1, 0 or 1.
 * A release beats a prerelease at the same numbers (1.0.0 > 1.0.0-rc.1), which
 * is the only prerelease rule we actually depend on.
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ''] = String(v).replace(/^v/, '').split('-');
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1; // release > prerelease
  if (right.pre === '') return -1;
  return left.pre > right.pre ? 1 : -1;
}

const has = (path, ...parts) => path.includes(join(...parts).replaceAll('/', sep));

/**
 * Work out how this copy of toris got onto the machine, because the correct
 * upgrade command is entirely determined by that. Guessing here is how a tool
 * ends up running `npm i -g` over somebody's git checkout.
 *
 * @param {{root?:string, execPath?:string}} [opts]
 */
export function detectInstall({ root = PACKAGE_ROOT, execPath = process.execPath } = {}) {
  const base = { root };

  // A checkout has history; an installed package never does.
  if (existsSync(join(root, '.git'))) {
    return { ...base, kind: 'source', manager: 'git', command: ['git', 'pull'] };
  }

  if (!has(root, 'node_modules')) {
    return { ...base, kind: 'unknown', manager: null, command: null };
  }

  const upgrade = (manager, args) => ({
    ...base,
    kind: 'global',
    manager,
    command: [manager, ...args, `${PACKAGE_NAME}@latest`],
  });

  if (has(root, 'node_modules', '.pnpm') || has(root, 'pnpm', 'global')) {
    return upgrade('pnpm', ['add', '-g']);
  }
  if (has(root, '.bun', 'install', 'global')) {
    return upgrade('bun', ['add', '-g']);
  }
  if (has(root, 'yarn', 'global')) {
    return upgrade('yarn', ['global', 'add']);
  }

  // npm's global root is <prefix>/lib/node_modules. Anything else under
  // node_modules is a project dependency and must not be touched with -g.
  const npmGlobalRoot = join(dirname(dirname(execPath)), 'lib', 'node_modules');
  if (root.startsWith(npmGlobalRoot) || has(root, 'lib', 'node_modules')) {
    return upgrade('npm', ['install', '-g']);
  }

  return {
    ...base,
    kind: 'local',
    manager: 'npm',
    command: ['npm', 'install', `${PACKAGE_NAME}@latest`],
  };
}

/**
 * Ask the registry what the newest published version is.
 * @param {{name?:string, registry?:string, timeoutMs?:number, fetchImpl?:Function}} [opts]
 */
export async function fetchLatestVersion({
  name = PACKAGE_NAME,
  registry = REGISTRY,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = `${registry.replace(/\/$/, '')}/${name}/latest`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err.message;
    throw new Error(`Could not reach the npm registry (${reason}).`);
  }
  if (!res.ok) {
    throw new Error(`Registry returned HTTP ${res.status} for ${name}.`);
  }
  const body = await res.json();
  if (!body?.version) throw new Error(`Registry gave no version for ${name}.`);
  return body.version;
}

/**
 * Decide what should happen, without doing it. Split out so the decision is
 * testable and so `--check` and the real run can never disagree.
 *
 * @param {{current:string, latest:string, install:ReturnType<typeof detectInstall>}} input
 */
export function planUpdate({ current, latest, install }) {
  const order = compareVersions(current, latest);
  if (order >= 0) {
    return {
      action: 'none',
      current,
      latest,
      reason: order > 0 ? 'ahead of the registry' : 'already the latest version',
    };
  }

  const manual = (reason, command) => ({ action: 'manual', current, latest, command, reason });

  if (install.kind === 'source') {
    return manual('running from a git checkout, so npm must not overwrite it', install.command);
  }
  if (install.kind === 'local') {
    return manual('installed as a project dependency, not globally', install.command);
  }
  if (install.kind === 'unknown' || !install.command) {
    return manual('could not tell how this copy was installed', [
      'npm',
      'install',
      '-g',
      `${PACKAGE_NAME}@latest`,
    ]);
  }
  return { action: 'run', current, latest, command: install.command };
}
