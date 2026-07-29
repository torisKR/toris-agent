import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, basename, dirname } from 'node:path';

import { TorisError } from './errors.js';

/** Skills that ship with toris itself, the lowest-precedence source. */
export const BUILTIN_SKILL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
);

/**
 * A skill package is a directory containing SKILL.md:
 *
 *   ---
 *   name: ship-small
 *   description: Land the smallest safe change.
 *   when: The user asks to implement, fix or change behaviour.
 *   ---
 *   ...markdown body the model reads when the skill is engaged...
 *
 * Skills are data, not code. A solo developer edits a markdown file and the
 * harness behaves differently on the next run — no rebuild, no plugin API.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Minimal `key: value` frontmatter. Deliberately not a YAML engine. */
function parseFrontmatter(text, source) {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    throw new TorisError(
      `${source} has no --- frontmatter block, so it cannot declare a name or description.`,
      'E_INVALID_SKILL',
    );
  }
  const meta = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(':');
    if (at === -1) {
      throw new TorisError(
        `${source} frontmatter line is not "key: value": ${trimmed}`,
        'E_INVALID_SKILL',
      );
    }
    const key = trimmed.slice(0, at).trim();
    const value = trimmed
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

/**
 * Load one skill package directory.
 * @param {string} dir directory containing SKILL.md
 * @returns {Promise<{name:string,description:string,when:string,body:string,dir:string}>}
 */
export async function loadSkill(dir) {
  const file = join(dir, 'SKILL.md');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new TorisError(`No SKILL.md in ${dir}.`, 'E_INVALID_SKILL');
  }
  const { meta, body } = parseFrontmatter(text, file);
  const name = meta.name || basename(dir);
  if (!meta.description) {
    throw new TorisError(
      `${file} is missing "description", so the model cannot tell when to use it.`,
      'E_INVALID_SKILL',
    );
  }
  if (body === '') {
    throw new TorisError(
      `${file} has an empty body, so engaging it would teach the model nothing.`,
      'E_INVALID_SKILL',
    );
  }
  return Object.freeze({
    name,
    description: meta.description,
    when: meta.when || '',
    body,
    dir: resolve(dir),
  });
}

/** Directories that may hold skill packages, lowest precedence first. */
export function skillSearchPaths({ builtinDir, home, projectPath } = {}) {
  return [
    builtinDir,
    home ? join(home, 'skills') : null,
    projectPath ? join(projectPath, '.toris', 'skills') : null,
  ].filter(Boolean);
}

/**
 * Load every skill found across `dirs`. A later directory wins on name
 * collision, so a project can override a built-in skill without forking it.
 * Missing directories are normal, not errors. A malformed SKILL.md is reported
 * rather than silently skipped — a skill that never loads is worse than a loud one.
 * @param {string[]} dirs
 * @returns {Promise<{skills:Array<object>, problems:Array<{dir:string,message:string}>}>}
 */
export async function discoverSkills(dirs) {
  const byName = new Map();
  const problems = [];

  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // absent search path is fine
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      try {
        const skill = await loadSkill(skillDir);
        byName.set(skill.name, skill);
      } catch (err) {
        problems.push({ dir: skillDir, message: err.message });
      }
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, problems };
}

/**
 * The block appended to a chat system prompt. Names and trigger conditions only:
 * full bodies would burn the context window before the first question.
 * @param {Array<{name:string,description:string,when:string,dir:string}>} skills
 */
export function renderSkillBriefing(skills) {
  if (skills.length === 0) return '';
  const lines = skills.map(
    (s) =>
      `- ${s.name}: ${s.description}${s.when ? ` (use when: ${s.when})` : ''}\n  procedure: ${join(s.dir, 'SKILL.md')}`,
  );
  return [
    'Skills available to you. When one applies, follow it exactly:',
    ...lines,
    '',
    'Read the listed procedure file with the read_file tool before acting on a skill.',
  ].join('\n');
}
