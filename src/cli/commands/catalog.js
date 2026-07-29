import { join } from 'node:path';
import { listAgents, AGENT_CATEGORIES } from '../../core/agents.js';
import { AUTONOMY_LEVELS } from '../../core/autonomy.js';
import { discoverSkills, skillSearchPaths, BUILTIN_SKILL_DIR } from '../../core/skills.js';
import { UsageError, EXIT } from '../../core/errors.js';
import { printJson, line, table, c } from '../output.js';

export async function cmdAgents(ctx, _positionals, flags) {
  const category = typeof flags.category === 'string' ? flags.category : undefined;
  if (category && !AGENT_CATEGORIES.includes(category)) {
    throw new UsageError(`Unknown category "${category}". One of: ${AGENT_CATEGORIES.join(', ')}`);
  }
  const agents = listAgents(category);
  if (ctx.json) {
    printJson({ agents });
    return EXIT.OK;
  }
  line(c.bold(`Agent profiles (${agents.length})`));
  line();
  table(
    ['ID', 'CATEGORY', 'WRITES', 'SUMMARY'],
    agents.map((a) => [a.id, a.category, a.writes ? 'yes' : 'no', a.summary]),
  );
  return EXIT.OK;
}

/** What the agent is allowed to do, by level. */
export async function cmdAutonomy(ctx) {
  const levels = Object.values(AUTONOMY_LEVELS);
  if (ctx.json) {
    printJson({ autonomy: levels });
    return EXIT.OK;
  }
  line(c.bold('Autonomy levels'));
  line();
  table(
    ['LEVEL', 'WRITE', 'COMMIT', 'PUSH', 'MEANING'],
    levels.map((l) => [
      l.level,
      l.writes ? 'yes' : 'no',
      l.commits ? 'yes' : 'no',
      l.pushes ? 'yes' : 'no',
      l.label,
    ]),
  );
  return EXIT.OK;
}

/**
 * Where a skill came from, so an operator can tell a shipped habit from one
 * they wrote. The precedence order is builtin < home < project, and the label
 * has to answer "which file do I edit to change this?" at a glance.
 */
function skillSource(dir, ctx) {
  if (dir.startsWith(BUILTIN_SKILL_DIR)) return 'builtin';
  if (ctx.home && dir.startsWith(join(ctx.home, 'skills'))) return 'home';
  if (ctx.cwd && dir.startsWith(join(ctx.cwd, '.toris', 'skills'))) return 'project';
  return dir;
}

/** Skill packages: the working habits the model is told to follow in chat. */
export async function cmdSkills(ctx) {
  const dirs = skillSearchPaths({
    builtinDir: BUILTIN_SKILL_DIR,
    home: ctx.home,
    projectPath: ctx.cwd,
  });
  const { skills, problems } = await discoverSkills(dirs);
  if (ctx.json) {
    printJson({ skills: skills.map(({ body: _body, ...meta }) => meta), problems });
    return EXIT.OK;
  }
  if (skills.length === 0) {
    line('No skills loaded.');
    line(c.dim(`Add one as ${'<project>'}/.toris/skills/<name>/SKILL.md`));
    return EXIT.OK;
  }
  line(c.bold(`Skills (${skills.length})`));
  line();
  table(
    ['NAME', 'SOURCE', 'DESCRIPTION'],
    skills.map((s) => [s.name, skillSource(s.dir, ctx), s.description]),
  );
  for (const p of problems) line(c.dim(`  skipped ${p.dir}: ${p.message}`));
  return EXIT.OK;
}
