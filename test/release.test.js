import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builder = join(root, 'scripts/build-release.js');

test('release archive and formula install a standalone CLI with a real offline plan', async (t) => {
  // Missing runtime files, a checksum mismatch, broken argument forwarding, or
  // an attempted npm dependency installation must make this test fail.
  // macOS exposes temporary directories through /var and /tmp symlinks,
  // while a child process reports its physical working directory.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'toris-release-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'release files');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const { stdout } = await execute(process.execPath, [builder, '--out', out], { cwd: dir });
  const release = JSON.parse(stdout);
  assert.equal(release.name, manifest.name);
  assert.equal(release.version, manifest.version);
  assert.equal(release.tag, `v${manifest.version}`);
  assert.equal(release.archive, join(out, `toris-agent-${manifest.version}.tgz`));
  assert.equal(release.releaseUrl,
    `https://github.com/torisKR/toris-agent/releases/download/v${manifest.version}/toris-agent-${manifest.version}.tgz`);
  const archive = await readFile(release.archive);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  assert.equal(release.sha256, sha256);
  assert.equal(await readFile(release.checksums, 'utf8'),
    `${sha256}  toris-agent-${manifest.version}.tgz\n`);
  const formula = await readFile(release.formula, 'utf8');
  assert.match(formula, /^class TorisAgent < Formula$/m);
  assert.ok(formula.includes(`url "${release.releaseUrl}"`));
  assert.ok(formula.includes(`version "${manifest.version}"`));
  assert.ok(formula.includes(`sha256 "${sha256}"`));
  assert.match(formula, /depends_on "node"/);
  assert.match(formula, /libexec\.install Dir\["\*"\]/);
  assert.doesNotMatch(formula, /npm\s+(?:install|ci)|build:native|cargo\s+build/);
  assert.match(formula, /test do[\s\S]*--solo[\s\S]*--offline[\s\S]*--dry-run/);

  const { stdout: listing } = await execute('tar', ['-tzf', release.archive]);
  const entries = listing.trim().split('\n');
  for (const path of ['package/bin/toris.js', 'package/src/cli/index.js', 'package/package.json',
    'package/LICENSE', 'package/skills/reproduce-first/SKILL.md',
    'package/packs/knowledge/toris-ops/DOMAIN.md', 'package/python/auto_shorts/pyproject.toml']) {
    assert.ok(entries.includes(path), `${path} must be included`);
  }
  assert.equal(entries.some((path) => /(?:^|\/)(?:node_modules|build|\.git|src\/studio)\//.test(path)), false);
  assert.equal(entries.some((path) => path.endsWith('.node')), false);

  const stage = join(dir, 'installation with spaces');
  await mkdir(stage);
  await execute('tar', ['-xzf', release.archive, '-C', stage]);
  const libexec = join(stage, 'package');
  await assert.rejects(access(join(libexec, 'node_modules')), { code: 'ENOENT' });
  // Exercise the actual generated wrapper after resolving Homebrew's Ruby
  // interpolations. This verifies quoting and forwarding without pretending
  // that the Homebrew installer is available on this host.
  const wrapperSource = formula.match(/\(bin\/"toris"\)\.write <<~SH\n([\s\S]*?)^\s*SH$/m)?.[1];
  assert.ok(wrapperSource, 'formula must provide a portable executable wrapper');
  const wrapper = join(stage, 'toris');
  await writeFile(wrapper, wrapperSource.replace(/^ {6}/gm, '')
    .replaceAll('#{Formula["node"].opt_bin}', dirname(process.execPath))
    .replaceAll('#{libexec}', libexec));
  await chmod(wrapper, 0o755);
  const project = join(dir, 'project with spaces');
  const home = join(dir, 'isolated state');
  await mkdir(project);
  const env = { ...process.env, PATH: '/usr/bin:/bin', NO_COLOR: '1' };
  delete env.TORIS_DISABLE_NATIVE;
  const invoke = async (...args) => {
    const result = await execute(wrapper, args, { cwd: project, env });
    return JSON.parse(result.stdout);
  };
  const version = await invoke('--version', '--json');
  assert.equal(version.version, manifest.version);
  const init = await invoke('init', '--solo', '--json', '--home', home);
  assert.equal(init.ok, true);
  assert.equal(init.home, home);
  assert.equal(init.solo.project.path, project);
  assert.equal(init.solo.autonomy, 'L2');
  assert.equal(init.solo.apply, 'manual');
  await access(join(home, 'config.json'));
  const run = await invoke('run', 'add a health endpoint', '--offline', '--dry-run', '--json', '--home', home);
  assert.equal(run.ok, true);
  assert.equal(run.run.goal, 'add a health endpoint');
  assert.equal(run.run.status, 'dry-run');
  assert.equal(run.run.projectId, init.solo.project.id);
  assert.equal(run.run.providerAvailable, false);
  assert.equal(run.run.costUsd, 0);
  assert.ok(run.run.tasks.length > 0);
  const { stdout: backend } = await execute(process.execPath, ['--input-type=module', '-e',
    `import { isNativeActive, backendInfo } from ${JSON.stringify(join(libexec, 'src/native/index.js'))};
     console.log(JSON.stringify({ active: isNativeActive(), info: backendInfo() }));`], { cwd: project, env });
  assert.equal(JSON.parse(backend).active, false);
  assert.match(JSON.parse(backend).info, /javascript fallback/);
});

test('release builder rejects unsupported arguments before packaging', async () => {
  for (const args of [['--unknown'], ['--out'], ['--out', '--unknown']]) {
    await assert.rejects(execute(process.execPath, [builder, ...args], { cwd: root }), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /build-release failed: (?:Unknown argument|--out requires a directory)/);
      return true;
    });
  }
});

test('release builder refuses runtime dependencies that direct Homebrew installation cannot satisfy', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'toris-release-dependencies-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  const fixtureBuilder = join(dir, 'scripts/build-release.js');
  await writeFile(fixtureBuilder, await readFile(builder));
  const base = { name: 'toris-agent', version: '1.2.3', type: 'module', license: 'Apache-2.0',
    repository: { url: 'git+https://github.com/torisKR/toris-agent.git' } };
  for (const dependencies of [
    { dependencies: { 'required-package': '1.0.0' } },
    { bundleDependencies: true },
    { bundledDependencies: ['bundled-package'] },
  ]) {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ ...base, ...dependencies }));
    await assert.rejects(execute(process.execPath, [fixtureBuilder, '--out', join(dir, 'out')]), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /Standalone Homebrew packaging requires zero runtime or bundled npm dependencies/);
      return true;
    });
  }
});
