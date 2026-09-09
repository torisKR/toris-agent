/**
 * Demo provider — a real, key-free chat transport.
 *
 * It implements the exact same interface the toris chat engine expects from a
 * provider (`name`, async `stream(opts)` yielding `{type:'text',delta}` events
 * and a final `{type:'done', ...}`), so the ENTIRE desktop chat experience —
 * streaming, the agentic tool loop, approvals and usage — is demonstrable end
 * to end without any API key. When a real key/profile is configured the app
 * uses the real provider path instead; Demo is the always-available fallback.
 *
 * The responses are canned/echoed and clearly labelled "Demo" in the UI. To
 * prove the tool loop and approval gating are genuinely wired (not faked in the
 * frontend), the demo can emit real tool calls that the engine executes:
 *   - a read-only `list_files` call, and
 *   - a `run_command` call that runs a harmless `echo` (which is a mutating
 *     tool, so it exercises the approval prompt below L3).
 */

/** Which "Mode:" the active preset asked for, read out of the system prompt. */
function detectMode(system) {
  const match = /Mode:\s*([^.\n]+)/i.exec(system ?? '');
  return match ? match[1].trim().toLowerCase() : 'general assistant';
}

/** The most recent user turn, as plain text. */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
      return messages[i].content;
    }
  }
  return '';
}

/** Compose a mode-flavoured canned answer that visibly reacts to the input. */
function composeReply(mode, userText, { afterTool = null } = {}) {
  const topic = userText.trim() || 'your request';
  const short = topic.length > 120 ? `${topic.slice(0, 117)}…` : topic;

  if (afterTool) {
    return (
      `Here is what I found by running the **${afterTool.name}** tool:\n\n` +
      `${afterTool.summary}\n\n` +
      `That is real output from the toris tool loop — in Demo mode I drive the ` +
      `same agent engine the CLI uses, just without a paid model behind it. ` +
      `Configure a provider in Settings to get real AI answers.`
    );
  }

  if (mode.startsWith('email')) {
    return (
      `**Subject:** Re: ${short}\n\n` +
      `Hi [NAME],\n\n` +
      `Thanks for reaching out. ${short} — here's where I land: [YOUR POSITION]. ` +
      `Happy to talk it through if useful.\n\n` +
      `Best,\n[YOUR NAME]\n\n` +
      `_(Demo mode: this is a canned draft. Add an API key in Settings for real, ` +
      `tailored copy.)_`
    );
  }
  if (mode.startsWith('weekly') || mode.includes('planner')) {
    return (
      `Here's a realistic week for "${short}":\n\n` +
      `**Most important thing:** [THE ONE OUTCOME]\n\n` +
      `- **Mon** — Deep work on the priority; no meetings before noon.\n` +
      `- **Tue** — Ship the first slice; batch admin in the afternoon.\n` +
      `- **Wed** — Customer / revenue work.\n` +
      `- **Thu** — Buffer + follow-ups.\n` +
      `- **Fri** — Finish, review, plan next week.\n\n` +
      `_(Demo mode — canned plan. Connect a provider for a plan tuned to your ` +
      `actual tasks.)_`
    );
  }
  if (mode.startsWith('marketing')) {
    return (
      `Three angles for "${short}":\n\n` +
      `1. **Problem-first:** "Still doing [PAIN] by hand? [PRODUCT] does it in minutes."\n` +
      `2. **Outcome-first:** "Get [DESIRED RESULT] without [OBSTACLE]."\n` +
      `3. **Founder voice:** "I built [PRODUCT] because I was tired of [PAIN]."\n\n` +
      `_(Demo mode — canned copy. Add a key in Settings for options written for ` +
      `your real offer.)_`
    );
  }
  if (mode.startsWith('summariz')) {
    return (
      `**TL;DR:** ${short}\n\n` +
      `- Key point one [FROM SOURCE]\n` +
      `- Key point two [FROM SOURCE]\n` +
      `- Key point three [FROM SOURCE]\n\n` +
      `**Action items:** [IF ANY]\n\n` +
      `_(Demo mode — paste real text and connect a provider for a true summary.)_`
    );
  }
  if (mode.startsWith('bookkeeping')) {
    return (
      `**INVOICE (draft)**\n\n` +
      `Bill to: [CLIENT]\nInvoice #: [NUMBER]   Date: [DATE]\n\n` +
      `| Description | Qty | Rate | Amount |\n` +
      `| --- | --- | --- | --- |\n` +
      `| ${short} | [QTY] | [RATE] | [AMOUNT] |\n\n` +
      `Subtotal: [SUBTOTAL]  ·  Tax: [TAX]  ·  **Total: [TOTAL]**\n\n` +
      `Note: I'm not an accountant — confirm tax details with a professional.\n\n` +
      `_(Demo mode — canned template. Add a key for figures filled from your input.)_`
    );
  }
  if (mode.startsWith('coding') || mode.includes('code')) {
    return (
      `On "${short}": in Demo mode I can still run read-only tools against this ` +
      `project. Ask me to *"list the files in this project"* and watch the tool ` +
      `activity appear inline. Connect a real provider in Settings to have me ` +
      `actually read and change code.`
    );
  }
  return (
    `You said: "${short}"\n\n` +
    `This is **toris Demo mode** — a working ChatGPT-style chat with no API key ` +
    `required. It streams token by token, keeps your conversations in the ` +
    `sidebar, and runs the real toris agent tool loop. Open **Settings** to ` +
    `connect Anthropic, OpenAI or a CLI provider for genuine AI answers.`
  );
}

