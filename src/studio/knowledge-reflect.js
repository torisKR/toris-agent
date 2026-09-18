import { acceptReflections, proposeFromRun } from '../core/knowledge/index.js';
import { HttpError } from './http.js';

export function publicReflectProposal(item) {
  if (!item) return null;
  return {
    id: item.id,
    title: item.title,
    domain: item.domain ?? null,
    goal: item.goal ?? item.title,
    outcome: item.outcome ?? '',
    runId: item.runId ?? null,
    tags: Array.isArray(item.tags) ? item.tags : ['tacit', 'reflect', 'receipt'],
  };
}

/** Studio card: verified receipts only. Failed or unverified stay hidden. */
export function presentReflect(result) {
  const verified = result?.source?.verified === true;
  const draft = verified ? result.proposals?.[0] : null;
  const notable = Boolean(result?.notable && draft);
  return {
    ok: true,
    written: false,
    notable,
    reason: result?.reason ?? 'Nothing to propose.',
    source: result?.source ?? { kind: 'receipt', runId: null, verified: false },
    proposal: notable ? publicReflectProposal(draft) : null,
  };
}

async function noteExists(knowledge, proposal) {
  if (!knowledge || !proposal?.id) return false;
  if (proposal.domain) {
    try {
      const notes = await knowledge.listTacit(proposal.domain);
      if (notes.some((note) => note.id === proposal.id)) return true;
    } catch {
      // Unknown domain — fall through to inbox.
    }
  }
  const inbox = await knowledge.listInbox();
  return inbox.some((note) => note.id === proposal.id);
}

export async function loadReflect(runStore, knowledge, runId) {
  let domains = [];
  if (knowledge && (await knowledge.status()).ok) {
    domains = await knowledge.listDomains();
  }
  const result = await proposeFromRun(runStore, { runId, domains });
  const presented = presentReflect(result);
  if (presented.notable && (await noteExists(knowledge, presented.proposal))) {
    return {
      result,
      presented: {
        ...presented,
        notable: false,
        proposal: null,
        reason: 'Already accepted.',
      },
    };
  }
  return { result, presented };
}

export async function acceptReflect(runStore, knowledge, runId) {
  if (!(await knowledge.status()).ok) await knowledge.init({ seed: true });
  const { result, presented } = await loadReflect(runStore, knowledge, runId);
  if (!presented.notable) throw new HttpError(409, presented.reason);
  const notes = await acceptReflections(knowledge, result);
  return {
    ok: true,
    written: true,
    notable: true,
    reason: result.reason,
    source: result.source,
    proposal: presented.proposal,
    note: notes[0] ?? null,
  };
}
