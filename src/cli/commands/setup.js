import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG, saveConfig, configPath } from '../../core/config.js';
import { ADAPTERS, detectBinary } from '../../core/providers.js';
import {
  API_PROVIDERS,
  apiKeyEnvVar,
  readApiKey,
  listProfiles,
  resolveRole,
  isInvokable,
} from '../../core/models.js';
import { discoverSkills, skillSearchPaths, BUILTIN_SKILL_DIR } from '../../core/skills.js';
import { EXIT } from '../../core/errors.js';
import { isRepo } from '../../core/git.js';
import { printJson, line, keyValues, c, statusColor } from '../output.js';

const require = createRequire(import.meta.url);

export async function cmdVersion(ctx) {
  const pkg = require('../../../package.json');
  if (ctx.json) {
    printJson({ name: pkg.name, version: pkg.version, node: process.version });
    return EXIT.OK;
  }
  line(`${c.bold(pkg.name)} ${pkg.version}  ${c.dim(`(node ${process.version})`)}`);
  return EXIT.OK;
}

export async function cmdInit(ctx) {
  const existed = ctx.configExists;
  const config = existed ? ctx.config : { ...DEFAULT_CONFIG };
  await saveConfig(ctx.home, config);
  await ctx.store.init();
  if (ctx.json) {
    printJson({ ok: true, home: ctx.home, config: configPath(ctx.home), created: !existed });
    return EXIT.OK;
  }
  line(
    existed
      ? `${c.yellow('~')} Config already present, left untouched.`
      : `${c.green('+')} Created config.`,
  );
  keyValues([
    ['home', ctx.home],
    ['config', configPath(ctx.home)],
  ]);
  line();
  line(`Next: ${c.cyan('toris doctor')} then ${c.cyan('toris project add .')}`);
  if (Object.keys(config.models?.profiles ?? {}).length === 0) {
    line(
      c.dim('For chat, add a model profile to config.json — `toris chat` prints the exact block.'),
    );
  }
  return EXIT.OK;
}

/** Every check returns {name,status,detail}; status is PASS | WARN | FAIL. */
export async function cmdDoctor(ctx) {
  const checks = [];
  const [major] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'node',
    status: major >= 22 ? 'PASS' : 'FAIL',
    detail: `${process.version} (requires >= 22.6.0)`,
  });

  let anyProvider = false;
  for (const adapter of Object.values(ADAPTERS)) {
    const found = detectBinary(adapter.bin);
    if (found) anyProvider = true;
    checks.push({
      name: `provider:${adapter.name}`,
      status: found ? 'PASS' : 'WARN',
      detail: found ?? `"${adapter.bin}" not on PATH`,
    });
  }
  checks.push({
    name: 'providers',
    status: anyProvider ? 'PASS' : 'FAIL',
    detail: anyProvider
      ? 'at least one agent CLI available'
      : 'install claude or codex to execute runs',
  });

  checks.push({
    name: 'git',
    status: detectBinary('git') ? 'PASS' : 'WARN',
    detail: detectBinary('git') ?? 'git not found; artifact tracking disabled',
  });

  checks.push({
    name: 'config',
    status: ctx.configExists ? 'PASS' : 'WARN',
    detail: ctx.configExists ? configPath(ctx.home) : 'not created yet, run: toris init',
  });

  try {
    await ctx.store.init();
    checks.push({ name: 'store', status: 'PASS', detail: ctx.home });
  } catch (err) {
    checks.push({ name: 'store', status: 'FAIL', detail: err.message });
  }

  checks.push({
    name: 'cwd-git',
    status: (await isRepo(process.cwd())) ? 'PASS' : 'WARN',
    detail: process.cwd(),
  });

  for (const check of chatChecks(ctx)) checks.push(check);
  checks.push(await skillCheck(ctx));

  const failed = checks.filter((check) => check.status === 'FAIL');
  if (ctx.json) {
    printJson({ ok: failed.length === 0, checks });
    return failed.length === 0 ? EXIT.OK : EXIT.FAILURE;
  }
  line(c.bold('toris doctor'));
  line();
  for (const check of checks) {
    line(
      `  ${statusColor(check.status).padEnd(4)}  ${check.name.padEnd(18)} ${c.dim(check.detail)}`,
    );
  }
  line();
  line(
    failed.length === 0
      ? c.green('All required checks passed.')
      : c.red(`${failed.length} required check(s) failed.`),
  );
  return failed.length === 0 ? EXIT.OK : EXIT.FAILURE;
}

/**
 * Doctor is the page a user lands on when chat misbehaves, so the model layer
 * has to be visible here. A key without a profile, or a profile without a key,
 * both leave `toris chat` dead — and both used to report an all-clear.
 * @param {object} ctx
 */
function chatChecks(ctx) {
  const checks = [];

  const keyed = API_PROVIDERS.filter((provider) => readApiKey(provider));
  checks.push({
    name: 'api-keys',
    status: keyed.length > 0 ? 'PASS' : 'WARN',
    detail:
      keyed.length > 0
        ? keyed.map((provider) => apiKeyEnvVar(provider)).join(', ')
        : `none set; export ${API_PROVIDERS.map((p) => apiKeyEnvVar(p)).join(' or ')} to chat`,
  });

  const profiles = listProfiles(ctx.config);
  checks.push({
    name: 'model-profiles',
    status: profiles.length > 0 ? 'PASS' : 'WARN',
    detail:
      profiles.length > 0
        ? profiles.join(', ')
        : 'none defined under models.profiles; run: toris chat (it prints the block to paste)',
  });

  let status = 'WARN';
  let detail = 'no chat profile resolves; toris chat will not start';
  try {
    const resolved = resolveRole('chat', ctx.config);
    const invokable = isInvokable(resolved);
    status = invokable ? 'PASS' : 'WARN';
    detail = invokable
      ? `${resolved.provider}/${resolved.model}`
      : `${resolved.provider}/${resolved.model} needs ${apiKeyEnvVar(resolved.provider)}`;
  } catch (err) {
    detail = err.message.split('\n')[0];
  }
  checks.push({ name: 'chat', status, detail });

  return checks;
}

/** Skills are the harness config for a solo dev; a broken one changes behaviour silently. */
async function skillCheck(ctx) {
  try {
    const { skills, problems } = await discoverSkills(
      skillSearchPaths({
        builtinDir: BUILTIN_SKILL_DIR,
        home: ctx.home,
        projectPath: process.cwd(),
      }),
    );
    if (problems.length > 0) {
      return {
        name: 'skills',
        status: 'WARN',
        detail: `${skills.length} loaded, ${problems.length} broken: ${problems[0].dir} (${problems[0].message})`,
      };
    }
    return {
      name: 'skills',
      status: skills.length > 0 ? 'PASS' : 'WARN',
      detail:
        skills.length > 0
          ? skills.map((skill) => skill.name).join(', ')
          : 'no skill packages found',
    };
  } catch (err) {
    return { name: 'skills', status: 'WARN', detail: err.message };
  }
}

/** Read a project's package.json if it has one. */
export async function readManifest(projectPath) {
  try {
    return JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}
