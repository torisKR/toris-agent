import { buildBrief } from '../core/brief.js';
import { loadConfig } from '../core/config.js';
import { setDailyBudget } from '../core/cost.js';
import { HttpError, readJson } from './http.js';

async function briefOf(options, store, period) {
  let config;
  try {
    ({ config } = await loadConfig(options.home));
  } catch {
    config = undefined;
  }
  try {
    return await buildBrief({
      home: options.home,
      store,
      config,
      cwd: options.cwd,
      period,
    });
  } catch (error) {
    if (/Unknown brief period/.test(error.message)) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

/**
 * Additive Studio routes for /api/brief. Reuses `buildBrief` — no extra
 * spend / runs / daemon / knowledge assembly. GET never writes.
 * POST /api/brief/budget writes `config.maxDailyCostUsd` only.
 */
export function registerBriefRoutes(router, { sendJson, requireJson, options, store }) {
  router.add('GET', '/api/brief', async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const rawPeriod = url.searchParams.get('period');
    const period = rawPeriod == null || rawPeriod === '' ? undefined : rawPeriod;
    sendJson(response, 200, { ok: true, ...(await briefOf(options, store, period)) });
  });

  router.add('POST', '/api/brief/budget', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    if (!Object.hasOwn(body, 'maxDailyCostUsd') && !Object.hasOwn(body, 'capUsd')) {
      throw new HttpError(400, 'maxDailyCostUsd is required');
    }
    const raw = Object.hasOwn(body, 'maxDailyCostUsd') ? body.maxDailyCostUsd : body.capUsd;
    try {
      await setDailyBudget(options.home, raw);
    } catch (error) {
      if (/maxDailyCostUsd|non-negative/.test(error.message)) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
    sendJson(response, 200, { ok: true, ...(await briefOf(options, store)) });
  });
}
