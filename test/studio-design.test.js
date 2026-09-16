import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServer } from '../src/studio/server.js';
import { composeDesignTurnMessage } from '../src/studio/design.js';

async function withServer(fn, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'toris-studio-design-'));
  const studio = await createStudioServer({
    home,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    ...extra,
  });
  await studio.listen();
  const base = `http://127.0.0.1:${studio.server.address().port}`;
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

async function withTarget(html, fn) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/checkout`;
  try {
    await fn(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /design/sample injects the picker and allows being framed by studio', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(`${base}/design/sample`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    const html = await page.text();
    assert.match(html, /id="sample-cta"/);
    assert.match(html, /\/assets\/design-picker\.js/);
  });
});

test('GET /design/frame proxies HTML and injects the picker', async () => {
  const targetHtml = `<!doctype html><html><head><title>app</title></head><body><button id="buy">Buy</button></body></html>`;
  await withTarget(targetHtml, async (target) => {
    await withServer(async ({ base }) => {
      const framed = await fetch(`${base}/design/frame?url=${encodeURIComponent(target)}`);
      assert.equal(framed.status, 200);
      const html = await framed.text();
      assert.match(html, /\/assets\/design-picker\.js/);
      assert.match(html, /id="buy"/);
      assert.match(html, /<base href="/);
    });
  });
});

test('POST /api/design/captures requires origin+token and persists evidence', async () => {
  await withServer(async ({ base, home }) => {
    const denied = await fetch(`${base}/api/design/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/x', outerHTML: '<div></div>' }),
    });
    assert.equal(denied.status, 403);

    const created = await fetch(
      `${base}/api/design/captures`,
      mutation(base, {
        url: 'http://127.0.0.1:3000/checkout',
        selector: '#buy',
        tagName: 'button',
        outerHTML: '<button id="buy">Buy</button>',
        computedStyle: { color: 'rgb(255, 118, 87)', backgroundColor: 'rgb(27, 14, 10)' },
        text: 'Buy',
      }),
    );
    assert.equal(created.status, 201);
    const capture = await created.json();
    assert.match(capture.id, /^des_/);
    const onDisk = JSON.parse(await readFile(join(home, 'studio', 'design', `${capture.id}.json`), 'utf8'));
    assert.equal(onDisk.selector, '#buy');
    assert.match(composeDesignTurnMessage('Match this button to the brand CTA.', onDisk), /Design Mode attachment/);
    assert.match(composeDesignTurnMessage('Match this button to the brand CTA.', onDisk), /#buy/);

    const listed = await (await fetch(`${base}/api/design/captures`)).json();
    assert.equal(listed.items.length, 1);
  });
});

test('POST /api/agent/turn forwards a design capture into the agent message', async () => {
  let received;
  await withServer(
    async ({ base }) => {
      const saved = await (
        await fetch(
          `${base}/api/design/captures`,
          mutation(base, {
            url: 'http://127.0.0.1:3000/',
            selector: '#sample-cta',
            outerHTML: '<button id="sample-cta">Continue</button>',
            computedStyle: { backgroundColor: 'rgb(255, 118, 87)' },
          }),
        )
      ).json();
      const response = await fetch(
        `${base}/api/agent/turn`,
        mutation(base, {
          agent: 'implementer',
          message: 'Match this button to the brand CTA.',
          designId: saved.id,
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(received.message, 'Match this button to the brand CTA.');
      assert.equal(received.designId, saved.id);
    },
    {
      runAgentTurn: async (input) => {
        received = input;
        return { ok: true, text: 'will edit the button', agent: { id: 'implementer', title: 'Implementer' } };
      },
    },
  );
});

test('GET /design/frame rejects non-http targets', async () => {
  await withServer(async ({ base }) => {
    const file = await fetch(`${base}/design/frame?url=${encodeURIComponent('file:///etc/passwd')}`);
    assert.equal(file.status, 400);
  });
});

test('GET /api/design/bookmarklet returns a javascript: picker for the live origin', async () => {
  await withServer(async ({ base }) => {
    const body = await (await fetch(`${base}/api/design/bookmarklet`)).json();
    assert.match(body.href, /^javascript:/);
    assert.match(body.href, /design-picker\.js/);
    assert.equal(body.origin, base);
  });
});
