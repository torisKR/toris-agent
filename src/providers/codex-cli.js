import { spawn as nodeSpawn } from 'node:child_process';
import { TorisError } from '../core/errors.js';
import { AUTO_MODEL } from '../core/models.js';

/**
 * Chat transport backed by the installed Codex CLI.
 *
 * Unlike the anthropic/openai providers, toris does NOT own the tool loop here:
 * codex runs its own tools inside its own sandbox and only reports the text it
 * decided to say. So `toolCalls` is always [] and every turn ends 'end_turn'.
 * What toris still owns is the transcript, the session continuity and the token
 * accounting surfaced back to the caller.
 *
 * Verified against `codex-cli 0.145.0` (`codex exec --help`, `codex exec resume
 * --help`, plus live runs). Syntax used:
 *
 *   first turn:  codex exec        --json [-m MODEL] -- <PROMPT>
 *   later turns: codex exec resume --json [-m MODEL] -- <SESSION_ID> <PROMPT>
 *
 * Notes on that syntax, all confirmed empirically rather than assumed:
 *  - `--json` is the JSONL flag on both `exec` and `exec resume`.
 *  - `-m/--model` exists on both subcommands.
 *  - `-s/--sandbox` exists on `exec` but NOT on `exec resume`, so it is never
 *    passed; sandbox policy is left to the user's ~/.codex/config.toml.
 *  - `--` is accepted as the end-of-options separator, which keeps a prompt
 *    that begins with '-' from being parsed as a flag.
 *  - `exec` reads stdin when it is piped ("Reading additional input from
 *    stdin..."), so the child is spawned with stdin ignored.
 *
 * There is no dedicated flag for a system prompt, so on the first turn the
 * system text is prepended to the prompt as a <system> preamble.
 *
 * @typedef {{role:'user'|'assistant'|'tool', content:any}} Message
 * @typedef {{type:'text', delta:string}} TextEvent
 * @typedef {{type:'done', text:string, toolCalls:[], stopReason:string,
 *            usage:{inputTokens:number,outputTokens:number}}} DoneEvent
 */

const DEFAULT_BIN = 'codex';
const DEFAULT_TIMEOUT_MS = 900_000;
/** Enough stderr to diagnose a crash, not enough to flood the terminal. */
const STDERR_TAIL_LIMIT = 500;

/** Flatten a message content field, which may be a string or content blocks. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }
  return '';
}

/**
 * Build the prompt string for one turn.
 *
 * With a session id codex still holds the transcript, so only the newest user
 * turn is sent. Without one (first turn, or a conversation restored from disk)
 * the neutral transcript is replayed into a single prompt, since `codex exec`
 * takes exactly one prompt argument and has no message-array input.
 *
 * @param {{system?:string, messages?:Message[], sessionId?:string|null}} [input]
 * @returns {string}
 */
export function buildPrompt({ system, messages = [], sessionId = null } = {}) {
  const turns = messages.filter((m) => m?.role === 'user' || m?.role === 'assistant');

  if (sessionId) {
    const latest = turns.findLast((m) => m.role === 'user');
    return textOf(latest?.content).trim();
  }

  const parts = [];
  if (system) parts.push(`<system>\n${system}\n</system>`);
  if (turns.length <= 1) {
    parts.push(textOf(turns[0]?.content));
  } else {
    // Label the replayed turns so codex can tell who said what.
    for (const turn of turns)
      parts.push(`<${turn.role}>\n${textOf(turn.content)}\n</${turn.role}>`);
  }
  return parts.join('\n\n').trim();
}

/**
 * Assemble the argv for one codex invocation.
 *
 * @param {{model?:string, sessionId?:string|null, prompt:string}} input
 * @returns {string[]}
 */
export function buildArgs({ model, sessionId = null, prompt }) {
  // 'auto' means "whatever the CLI is already configured to use", so the flag
  // is simply omitted rather than forwarded.
  const modelFlag = model && model !== AUTO_MODEL ? ['-m', model] : [];
  if (sessionId) {
    return ['exec', 'resume', '--json', ...modelFlag, '--', sessionId, prompt];
  }
  return ['exec', '--json', ...modelFlag, '--', prompt];
}

/**
 * Normalise one JSONL line into an event toris cares about.
 * Unknown shapes and malformed JSON return null so callers can skip silently:
 * codex also emits notice items (hook-trust warnings, skill-budget notes) that
 * are not part of the answer.
 *
 * @param {string} line
 * @returns {{kind:'session', sessionId:string}
 *          |{kind:'text', delta:string}
 *          |{kind:'done', usage:{inputTokens:number,outputTokens:number}}
 *          |{kind:'failed', message:string}
 *          |null}
 */
