#!/usr/bin/env node
/** Build the portable GitHub Release asset and its matching Homebrew formula. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  let out;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--out') throw new Error(`Unknown argument: ${argv[i]}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('--out requires a directory');
    out = resolve(value);
  }
  return out;
}

function githubRepository(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const match = raw?.match(/^(?:git\+)?https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error('package.json repository must be a GitHub HTTPS repository URL');
  return `https://github.com/${match[1]}`;
}

// Ruby double-quoted strings interpolate #{...}; package metadata is text.
const rubyString = (value) => JSON.stringify(value).replaceAll('#{', '\\#{');

function homebrewFormula(pkg, repository, releaseUrl, sha256) {
  return `class TorisAgent < Formula
  desc "Terminal development harness for solo builders"
  homepage ${rubyString(repository)}
  url ${rubyString(releaseUrl)}
  version ${rubyString(pkg.version)}
  sha256 ${rubyString(sha256)}
  license ${rubyString(pkg.license)}

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"toris").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/toris.js" "$@"
    SH
    chmod 0755, bin/"toris"
  end

  test do
    require "json"

    info = JSON.parse(shell_output("#{bin}/toris --version --json"))
    assert_equal "toris-agent", info.fetch("name")
    assert_equal version.to_s, info.fetch("version")

    home = testpath/"toris-home"
    init = JSON.parse(shell_output("#{bin}/toris init --solo --json --home '#{home}'"))
    assert_equal true, init.fetch("ok")
    assert_equal home.to_s, init.fetch("home")
    assert_equal testpath.realpath.to_s, init.fetch("solo").fetch("project").fetch("path")
    assert_equal "L2", init.fetch("solo").fetch("autonomy")
    assert_equal "manual", init.fetch("solo").fetch("apply")
    assert_path_exists home/"config.json"

    result = JSON.parse(shell_output("#{bin}/toris run 'add a health endpoint' --offline --dry-run --json --home '#{home}'"))
    assert_equal true, result.fetch("ok")
    run = result.fetch("run")
    assert_equal "dry-run", run.fetch("status")
    assert_equal false, run.fetch("providerAvailable")
    assert_equal 0, run.fetch("costUsd")
    refute_empty run.fetch("tasks")
    assert_equal init.fetch("solo").fetch("project").fetch("id"), run.fetch("projectId")
  end
end
`;
}

async function main() {
  const requestedOut = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  if (pkg.name !== 'toris-agent' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(pkg.version)) {
    throw new Error('package.json must declare toris-agent with a semantic version');
  }
  const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies;
  if (Object.keys(pkg.dependencies ?? {}).length || bundled === true || bundled?.length) {
    throw new Error('Standalone Homebrew packaging requires zero runtime or bundled npm dependencies');
  }
  const repository = githubRepository(pkg);
  const out = requestedOut ?? join(tmpdir(), `toris-agent-release-${pkg.version}`);
  await mkdir(out, { recursive: true });
  const cache = await mkdtemp(join(tmpdir(), 'toris-pack-cache-'));
  let packed;
  try {
    const { stdout } = await execute(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', out, '--cache', cache],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
    [packed] = JSON.parse(stdout);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
  const filename = `toris-agent-${pkg.version}.tgz`;
  if (packed?.filename !== filename || packed.name !== pkg.name || packed.version !== pkg.version) {
    throw new Error('npm pack metadata does not match package.json');
  }
  if (packed.files.some(({ path }) => /(?:^|\/)(?:node_modules|build|\.git)\//.test(path) || path.endsWith('.node'))) {
    throw new Error('Portable release must not contain node_modules or native build artifacts');
  }
  const archive = join(out, filename);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const checksums = join(out, 'SHA256SUMS');
  const formula = join(out, 'Formula', 'toris-agent.rb');
  const tag = `v${pkg.version}`;
  const releaseUrl = `${repository}/releases/download/${tag}/${filename}`;
  await mkdir(dirname(formula), { recursive: true });
  await writeFile(checksums, `${sha256}  ${basename(archive)}\n`);
  await writeFile(formula, homebrewFormula(pkg, repository, releaseUrl, sha256));
  process.stdout.write(`${JSON.stringify({ name: pkg.name, version: pkg.version, tag,
    archive, sha256, checksums, formula, releaseUrl }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`build-release failed: ${err.message}\n`);
  process.exitCode = 1;
});
