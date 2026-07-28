import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadSkill,
  skillSearchPaths,
  discoverSkills,
  renderSkillBriefing,
} from '../src/core/skills.js';

/** Build a throwaway skill tree and hand back its root. */
async function withSkillDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'toris-skills-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(root, name, { description, when, body } = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const front = ['---', `name: ${name}`];
  if (description !== undefined) front.push(`description: ${description}`);
  if (when !== undefined) front.push(`when: ${when}`);
  front.push('---');
  await writeFile(join(dir, 'SKILL.md'), `${front.join('\n')}\n${body ?? 'Do the thing.'}\n`);
  return dir;
}

test('loadSkill reads frontmatter and body', async () => {
  await withSkillDir(async (root) => {
    // Arrange
    const dir = await writeSkill(root, 'ship-small', {
      description: 'Cut scope until it ships today',
      when: 'a change is growing past one sitting',
      body: 'Step 1. Delete something.',
    });

    // Act
    const skill = await loadSkill(dir);

    // Assert
    assert.equal(skill.name, 'ship-small');
    assert.equal(skill.description, 'Cut scope until it ships today');
    assert.equal(skill.when, 'a change is growing past one sitting');
    assert.match(skill.body, /Delete something/);
  });
});

test('loadSkill rejects a skill with no description', async () => {
  await withSkillDir(async (root) => {
    const dir = await writeSkill(root, 'nameless', { description: undefined });
    await assert.rejects(() => loadSkill(dir), /missing "description"/);
  });
});

test('loadSkill rejects an empty body', async () => {
  await withSkillDir(async (root) => {
    const dir = await writeSkill(root, 'hollow', { description: 'does nothing', body: '' });
    await assert.rejects(() => loadSkill(dir), /empty body/);
  });
});

test('loadSkill reports a directory with no SKILL.md', async () => {
  await withSkillDir(async (root) => {
    const dir = join(root, 'not-a-skill');
    await mkdir(dir, { recursive: true });
    await assert.rejects(() => loadSkill(dir), /No SKILL\.md/);
  });
});

test('skillSearchPaths orders builtin, home, then project', () => {
  const paths = skillSearchPaths({
    builtinDir: '/app/skills',
    home: '/home/u/.toris',
    projectPath: '/w',
  });
  assert.deepEqual(paths, ['/app/skills', '/home/u/.toris/skills', '/w/.toris/skills']);
});

test('skillSearchPaths drops the sources that are not configured', () => {
  assert.deepEqual(skillSearchPaths({ builtinDir: '/app/skills' }), ['/app/skills']);
  assert.deepEqual(skillSearchPaths(), []);
});

test('discoverSkills ignores absent directories', async () => {
  const { skills, problems } = await discoverSkills(['/definitely/not/here']);
  assert.deepEqual(skills, []);
  assert.deepEqual(problems, []);
});

test('a later directory overrides a built-in skill of the same name', async () => {
  await withSkillDir(async (root) => {
    // Arrange: same skill name in two search paths
    const builtin = join(root, 'builtin');
    const project = join(root, 'project');
    await writeSkill(builtin, 'ship-small', { description: 'builtin version' });
    await writeSkill(project, 'ship-small', { description: 'project version' });

    // Act
    const { skills } = await discoverSkills([builtin, project]);

    // Assert
    assert.equal(skills.length, 1);
    assert.equal(skills[0].description, 'project version');
  });
});

test('a malformed skill is reported instead of silently skipped', async () => {
  await withSkillDir(async (root) => {
    await writeSkill(root, 'good', { description: 'fine' });
    await writeSkill(root, 'broken', { description: undefined });

    const { skills, problems } = await discoverSkills([root]);

    assert.deepEqual(
      skills.map((s) => s.name),
      ['good'],
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0].dir, /broken$/);
    assert.match(problems[0].message, /description/);
  });
});

test('discovered skills are sorted by name for a stable briefing', async () => {
  await withSkillDir(async (root) => {
    await writeSkill(root, 'zebra', { description: 'z' });
    await writeSkill(root, 'alpha', { description: 'a' });

    const { skills } = await discoverSkills([root]);

    assert.deepEqual(
      skills.map((s) => s.name),
      ['alpha', 'zebra'],
    );
  });
});

test('renderSkillBriefing is empty when nothing is loaded', () => {
  assert.equal(renderSkillBriefing([]), '');
});

test('the briefing names each skill and the file that holds its procedure', () => {
  const briefing = renderSkillBriefing([
    {
      name: 'ship-small',
      description: 'cut scope',
      when: 'scope grows',
      dir: '/app/skills/ship-small',
    },
  ]);

  assert.match(briefing, /ship-small: cut scope/);
  assert.match(briefing, /use when: scope grows/);
  // Without the concrete path the model cannot follow its own instructions.
  assert.match(briefing, /\/app\/skills\/ship-small\/SKILL\.md/);
});

test('the briefing omits the "use when" clause it does not have', () => {
  const briefing = renderSkillBriefing([
    { name: 'plain', description: 'just do it', when: '', dir: '/s/plain' },
  ]);
  assert.doesNotMatch(briefing, /use when/);
});

test('the shipped skill packages all load', async () => {
  const dir = fileURLToPath(new URL('../skills/', import.meta.url));
  const { skills, problems } = await discoverSkills([dir]);

  assert.deepEqual(problems, [], 'a shipped skill failed to load');
  assert.ok(skills.length >= 3, `expected the shipped skills, got ${skills.length}`);
  for (const skill of skills) {
    assert.ok(skill.description.length > 0, `${skill.name} has no description`);
    assert.ok(skill.body.length > 40, `${skill.name} body is too thin to be a procedure`);
  }
});
