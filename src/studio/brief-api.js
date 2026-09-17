import { buildBrief } from '../core/brief.js';
import { loadConfig } from '../core/config.js';
import { HttpError } from './http.js';

/**
 * Additive Studio routes for /api/brief. Reuses `buildBrief` — no extra
 * spend / runs / daemon / knowledge assembly. Read-only GET.
 */
export function registerBriefRoutes(router, { sendJson, options, store }) {
  router.add('GET', '/api/brief', async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const rawPeriod = url.searchParams.get('period');
    const period = rawPeriod == null || rawPeriod === '' ? undefined : rawPeriod;
    let config;
    try {
      ({ config } = await loadConfig(options.home));
    } catch {
      config = undefined;
    }
    try {
      const brief = await buildBrief({
        home: options.home,
        store,
        config,
        cwd: options.cwd,
        period,
      });
      sendJson(response, 200, { ok: true, ...brief });
    } catch (error) {
      if (/Unknown brief period/.test(error.message)) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
  });
}
