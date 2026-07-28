import { randomUUID } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Short, sortable, human-quotable id: <prefix>_<base32 time><random>.
 * Time prefix keeps ids lexicographically ordered by creation.
 * @param {string} prefix
 * @param {() => number} now
 */
export function createId(prefix, now = Date.now) {
  let t = now();
  let time = '';
  for (let i = 0; i < 8; i += 1) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomUUID().replace(/-/g, '').slice(0, 6);
  return `${prefix}_${time}${rand}`;
}

export const newRunId = (now) => createId('run', now);
export const newTaskId = (now) => createId('tsk', now);
export const newProjectId = (now) => createId('prj', now);
export const newApprovalId = (now) => createId('apv', now);
export const newEventId = (now) => createId('evt', now);
