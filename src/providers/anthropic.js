import { TorisError } from '../core/errors.js';
import { AUTO_MODEL } from '../core/models.js';

/**
 * Direct client for the Anthropic Messages API.
 *
 * This is a real model connection, not a wrapper around another agent CLI:
 * toris owns the conversation, the tool loop and the token accounting.
 *
 * @typedef {{role:'user'|'assistant', content:any}} Message
 * @typedef {{id:string, name:string, input:any}} ToolCall
 * @typedef {{text:string, toolCalls:ToolCall[], stopReason:string|null, usage:{inputTokens:number,outputTokens:number}}} Completion
 */

const API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 4096;

/** Anthropic needs a concrete model; 'auto' has no meaning on this transport. */
function requireConcreteModel(model) {
  if (!model || model === AUTO_MODEL) {
    throw new TorisError(
      'The anthropic provider needs a concrete model id. Set "model" on the profile ' +
        '(config: models.profiles.<name>.model); "auto" is only valid for CLI-backed providers.',
      'E_MODEL_REQUIRED',
    );
  }
  return model;
}

/** Turn a failed HTTP response into an error a human can act on. */
async function toHttpError(res) {
  let body = '';
  try {
    body = (await res.text()).slice(0, 500);
  } catch {
    /* body is best-effort */
  }
  if (res.status === 401 || res.status === 403) {
    return new TorisError(
      `Anthropic rejected the credential (HTTP ${res.status}). Check ANTHROPIC_API_KEY. ${body}`,
      'E_PROVIDER_AUTH',
    );
  }
  if (res.status === 429) {
    return new TorisError(`Anthropic rate limit hit (HTTP 429). ${body}`, 'E_PROVIDER_RATE_LIMIT');
  }
  return new TorisError(
    `Anthropic request failed (HTTP ${res.status}). ${body}`,
    'E_PROVIDER_HTTP',
  );
}

/** Split a completed response body into plain text and tool calls. */
function splitContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls = blocks
    .filter((b) => b?.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
  return { text, toolCalls };
}

/** Anthropic tool schema shape. */
const toAnthropicTools = (tools) =>
  (tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

/** Tool arguments arrive as streamed JSON fragments; a bad join must not crash the turn. */
function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return { __unparsed: json };
  }
}

/**
 * Translate toris' neutral transcript into Anthropic content blocks.
 *
 * Two rules this API enforces and a naive mapping gets wrong:
 *  - tool results are `user` turns carrying `tool_result` blocks, not a `tool` role;
 *  - consecutive tool results must be merged into ONE user message.
 */
export function toWire(messages) {
  const wire = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content ?? '',
        ...(msg.isError ? { is_error: true } : {}),
      };
      const prev = wire[wire.length - 1];
      const isOpenToolTurn =
        prev?.role === 'user' &&
        Array.isArray(prev.content) &&
        prev.content[0]?.type === 'tool_result';
      if (isOpenToolTurn) {
        wire[wire.length - 1] = { role: 'user', content: [...prev.content, block] };
      } else {
        wire.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const content = [
        ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
        ...(msg.toolCalls ?? []).map((c) => ({
          type: 'tool_use',
          id: c.id,
          name: c.name,
          input: c.input ?? {},
        })),
      ];
      // An assistant turn with neither text nor tools is not a legal message.
      if (content.length) wire.push({ role: 'assistant', content });
      continue;
    }

    wire.push({ role: 'user', content: [{ type: 'text', text: msg.content ?? '' }] });
  }
  return wire;
}

/**
 * @param {{apiKey:string, fetchImpl?:Function, baseUrl?:string}} opts
 */
export function createAnthropicProvider({ apiKey, fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL }) {
  if (!apiKey) {
    throw new TorisError(
      'No Anthropic API key. Export ANTHROPIC_API_KEY, then retry.',
      'E_PROVIDER_AUTH',
    );
  }

  const request = (body, signal) =>
    fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

  const buildBody = ({ model, messages, system, tools, maxTokens }, stream) => ({
    model: requireConcreteModel(model),
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(system ? { system } : {}),
    messages: toWire(messages),
    ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
    ...(stream ? { stream: true } : {}),
  });

  return Object.freeze({
    name: 'anthropic',

    /**
     * One non-streaming turn.
     * @returns {Promise<Completion>}
     */
    async complete(opts) {
      const res = await request(buildBody(opts, false), opts.signal);
      if (!res.ok) throw await toHttpError(res);
      const json = await res.json();
      const { text, toolCalls } = splitContent(json.content);
      return {
        text,
        toolCalls,
        stopReason: json.stop_reason ?? null,
        usage: {
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
        },
      };
    },

    /**
     * Streaming turn. Yields text deltas as they arrive so a REPL can print
     * them live, then a final 'done' carrying the assembled tool calls.
     * @returns {AsyncGenerator<{type:string, [k:string]:any}>}
     */
    async *stream(opts) {
      const res = await request(buildBody(opts, true), opts.signal);
      if (!res.ok) throw await toHttpError(res);
      if (!res.body) throw new TorisError('Anthropic returned no stream body.', 'E_PROVIDER_HTTP');

      const decoder = new TextDecoder();
      /** @type {Map<number, {id:string,name:string,json:string}>} */
      const partialTools = new Map();
      const usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason = null;
      let buffered = '';
      let fullText = '';

      for await (const chunk of res.body) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;

          let evt;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue; // a partial frame; the next chunk completes it
          }

          if (evt.type === 'message_start') {
            usage.inputTokens = evt.message?.usage?.input_tokens ?? 0;
          } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            partialTools.set(evt.index, {
              id: evt.content_block.id,
              name: evt.content_block.name,
              json: '',
            });
          } else if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta') {
              fullText += evt.delta.text;
              yield { type: 'text', delta: evt.delta.text };
            } else if (evt.delta?.type === 'input_json_delta') {
              const pending = partialTools.get(evt.index);
              if (pending) pending.json += evt.delta.partial_json ?? '';
            }
          } else if (evt.type === 'message_delta') {
            stopReason = evt.delta?.stop_reason ?? stopReason;
            usage.outputTokens = evt.usage?.output_tokens ?? usage.outputTokens;
          }
        }
      }

      const toolCalls = [...partialTools.values()].map((t) => ({
        id: t.id,
        name: t.name,
        input: t.json ? safeParse(t.json) : {},
      }));
      yield { type: 'done', text: fullText, toolCalls, stopReason, usage };
    },
  });
}
