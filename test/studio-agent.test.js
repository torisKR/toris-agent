import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { SURFACE_AGENT } from '../src/core/agents.js';

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

test('GET /api/agents includes a project-local profile from .toris/agents', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'toris-studio-agents-cwd-'));
  await mkdir(join(cwd, '.toris', 'agents'), { recursive: true });
  await writeFile(
    join(cwd, '.toris', 'agents', 'aso-specialist.json'),
    JSON.stringify({
      id: 'aso-specialist',
      title: 'ASO Specialist',
      category: 'plan',
      writes: false,
      summary: 'Turns a change into store listing copy.',
    }),
    'utf8',
  );
  try {
    await withServer(
      async ({ base }) => {
        const response = await fetch(`${base}/api/agents`);
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.ok(body.agents.some((agent) => agent.id === 'aso-specialist'));
        assert.ok(body.agents.some((agent) => agent.id === 'implementer'));
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

test('GET /api/agents lists the same catalogue the TUI picker uses', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/agents`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ready, false);
    assert.equal(body.agent.id, SURFACE_AGENT.id);
    assert.equal(body.agents[0].id, 'toris');
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
