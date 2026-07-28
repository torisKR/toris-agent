import { TorisError } from '../core/errors.js';
import { AUTO_MODEL } from '../core/models.js';

/**
 * Direct client for the OpenAI Chat Completions API.
 *
 * Deliberately exposes the SAME surface as the anthropic provider and
 * normalizes tool calls to the same `{id,name,input}` shape, so the agent loop
 * never branches on which provider it is talking to.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MAX_TOKENS = 4096;

function requireConcreteModel(model) {
  if (!model || model === AUTO_MODEL) {
    throw new TorisError(
      'The openai provider needs a concrete model id. Set "model" on the profile ' +
        '(config: models.profiles.<name>.model); "auto" is only valid for CLI-backed providers.',
      'E_MODEL_REQUIRED',
    );
  }
  return model;
}

async function toHttpError(res) {
  let body = '';
  try {
    body = (await res.text()).slice(0, 500);
  } catch {
    /* best-effort */
  }
  if (res.status === 401 || res.status === 403) {
    return new TorisError(
      `OpenAI rejected the credential (HTTP ${res.status}). Check OPENAI_API_KEY. ${body}`,
      'E_PROVIDER_AUTH',
    );
  }
  if (res.status === 429) {
    return new TorisError(`OpenAI rate limit hit (HTTP 429). ${body}`, 'E_PROVIDER_RATE_LIMIT');
  }
  return new TorisError(`OpenAI request failed (HTTP ${res.status}). ${body}`, 'E_PROVIDER_HTTP');
}

/** OpenAI sends tool arguments as a JSON *string*; the loop wants an object. */
function parseArguments(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsed: raw };
  }
}

const normalizeToolCalls = (calls) =>
  (calls ?? []).map((c) => ({
    id: c.id,
    name: c.function?.name ?? c.name ?? '',
    input: parseArguments(c.function?.arguments),
  }));

const toOpenAITools = (tools) =>
  (tools ?? []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));

/** OpenAI puts the system prompt in the message list rather than a top-level field. */
const withSystem = (messages, system) =>
  system ? [{ role: 'system', content: system }, ...messages] : messages;

/**
 * Translate toris' neutral transcript into OpenAI chat messages.
 *
 * Mirror image of the anthropic mapper: here tool results DO get their own
 * `tool` role, and tool arguments must be re-serialized to a JSON string.
 */
export function toWire(messages) {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content ?? '' };
    }
    if (msg.role === 'assistant') {
      const calls = msg.toolCalls ?? [];
      return {
        role: 'assistant',
        content: msg.content || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      };
    }
    return { role: 'user', content: msg.content ?? '' };
  });
}

/**
 * @param {{apiKey:string, fetchImpl?:Function, baseUrl?:string}} opts
 */
export function createOpenAIProvider({ apiKey, fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL }) {
  if (!apiKey) {
    throw new TorisError('No OpenAI API key. Export OPENAI_API_KEY, then retry.', 'E_PROVIDER_AUTH');
  }

  const request = (body, signal) =>
    fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

  const buildBody = ({ model, messages, system, tools, maxTokens }, stream) => ({
    model: requireConcreteModel(model),
    max_completion_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: withSystem(toWire(messages), system),
    ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  });

  return Object.freeze({
    name: 'openai',

    async complete(opts) {
      const res = await request(buildBody(opts, false), opts.signal);
      if (!res.ok) throw await toHttpError(res);
      const json = await res.json();
      const choice = json.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        toolCalls: normalizeToolCalls(choice?.message?.tool_calls),
        stopReason: choice?.finish_reason ?? null,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    },

    async *stream(opts) {
      const res = await request(buildBody(opts, true), opts.signal);
      if (!res.ok) throw await toHttpError(res);
      if (!res.body) throw new TorisError('OpenAI returned no stream body.', 'E_PROVIDER_HTTP');

      const decoder = new TextDecoder();
      /** @type {Map<number, {id:string,name:string,args:string}>} */
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
            continue;
          }

          if (evt.usage) {
            usage.inputTokens = evt.usage.prompt_tokens ?? usage.inputTokens;
            usage.outputTokens = evt.usage.completion_tokens ?? usage.outputTokens;
          }
          const choice = evt.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) stopReason = choice.finish_reason;

          const delta = choice.delta ?? {};
          if (delta.content) {
            fullText += delta.content;
            yield { type: 'text', delta: delta.content };
          }
          // Tool calls stream in fragments keyed by index, not by id.
          for (const call of delta.tool_calls ?? []) {
            const idx = call.index ?? 0;
            const pending = partialTools.get(idx) ?? { id: '', name: '', args: '' };
            partialTools.set(idx, {
              id: call.id ?? pending.id,
              name: call.function?.name ?? pending.name,
              args: pending.args + (call.function?.arguments ?? ''),
            });
          }
        }
      }

      const toolCalls = [...partialTools.values()].map((t) => ({
        id: t.id,
        name: t.name,
        input: parseArguments(t.args),
      }));
      yield { type: 'done', text: fullText, toolCalls, stopReason, usage };
    },
  });
}
