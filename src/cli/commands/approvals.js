import { newApprovalId } from '../../core/ids.js';
import { UsageError, EXIT } from '../../core/errors.js';
import { printJson, line, table, c } from '../output.js';

const COLLECTION = 'approvals';

export async function cmdApprovals(ctx, _positionals, flags) {
  let approvals = await ctx.store.readCollection(COLLECTION);
  if (flags.run) approvals = approvals.filter((a) => a.runId === flags.run);
  const pending = approvals.filter((a) => a.status === 'pending');
  if (ctx.json) { printJson({ approvals, pending: pending.length }); return EXIT.OK; }
  line(c.bold(`Approvals (${approvals.length}, ${pending.length} pending)`));
  line();
  table(['ID', 'RUN', 'ACTION', 'STATUS', 'REQUESTED'],
    approvals.map((a) => [a.id, a.runId, a.action, a.status, a.requestedAt?.slice(0, 19)]));
  return EXIT.OK;
}

/** Create a pending approval for a blocked run. Used by the orchestrator gate. */
export async function requestApproval(ctx, runId, action, reason) {
  const approval = {
    id: newApprovalId(),
    runId,
    action,
    reason,
    status: 'pending',
    requestedAt: new Date().toISOString(),
    decidedAt: null,
  };
  await ctx.store.updateCollection(COLLECTION, (items) => [...items, approval]);
  return approval;
}

async function decide(ctx, positionals, flags, status) {
  const id = positionals[0];
  if (!id) throw new UsageError(`Usage: toris ${status === 'approved' ? 'approve' : 'reject'} <approvalId>`);
  const approvals = await ctx.store.readCollection(COLLECTION);
  const target = approvals.find((a) => a.id === id || a.id.startsWith(id));
  if (!target) throw new UsageError(`No approval matching "${id}"`);
  if (target.status !== 'pending') {
    throw new UsageError(`Approval ${target.id} is already "${target.status}"`);
  }
  const decided = {
    ...target,
    status,
    reason: typeof flags.reason === 'string' ? flags.reason : target.reason,
    decidedAt: new Date().toISOString(),
  };
  await ctx.store.writeCollection(COLLECTION, approvals.map((a) => (a.id === decided.id ? decided : a)));

  const run = await ctx.store.getRun(decided.runId);
  if (run && run.status === 'awaiting-approval') {
    await ctx.store.saveRun({ ...run, status: status === 'approved' ? 'planned' : 'rejected' });
  }
  if (ctx.json) { printJson({ ok: true, approval: decided }); return status === 'approved' ? EXIT.OK : EXIT.APPROVAL_DENIED; }
  line(status === 'approved'
    ? `${c.green('OK')} Approved ${decided.id}. Re-run with: ${c.cyan(`toris run --autonomy L3 ...`)}`
    : `${c.red('X')} Rejected ${decided.id}`);
  return status === 'approved' ? EXIT.OK : EXIT.APPROVAL_DENIED;
}

export const cmdApprove = (ctx, p, f) => decide(ctx, p, f, 'approved');
export const cmdReject = (ctx, p, f) => decide(ctx, p, f, 'rejected');
