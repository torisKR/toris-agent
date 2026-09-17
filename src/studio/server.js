import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContentStore } from './content-store.js';
import { CONTENT_STATUS } from './content.js';
import { HttpError, Router, assertStudioMutation, readJson, startSse, wantsEventStream, writeSse } from './http.js';
import { JobQueue } from './job-queue.js';
import { mediaResponse, saveMp4Upload } from './media-store.js';
import { RenderService } from './render-service.js';
import { checkRelease, contentHash } from './release-guard.js';
import { inspectAgentRuntime, publicAgentStatus, runAgentTurn } from './agent-runtime.js';
import { loadAgentCatalogue, resolveSurfaceAgent } from '../core/agents.js';
import { Store } from '../core/store.js';
import { applySavedPatch, discardSavedPatch, getPatch, listPatches, readPatchDiff, refreshSavedPatchDiff } from '../core/patches.js';
import { isRepo } from '../core/git.js';
import { TorisError } from '../core/errors.js';
import { summarizeCost } from '../core/cost.js';
import { loadConfig } from '../core/config.js';
import { DesignStore } from './design-store.js';
import { buildBookmarklet } from './design.js';
import {
  PATCH_REVIEW_DIFF_CHAR_LIMIT,
  PATCH_REVIEW_NOTE_LIMIT,
  PATCH_STATUSES,
  boundUnifiedDiff,
  presentPatch,
} from './patch-view.js';
import { FRAME_CSP, SAMPLE_CSP, loadProxiedPage } from './design-proxy.js';
import { registerKnowledgeRoutes } from './knowledge-api.js';

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const STATIC_ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/agent', ['index.html', 'text/html; charset=utf-8']],
  ['/design', ['index.html', 'text/html; charset=utf-8']],
  ['/patches', ['index.html', 'text/html; charset=utf-8']],
  ['/knowledge', ['knowledge.html', 'text/html; charset=utf-8']],
  ['/design-system', ['design-system.html', 'text/html; charset=utf-8']],
  ['/design/sample', ['design-sample.html', 'text/html; charset=utf-8', SAMPLE_CSP]],
  ['/assets/tokens.css', ['tokens.css', 'text/css; charset=utf-8']],
  ['/assets/components.css', ['components.css', 'text/css; charset=utf-8']],
  ['/assets/studio.css', ['studio.css', 'text/css; charset=utf-8']],
  ['/assets/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/knowledge.js', ['knowledge.js', 'text/javascript; charset=utf-8']],
  ['/assets/knowledge.css', ['knowledge.css', 'text/css; charset=utf-8']],
  ['/assets/design-picker.js', ['design-picker.js', 'text/javascript; charset=utf-8']],
  ['/assets/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

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

function turnHttpError(error) {
  if (error instanceof HttpError) throw error;
  const status = turnHttpStatus(error);
  if (status === 500) throw error;
  throw new HttpError(status, error.message);
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

async function studioCostReadout(home, store) {
  try {
    const { config } = await loadConfig(home);
    const summary = await summarizeCost({ home, store, config });
    return {
      day: summary.today.day,
      spentUsd: summary.today.spentUsd,
      capUsd: summary.today.capUsd,
      remainingUsd: summary.today.remainingUsd,
    };
  } catch {
    return null;
  }
}

function patchHttpError(error) {
  if (error instanceof HttpError) throw error;
  if (error instanceof TorisError && error.code === 'E_UNKNOWN_PATCH') throw new HttpError(404, error.message);
  if (error instanceof TorisError && (error.code === 'E_PATCH_STATE' || error.code === 'E_PATCH_APPLY' || error.code === 'E_PATCH_WORKTREE')) {
    throw new HttpError(409, error.message);
  }
  throw error;
}

async function sendStatic(response, pathname) {
  const asset = STATIC_ASSETS.get(pathname);
  if (!asset) throw new HttpError(404, 'asset not found');
  const body = await readFile(join(UI_ROOT, asset[0]));
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-length': String(body.length),
    'content-security-policy': asset[2] || CONTENT_SECURITY_POLICY,
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
  const store = options.store || await new Store(options.home).init();
  const designs = options.designs || (await new DesignStore(options.home).init());
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
    const cost = await studioCostReadout(options.home, store);
    sendJson(response, 200, {
      ok: true,
      name: 'Toris Studio',
      localOnly: true,
      status: 'ready',
      surfaces: ['review', 'agent', 'design', 'patches', 'knowledge'],
      cost,
    });
  });
  for (const pathname of STATIC_ASSETS.keys()) {
    router.add('GET', pathname, async (_request, response) => sendStatic(response, pathname));
  }
  router.add('GET', '/api/session', async (_request, response) => {
    sendJson(response, 200, { token, origin: origin() });
  });
  router.add('GET', '/api/agents', async (_request, response) => {
    const status = await inspectAgentRuntime({ home: options.home, cwd: options.cwd });
    sendJson(response, 200, publicAgentStatus(status));
  });
  router.add('GET', '/api/agent/status', async (request, response) => {
    const url = new URL(request.url || '/', origin());
    const status = await inspectAgentRuntime({ home: options.home, cwd: options.cwd });
    sendJson(response, 200, publicAgentStatus(status, url.searchParams.get('agent')));
  });
  router.add('POST', '/api/agent/turn', async (request, response) => {
    requireJson(request);
    const body = await readJson(request, { limitBytes: 1024 * 1024 });
    const message = String(body.message ?? '').trim();
    if (!message && !body.design && !body.designId && !body.tray && !body.designIds?.length && !body.designs?.length) {
      throw new HttpError(400, 'message is required');
    }
    let catalogue;
    try {
      catalogue = await loadAgentCatalogue({ home: options.home, projectPath: options.cwd });
      resolveSurfaceAgent(body.agent, catalogue);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const abort = new AbortController();
    request.on('close', () => abort.abort());
    const turn = options.runAgentTurn || runAgentTurn;
    const payload = {
      home: options.home,
      cwd: options.cwd,
      catalogue,
      agent: body.agent,
      message,
      history: body.history,
      profile: body.profile,
      design: body.design,
      designId: body.designId,
      designIds: body.designIds,
      designs: body.designs,
      tray: body.tray,
      loadDesign: (id) => designs.get(id),
      saveDesign: (capture) => designs.save(capture),
      loadTray: () => designs.getTray(),
      signal: abort.signal,
    };
    if (!wantsEventStream(request)) {
      try {
        sendJson(response, 200, await turn(payload));
      } catch (error) {
        turnHttpError(error);
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
        const detail = status === 500 && !(error instanceof HttpError) ? 'internal server error' : error.message;
        writeSse(response, 'error', { message: detail, status });
      }
    }
    if (!response.writableEnded) response.end();
  });
  router.add('GET', '/api/design/bookmarklet', async (_request, response) => {
    sendJson(response, 200, { href: buildBookmarklet(origin()), origin: origin() });
  });
  router.add('GET', '/design/frame', async (request, response) => {
    const url = new URL(request.url || '/', origin());
    const target = url.searchParams.get('url');
    if (!target) throw new HttpError(400, 'url is required');
    const page = await loadProxiedPage(target, { fetch: options.fetchPage });
    const body = Buffer.from(page.html);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': String(body.length),
      'content-security-policy': FRAME_CSP,
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-toris-design-url': page.url,
    });
    response.end(body);
  });
  router.add('GET', '/api/design/captures', async (_request, response) => {
    sendJson(response, 200, { items: await designs.list() });
  });
  router.add('GET', '/api/design/captures/:id', async (_request, response, params) => {
    const capture = await designs.get(params.id);
    if (!capture) throw new HttpError(404, 'design capture not found');
    sendJson(response, 200, capture);
  });
  router.add('POST', '/api/design/captures', async (request, response) => {
    requireJson(request);
    try {
      const capture = await designs.save(await readJson(request, { limitBytes: 1024 * 1024 }));
      const tray = await designs.addToTray(capture.id, capture.note);
      sendJson(response, 201, { ...capture, tray });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error.message);
    }
  });
  router.add('PATCH', '/api/design/captures/:id', async (request, response, params) => {
    requireJson(request);
    const capture = await designs.update(params.id, await readJson(request));
    if (!capture) throw new HttpError(404, 'design capture not found');
    const tray = await designs.getTray();
    if (tray.items.some((item) => item.id === capture.id)) {
      await designs.addToTray(capture.id, capture.note);
    }
    sendJson(response, 200, capture);
  });
  router.add('GET', '/api/design/tray', async (_request, response) => {
    sendJson(response, 200, await designs.getTray());
  });
  router.add('PUT', '/api/design/tray', async (request, response) => {
    requireJson(request);
    sendJson(response, 200, await designs.saveTray(await readJson(request)));
  });
  router.add('POST', '/api/design/tray/items', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    const tray = await designs.addToTray(body.id, body.note);
    if (!tray) throw new HttpError(404, 'design capture not found');
    sendJson(response, 200, tray);
  });
  router.add('POST', '/api/design/tray/clear', async (request, response) => {
    requireJson(request);
    await readJson(request);
    sendJson(response, 200, await designs.clearTray());
  });
  router.add('DELETE', '/api/design/tray/items/:id', async (_request, response, params) => {
    sendJson(response, 200, await designs.removeFromTray(params.id));
  });
  router.add('GET', '/api/patches', async (request, response) => {
    const url = new URL(request.url || '/', origin());
    const status = url.searchParams.get('status') || undefined;
    if (status && !PATCH_STATUSES.includes(status)) throw new HttpError(400, 'unknown patch status');
    const items = await listPatches(store, { status });
    sendJson(response, 200, { items: items.map((item) => presentPatch(item)) });
  });
  router.add('GET', '/api/patches/:id', async (_request, response, params) => {
    const record = await getPatch(store, params.id);
    if (!record) throw new HttpError(404, 'patch not found');
    sendJson(response, 200, presentPatch(record, { diff: await readPatchDiff(record) }));
  });
  router.add('POST', '/api/patches/:id/apply', async (request, response, params) => {
    requireJson(request);
    await readJson(request);
    try {
      const applyOpts = options.applyPatchFn ? { applyFn: options.applyPatchFn } : {};
      sendJson(response, 200, presentPatch(await applySavedPatch(store, params.id, applyOpts)));
    } catch (error) {
      patchHttpError(error);
    }
  });
  router.add('POST', '/api/patches/:id/discard', async (request, response, params) => {
    requireJson(request);
    await readJson(request);
    try {
      sendJson(response, 200, presentPatch(await discardSavedPatch(store, params.id)));
    } catch (error) {
      patchHttpError(error);
    }
  });
  router.add('POST', '/api/patches/:id/review', async (request, response, params) => {
    requireJson(request);
    const body = await readJson(request);
    const record = await getPatch(store, params.id);
    if (!record) throw new HttpError(404, 'patch not found');
    if (record.status !== 'pending') throw new HttpError(409, `Patch ${record.id} is already ${record.status}.`);
    const note = String(body.note ?? '').trim();
    const hunk = String(body.hunk ?? '').trim();
    if (!note && !hunk) throw new HttpError(400, 'review note or hunk is required');
    if (note.length > PATCH_REVIEW_NOTE_LIMIT) throw new HttpError(400, 'review note is too long');
    try {
      const catalogue = await loadAgentCatalogue({ home: options.home, projectPath: options.cwd });
      resolveSurfaceAgent(body.agent, catalogue);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    if (!record.worktreePath || !(await isRepo(record.worktreePath))) {
      throw new HttpError(409, `Isolated worktree for ${record.id} is gone; review would edit the original checkout.`);
    }
    const bounded = boundUnifiedDiff(await readPatchDiff(record), { maxChars: PATCH_REVIEW_DIFF_CHAR_LIMIT });
    const abort = new AbortController();
    request.on('close', () => abort.abort());
    const turn = options.runAgentTurn || runAgentTurn;
    try {
      const result = await turn({
        home: options.home,
        cwd: record.worktreePath,
        agent: body.agent || 'implementer',
        message: note || 'Fix the selected hunk on this isolated patch.',
        patchReview: { patch: record, diff: bounded.diff, hunk },
        history: [],
        signal: abort.signal,
      });
      const refreshed = await refreshSavedPatchDiff(store, record.id);
      sendJson(response, 200, {
        ...result,
        patch: presentPatch(refreshed, { diff: await readPatchDiff(refreshed) }),
      });
    } catch (error) {
      if (error.code === 'E_UNKNOWN_PROFILE' || error.code === 'E_PROVIDER_AUTH' || error.code === 'E_PROVIDER_CLI' || error.code === 'E_MODEL_REQUIRED' || error.code === 'E_UNKNOWN_PROVIDER') {
        throw new HttpError(409, error.message);
      }
      patchHttpError(error);
    }
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

  registerKnowledgeRoutes(router, { sendJson, requireJson, options });

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
    designs,
    store,
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
