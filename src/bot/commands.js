/**
 * Shared grammar for Telegram, Slack, and the local bot REPL.
 * Parsing is pure so tests do not need a network.
 */

const ALIASES = Object.freeze({
  start: 'help',
  '?': 'help',
  patches: 'patches',
  patch: 'patches',
  list: 'patches',
  apply: 'apply',
  approve: 'apply',
  discard: 'discard',
  reject: 'discard',
  diff: 'diff',
  show: 'diff',
  status: 'status',
  run: 'run',
  last: 'last',
  latest: 'last',
  runs: 'runs',
  projects: 'projects',
  project: 'projects',
  workspace: 'workspace',
  ws: 'workspace',
  receipt: 'receipt',
  chat: 'chat',
  autonomy: 'autonomy',
  help: 'help',
});

export const BOT_COMMANDS = Object.freeze([
  { name: 'help', summary: 'this list' },
  { name: 'status', summary: 'recent runs and pending patches' },
  { name: 'run', args: '<goal>', summary: 'plan and execute in an isolated worktree' },
  { name: 'last', summary: 'apply the newest pending patch' },
  { name: 'runs', summary: 'recent runs' },
  { name: 'projects', summary: 'registered projects' },
  { name: 'workspace', args: '[path|id]', summary: 'show or set the bot workspace' },
  { name: 'receipt', args: '[runId]', summary: 'evidence for a run' },
  { name: 'chat', args: '<message>', summary: 'one-shot chat through the connected model' },
  { name: 'patches', summary: 'pending isolated diffs' },
  { name: 'diff', args: '<id>', summary: 'show a stored patch' },
  { name: 'apply', args: '<id>', summary: 'apply a patch to the original repo' },
  { name: 'discard', args: '<id>', summary: 'drop a patch and its worktree' },
  { name: 'autonomy', args: '[L1-L5]', summary: 'show or set the default autonomy' },
]);

export function parseBotCommand(input) {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (!text) return null;
  text = text.replace(/^<@[A-Z0-9]+>\s+/i, '');
  if (!text.startsWith('/')) {
    return { name: 'chat', args: [text], raw: input };
  }
  const body = text.slice(1);
  const at = body.indexOf(' ');
  const head = (at === -1 ? body : body.slice(0, at)).toLowerCase().replace(/@.*$/, '');
  const rest = (at === -1 ? '' : body.slice(at + 1)).trim();
  const name = ALIASES[head] ?? head;
  const known = BOT_COMMANDS.some((cmd) => cmd.name === name);
  if (name === 'run' || name === 'chat' || name === 'workspace') {
    return { name, args: rest ? [rest] : [], known, raw: input };
  }
  return {
    name,
    args: rest ? rest.split(/\s+/).filter(Boolean) : [],
    known,
    raw: input,
  };
}

export function renderBotHelp() {
  const labels = BOT_COMMANDS.map((cmd) => `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`);
  const width = Math.max(...labels.map((label) => label.length));
  return [
    'toris bot — isolated edits, then you apply them.',
    '',
    ...BOT_COMMANDS.map((cmd, i) => `${labels[i].padEnd(width)}  ${cmd.summary}`),
  ].join('\n');
}

export function senderAllowed(allowFrom, senderId) {
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return true;
  const id = String(senderId ?? '');
  return allowFrom.map(String).includes(id);
}
