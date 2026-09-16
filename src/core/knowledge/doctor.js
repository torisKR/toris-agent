import { KnowledgeStore } from './store.js';

/** Doctor check: missing store is a warning, never a failed run. */
export async function knowledgeDoctorCheck({ home, projectPath } = {}) {
  try {
    const store = new KnowledgeStore({ home, projectPath });
    const status = await store.status();
    if (!status.ok) {
      return {
        name: 'knowledge',
        status: 'WARN',
        detail: 'not created yet, run: toris knowledge init',
      };
    }
    return {
      name: 'knowledge',
      status: 'PASS',
      detail: `${status.domains} domains · ${status.root}`,
    };
  } catch (err) {
    return { name: 'knowledge', status: 'WARN', detail: err.message };
  }
}
