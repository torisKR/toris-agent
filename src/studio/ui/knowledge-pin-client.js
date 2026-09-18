/**
 * Shared Studio client pin — one localStorage key for /knowledge, /agent,
 * Design Mode, and /android. Shape stays { domain, nodeId }.
 */
export const KNOWLEDGE_PIN_KEY = 'toris.studio.knowledge.pin';

function storageOf(storage) {
  return storage ?? globalThis.localStorage;
}

export function knowledgePinFromStorage(storage) {
  try {
    const raw = JSON.parse(storageOf(storage).getItem(KNOWLEDGE_PIN_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const domain = String(raw.domain || '').trim();
    const nodeId = String(raw.nodeId || raw.id || '').trim();
    return domain && nodeId ? { domain, nodeId } : null;
  } catch {
    return null;
  }
}

export function writeKnowledgePin(pin, storage) {
  try {
    const store = storageOf(storage);
    if (pin) store.setItem(KNOWLEDGE_PIN_KEY, JSON.stringify({ domain: pin.domain, nodeId: pin.nodeId }));
    else store.removeItem(KNOWLEDGE_PIN_KEY);
  } catch { /* private mode */ }
}

export function clearKnowledgePin(storage) {
  try { storageOf(storage).removeItem(KNOWLEDGE_PIN_KEY); } catch { /* private mode */ }
}

/** Attach a stored pin to a turn payload. Does not consume — call consume after accept. */
export function withStoredKnowledgePin(payload, storage) {
  const knowledge = knowledgePinFromStorage(storage);
  if (knowledge) payload.knowledge = knowledge;
  return { payload, knowledge };
}

/** Clear only after the turn request is accepted (same rule as streamAgentTurn). */
export function consumeKnowledgePinAfterAccept(knowledge, storage) {
  if (knowledge) clearKnowledgePin(storage);
}
