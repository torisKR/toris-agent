import { KnowledgeStore, searchIndex, STARTER_DOMAIN_SLUGS } from '../core/knowledge/index.js';
import { HttpError, readJson } from './http.js';
import { loadKnowledgeDag } from './knowledge-dag.js';
import { acceptReflect, loadReflect } from './knowledge-reflect.js';
import {
  addStudioKnowledgeNode,
  createStudioKnowledgeDomain,
  removeStudioKnowledgeNode,
  updateStudioKnowledgeNode,
} from './knowledge-write.js';

function storeOf(options) {
  return new KnowledgeStore({ home: options.home, projectPath: options.cwd });
}

function optionalRunId(value) {
  if (value == null) return undefined;
  const runId = String(value).trim();
  return runId || undefined;
}

/**
 * Additive Studio routes for /api/knowledge. Does not touch review, agent, or
 * design handlers — those stay in server.js.
 */
export function registerKnowledgeRoutes(router, { sendJson, requireJson, options, store }) {
  router.add('GET', '/api/knowledge', async (_request, response) => {
    const store = storeOf(options);
    const status = await store.status();
    const domains = await store.listDomains();
    if (!status.ok) {
      sendJson(response, 200, {
        ok: false,
        status,
        domains,
        starters: STARTER_DOMAIN_SLUGS,
        hint: 'toris knowledge init',
      });
      return;
    }
    sendJson(response, 200, { ok: true, status, domains });
  });

  router.add('GET', '/api/knowledge/search', async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
    if (!query.trim()) throw new HttpError(400, 'q is required');
    const store = storeOf(options);
    if (!(await store.status()).ok) await store.init({ seed: true });
    const hits = searchIndex(await store.loadIndex(), query, {
      domain: url.searchParams.get('domain') || undefined,
      limit: Number(url.searchParams.get('limit') || 12) || 12,
    });
    sendJson(response, 200, { query, hits });
  });

  router.add('GET', '/api/knowledge/domains', async (_request, response) => {
    const store = storeOf(options);
    if (!(await store.status()).ok) await store.init({ seed: true });
    sendJson(response, 200, { domains: await store.listDomains() });
  });

  router.add('GET', '/api/knowledge/domains/:slug', async (_request, response, params) => {
    const store = storeOf(options);
    try {
      sendJson(response, 200, await store.inspectDomain(params.slug));
    } catch (error) {
      throw new HttpError(error.code === 'E_UNKNOWN_DOMAIN' ? 404 : 400, error.message);
    }
  });

  router.add('GET', '/api/knowledge/domains/:slug/dag', async (_request, response, params) => {
    const store = storeOf(options);
    try {
      sendJson(response, 200, await loadKnowledgeDag(store, params.slug));
    } catch (error) {
      throw new HttpError(error.code === 'E_UNKNOWN_DOMAIN' ? 404 : 400, error.message);
    }
  });

  router.add('POST', '/api/knowledge/init', async (_request, response) => {
    const store = storeOf(options);
    sendJson(response, 200, await store.init({ seed: true }));
  });

  router.add('POST', '/api/knowledge/domains', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    const store = storeOf(options);
    try {
      sendJson(response, 201, await createStudioKnowledgeDomain(store, body));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(error.code === 'E_DOMAIN_EXISTS' ? 409 : 400, error.message);
    }
  });

  router.add('POST', '/api/knowledge/domains/:slug/nodes', async (request, response, params) => {
    requireJson(request);
    const body = await readJson(request);
    const store = storeOf(options);
    try {
      sendJson(response, 201, await addStudioKnowledgeNode(store, params.slug, body));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(error.code === 'E_UNKNOWN_DOMAIN' ? 404 : error.code === 'E_NODE_EXISTS' ? 409 : 400, error.message);
    }
  });

  router.add('POST', '/api/knowledge/domains/:slug/nodes/:id/update', async (request, response, params) => {
    requireJson(request);
    const body = await readJson(request);
    const store = storeOf(options);
    try {
      sendJson(response, 200, await updateStudioKnowledgeNode(store, params.slug, params.id, body));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(error.code === 'E_UNKNOWN_DOMAIN' || error.code === 'E_UNKNOWN_NODE' ? 404 : 400, error.message);
    }
  });

  router.add('POST', '/api/knowledge/domains/:slug/nodes/:id/remove', async (request, response, params) => {
    requireJson(request);
    await readJson(request);
    const store = storeOf(options);
    try {
      sendJson(response, 200, await removeStudioKnowledgeNode(store, params.slug, params.id));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(error.code === 'E_UNKNOWN_DOMAIN' || error.code === 'E_UNKNOWN_NODE' ? 404 : 400, error.message);
    }
  });

  router.add('POST', '/api/knowledge/domains/:slug/edges', async (request, response, params) => {
    requireJson(request);
    const body = await readJson(request);
    const store = storeOf(options);
    try {
      sendJson(response, 201, await store.link(params.slug, body));
    } catch (error) {
      throw new HttpError(error.code === 'E_DAG_CYCLE' || error.code === 'E_UNKNOWN_NODE' ? 400 : 400, error.message);
    }
  });

  router.add('POST', '/api/knowledge/tacit', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    const store = storeOf(options);
    if (!(await store.status()).ok) await store.init({ seed: true });
    try {
      sendJson(response, 201, await store.addTacit(body.domain, body));
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  });

  router.add('GET', '/api/knowledge/reflect', async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const runId = optionalRunId(url.searchParams.get('runId') || url.searchParams.get('from-run'));
    const { presented } = await loadReflect(store, storeOf(options), runId);
    sendJson(response, 200, presented);
  });

  router.add('POST', '/api/knowledge/reflect/accept', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    try {
      sendJson(response, 201, await acceptReflect(store, storeOf(options), optionalRunId(body.runId)));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(error.code === 'E_NODE_EXISTS' ? 409 : 400, error.message);
    }
  });

  router.add('POST', '/api/knowledge/reflect/dismiss', async (request, response) => {
    requireJson(request);
    await readJson(request);
    sendJson(response, 200, { ok: true, written: false });
  });
}
