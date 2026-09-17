import {
  addSchedule,
  findSchedule,
  listRecentDaemonJobs,
  listSchedules,
  publicSchedule,
  readDaemonStatus,
  removeSchedule,
  ScheduleExprError,
  setScheduleEnabled,
} from '../daemon/index.js';
import { HttpError, readJson } from './http.js';

const RECENT_JOB_LIMIT = 20;

function scheduleHttpError(error) {
  if (error instanceof HttpError) throw error;
  if (error instanceof ScheduleExprError) throw new HttpError(400, error.message);
  throw error;
}

async function requireSchedule(home, ref) {
  const found = findSchedule(await listSchedules(home), ref);
  if (!found) throw new HttpError(404, 'schedule not found');
  return found;
}

export async function presentDaemonSnapshot(home, options = {}) {
  const status = await readDaemonStatus(home);
  const schedules = (await listSchedules(home)).map(publicSchedule);
  const recentJobs = await listRecentDaemonJobs(home, {
    limit: options.jobLimit ?? RECENT_JOB_LIMIT,
  });
  return {
    ok: true,
    status: {
      running: status.running,
      pid: status.pid,
      startedAt: status.startedAt,
      heartbeatAt: status.heartbeatAt,
      uptimeMs: status.uptimeMs,
      home: status.home,
      version: status.version,
      socket: status.socket,
      jobs: status.jobs,
      schedules: status.schedules,
    },
    schedules,
    recentJobs,
  };
}

/**
 * Additive Studio routes for /api/daemon. Reuses the same schedule store as
 * `toris daemon schedule`. Does not start or stop the worker.
 */
export function registerDaemonRoutes(router, { sendJson, requireJson, options }) {
  router.add('GET', '/api/daemon', async (_request, response) => {
    sendJson(response, 200, await presentDaemonSnapshot(options.home));
  });

  router.add('GET', '/api/daemon/schedules', async (_request, response) => {
    const snapshot = await presentDaemonSnapshot(options.home);
    sendJson(response, 200, {
      items: snapshot.schedules,
      count: snapshot.schedules.length,
      enabled: snapshot.schedules.filter((item) => item.enabled).length,
      nextDueAt: snapshot.status.schedules.nextDueAt ?? null,
      nextId: snapshot.status.schedules.nextId ?? null,
    });
  });

  router.add('POST', '/api/daemon/schedules', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    const expr = String(body.expr ?? '').trim();
    const goal = String(body.goal ?? '').trim();
    if (!expr) throw new HttpError(400, 'expr is required');
    if (!goal) throw new HttpError(400, 'goal is required');
    try {
      const schedule = await addSchedule(options.home, {
        expr,
        goal,
        enabled: body.enabled !== false,
        autonomy: body.autonomy ?? null,
        budgetUsd: typeof body.budgetUsd === 'number' ? body.budgetUsd : null,
        dryRun: Boolean(body.dryRun),
        apply: Boolean(body.apply),
        review: body.review !== false,
        provider: typeof body.provider === 'string' ? body.provider : null,
        cwd: options.cwd ?? null,
        project: body.project ?? null,
      });
      sendJson(response, 201, { ok: true, schedule: publicSchedule(schedule) });
    } catch (error) {
      scheduleHttpError(error);
    }
  });

  router.add('POST', '/api/daemon/schedules/:id/enable', async (request, response, params) => {
    requireJson(request);
    await readJson(request);
    const current = await requireSchedule(options.home, params.id);
    try {
      const schedule = await setScheduleEnabled(options.home, current.id, true);
      sendJson(response, 200, { ok: true, schedule: publicSchedule(schedule) });
    } catch (error) {
      scheduleHttpError(error);
    }
  });

  router.add('POST', '/api/daemon/schedules/:id/disable', async (request, response, params) => {
    requireJson(request);
    await readJson(request);
    const current = await requireSchedule(options.home, params.id);
    try {
      const schedule = await setScheduleEnabled(options.home, current.id, false);
      sendJson(response, 200, { ok: true, schedule: publicSchedule(schedule) });
    } catch (error) {
      scheduleHttpError(error);
    }
  });

  router.add('POST', '/api/daemon/schedules/:id/remove', async (request, response, params) => {
    requireJson(request);
    await readJson(request);
    const current = await requireSchedule(options.home, params.id);
    await removeSchedule(options.home, current.id);
    sendJson(response, 200, { ok: true, removed: true, schedule: publicSchedule(current) });
  });
}
