import { resolve, basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { newProjectId } from '../../core/ids.js';
import { UsageError, EXIT } from '../../core/errors.js';
import { isRepo, repoRoot, currentBranch } from '../../core/git.js';
import { inferChecks } from '../../core/verifier.js';
import { readManifest } from './setup.js';
import { printJson, line, table, keyValues, c } from '../output.js';

const COLLECTION = 'projects';

export async function loadProjects(ctx) {
  return ctx.store.readCollection(COLLECTION);
}

/** Resolve by id, exact name, or unique name prefix. */
export function findProject(projects, ref) {
  if (!ref) return null;
  const byId = projects.find((p) => p.id === ref);
  if (byId) return byId;
  const byName = projects.find((p) => p.name === ref);
  if (byName) return byName;
  const matches = projects.filter((p) => p.id.startsWith(ref) || p.name.startsWith(ref));
  return matches.length === 1 ? matches[0] : null;
}

export async function cmdProjectAdd(ctx, positionals) {
  const target = resolve(positionals[0] ?? '.');
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) throw new UsageError(`Not a directory: ${target}`);

  const root = (await isRepo(target)) ? (await repoRoot(target)) ?? target : target;
  const existing = await loadProjects(ctx);
  const already = existing.find((p) => p.path === root);
  if (already) {
    if (ctx.json) { printJson({ ok: true, project: already, created: false }); return EXIT.OK; }
    line(`${c.yellow('~')} Already registered as ${c.bold(already.name)} (${already.id})`);
    return EXIT.OK;
  }

  const manifest = await readManifest(root);
  const project = {
    id: newProjectId(),
    name: manifest?.name ?? basename(root),
    path: root,
    isGitRepo: await isRepo(root),
    branch: await currentBranch(root),
    checks: inferChecks(manifest),
    addedAt: new Date().toISOString(),
  };
  await ctx.store.updateCollection(COLLECTION, (items) => [...items, project]);

  if (ctx.json) { printJson({ ok: true, project, created: true }); return EXIT.OK; }
  line(`${c.green('+')} Registered ${c.bold(project.name)}`);
  keyValues([
    ['id', project.id],
    ['path', project.path],
    ['git', project.isGitRepo ? `yes (${project.branch ?? 'detached'})` : 'no'],
    ['checks', project.checks.length ? project.checks.join(', ') : c.dim('none detected')],
  ]);
  return EXIT.OK;
}

export async function cmdProjectList(ctx) {
  const projects = await loadProjects(ctx);
  if (ctx.json) { printJson({ projects }); return EXIT.OK; }
  line(c.bold(`Projects (${projects.length})`));
  line();
  table(['ID', 'NAME', 'GIT', 'PATH'],
    projects.map((p) => [p.id, p.name, p.isGitRepo ? 'yes' : 'no', p.path]));
  return EXIT.OK;
}

export async function cmdProjectInspect(ctx, positionals) {
  const ref = positionals[0];
  if (!ref) throw new UsageError('Usage: toris project inspect <id>');
  const project = findProject(await loadProjects(ctx), ref);
  if (!project) { throw new UsageError(`No project matching "${ref}"`); }
  if (ctx.json) { printJson({ project }); return EXIT.OK; }
  line(c.bold(project.name));
  keyValues([
    ['id', project.id],
    ['path', project.path],
    ['git', project.isGitRepo ? `yes (${project.branch ?? 'detached'})` : 'no'],
    ['checks', project.checks.length ? project.checks.join(', ') : c.dim('none')],
    ['added', project.addedAt],
  ]);
  return EXIT.OK;
}

export async function cmdProjectRemove(ctx, positionals) {
  const ref = positionals[0];
  if (!ref) throw new UsageError('Usage: toris project remove <id>');
  const projects = await loadProjects(ctx);
  const project = findProject(projects, ref);
  if (!project) throw new UsageError(`No project matching "${ref}"`);
  await ctx.store.writeCollection(COLLECTION, projects.filter((p) => p.id !== project.id));
  if (ctx.json) { printJson({ ok: true, removed: project.id }); return EXIT.OK; }
  line(`${c.green('-')} Removed ${c.bold(project.name)} (${project.id})`);
  return EXIT.OK;
}

export async function cmdProject(ctx, positionals) {
  const [sub, ...rest] = positionals;
  switch (sub) {
    case undefined:
    case 'list': return cmdProjectList(ctx);
    case 'add': return cmdProjectAdd(ctx, rest);
    case 'inspect': return cmdProjectInspect(ctx, rest);
    case 'remove': return cmdProjectRemove(ctx, rest);
    default: throw new UsageError(`Unknown subcommand "project ${sub}". Try: add | list | inspect | remove`);
  }
}
