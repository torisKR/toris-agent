import { spawn as nodeSpawn } from 'node:child_process';

import { TorisError } from '../core/errors.js';
import { AUTO_MODEL } from '../core/models.js';

/**
 * Chat provider backed by the installed `claude` CLI.
 *
 * Unlike src/providers/anthropic.js this is NOT a direct model connection: the
 * CLI owns the conversation, its own agent loop and its own login session, so
 * toris needs no API key here. The trade-off is that `toolCalls` is ALWAYS
 * empty — the CLI already ran whatever tools it wanted, and handing those calls
 * back to src/core/chat.js would execute every tool a second time.
 *
 * @typedef {{role:'user'|'assistant'|'tool', content:any}} Message
 * @typedef {{inputTokens:number, outputTokens:number}} Usage
 * @typedef {{text:string, toolCalls:[], stopReason:string|null, usage:Usage}} Completion
 */

/**
 * `stream-json` is only legal in print mode, and print mode rejects it without
 * `--verbose`. These three always travel together.
 */
const OUTPUT_FLAGS = Object.freeze(['--output-format', 'stream-json', '--verbose']);

/** Enough stderr to diagnose a crash without pasting a whole log into the REPL. */
const STDERR_TAIL = 500;
/** Cap on retained stderr so a chatty failure cannot grow unbounded in memory. */
const STDERR_KEEP = 4000;

const DEFAULT_BIN = 'claude';
const DEFAULT_TIMEOUT_MS = 900_000;

/**
 * Build the argv for one turn.
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
 * The CLI takes a single prompt, not a transcript: continuity comes from
 * `--resume`, so only the newest user turn is sent.
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
function describeFailure(evt) {
  if (typeof evt.result === 'string' && evt.result.trim() !== '') return evt.result;
  if (Array.isArray(evt.errors) && evt.errors.length) return evt.errors.join('; ');
  return evt.subtype ?? 'unknown error';
}

/**
 * @param {{bin?:string, timeoutMs?:number, env?:object, spawnImpl?:Function}} [opts]
 */
