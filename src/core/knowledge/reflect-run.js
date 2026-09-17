import { buildReceipt } from '../receipt.js';
import { emptyReflection, isVerifiedSuccess } from './reflect.js';
import { proposeReflectionsFromReceipt } from './reflect-receipt.js';

/** Run ids are `run_<sortable><rand>`. */
export function looksLikeRunId(value) {
  return typeof value === 'string' && /^run[_-]/i.test(value.trim());
}

/**
 * Resolve a stored run: exact id, prefix, or the newest verified success.
 * @param {{getRun?:Function, listRuns?:Function}|null} store
 * @param {string} [runId]
 */
export async function getRunFromStore(store, runId) {
  if (!store) return null;
  const wanted = typeof runId === 'string' ? runId.trim() : '';
  if (wanted && typeof store.getRun === 'function') {
    const exact = await store.getRun(wanted);
    if (exact) return exact;
  }
  if (typeof store.listRuns !== 'function') return null;
  const runs = await store.listRuns();
  if (wanted) return runs.find((run) => run.id === wanted || run.id.startsWith(wanted)) ?? null;
  return runs.find((run) => isVerifiedSuccess(run)) ?? null;
}

/**
 * Build a tacit proposal from a completed run receipt. Does not write.
 * @param {object|null} store
 * @param {{runId?:string, domain?:string, domains?:object[]}} [options]
 */
export async function proposeFromRun(store, options = {}) {
  const run = await getRunFromStore(store, options.runId);
  if (!run) {
    return emptyReflection(
      options.runId ? `No run "${options.runId}".` : 'No verified successful run to reflect on.',
      { source: { kind: 'receipt', runId: options.runId ?? null, verified: false } },
    );
  }
  const receipt = buildReceipt(run, []);
  return proposeReflectionsFromReceipt(receipt, {
    domain: options.domain,
    domains: options.domains,
  });
}
