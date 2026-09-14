import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContentStore } from './content-store.js';
import { CONTENT_STATUS } from './content.js';
import { HttpError, Router, assertStudioMutation, readJson } from './http.js';
import { JobQueue } from './job-queue.js';
import { mediaResponse, saveMp4Upload } from './media-store.js';
import { RenderService } from './render-service.js';
import { checkRelease, contentHash } from './release-guard.js';
import { inspectAgentRuntime, publicAgentStatus, runAgentTurn } from './agent-runtime.js';
import { resolveSurfaceAgent } from '../core/agents.js';

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const STATIC_ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/agent', ['index.html', 'text/html; charset=utf-8']],
  ['/design-system', ['design-system.html', 'text/html; charset=utf-8']],
  ['/assets/tokens.css', ['tokens.css', 'text/css; charset=utf-8']],
  ['/assets/components.css', ['components.css', 'text/css; charset=utf-8']],
  ['/assets/studio.css', ['studio.css', 'text/css; charset=utf-8']],
  ['/assets/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function sendJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(body.length),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function requireJson(request) {
  const type = String(request.headers['content-type'] || '').split(';', 1)[0];
  if (type !== 'application/json') throw new HttpError(415, 'request must use application/json');
}

function wantsEventStream(request) {
  return String(request.headers.accept || '')
    .split(',')
    .some((part) => part.trim().toLowerCase().startsWith('text/event-stream'));
}

