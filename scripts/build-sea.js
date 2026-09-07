/**
 * Build a standalone single-file `toris` executable with Node's built-in
 * Single Executable Applications (SEA) feature — no third-party packager, so
 * the zero-runtime-dependency ethos is preserved.
 *
 * SEA embeds one script into a copy of the running `node` binary. Two build-only
 * tools are invoked through `npx` (never installed as dependencies):
 *   - esbuild  bundles the ESM source tree into a single CommonJS file, because
 *              a SEA blob is one script and cannot resolve imports from a disk
 *              that will not exist on the user's machine.
 *   - postject injects the generated blob into the copied binary, exactly as the
 *              official Node SEA tutorial prescribes.
 *
 * SEA cannot cross-compile: the base binary is whatever `node` is running this
 * script, so each platform artifact is produced on a runner of that platform.
 * That is what .github/workflows/release.yml does with a per-OS matrix; locally
 * this builds the host binary only.
 *
 * Usage:
 *   node scripts/build-sea.js               # build for the host platform
 *   node scripts/build-sea.js --label x     # override the artifact name suffix
 *   node scripts/build-sea.js --out dir     # override the output directory
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The sentinel postject looks for in the node binary. Fixed by Node's SEA spec. */
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { label: undefined, out: join(ROOT, 'dist', 'sea') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--label') args.label = argv[++i];
    else if (argv[i] === '--out') args.out = resolve(argv[++i]);
  }
  return args;
}

/** The `<platform>-<arch>` label used to name the artifact, e.g. `linux-x64`. */
function hostLabel() {
  const arch = process.arch === 'ia32' ? 'x86' : process.arch;
  // `win32` is Node's spelling; the release assets and installer use `win`.
  const platform = process.platform === 'win32' ? 'win' : process.platform;
  return `${platform}-${arch}`;
}

/**
 * Run a command, echoing it first, and abort the build if it fails.
 * @param {string} cmd @param {string[]} cmdArgs @param {object} [opts]
 */
function run(cmd, cmdArgs, opts = {}) {
  process.stdout.write(`\n$ ${cmd} ${cmdArgs.join(' ')}\n`);
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} exited with code ${res.status}`);
  }
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function main() {
  const { label: labelArg, out } = parseArgs(process.argv.slice(2));
  const label = labelArg ?? hostLabel();
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  mkdirSync(out, { recursive: true });

  const bundle = join(out, 'toris.cjs');
  const blob = join(out, 'toris.blob');
  const seaConfig = join(out, 'sea-config.json');
  const binary = join(out, `toris-${label}${isWindows ? '.exe' : ''}`);

  // 1. Bundle the ESM entry into a single CommonJS file.
  run(npx, [
    '--yes',
    'esbuild@0.24.2',
    'bin/toris.js',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    // In a CJS bundle `import.meta.url` has no value, which would crash the two
    // call sites that derive a directory from it (the builtin-skills path and
    // the native loader). Neither path exists inside a SEA anyway — skills are
    // optional and the native require is caught — so a stable placeholder URL is
    // enough to keep `fileURLToPath`/`createRequire` from throwing at startup.
    '--define:import.meta.url="file:///toris-sea/"',
    // The native addon is loaded through a dynamic require and is optional; a
    // SEA blob has no node_modules, so the pure-JS fallback takes over. Marking
    // it external keeps esbuild from trying (and failing) to resolve it.
    '--external:@toris-agent/*',
    `--outfile=${bundle}`,
  ]);

  // 2. Describe the blob and generate it with Node's SEA tooling.
  writeFileSync(
    seaConfig,
    `${JSON.stringify(
      {
        main: bundle,
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        // Embed the manifest so `toris version`/`--version` can answer without a
        // package.json on disk (src/core/version.js reads it via node:sea).
        assets: { 'package.json': join(ROOT, 'package.json') },
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, ['--experimental-sea-config', seaConfig]);

  // 3. Copy the host node binary and inject the blob into it.
  copyFileSync(process.execPath, binary);
  if (!isWindows) chmodSync(binary, 0o755);

  // macOS refuses to run a modified signed binary until it is re-signed, so the
  // existing signature is stripped before injection and an ad-hoc one applied
  // after.
  if (isMac) {
    spawnSync('codesign', ['--remove-signature', binary], { stdio: 'inherit' });
  }

  const postjectArgs = [
    '--yes',
    'postject',
    binary,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    SENTINEL,
  ];
  if (isMac) postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  run(npx, postjectArgs);

  if (isMac) {
    spawnSync('codesign', ['--sign', '-', binary], { stdio: 'inherit' });
  }

  // Tidy the intermediates; keep only the runnable binary.
  for (const intermediate of [bundle, blob, seaConfig]) {
    if (existsSync(intermediate)) rmSync(intermediate);
  }

  // Emit a checksum sidecar in the `<sha256>␠␠<filename>` shape that both
  // sha256sum and shasum verify, so the installer and CI need no per-OS logic.
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
  writeFileSync(`${binary}.sha256`, `${digest}  ${basename(binary)}\n`);

  const sizeMb = (statSync(binary).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`\nBuilt ${binary} (${sizeMb} MB)\n`);
  process.stdout.write(`sha256 ${digest}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`\nbuild-sea failed: ${err?.message ?? err}\n`);
  process.exitCode = 1;
}
