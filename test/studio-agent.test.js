import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../src/studio/server.js';
import { SURFACE_AGENT } from '../src/core/agents.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-agent-'));
  const studio = await createStudioServer({
    home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    ...extra,
  });
  await studio.listen();
  const address = studio.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ studio, home, base });
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
}

function mutation(base, body) {
  return {
    method: 'POST',
    headers: {
      origin: base,
      'x-toris-studio-token': 'test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function fixtureProfile(id, extra = {}) {
  return {
    id,
    title: extra.title ?? 'ASO Specialist',
    category: extra.category ?? 'plan',
    writes: extra.writes ?? false,
    summary: extra.summary ?? 'Turns a change into store listing copy.',
  };
}

async function writeProfile(dir, id, extra = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(extra.raw ?? fixtureProfile(id, extra)), 'utf8');
}

async function snapshotAgentDirs(home, cwd) {
  const files = {};
  for (const [key, dir] of [
    ['home', join(home, 'agents')],
    ['project', join(cwd, '.toris', 'agents')],
  ]) {
    try {
      const names = (await readdir(dir)).sort();
      files[key] = {};
      for (const name of names) {
        files[key][name] = await readFile(join(dir, name), 'utf8');
      }
    } catch (error) {
      if (error.code === 'ENOENT') files[key] = null;
      else throw error;
    }
  }
  return files;
}

test('GET /api/agents includes a project-local profile from .toris/agents', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'toris-studio-agents-cwd-'));
  await writeProfile(join(cwd, '.toris', 'agents'), 'aso-specialist');
  try {
    await withServer(
      async ({ base }) => {
        const response = await fetch(`${base}/api/agents`);
        const body = await response.json();
        assert.equal(response.status, 200);
        const aso = body.agents.find((agent) => agent.id === 'aso-specialist');
        assert.equal(aso.source, 'project');
        const builtin = body.agents.find((agent) => agent.id === 'implementer');
        assert.equal(builtin.source, 'builtin');
        const status = await fetch(`${base}/api/agent/status?agent=aso-specialist`);
        assert.equal((await status.json()).agent.id, 'aso-specialist');
        const turn = await fetch(
          `${base}/api/agent/turn`,
          mutation(base, { agent: 'aso-specialist', message: 'draft listing' }),
        );
        assert.equal(turn.status, 200);
        assert.equal((await turn.json()).agent.id, 'aso-specialist');
      },
      {
        cwd,
        runAgentTurn: async ({ agent }) => ({
          ok: true,
          agent: { id: agent, title: 'ASO Specialist' },
          text: 'ok',
          events: [],
        }),
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('GET /api/agents includes a user-global profile from ~/.toris/agents', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'toris-studio-agents-home-cwd-'));
  try {
    await withServer(
      async ({ base, home }) => {
        await writeProfile(join(home, 'agents'), 'growth-marketer', {
          title: 'Growth Marketer',
          summary: 'Plans launch loops for a single operator.',
        });
        const response = await fetch(`${base}/api/agents`);
        const body = await response.json();
        assert.equal(response.status, 200);
        const custom = body.agents.find((agent) => agent.id === 'growth-marketer');
        assert.equal(custom.title, 'Growth Marketer');
        assert.equal(custom.source, 'home');
      },
      { cwd },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('GET /api/agents does not write overlay files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'toris-studio-agents-ro-'));
  await writeProfile(join(cwd, '.toris', 'agents'), 'aso-specialist');
  try {
    await withServer(
      async ({ base, home }) => {
        const before = await snapshotAgentDirs(home, cwd);
        assert.equal(before.home, null);
        assert.ok(before.project['aso-specialist.json']);
        assert.equal((await fetch(`${base}/api/agents`)).status, 200);
        assert.equal((await fetch(`${base}/api/agent/status`)).status, 200);
        assert.deepEqual(await snapshotAgentDirs(home, cwd), before);
      },
      { cwd },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('GET /api/agents skips broken JSON without 500', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'toris-studio-agents-broken-'));
  const dir = join(cwd, '.toris', 'agents');
  await writeProfile(dir, 'aso-specialist');
  await writeFile(join(dir, 'broken-specialist.json'), '{ not json', 'utf8');
  await writeFile(join(dir, 'also-broken.json'), JSON.stringify({ id: 'also-broken' }), 'utf8');
  try {
    await withServer(
      async ({ base }) => {
        const response = await fetch(`${base}/api/agents`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.ok(body.agents.some((agent) => agent.id === 'aso-specialist'));
        assert.ok(body.agents.some((agent) => agent.id === 'implementer'));
        assert.equal(body.agents.some((agent) => agent.id === 'broken-specialist'), false);
        assert.equal(body.agents.some((agent) => agent.id === 'also-broken'), false);
        const turn = await fetch(
          `${base}/api/agent/turn`,
          mutation(base, { agent: 'aso-specialist', message: 'draft listing' }),
        );
        assert.equal(turn.status, 200);
        assert.equal((await turn.json()).agent.id, 'aso-specialist');
      },
      {
        cwd,
        runAgentTurn: async ({ agent }) => ({
          ok: true,
          agent: { id: agent, title: 'ASO Specialist' },
          text: 'ok',
          events: [],
        }),
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Studio agent picker labels custom profiles from source', async () => {
  const html = await readFile(join(repoRoot, 'src/studio/ui/index.html'), 'utf8');
  const js = await readFile(join(repoRoot, 'src/studio/ui/app.js'), 'utf8');
  assert.match(html, /id="agent-list"/);
  assert.match(html, /\.toris\/agents/);
  assert.match(html, /id="create-agent-form"/);
  assert.match(html, /id="new-agent-id"/);
  assert.match(html, /id="new-agent-title"/);
  assert.match(html, /id="new-agent-system"/);
  assert.match(html, /id="edit-agent-form"/);
  assert.match(html, /id="edit-agent-title"/);
  assert.match(html, /id="edit-agent-system"/);
  assert.match(html, /id="delete-agent"/);
  assert.match(js, /function agentPickerBadge/);
  assert.match(js, /source === 'home' \|\| agent\?\.source === 'project'/);
  assert.match(js, /\$\{source\} · \$\{writes\}/);
  assert.match(js, /agent:\s*state\.agentId/);
  assert.match(js, /\/api\/agents/);
  assert.match(js, /await loadAgents\(\)/);
  assert.doesNotMatch(js, /\/api\/agents\/(?:update|delete)/);
  assert.doesNotMatch(js, /~\/\.toris\/agents/);
});

test('GET /api/agents lists the same catalogue the TUI picker uses', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/agents`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ready, false);
    assert.equal(body.agent.id, SURFACE_AGENT.id);
    assert.equal(body.agents[0].id, 'toris');
    assert.equal(body.agents[0].source, 'builtin');
    assert.ok(body.agents.some((agent) => agent.id === 'implementer'));
    assert.match(body.tui, /toris/);
    assert.match(body.gui, /\/agent$/);
  });
});

test('GET /api/agent/status reflects a selected role and stays local', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/agent/status?agent=implementer`);
    const body = await response.json();
    assert.equal(body.agent.id, 'implementer');
    assert.match(body.tui, /\/agent implementer/);
    assert.equal(response.headers.has('access-control-allow-origin'), false);
  });
});

test('POST /api/agent/turn requires the studio origin and token', async () => {
  await withServer(async ({ base }) => {
    const denied = await fetch(`${base}/api/agent/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(denied.status, 403);
  });
});

test('POST /api/agent/turn rejects an empty message and an unknown agent', async () => {
  await withServer(
    async ({ base }) => {
      const empty = await fetch(`${base}/api/agent/turn`, mutation(base, { message: '   ' }));
      assert.equal(empty.status, 400);
      const unknown = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, { agent: 'wizard', message: 'hi' }),
      );
      assert.equal(unknown.status, 400);
    },
    {
      runAgentTurn: async () => {
        throw new Error('runner must not be called for invalid input');
      },
    },
  );
});

test('POST /api/agent/turn streams SSE when the client asks for it', async () => {
  await withServer(
    async ({ base }) => {
      const init = mutation(base, { agent: 'planner', message: 'split this goal' });
      init.headers.accept = 'text/event-stream';
      const response = await fetch(`${base}/api/agent/turn`, init);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      const body = await response.text();
      assert.match(body, /event: text/);
      assert.match(body, /"delta":"hel"/);
      assert.match(body, /event: tool-start/);
      assert.match(body, /event: done/);
      assert.match(body, /"text":"hello"/);
      assert.match(body, /"ok":true/);
    },
    {
      runAgentTurn: async ({ agent, onEvent }) => {
        onEvent?.({ type: 'text', delta: 'hel' });
        onEvent?.({ type: 'tool-start', name: 'read_file' });
        onEvent?.({ type: 'text', delta: 'lo' });
        return {
          ok: true,
          agent: { id: agent, title: 'Planner' },
          text: 'hello',
          events: [
            { type: 'text', delta: 'hel' },
            { type: 'tool-start', name: 'read_file' },
            { type: 'text', delta: 'lo' },
          ],
        };
      },
    },
  );
});

test('POST /api/agent/turn still rejects empty input as JSON when SSE is requested', async () => {
  await withServer(
    async ({ base }) => {
      const init = mutation(base, { message: '   ' });
      init.headers.accept = 'text/event-stream';
      const response = await fetch(`${base}/api/agent/turn`, init);
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const body = await response.json();
      assert.equal(body.ok, false);
    },
    {
      runAgentTurn: async () => {
        throw new Error('runner must not be called for invalid input');
      },
    },
  );
});

test('POST /api/agent/turn runs the selected agent and returns text', async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, { agent: 'planner', message: 'split this goal', history: [] }),
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.text, 'echo:planner:split this goal');
      assert.equal(body.agent.id, 'planner');
    },
    {
      runAgentTurn: async ({ agent, message }) => {
        const resolved = typeof agent === 'string' ? agent : agent?.id;
        return {
          ok: true,
          agent: { id: resolved, title: 'Planner' },
          text: `echo:${resolved}:${message}`,
          usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
          events: [{ type: 'text', delta: message }],
        };
      },
    },
  );
});

test('a configured home reports the agent room as ready', async () => {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-ready-'));
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      models: {
        profiles: { main: { provider: 'anthropic', model: 'model-id' } },
        routing: { chat: 'main' },
      },
    }),
  );
  const studio = await createStudioServer({ home, host: '127.0.0.1', port: 0, token: 'test-token' });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
  try {
    const body = await (await fetch(`${base}/api/agent/status`)).json();
    assert.equal(body.ready, true);
    assert.equal(body.reason, null);
  } finally {
    await studio.close();
    await rm(home, { recursive: true, force: true });
  }
});
