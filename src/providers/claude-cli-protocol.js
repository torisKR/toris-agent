/**
 * The wire format both `claude` transports share.
 *
 * The provider can talk to the CLI two ways — a fresh process per turn (cold)
 * or one long-lived process fed NDJSON on stdin (warm) — but the events coming
 * back are identical, so the parsing and argv rules live here rather than being
 * written twice and drifting apart.
 *
 * @typedef {{role:'user'|'assistant'|'tool', content:any}} Message
 * @typedef {{inputTokens:number, outputTokens:number}} Usage
 */

import { TorisError } from '../core/errors.js';
import { AUTO_MODEL } from '../core/models.js';

/**
 * `stream-json` is only legal in print mode, and print mode rejects it without
 * `--verbose`. These three always travel together.
 */
export const OUTPUT_FLAGS = Object.freeze(['--output-format', 'stream-json', '--verbose']);

/** Enough stderr to diagnose a crash without pasting a whole log into the REPL. */
export const STDERR_TAIL = 500;
/** Cap on retained stderr so a chatty failure cannot grow unbounded in memory. */
export const STDERR_KEEP = 4000;

export const DEFAULT_BIN = 'claude';
export const DEFAULT_TIMEOUT_MS = 900_000;

/**
 * Build the argv for one cold turn.
 *
 * Two details are load-bearing and were verified against `claude --help`:
 * - `-p/--print` is a BOOLEAN flag; the prompt is a positional argument, so
 *   `-p <prompt>` is two argv entries, not a flag with a value.
 * - `--resume` takes the session id as its value, so it must come before the
 *   positional prompt or the prompt would be swallowed as the resume target.
 *
 * @param {{model?:string|null, system?:string|null, sessionId?:string|null, prompt:string}} opts
 * @returns {string[]}
 */
export function buildArgs({ model, system, sessionId, prompt }) {
  const args = [];

  if (sessionId) args.push('--resume', sessionId);

  // The CLI keeps the system prompt for the life of the session, so appending
  // it again on every resumed turn would stack duplicates.
  if (!sessionId && typeof system === 'string' && system.trim() !== '') {
    args.push('--append-system-prompt', system);
  }

  // 'auto' means "let the CLI pick", which is simply the absence of --model.
  if (model && model !== AUTO_MODEL) args.push('--model', model);

  args.push('-p', prompt, ...OUTPUT_FLAGS);
  return args;
}

/** @param {string} line @returns {object|null} */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null; // a line we cannot read is a line we ignore
  }
}

/**
 * Incremental NDJSON reader. A stdout chunk boundary can land in the middle of
 * a JSON object, so the trailing fragment is held back until the newline that
 * completes it arrives.
 */
export function createNdjsonParser() {
  let buffered = '';

  return {
    /** @param {string} chunk @returns {object[]} */
    push(chunk) {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? ''; // last element is the incomplete remainder
      return lines.map(parseLine).filter((evt) => evt !== null);
    },

    /** Drain whatever is left once stdout ends without a trailing newline. */
    flush() {
      const rest = buffered;
      buffered = '';
      const evt = parseLine(rest);
      return evt === null ? [] : [evt];
    },
  };
}

/**
 * The CLI takes a single prompt, not a transcript: continuity comes from the
 * session (or `--resume`), so only the newest user turn is sent.
 *
 * @param {ReadonlyArray<Message>} [messages]
 * @returns {string}
 */
export function lastUserPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    }
    return '';
  }
  throw new TorisError('The claude-cli provider needs a user message to send.', 'E_INVALID_ARG');
}

/** Best-effort human explanation for a `result` event that reports failure. */
export function describeFailure(evt) {
  if (typeof evt.result === 'string' && evt.result.trim() !== '') return evt.result;
  if (Array.isArray(evt.errors) && evt.errors.length) return evt.errors.join('; ');
  return evt.subtype ?? 'unknown error';
}

/**
 * Text carried by an `assistant` event.
 *
 * 'thinking' and 'tool_use' blocks ride the same channel; only text is ours to
 * surface to the REPL.
 *
 * @param {object} evt
 * @returns {string[]}
 */
export function assistantText(evt) {
  const blocks = Array.isArray(evt?.message?.content) ? evt.message.content : [];
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text !== '')
    .map((b) => b.text);
}

/**
 * Text carried by a partial-message event (`--include-partial-messages`).
 *
 * These arrive token by token, well before the assistant block that repeats
 * them wholesale, and are the reason a warm session feels immediate.
 *
 * @param {object} evt
 * @returns {string|null}
 */
export function partialText(evt) {
  if (evt?.type !== 'stream_event') return null;
  const inner = evt.event;
  if (inner?.type !== 'content_block_delta') return null;
  const delta = inner.delta;
  if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text === '') {
    return null;
  }
  return delta.text;
}

/**
 * Usage totals from a `result` event, normalised to toris' shape.
 * @param {object} evt
 * @returns {Usage}
 */
export function resultUsage(evt) {
  return {
    inputTokens: evt?.usage?.input_tokens ?? 0,
    outputTokens: evt?.usage?.output_tokens ?? 0,
  };
}

/** The session id a `system:init` or `result` event reports, if any. */
export function sessionIdOf(evt) {
  const id = evt?.session_id;
  return typeof id === 'string' && id !== '' ? id : null;
}
