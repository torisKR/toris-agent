/**
 * A `claude` process that outlives a single turn.
 *
 * The cold path pays the CLI's whole boot — node start, config load, MCP and
 * tool discovery, session resume — before the first token of every answer. In
 * a chat loop that cost is paid over and over for a conversation the CLI is
 * perfectly capable of holding open.
 *
 * So: spawn once with `--input-format stream-json`, write one NDJSON line per
 * user turn, and read turns back off the same stdout. Boot happens while the
 * operator is still typing their first message, and every later turn starts at
 * the model instead of at execve.
 *
 * The warm path is an optimisation, never a requirement. Anything unexpected —
 * an older CLI that rejects the flags, a child that dies, a turn that produces
 * no result — is reported as `E_WARM_UNAVAILABLE` *before any output is
 * yielded*, which lets the provider fall back to the cold path without the
 * user seeing a duplicated or truncated answer.
 */

import { TorisError } from '../core/errors.js';
import { AUTO_MODEL } from '../core/models.js';
import {
  DEFAULT_BIN,
  DEFAULT_TIMEOUT_MS,
  STDERR_KEEP,
  STDERR_TAIL,
  assistantText,
  createNdjsonParser,
  describeFailure,
  partialText,
  resultUsage,
  sessionIdOf,
} from './claude-cli-protocol.js';

/**
 * Flags that turn the CLI into a stdin-driven server.
 *
 * `--include-partial-messages` is what makes the warm path feel live: without
 * it the CLI emits each assistant block only once it is complete, so a long
 * answer arrives in one lump.
 */
export const WARM_FLAGS = Object.freeze([
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--print',
  '--include-partial-messages',
]);

/** Raised when the warm path cannot serve a turn and the caller should retry cold. */
export const WARM_UNAVAILABLE = 'E_WARM_UNAVAILABLE';

const unavailable = (message) => new TorisError(message, WARM_UNAVAILABLE);

/** @param {{model?:string|null, system?:string|null}} opts @returns {string[]} */
export function warmArgs({ model, system } = {}) {
  const args = [...WARM_FLAGS];
  if (model && model !== AUTO_MODEL) args.push('--model', model);
  if (typeof system === 'string' && system.trim() !== '') {
    args.push('--append-system-prompt', system);
  }
  return args;
}

/**
 * One user turn, in the shape the CLI expects on stdin.
 * @param {string} text
 * @returns {string} A single NDJSON line, newline included.
 */
