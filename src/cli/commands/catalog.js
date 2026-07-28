import { listAgents, AGENT_CATEGORIES } from '../../core/agents.js';
import { AUTONOMY_LEVELS } from '../../core/autonomy.js';
import { UsageError, EXIT } from '../../core/errors.js';
import { printJson, line, table, c } from '../output.js';

export async function cmdAgents(ctx, _positionals, flags) {
  const category = typeof flags.category === 'string' ? flags.category : undefined;
  if (category && !AGENT_CATEGORIES.includes(category)) {
    throw new UsageError(`Unknown category "${category}". One of: ${AGENT_CATEGORIES.join(', ')}`);
  }
  const agents = listAgents(category);
  if (ctx.json) { printJson({ agents }); return EXIT.OK; }
  line(c.bold(`Agent profiles (${agents.length})`));
  line();
  table(['ID', 'CATEGORY', 'WRITES', 'SUMMARY'],
    agents.map((a) => [a.id, a.category, a.writes ? 'yes' : 'no', a.summary]));
  return EXIT.OK;
}

/** Autonomy levels double as the "skills"/capability surface for v0.1.0. */
export async function cmdSkills(ctx) {
  const levels = Object.values(AUTONOMY_LEVELS);
  if (ctx.json) { printJson({ autonomy: levels }); return EXIT.OK; }
  line(c.bold('Autonomy levels'));
  line();
  table(['LEVEL', 'WRITE', 'COMMIT', 'PUSH', 'MEANING'],
    levels.map((l) => [l.level, l.writes ? 'yes' : 'no', l.commits ? 'yes' : 'no', l.pushes ? 'yes' : 'no', l.label]));
  return EXIT.OK;
}