function writeSse(response, event, data) {
  if (response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startSse(response) {
  response.writeHead(200, {
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  if (typeof response.flushHeaders === 'function') response.flushHeaders();
}

function turnHttpStatus(error) {
  if (error instanceof HttpError) return error.status;
  if (
    error.code === 'E_UNKNOWN_PROFILE'
    || error.code === 'E_PROVIDER_AUTH'
    || error.code === 'E_PROVIDER_CLI'
    || error.code === 'E_MODEL_REQUIRED'
    || error.code === 'E_UNKNOWN_PROVIDER'
  ) {
    return 409;
  }
  return 500;
}

function editableContentPatch(input) {
  if (Object.hasOwn(input, 'channels') && !Array.isArray(input.channels)) throw new HttpError(400, 'content channels must be an array');
  return Object.fromEntries(['title', 'brief', 'channels'].filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
}

function createContentInput(input) {
  for (const key of ['media', 'render', 'quality', 'publication', 'status']) {
    if (Object.hasOwn(input, key)) throw new HttpError(400, `${key} cannot be set during content creation`);
  }
  if (Object.hasOwn(input, 'channels') && !Array.isArray(input.channels)) throw new HttpError(400, 'content channels must be an array');
  if (input.brief?.channels != null && !Array.isArray(input.brief.channels)) throw new HttpError(400, 'brief channels must be an array');
  return Object.fromEntries(['kind', 'title', 'brief', 'channels'].filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
}

async function sendStatic(response, pathname) {
  const asset = STATIC_ASSETS.get(pathname);
  if (!asset) throw new HttpError(404, 'asset not found');
  const body = await readFile(join(UI_ROOT, asset[0]));
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-length': String(body.length),
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'content-type': asset[1],
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export async function createStudioServer(options) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 5824;
  if (host !== '127.0.0.1') throw new Error('Toris Studio only binds to 127.0.0.1');
  const token = options.token || randomBytes(32).toString('base64url');
  const contents = await new ContentStore(options.home).init();
  const renderService = options.renderService || new RenderService({
    home: options.home,
    contents,
    pythonPath: options.pythonPath,
    bundleRoot: options.bundleRoot,
    runAutoShorts: options.runAutoShorts,
  });
  const jobs = await new JobQueue(options.home, { runners: { render: (job) => renderService.render(job), ...(options.jobRunners || {}) } }).init();
  const router = new Router();
  let server;

  const origin = () => {
    const address = server.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
  };

  router.add('GET', '/api/health', async (_request, response) => {
    sendJson(response, 200, {
      ok: true,
      name: 'Toris Studio',
      localOnly: true,
      status: 'ready',
      surfaces: ['review', 'agent'],
    });
  });
  for (const pathname of STATIC_ASSETS.keys()) {
    router.add('GET', pathname, async (_request, response) => sendStatic(response, pathname));
  }
  router.add('GET', '/api/session', async (_request, response) => {
    sendJson(response, 200, { token, origin: origin() });
  });
  router.add('GET', '/api/agents', async (_request, response) => {
    const status = await inspectAgentRuntime({ home: options.home });
    sendJson(response, 200, publicAgentStatus(status));
  });
  router.add('GET', '/api/agent/status', async (request, response) => {
    const url = new URL(request.url || '/', origin());
    const status = await inspectAgentRuntime({ home: options.home });
    sendJson(response, 200, publicAgentStatus(status, url.searchParams.get('agent')));
  });
  router.add('POST', '/api/agent/turn', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    const message = String(body.message ?? '').trim();
    if (!message) throw new HttpError(400, 'message is required');
    try {
      resolveSurfaceAgent(body.agent);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const abort = new AbortController();
    request.on('close', () => abort.abort());
    const turn = options.runAgentTurn || runAgentTurn;
    const stream = wantsEventStream(request);
    const payload = {
      home: options.home,
      cwd: options.cwd,
      agent: body.agent,
      message,
      history: body.history,
      profile: body.profile,
      signal: abort.signal,
    };
    if (!stream) {
      try {
        sendJson(response, 200, await turn(payload));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const status = turnHttpStatus(error);
        if (status === 500) throw error;
        throw new HttpError(status, error.message);
      }
      return;
    }
    startSse(response);
    try {
      const result = await turn({
        ...payload,
        onEvent: (evt) => writeSse(response, evt.type || 'message', evt),
      });
      writeSse(response, 'done', result);
    } catch (error) {
      if (abort.signal.aborted) writeSse(response, 'abort', { ok: false });
      else {
        const status = turnHttpStatus(error);
        const message = status === 500 && !(error instanceof HttpError) ? 'internal server error' : error.message;
        writeSse(response, 'error', { message, status });
      }
    }
    if (!response.writableEnded) response.end();
  });
  router.add('GET', '/api/contents', async (_request, response) => {
    sendJson(response, 200, { items: await contents.list() });
  });
  router.add('POST', '/api/contents', async (request, response) => {
    requireJson(request);
    const content = await contents.create(createContentInput(await readJson(request)));
    sendJson(response, 201, content);
  });
  router.add('GET', '/api/contents/:id', async (_request, response, params) => {
    const content = await contents.get(params.id);
    if (!content) throw new HttpError(404, 'content not found');
    sendJson(response, 200, content);
  });
  router.add('PATCH', '/api/contents/:id', async (request, response, params) => {
    requireJson(request);
    if (!await contents.get(params.id)) throw new HttpError(404, 'content not found');
    sendJson(response, 200, await contents.update(params.id, editableContentPatch(await readJson(request))));
  });
  router.add('POST', '/api/contents/:id/upload', async (request, response, params) => {
    const content = await contents.get(params.id);
    if (!content) throw new HttpError(404, 'content not found');
    const media = await saveMp4Upload(request, { home: options.home, contentId: content.id, maxBytes: options.maxUploadBytes });
    sendJson(response, 200, await contents.update(content.id, {
      media,
      kind: content.kind === 'post' ? 'combined' : content.kind,
      status: CONTENT_STATUS.AWAITING_REVIEW,
      render: null,
      quality: null,
      publication: null,
    }));
  });
  router.add('GET', '/api/contents/:id/media', async (request, response, params) => {
    const content = await contents.get(params.id);
    if (!content) throw new HttpError(404, 'content not found');
    const media = await mediaResponse(content, request.headers.range, { home: options.home });
    response.writeHead(media.status, media.headers);
    media.stream.pipe(response);
  });
  router.add('GET', '/api/contents/:id/quality', async (_request, response, params) => {
    const content = await contents.get(params.id);
    if (!content) throw new HttpError(404, 'content not found');
    if (!content.quality) throw new HttpError(404, 'quality evidence not found');
    sendJson(response, 200, content.quality);
  });
  router.add('GET', '/api/contents/:id/review', async (_request, response, params) => {
    const content = await contents.get(params.id);
    if (!content) throw new HttpError(404, 'content not found');
    sendJson(response, 200, { contentId: content.id, contentHash: contentHash(content), publishReady: (!content.media || content.quality?.passed === true) && content.channels.length > 0 });
  });
  router.add('POST', '/api/contents/:id/release-check', async (request, response, params) => {
    requireJson(request);
    const content = await contents.get(params.id);
    if (!content) throw new HttpError(404, 'content not found');
    sendJson(response, 200, checkRelease(content, await readJson(request)));
  });
  router.add('POST', '/api/renders', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    if (!await contents.get(body.contentId)) throw new HttpError(404, 'content not found');
    sendJson(response, 202, await jobs.enqueue('render', body));
  });
  router.add('GET', '/api/jobs', async (_request, response) => {
    sendJson(response, 200, { items: await jobs.list() });
  });
  router.add('POST', '/api/jobs', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    if (!jobs.canRun(body.type)) throw new HttpError(400, 'unknown job type');
    const job = await jobs.enqueue(body.type, { ...body, type: undefined });
    sendJson(response, 202, job);
  });
  router.add('GET', '/api/jobs/:id', async (_request, response, params) => {
    const job = await jobs.get(params.id);
    if (!job) throw new HttpError(404, 'job not found');
    sendJson(response, 200, job);
  });

  server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: true }, async (request, response) => {
    try {
      const url = new URL(request.url || '/', origin());
      assertStudioMutation(request, { token, origin: origin() });
      const route = router.match(request.method || 'GET', url.pathname);
      if (!route) throw new HttpError(404, 'route not found');
      await route.handler(request, response, route.params);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { ok: false, error: { code: status, message: status === 500 ? 'internal server error' : error.message } });
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 15 * 60 * 1000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    token,
    contents,
    jobs,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(this); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host, port });
      });
    },
    async close() {
      await jobs.waitForIdle();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
    },
  };
}