export function createClaudeCliProvider({
  bin = DEFAULT_BIN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  spawnImpl = nodeSpawn,
} = {}) {
  /**
   * Per-provider conversation state. The first turn learns the id from the
   * `system:init` event; every later turn replays it through `--resume`.
   * @type {string|null}
   */
  let sessionId = null;

  /**
   * One turn: spawn the CLI, translate its NDJSON into provider events.
   * @returns {AsyncGenerator<{type:string, [k:string]:any}>}
   */
  async function* stream(opts) {
    const prompt = lastUserPrompt(opts?.messages);
    const signal = opts?.signal;
    if (signal?.aborted) throw new TorisError('The turn was cancelled.', 'E_CANCELLED');

    const args = buildArgs({
      model: opts?.model,
      system: opts?.system,
      sessionId,
      prompt,
    });

    const child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });

    // --- event plumbing -----------------------------------------------------
    // Node streams push at us, the generator pulls; this queue plus a one-shot
    // waiter bridges the two without a dependency.
    /** @type {object[]} */
    const pending = [];
    /** @type {(() => void)|null} */
    let wake = null;
    /** @type {Error|null} */
    let failure = null;
    let settled = false;

    const wakeUp = () => {
      const resume = wake;
      wake = null;
      if (resume) resume();
    };
    const emit = (evt) => {
      pending.push(evt);
      wakeUp();
    };
    /** First failure wins: a kill triggers a bogus exit code we must not report. */
    const fail = (err) => {
      if (!failure) failure = err;
      settled = true;
      wakeUp();
    };

    const parser = createNdjsonParser();
    /** @type {{text:string, usage:Usage}|null} */
    let result = null;
    let fullText = '';
    let stderrTail = '';
    let stdoutEnded = false;
    let exited = false;
    let exitCode = null;
    let finalized = false;

    const kill = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };

    const handle = (evt) => {
      if (evt.type === 'system') {
        if (evt.subtype === 'init' && typeof evt.session_id === 'string' && evt.session_id) {
          sessionId = evt.session_id;
        }
        return;
      }

      if (evt.type === 'assistant') {
        const blocks = Array.isArray(evt.message?.content) ? evt.message.content : [];
        for (const block of blocks) {
          // 'thinking' and 'tool_use' blocks ride the same channel; only text
          // is ours to surface to the REPL.
          if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
            fullText += block.text;
            emit({ type: 'text', delta: block.text });
          }
        }
        return;
      }

      if (evt.type === 'result') {
        result = {
          text: typeof evt.result === 'string' ? evt.result : '',
          usage: {
            inputTokens: evt.usage?.input_tokens ?? 0,
            outputTokens: evt.usage?.output_tokens ?? 0,
          },
        };
        if (evt.is_error) {
          fail(
            new TorisError(
              `${bin} reported a failed turn: ${describeFailure(evt)}`,
              'E_PROVIDER_CLI',
            ),
          );
        }
      }
      // Anything else (rate_limit_event, hook_started, future types) is skipped.
    };

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      if (failure) return; // already explained by something more specific

      if (exitCode !== 0) {
        const tail = stderrTail.slice(-STDERR_TAIL).trim();
        fail(
          new TorisError(
            `${bin} exited with code ${exitCode}.${tail ? ` stderr: ${tail}` : ''}`,
            'E_PROVIDER_CLI',
          ),
        );
        return;
      }

      if (!result) {
        fail(
          new TorisError(
            `${bin} finished without a result event; the turn produced no answer.`,
            'E_PROVIDER_STREAM',
          ),
        );
        return;
      }

      emit({
        type: 'done',
        // Streamed assistant text is authoritative; `result` is the fallback
        // for turns that emitted no assistant block at all.
        text: fullText || result.text,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: result.usage,
      });
      settled = true;
      wakeUp();
    };

    // Wait for stdout to drain AND the process to close, so a fast exit cannot
    // race us into dropping the tail of the transcript.
    const maybeFinalize = () => {
      if (stdoutEnded && exited) finalize();
    };

    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      for (const evt of parser.push(String(chunk))) handle(evt);
    });
    child.stdout?.on('end', () => {
      for (const evt of parser.flush()) handle(evt);
      stdoutEnded = true;
      maybeFinalize();
    });

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_KEEP);
    });

    child.on('error', (err) => {
      fail(
        new TorisError(
          `Could not run "${bin}" (${err?.code ?? 'spawn failed'}). ` +
            `Install the Claude CLI and sign in with \`${bin} login\`, ` +
            'or point providers.claude.bin at the binary.',
          'E_PROVIDER_CLI',
        ),
      );
    });

    child.on('close', (code) => {
      exitCode = code ?? 0;
      exited = true;
      maybeFinalize();
    });

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            kill();
            fail(new TorisError(`${bin} did not finish within ${timeoutMs}ms.`, 'E_PROVIDER_CLI'));
          }, timeoutMs)
        : null;
    timer?.unref?.();

    const onAbort = () => {
      kill();
      fail(new TorisError('The turn was cancelled.', 'E_CANCELLED'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      for (;;) {
        if (failure) throw failure;
        if (pending.length) {
          yield pending.shift();
          continue;
        }
        if (settled) break;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
      if (failure) throw failure;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      // Covers the consumer breaking out of the loop early.
      if (!exited) kill();
    }
  }

  return Object.freeze({
    name: 'claude-cli',

    stream,

    /**
     * One turn, collapsed to its final event. The CLI has no cheaper
     * non-streaming mode, so this just drains the stream.
     * @returns {Promise<Completion>}
     */
    async complete(opts) {
      let final = null;
      for await (const evt of stream(opts)) {
        if (evt.type === 'done') final = evt;
      }
      if (!final) {
        throw new TorisError(`${bin} produced no final event.`, 'E_PROVIDER_STREAM');
      }
      return final;
    },
  });
}
