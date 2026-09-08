import { resolve } from 'node:path';

import { mergeConfig, saveConfig } from '../core/config.js';
import { resolveAutonomy } from '../core/autonomy.js';
import { applyDecision } from '../core/apply-gate.js';
import { formatPatchNotice } from '../core/channels.js';
import {
  applySavedPatch,
  discardSavedPatch,
  getPatch,
  listPatches,
  readPatchDiff,
} from '../core/patches.js';
import { Orchestrator } from '../core/orchestrator.js';
import { parseBotCommand, renderBotHelp, senderAllowed } from './commands.js';

const DIFF_LIMIT = 3500;

function clip(text, limit = DIFF_LIMIT) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…truncated` : value;
}

export function workspacePath(ctx) {
  return (
    ctx.config?.channels?.workspace ||
    ctx.projects?.find((project) => project.path)?.path ||
    ctx.cwd
  );
}

export async function dispatchBotText(text, ctx) {
  const parsed = parseBotCommand(text);
  if (!parsed) return renderBotHelp();
  if (parsed.name !== 'chat' && parsed.known === false) {
    return `unknown command /${parsed.name}\n\n${renderBotHelp()}`;
  }
  return await executeBotCommand(parsed, ctx);
}

export async function executeBotCommand(cmd, ctx) {
  switch (cmd.name) {
    case 'help':
      return renderBotHelp();
    case 'status':
      return await botStatus(ctx);
    case 'patches':
      return await botPatches(ctx);
    case 'diff':
      return await botDiff(ctx, cmd.args[0]);
    case 'apply':
      return await botApply(ctx, cmd.args[0]);
    case 'discard':
      return await botDiscard(ctx, cmd.args[0]);
    case 'autonomy':
      return await botAutonomy(ctx, cmd.args[0]);
    case 'run':
      return await botRun(ctx, cmd.args[0]);
    case 'last':
      return await botLast(ctx);
    case 'runs':
      return await botRuns(ctx);
    case 'projects':
      return botProjects(ctx);
    case 'workspace':
      return await botWorkspace(ctx, cmd.args[0]);
    case 'receipt':
      return await botReceipt(ctx, cmd.args[0]);
    case 'chat':
      return `Use /run for repository work. Chat from a bot is reserved for commands so a coding CLI cannot write your checkout unseen.\nTry: /run ${cmd.args[0] || '<goal>'}`;
    default:
      return `unknown command /${cmd.name}\n\n${renderBotHelp()}`;
  }
}

async function botStatus(ctx) {
  const runs = (await ctx.store.listRuns()).slice(0, 5);
  const pending = await listPatches(ctx.store, { status: 'pending' });
  const autonomy = ctx.config.defaultAutonomy;
  const lines = [
    `workspace ${workspacePath(ctx)}`,
    `autonomy ${autonomy} (${applyDecision(autonomy)})`,
    pending.length ? `pending patches ${pending.length}` : 'pending patches 0',
    '',
    'recent runs',
    ...(runs.length
      ? runs.map((run) => `- ${run.id} ${run.status} ${run.goal}`)
      : ['- none']),
  ];
  return lines.join('\n');
}

async function botPatches(ctx) {
  const pending = await listPatches(ctx.store, { status: 'pending' });
  if (pending.length === 0) return 'no pending patches';
  return pending.map((patch) => formatPatchNotice(patch)).join('\n\n');
}

async function botDiff(ctx, id) {
  const patch = await getPatch(ctx.store, id);
  if (!patch) return `no patch matching "${id || ''}"`;
  const diff = await readPatchDiff(patch);
  return `${formatPatchNotice(patch)}\n\n${clip(diff || '(empty diff)')}`;
}

async function botApply(ctx, id) {
  const target = id || (await listPatches(ctx.store, { status: 'pending' }))[0]?.id;
  if (!target) return 'no pending patches';
  const applied = await applySavedPatch(ctx.store, target);
  return formatPatchNotice(applied, `applied to ${applied.originPath}`);
}

async function botLast(ctx) {
  return botApply(ctx);
}

async function botRuns(ctx) {
  const runs = (await ctx.store.listRuns()).slice(0, 8);
  if (runs.length === 0) return 'no runs yet';
  return ['recent runs', ...runs.map((run) => `- ${run.id} ${run.status} ${run.goal}`)].join('\n');
}

function botProjects(ctx) {
  const projects = ctx.projects ?? [];
  if (projects.length === 0) return 'no registered projects. Run: toris project add .';
  return projects.map((project) => `- ${project.id} ${project.name} ${project.path}`).join('\n');
}

async function botWorkspace(ctx, ref) {
  if (!ref) return `workspace ${workspacePath(ctx)}`;
  const projects = ctx.projects ?? [];
  const found =
    projects.find((project) => project.id === ref || project.name === ref) ||
    (projects.filter((project) => project.id.startsWith(ref) || project.name.startsWith(ref))
      .length === 1
      ? projects.find((project) => project.id.startsWith(ref) || project.name.startsWith(ref))
      : null);
  const path = found?.path || resolve(ctx.cwd || process.cwd(), ref);
  const next = mergeConfig(ctx.config, { channels: { workspace: path } });
  await saveConfig(ctx.home, next);
  ctx.config = next;
  return `workspace set to ${path}`;
}

async function botReceipt(ctx, id) {
  let run = id ? await ctx.store.getRun(id) : null;
  if (!run && id) {
    run = (await ctx.store.listRuns()).find((item) => item.id.startsWith(id)) ?? null;
  }
  if (!run) run = (await ctx.store.listRuns())[0] ?? null;
  if (!run) return 'no runs yet';
  return [
    `run ${run.id} ${run.status}`,
    run.goal,
    `autonomy ${run.autonomy}`,
    run.patchId ? `patch ${run.patchId}` : null,
    `cost $${Number(run.costUsd ?? 0).toFixed(4)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function botDiscard(ctx, id) {
  if (!id) return 'usage: /discard <id>';
  const discarded = await discardSavedPatch(ctx.store, id);
  return formatPatchNotice(discarded);
}

async function botAutonomy(ctx, value) {
  if (!value) {
    return `autonomy ${ctx.config.defaultAutonomy} (${applyDecision(ctx.config.defaultAutonomy)})`;
  }
  const level = resolveAutonomy(value).level;
  const next = { ...ctx.config, defaultAutonomy: level };
  await saveConfig(ctx.home, next);
  ctx.config = next;
  return `autonomy set to ${level} (${applyDecision(level)})`;
}

async function botRun(ctx, goal) {
  if (!goal) return 'usage: /run <goal>';
  const projectPath = workspacePath(ctx);
  const orchestrator = new Orchestrator({ store: ctx.store, config: ctx.config });
  const project = ctx.projects?.find((item) => item.path === projectPath) ?? {
    id: null,
    name: 'workspace',
    path: projectPath,
  };
  const run = await orchestrator.run({
    goal,
    project,
    autonomy: ctx.config.defaultAutonomy,
  });
  const pending = (await listPatches(ctx.store, { status: 'pending' })).find(
    (patch) => patch.runId === run.id,
  );
  const lines = [
    `run ${run.id} ${run.status}`,
    run.goal,
    pending ? formatPatchNotice(pending) : 'no isolated diff (plan-only, empty, or already applied)',
  ];
  return lines.join('\n');
}

export function authorizeSender(config, channel, senderId) {
  const allowFrom = config?.channels?.[channel]?.allowFrom;
  return senderAllowed(allowFrom, senderId);
}
