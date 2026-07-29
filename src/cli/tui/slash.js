/**
 * Slash-command grammar for the chat REPL.
 *
 * Parsing lives apart from the REPL so the grammar can be tested without a
 * terminal, a provider or an API key. Nothing here performs an action; it only
 * decides what the operator asked for.
 */

import { c } from '../output.js';

/**
 * @typedef {{name:string, args:string, summary:string}} SlashCommandSpec
 */

/** @type {ReadonlyArray<SlashCommandSpec>} */
export const SLASH_COMMANDS = Object.freeze([
  Object.freeze({ name: 'help', args: '', summary: 'this list' }),
  Object.freeze({ name: 'model', args: '[profile]', summary: 'show the model, or switch profile' }),
  Object.freeze({ name: 'autonomy', args: '[L1-L5]', summary: 'show or set what runs unattended' }),
  Object.freeze({ name: 'skills', args: '', summary: 'skill packages in the system prompt' }),
  Object.freeze({ name: 'tools', args: '', summary: 'tools the model may call' }),
  Object.freeze({ name: 'usage', args: '', summary: 'tokens and turns used so far' }),
  Object.freeze({ name: 'clear', args: '', summary: 'forget the transcript, keep the session' }),
  Object.freeze({ name: 'exit', args: '', summary: 'leave (also: q, ctrl-d)' }),
]);

/** Spellings that mean the same thing, so muscle memory from other tools works. */
const ALIASES = Object.freeze({
  '?': 'help',
  h: 'help',
  commands: 'help',
  profile: 'model',
  models: 'model',
  cls: 'clear',
  reset: 'clear',
  new: 'clear',
  tokens: 'usage',
  cost: 'usage',
  quit: 'exit',
  q: 'exit',
  bye: 'exit',
});

/** Typed on its own, these end the session without needing a slash. */
const QUIT_WORDS = new Set(['q']);

const KNOWN = new Set(SLASH_COMMANDS.map((cmd) => cmd.name));

/**
 * @typedef {{name:string, args:string[], known:boolean, raw:string}} SlashCommand
 */

/**
 * Parse one REPL line as a slash command.
 * @param {unknown} input
 * @returns {SlashCommand|null} null when the line is prose meant for the model.
 */
export function parseSlashCommand(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw.startsWith('/')) return null;

  const parts = raw
    .slice(1)
    .split(/\s+/)
    .filter((part) => part !== '');
  const head = (parts[0] ?? '').toLowerCase();
  const name = ALIASES[head] ?? head;
  return { name, args: parts.slice(1), known: KNOWN.has(name), raw };
}

/**
 * True for a bare word that means "leave". Kept separate from slash parsing so
 * an ordinary message that merely starts with "quit" is still sent to the model.
 * @param {unknown} input
 */
export const isQuitWord = (input) =>
  QUIT_WORDS.has(
    String(input ?? '')
      .trim()
      .toLowerCase(),
  );

/** @param {string} name */
export const isKnownSlashCommand = (name) => KNOWN.has(name);

/**
 * The `/help` body: one aligned row per command.
 * @returns {string}
 */
export function renderSlashHelp() {
  const labels = SLASH_COMMANDS.map((cmd) => `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`);
  const width = Math.max(...labels.map((label) => label.length));
  return SLASH_COMMANDS.map((cmd, i) => `  ${labels[i].padEnd(width)}  ${c.dim(cmd.summary)}`).join(
    '\n',
  );
}