export function parseEventLine(line) {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed) return null;

  let evt;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return null; // partial or non-JSON chatter on stdout
  }
  if (!evt || typeof evt !== 'object') return null;

  switch (evt.type) {
    case 'thread.started':
      return typeof evt.thread_id === 'string'
        ? { kind: 'session', sessionId: evt.thread_id }
        : null;

    // --json reports finished items only; there is no delta event today, so
    // counting just 'item.completed' cannot double-count the answer text.
    case 'item.completed': {
      if (evt.item?.type !== 'agent_message') return null;
      const delta = typeof evt.item.text === 'string' ? evt.item.text : '';
      return delta ? { kind: 'text', delta } : null;
    }

    case 'turn.completed':
      return {
        kind: 'done',
        usage: {
          inputTokens: evt.usage?.input_tokens ?? 0,
          outputTokens: evt.usage?.output_tokens ?? 0,
        },
      };

    case 'turn.failed':
      return {
        kind: 'failed',
        message: evt.error?.message ?? 'codex reported a failed turn.',
      };

    default:
      return null;
  }
}

/**
 * Split a byte/string stream into lines, holding a partial line across chunk
 * boundaries. A JSONL record is routinely split mid-object by the pipe.
 *
 * @param {AsyncIterable<Buffer|string>} stream
 * @returns {AsyncGenerator<string>}
 */
export async function* readLines(stream) {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stream) {
    buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    for (const part of parts) yield part;
  }
  if (buffered) yield buffered; // final line may arrive without a trailing \n
}

/**
 * @param {{bin?:string, timeoutMs?:number, env?:object, spawnImpl?:Function}} [options]
 */
export function createCodexCliProvider({
  bin = DEFAULT_BIN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  spawnImpl,
} = {}) {
  const spawn = spawnImpl ?? nodeSpawn;

  /**
   * Session continuity for this provider instance. Captured from the
   * 'thread.started' event and replayed via `exec resume` on later turns so
   * codex keeps its own context instead of re-reading the whole transcript.
   * @type {string|null}
   */
  let sessionId = null;

  /**
   * One turn. Yields text as codex reports it, then exactly one 'done'.
   * @param {{model?:string, system?:string, messages?:Message[], tools?:any[],
   *          maxTokens?:number, signal?:AbortSignal}} [opts]
   * @returns {AsyncGenerator<TextEvent|DoneEvent>}
   */
  async function* stream(opts = {}) {
    const prompt = buildPrompt({ system: opts.system, messages: opts.messages, sessionId });
    const args = buildArgs({ model: opts.model, sessionId, prompt });

    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_LIMIT);
    });

    // Resolves once, whichever comes first: a spawn failure or process exit.
    const settled = new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('close', (code) => resolve({ code: code ?? 0 }));
    });

    let cancelled = false;
    let timedOut = false;
    const kill = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      cancelled = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let fullText = '';
    let done = null;
    let failure = null;

    try {
      if (child.stdout) {
        for await (const line of readLines(child.stdout)) {
          const evt = parseEventLine(line);
          if (!evt) continue;
          if (evt.kind === 'session') {
            sessionId = evt.sessionId;
          } else if (evt.kind === 'text') {
            fullText += evt.delta;
            yield { type: 'text', delta: evt.delta };
          } else if (evt.kind === 'done') {
            done = evt;
          } else if (evt.kind === 'failed') {
            failure = evt.message;
          }
        }
      }

      const result = await settled;

      if (result.error) {
        if (result.error.code === 'ENOENT') {
          throw new TorisError(
            `Could not run "${bin}". Install the Codex CLI or set the binary path ` +
              '(config: providers.codex.bin).',
            'E_PROVIDER_CLI',
          );
        }
        throw new TorisError(`Failed to run "${bin}": ${result.error.message}`, 'E_PROVIDER_CLI');
      }
      // Cancellation and timeout both kill the child, which then exits
      // non-zero, so they are reported before the generic exit-code branch.
      if (cancelled) {
        // Same code the claude-cli provider uses, so callers branch once.
        throw new TorisError('The turn was cancelled.', 'E_CANCELLED');
      }
      if (timedOut) {
        throw new TorisError(
          `"${bin}" exceeded the ${timeoutMs}ms turn timeout.`,
          'E_PROVIDER_CLI',
        );
      }
      if (result.code !== 0) {
        const tail = stderrTail.trim();
        throw new TorisError(
          `"${bin}" exited with code ${result.code}.${tail ? ` ${tail}` : ''}`,
          'E_PROVIDER_CLI',
        );
      }
      if (failure) {
        throw new TorisError(`"${bin}" reported a failed turn: ${failure}`, 'E_PROVIDER_CLI');
      }
      if (!done) {
        throw new TorisError(
          `"${bin}" exited cleanly without a terminal event.`,
          'E_PROVIDER_STREAM',
        );
      }

      yield {
        type: 'done',
        text: fullText,
        toolCalls: [], // codex runs its own tools; nothing to hand back to toris
        stopReason: 'end_turn',
        usage: done.usage,
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      kill(); // no orphan if the consumer breaks out early
    }
  }

  return Object.freeze({
    name: 'codex-cli',

    stream,

    /**
     * One turn, drained. Same result as the stream's 'done' event.
     * @returns {Promise<DoneEvent>}
     */
    async complete(opts = {}) {
      let final = null;
      for await (const evt of stream(opts)) {
        if (evt.type === 'done') final = evt;
      }
      if (!final) {
        throw new TorisError(`"${bin}" produced no final event.`, 'E_PROVIDER_STREAM');
      }
      return final;
    },
  });
}