export function encodeUserTurn(text) {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: String(text) }] },
  })}\n`;
}

/**
 * @param {{
 *   bin?: string,
 *   model?: string|null,
 *   system?: string|null,
 *   env?: object,
 *   spawnImpl?: Function,
 *   timeoutMs?: number,
 *   onSessionId?: (id: string) => void,
 * }} [opts]
 */
export function createWarmSession({
  bin = DEFAULT_BIN,
  model = null,
  system = null,
  env = process.env,
  spawnImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onSessionId = () => {},
} = {}) {
  /** @type {any} */
  let child = null;
  /** Set once the warm path has proved itself unusable; never retried after. */
  let disabled = false;
  let disposed = false;
  /** One turn at a time: the CLI multiplexes nothing, and neither do we. */
  let busy = false;
  let stderrTail = '';
  /** @type {((err: Error) => void)|null} Notifies the in-flight turn of a death. */
  let onChildGone = null;

  const killChild = (signal) => {
    if (!child) return;
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };

  /**
   * A dead child is not a dead session: the next turn spawns a fresh one.
   *
   * Deliberately does NOT clear `onChildGone` — that belongs to the in-flight
   * turn, which still has to be told why its answer is never coming. Clearing
   * it here once cost the REPL a permanent hang on a dead child.
   */
  const dropChild = () => {
    child = null;
  };

  const exitGuard = () => killChild('SIGTERM');

  function spawnChild() {
    const args = warmArgs({ model, system });
    const proc = spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const parser = createNdjsonParser();

    proc.stdout?.setEncoding?.('utf8');
    proc.stderr?.setEncoding?.('utf8');

    proc.stdout?.on('data', (chunk) => {
      for (const evt of parser.push(String(chunk))) proc.onEvent?.(evt);
    });
    proc.stdout?.on('end', () => {
      for (const evt of parser.flush()) proc.onEvent?.(evt);
    });
    proc.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_KEEP);
    });

    const gone = (reason) => {
      if (child === proc) dropChild();
      onChildGone?.(reason);
    };

    proc.on('error', (err) =>
      gone(unavailable(`could not run "${bin}" (${err?.code ?? 'spawn failed'})`)),
    );
    // Writing a turn into a child that has just died raises EPIPE on the pipe,
    // not on the process. Unhandled, that is a crashed REPL; handled, it is
    // simply one more reason to fall back.
    proc.stdin?.on?.('error', (err) =>
      gone(unavailable(`${bin} closed its input (${err?.code ?? 'write failed'})`)),
    );
    proc.on('close', (code) => {
      const tail = stderrTail.slice(-STDERR_TAIL).trim();
      gone(unavailable(`${bin} exited with code ${code}${tail ? `: ${tail}` : ''}`));
    });

    // The warm child must never be the reason node refuses to exit.
    proc.unref?.();
    process.once?.('exit', exitGuard);
    return proc;
  }

  /** Boot the CLI now so the wait overlaps with the human typing. */
  function prewarm() {
    if (disabled || disposed || child) return false;
    try {
      child = spawnChild();
      return true;
    } catch {
      disabled = true;
      return false;
    }
  }

  /**
   * Stream one turn through the warm child.
   * @param {{prompt:string, signal?:AbortSignal, timeoutMs?:number}} opts
   * @returns {AsyncGenerator<{type:string, [k:string]:any}>}
   */
  async function* turn({ prompt, signal, timeoutMs: turnTimeoutMs = timeoutMs }) {
    if (disabled || disposed) throw unavailable('the warm session is not available');
    if (busy) throw unavailable('a warm turn is already in flight');
    if (signal?.aborted) throw new TorisError('The turn was cancelled.', 'E_CANCELLED');

    if (!child && !prewarm()) throw unavailable('the warm session could not be started');
    const proc = child;

    busy = true;
    /** @type {object[]} */
    const pending = [];
    /** @type {(() => void)|null} */
    let wake = null;
    /** @type {Error|null} */
    let failure = null;
    let settled = false;
    /**
     * Whether the caller has seen output. Past this point a failure can no
     * longer be answered by retrying cold — that would print the answer twice.
     */
    let emittedAny = false;
    let sawPartial = false;
    let fullText = '';

    const wakeUp = () => {
      const resume = wake;
      wake = null;
      if (resume) resume();
    };
    const emit = (evt) => {
      pending.push(evt);
      wakeUp();
    };
    const fail = (err) => {
      if (!failure) failure = err;
      settled = true;
      wakeUp();
    };

    const handle = (evt) => {
      const id = sessionIdOf(evt);
      if (id) onSessionId(id);

      const delta = partialText(evt);
      if (delta !== null) {
        sawPartial = true;
        fullText += delta;
        emit({ type: 'text', delta });
        return;
      }

      if (evt.type === 'assistant') {
        // With partial messages on, the completed block repeats text we have
        // already streamed; replaying it would double every answer.
        if (sawPartial) return;
        for (const text of assistantText(evt)) {
          fullText += text;
          emit({ type: 'text', delta: text });
        }
        return;
      }

      if (evt.type !== 'result') return; // rate_limit_event, hooks, future types

      if (evt.is_error) {
        fail(
          new TorisError(
            `${bin} reported a failed turn: ${describeFailure(evt)}`,
            'E_PROVIDER_CLI',
          ),
        );
        return;
      }

      emit({
        type: 'done',
        text: fullText || (typeof evt.result === 'string' ? evt.result : ''),
        toolCalls: [],
        stopReason: 'end_turn',
        usage: resultUsage(evt),
      });
      settled = true;
      wakeUp();
    };

    proc.onEvent = handle;
    onChildGone = (reason) => fail(reason);

    const timer =
      turnTimeoutMs > 0
        ? setTimeout(() => {
            killChild('SIGTERM');
            dropChild();
            fail(
              new TorisError(`${bin} did not finish within ${turnTimeoutMs}ms.`, 'E_PROVIDER_CLI'),
            );
          }, turnTimeoutMs)
        : null;
    timer?.unref?.();

    // SIGINT is how the CLI is asked to abandon a turn. If it takes the whole
    // process with it, `close` drops the child and the next turn respawns.
    const onAbort = () => {
      killChild('SIGINT');
      fail(new TorisError('The turn was cancelled.', 'E_CANCELLED'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      proc.stdin?.write?.(encodeUserTurn(prompt));
    } catch {
      busy = false;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      dropChild();
      throw unavailable(`${bin} would not accept input on stdin`);
    }

    try {
      for (;;) {
        if (failure && !emittedAny) throw failure;
        if (failure) throw promoted(failure, bin);
        if (pending.length) {
          emittedAny = true;
          yield pending.shift();
          continue;
        }
        if (settled) break;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
      if (failure) throw emittedAny ? promoted(failure, bin) : failure;
    } finally {
      busy = false;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (proc.onEvent === handle) proc.onEvent = null;
      onChildGone = null;
    }
  }

  return Object.freeze({
    prewarm,
    turn,

    /** True once the warm path has been ruled out for the rest of the session. */
    isDisabled: () => disabled || disposed,

    /** Permanently stop using the warm path (after a failed turn). */
    disable() {
      disabled = true;
      killChild('SIGTERM');
      dropChild();
      process.off?.('exit', exitGuard);
    },

    /** End of chat: no orphan `claude` processes left behind. */
    dispose() {
      disposed = true;
      killChild('SIGTERM');
      dropChild();
      process.off?.('exit', exitGuard);
    },
  });
}

/**
 * Once output is on screen, a warm failure is a real failure: the caller can no
 * longer silently retry, so the error must read as an error rather than as an
 * internal "try the other path" signal.
 */
function promoted(err, bin) {
  if (err?.code !== WARM_UNAVAILABLE) return err;
  return new TorisError(`${bin} stopped mid-turn: ${err.message}`, 'E_PROVIDER_STREAM');
}