/** Decide whether this turn should showcase a tool call, and which. */
function planToolCall(userText, tools) {
  if (!tools?.length) return null;
  const names = new Set(tools.map((t) => t.name));
  if (/\b(list|files?|directory|folder|project|repo|structure)\b/i.test(userText) && names.has('list_files')) {
    return { id: `demo_${Date.now()}_ls`, name: 'list_files', input: { path: '.' } };
  }
  if (/\b(run|command|execute|approve|approval|test|build)\b/i.test(userText) && names.has('run_command')) {
    return {
      id: `demo_${Date.now()}_cmd`,
      name: 'run_command',
      input: { command: 'echo "toris demo tool ran ✔"' },
    };
  }
  return null;
}

const sleep = (ms, signal) =>
  new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/** Break text into word-ish chunks so streaming looks natural. */
function tokenize(text) {
  return text.match(/\s+|\S+/g) ?? [text];
}

/**
 * @param {{delayMs?:number}} [opts]
 * @returns {{name:string, stream:Function, complete:Function}}
 */
export function createDemoProvider({ delayMs } = {}) {
  const perToken = Number.isFinite(delayMs)
    ? delayMs
    : Number(process.env.TORIS_DEMO_DELAY_MS ?? 16);

  async function* stream({ system, messages, tools, signal }) {
    const mode = detectMode(system);
    const last = messages[messages.length - 1];

    // Follow-up turn: the engine just handed us a tool result. Summarise it and
    // finish (no more tool calls) so the agent loop terminates cleanly.
    if (last?.role === 'tool') {
      const raw = String(last.content ?? '');
      const summary =
        raw.length > 600 ? `\`\`\`\n${raw.slice(0, 600)}\n…\n\`\`\`` : `\`\`\`\n${raw}\n\`\`\``;
      const text = composeReply(mode, lastUserText(messages), {
        afterTool: { name: last.name, summary },
      });
      for (const tok of tokenize(text)) {
        await sleep(perToken, signal);
        yield { type: 'text', delta: tok };
      }
      yield {
        type: 'done',
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: tokenize(text).length },
      };
      return;
    }

    const userText = lastUserText(messages);
    const toolCall = planToolCall(userText, tools);

    if (toolCall) {
      // Announce the tool with a short line, then emit the tool call. The engine
      // runs it (and gates it by autonomy), then calls us again for the summary.
      const lead =
        toolCall.name === 'run_command'
          ? `Sure — let me run a quick command to show the tool loop.\n`
          : `Let me take a look using the ${toolCall.name} tool.\n`;
      for (const tok of tokenize(lead)) {
        await sleep(perToken, signal);
        yield { type: 'text', delta: tok };
      }
      yield {
        type: 'done',
        text: lead,
        toolCalls: [toolCall],
        stopReason: 'tool_use',
        usage: { inputTokens: 0, outputTokens: tokenize(lead).length },
      };
      return;
    }

    const text = composeReply(mode, userText);
    for (const tok of tokenize(text)) {
      await sleep(perToken, signal);
      yield { type: 'text', delta: tok };
    }
    yield {
      type: 'done',
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: tokenize(text).length },
    };
  }

  async function complete(opts) {
    let text = '';
    let final = null;
    for await (const evt of stream(opts)) {
      if (evt.type === 'text') text += evt.delta;
      else if (evt.type === 'done') final = evt;
    }
    return {
      text,
      toolCalls: final?.toolCalls ?? [],
      stopReason: final?.stopReason ?? 'end_turn',
      usage: final?.usage ?? { inputTokens: 0, outputTokens: 0 },
    };
  }

  return Object.freeze({ name: 'demo', stream, complete });
}
