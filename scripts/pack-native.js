#!/usr/bin/env node
/**
 * Turn a compiled cdylib into a publishable per-platform npm package.
 *
 * Run once per CI matrix leg:
 *   node scripts/pack-native.js --triple darwin-arm64
 *
 * Produces npm/native-<triple>/ containing the binary renamed to the `.node`
 * extension the loader requires, plus a package.json whose `os`/`cpu`/`libc`
 * fields stop npm installing a macOS binary onto a Linux box.
 */

import { mkdir, copyFile, writeFile, stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { TARGETS, findTarget, packageNameFor } from './targets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { triple: '', outDir: join(ROOT, 'npm') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--triple') args.triple = argv[++i] ?? '';
    else if (argv[i] === '--out-dir') args.outDir = resolve(argv[++i] ?? '');
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

/** Where cargo leaves the artifact, with and without an explicit --target. */
function cdylibCandidates(target) {
  const base = join(ROOT, 'crates', 'toris-native', 'target');
  return [
    join(base, target.rustTarget, 'release', target.dylib),
    join(base, 'release', target.dylib),
  ];
}

async function firstExisting(paths) {
  for (const p of paths) {
    try {
      if ((await stat(p)).isFile()) return p;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

async function main() {
  const { triple, outDir } = parseArgs(process.argv.slice(2));
  if (!triple) {
    throw new Error(
      `--triple is required. Known triples: ${TARGETS.map((t) => t.triple).join(', ')}`,
    );
  }

  const target = findTarget(triple);
  if (!target) {
    throw new Error(
      `Unknown triple "${triple}". Add it to scripts/targets.js first, ` +
        `otherwise the CI matrix and optionalDependencies will disagree.`,
    );
  }

  const dylib = await firstExisting(cdylibCandidates(target));
  if (!dylib) {
    throw new Error(
      `No compiled ${target.dylib} for ${triple}. Build it first:\n` +
        `  cargo build --release --manifest-path crates/toris-native/Cargo.toml ` +
        `--target ${target.rustTarget}`,
    );
  }

  // Read version and repo from the root manifest so a platform package can
  // never claim a version the loader is not pinned to.
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const { version, repository, homepage } = root;
  const pkgDir = join(outDir, `native-${triple}`);
  const binaryName = `toris-native.${triple}.node`;
  await mkdir(pkgDir, { recursive: true });
  await copyFile(dylib, join(pkgDir, binaryName));

  // `main` points at the binary so `require('@toris-agent/native-<triple>')`
  // hands back the N-API exports directly.
  const manifest = {
    name: packageNameFor(triple),
    version,
    description: `Prebuilt toris-agent process-control binding for ${triple}.`,
    license: 'Apache-2.0',
    repository,
    main: binaryName,
    files: [binaryName],
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc ? { libc: [target.libc] } : {}),
    publishConfig: { access: 'public' },
  };

  await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    join(pkgDir, 'README.md'),
    `# ${manifest.name}\n\n` +
      `Prebuilt native binding for [toris-agent](${homepage}) on \`${triple}\`.\n\n` +
      `You do not install this directly — \`toris-agent\` pulls in the matching ` +
      `platform package through \`optionalDependencies\`. If none matches your ` +
      `platform, toris falls back to a pure-JS implementation with the same ` +
      `process-group semantics.\n`,
    'utf8',
  );

  const bytes = (await stat(join(pkgDir, binaryName))).size;
  process.stdout.write(
    `packed ${manifest.name}@${version} (${(bytes / 1024).toFixed(0)} KB) -> ${pkgDir}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`pack-native failed: ${err.message}\n`);
  process.exit(1);
});
