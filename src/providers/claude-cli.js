import { spawn as nodeSpawn } from 'node:child_process';

import { TorisError } from '../core/errors.js';
import {
  DEFAULT_BIN,
  DEFAULT_TIMEOUT_MS,
  STDERR_KEEP,
  STDERR_TAIL,
  assistantText,
  buildArgs,
  createNdjsonParser,
  describeFailure,
  lastUserPrompt,
  resultUsage,
  sessionIdOf,
} from './claude-cli-protocol.js';
import { createWarmSession, WARM_UNAVAILABLE } from './claude-cli-warm.js';

/**
 * Chat provider backed by the installed `claude` CLI.
 *
 * Unlike src/providers/anthropic.js this is NOT a direct model connection: the
 * CLI owns the conversation, its own agent loop and its own login session, so
 * toris needs no API key here. The trade-off is that `toolCalls` is ALWAYS
 * empty — the CLI already ran whatever tools it wanted, and handing those calls
 * back to src/core/chat.js would execute every tool a second time.
 *
 * Turns take the warm path (one long-lived process, see claude-cli-warm.js)
 * whenever the installed CLI supports it, and the cold path — a fresh process
 * per turn — whenever it does not.
 *
 * @typedef {{role:'user'|'assistant'|'tool', content:any}} Message
 * @typedef {{inputTokens:number, outputTokens:number}} Usage
 * @typedef {{text:string, toolCalls:[], stopReason:string|null, usage:Usage}} Completion
 */

// Re-exported because these are the provider's public surface and its tests'
// entry point; the definitions moved out only to keep this file readable.
export { buildArgs, createNdjsonParser, lastUserPrompt };

/**
 * @param {{bin?:string, timeoutMs?:number, env?:object, spawnImpl?:Function,
 *          warm?:boolean}} [opts]
 * @param {boolean} [opts.warm] Hold one CLI process open across turns. Off by
 *   default: it only pays for itself in a multi-turn session, and a per-turn
 *   process is the stricter isolation for one-shot and batch callers. The chat
 *   REPL turns it on.
 */
export function createClaudeCliProvider({
  bin = DEFAULT_BIN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  spawnImpl = nodeSpawn,
  warm: warmEnabled = false,
} = {}) {
  /**
   * Per-provider conversation state. The first turn learns the id from the
   * `system:init` event; every later turn replays it through `--resume`.
   * @type {string|null}
   */
  let sessionId = null;

  /**
   * The fast path. Created eagerly so `prewarm()` can start the CLI booting
   * while the operator is still typing, but never spawned until asked.
   */
  const warm = warmEnabled
    ? createWarmSession({
        bin,
        env,
        spawnImpl,
        timeoutMs,
        // A cold fallback after a warm turn must resume the same conversation,
        // not start a second one.
        onSessionId: (id) => {
          sessionId = id;
        },
      })
    : null;

  /**
   * Cold path: one turn, one process. Correct everywhere, slow to start.
   * @returns {AsyncGenerator<{type:string, [k:string]:any}>}
   */
  async function* coldStream(opts) {
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
        if (evt.subtype === 'init') sessionId = sessionIdOf(evt) ?? sessionId;
        return;
      }

      if (evt.type === 'assistant') {
        for (const text of assistantText(evt)) {
          fullText += text;
          emit({ type: 'text', delta: text });
        }
        return;
      }

      if (evt.type === 'result') {
        result = {
          text: typeof evt.result === 'string' ? evt.result : '',
          usage: resultUsage(evt),
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

  /**
   * One turn, warm if we can, cold if we must.
   *
   * The warm session only reports `E_WARM_UNAVAILABLE` before it has yielded
   * anything, so falling through here can never duplicate visible output.
   *
   * @returns {AsyncGenerator<{type:string, [k:string]:any}>}
   */
  async function* stream(opts) {
    // Validate before either path so a malformed call fails identically.
    const prompt = lastUserPrompt(opts?.messages);

    if (warm && !warm.isDisabled()) {
      try {
        yield* warm.turn({ prompt, signal: opts?.signal, timeoutMs });
        return;
      } catch (err) {
        if (err?.code !== WARM_UNAVAILABLE) throw err;
        // An installed CLI too old for stdin streaming, or a child that died
        // before answering: stop paying for the attempt and serve it cold.
        warm.disable();
      }
    }

    yield* coldStream(opts);
  }

  return Object.freeze({
    name: 'claude-cli',

    stream,

    /**
     * Start the CLI before there is anything to ask it, so its boot overlaps
     * with the user composing their first message. Safe to call more than once.
     */
    prewarm() {
      return Boolean(warm?.prewarm());
    },

    /** End of session: leave no `claude` process behind. */
    dispose() {
      warm?.dispose();
    },

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
