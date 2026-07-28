import { TorisError } from './errors.js';

/**
 * The agent loop: model -> tool calls -> tool results -> model, until the model
 * stops asking for tools. This is what makes toris an agent rather than a
 * chat box, and it is the piece that was missing.
 *
 * History is kept in a PROVIDER-NEUTRAL shape:
 *   { role:'user',      content:string }
 *   { role:'assistant', content:string, toolCalls:ToolCall[] }
 *   { role:'tool',      toolCallId:string, name:string, content:string, isError?:boolean }
 * Each provider translates this to its own wire format, so swapping models
 * mid-session never rewrites the transcript.
 */

/** A runaway tool loop burns real money; cap it and say so. */
const MAX_TOOL_TURNS = 24;

/**
 * @typedef {{name:string, description:string, inputSchema?:object,
 *            needsApproval?:boolean, run:(input:any, ctx:any)=>Promise<any>}} Tool
 */

/** Tool output must reach the model as text, whatever the tool returned. */
function stringifyResult(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * @param {{
 *   provider: {name:string, stream:Function, complete:Function},
 *   model: string,
 *   system?: string,
 *   tools?: Tool[],
 *   maxTokens?: number,
 *   approve?: (call:{name:string,input:any}) => Promise<boolean>,
 *   onEvent?: (evt:{type:string, [k:string]:any}) => void,
 * }} opts
 */
export function createChatSession({
  provider,
  model,
  system,
  tools = [],
  maxTokens,
  approve,
  onEvent = () => {},
}) {
  if (!provider) throw new TorisError('createChatSession needs a provider.', 'E_INVALID_ARG');

  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  /** @type {ReadonlyArray<object>} */
  let messages = [];
  const usage = { inputTokens: 0, outputTokens: 0, turns: 0 };

  const addUsage = (u) => {
    usage.inputTokens += u?.inputTokens ?? 0;
    usage.outputTokens += u?.outputTokens ?? 0;
  };

  /** Stream one model turn, surfacing text deltas live to the caller. */
  async function streamTurn(signal) {
    const iterator = provider.stream({
      model,
      system,
      messages,
      tools,
      maxTokens,
      signal,
    });
    let final = null;
    for await (const evt of iterator) {
      if (evt.type === 'text') {
        onEvent({ type: 'text', delta: evt.delta });
      } else if (evt.type === 'done') {
        final = evt;
      }
    }
    if (!final) {
      throw new TorisError('The model stream ended without a final event.', 'E_PROVIDER_STREAM');
    }
    addUsage(final.usage);
    usage.turns += 1;
    return final;
  }

  /**
   * Run one tool call. A tool that throws is NOT fatal: the error goes back to
   * the model as a tool result so it can correct itself, which is how the CLI
   * agents behave. Only a refused approval stops the action.
   */
  async function runToolCall(call, signal) {
    const tool = toolsByName.get(call.name);
    if (!tool) {
      onEvent({ type: 'tool-error', name: call.name, error: 'unknown tool' });
      return {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `No tool named "${call.name}" is registered.`,
        isError: true,
      };
    }

    if (tool.needsApproval && approve) {
      const allowed = await approve({ name: call.name, input: call.input });
      if (!allowed) {
        onEvent({ type: 'tool-denied', name: call.name });
        return {
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: 'The operator denied this action. Do not retry it; propose an alternative.',
          isError: true,
        };
      }
    }

    onEvent({ type: 'tool-start', name: call.name, input: call.input });
    try {
      const output = await tool.run(call.input, { signal });
      onEvent({ type: 'tool-end', name: call.name });
      return {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: stringifyResult(output),
      };
    } catch (err) {
      onEvent({ type: 'tool-error', name: call.name, error: err.message });
      return {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `Tool failed: ${err.message}`,
        isError: true,
      };
    }
  }

  /**
   * Send one user message and drive the loop to completion.
   * @returns {Promise<{text:string, usage:object}>}
   */
  async function send(text, { signal } = {}) {
    messages = [...messages, { role: 'user', content: text }];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const result = await streamTurn(signal);
      messages = [
        ...messages,
        { role: 'assistant', content: result.text, toolCalls: result.toolCalls },
      ];

      if (!result.toolCalls?.length) {
        onEvent({ type: 'turn-end', usage: { ...usage } });
        return { text: result.text, usage: { ...usage } };
      }

      // Sequential on purpose: tools mutate a shared workspace, and interleaved
      // writes are the hardest class of agent bug to reproduce.
      const results = [];
      for (const call of result.toolCalls) {
        results.push(await runToolCall(call, signal));
      }
      messages = [...messages, ...results];
    }

    throw new TorisError(
      `The agent used tools ${MAX_TOOL_TURNS} times without finishing. Stopping so it ` +
        'cannot loop on your budget. Narrow the request and try again.',
      'E_TOOL_LOOP',
    );
  }

  return Object.freeze({
    send,
    get history() {
      return messages;
    },
    get usage() {
      return { ...usage };
    },
    /** Replace the transcript (used by `/clear` and by session resume). */
    reset(next = []) {
      messages = [...next];
    },
  });
}
