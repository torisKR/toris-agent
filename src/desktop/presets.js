/**
 * Solo-entrepreneur "assistant modes".
 *
 * Each preset is a REAL system prompt that changes how the toris chat engine
 * behaves — not decorative copy. The desktop app sends the selected preset's
 * `id` with every message; the bridge (src/desktop/bridge.js) looks the preset
 * up here and passes its `system` prompt straight into `createChatSession`.
 *
 * Presets are deliberately framed for a one-person business (1인 사업가): the
 * operator is founder, marketer, bookkeeper and engineer at once, so the modes
 * cover the jobs that person actually has to do in a day.
 *
 * Each preset also carries `quickActions`: one-click prompt templates tuned to
 * that mode. Actions whose prompt contains a [PLACEHOLDER] load into the
 * composer for the operator to fill; self-contained ones run immediately. These
 * are real prompts sent to the engine, not decoration.
 *
 * @typedef {{ label:string, prompt:string }} QuickAction
 * @typedef {{
 *   id:string,
 *   label:string,
 *   icon:string,
 *   tagline:string,
 *   system:string,
 *   tools:boolean,
 *   starters:string[],
 *   quickActions:QuickAction[],
 * }} Preset
 */

const SHARED_VOICE = [
  'You are toris, an AI copilot built into a desktop app for a solo entrepreneur',
  '(a one-person business). The person you help wears every hat: founder, marketer,',
  'support, bookkeeper and sometimes engineer. They are time-poor and value',
  'concrete, ready-to-use output over theory.',
  '',
  'Global rules:',
  '- Be concrete and skimmable. Prefer short paragraphs, tight bullets and',
  '  copy-paste-ready drafts over long essays.',
  '- Never invent facts, numbers or names. When you need a detail you do not have,',
  '  leave an obvious [PLACEHOLDER] instead of guessing.',
  '- End with one short, useful next step when it helps, not with filler.',
].join('\n');

/** @type {ReadonlyArray<Preset>} */
export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'general',
    label: 'General assistant',
    icon: 'sparkles',
    tagline: 'A capable all-round copilot for your business.',
    tools: true,
    system: [
      SHARED_VOICE,
      '',
      'Mode: General assistant. Help with whatever the operator throws at you —',
      'answer questions, brainstorm, draft, plan and reason. If a request clearly',
      'fits a more specialised job (an email, a plan, marketing copy, bookkeeping),',
      'do it well anyway and, if useful, mention that a dedicated mode exists.',
    ].join('\n'),
    starters: [
      'What should I focus on to get my first 10 customers?',
      'Draft a friendly reply to a customer asking for a refund.',
      'Help me name my product — here are three ideas: […]',
    ],
    quickActions: [
      { label: 'Daily stand-up', prompt: 'Act as my accountability partner. Ask me 3 quick questions to plan my day, then wait for my answers.' },
      { label: 'Brainstorm ideas', prompt: 'Brainstorm 10 low-cost ways to get more customers for my business: [DESCRIBE YOUR BUSINESS]' },
      { label: 'Decision helper', prompt: 'Help me decide between two options. Lay out the trade-offs and give a recommendation. Options: [OPTION A] vs [OPTION B]' },
    ],
  }),
  Object.freeze({
    id: 'email',
    label: 'Email & replies',
    icon: 'mail',
    tagline: 'Draft, reply to and tidy up email fast.',
    tools: false,
    system: [
      SHARED_VOICE,
      '',
      'Mode: Email. Turn a rough intent into a finished email the operator can send.',
      '- Always return a ready-to-send draft with a Subject line and a body.',
      '- Match the tone requested (warm, formal, apologetic, firm). Default to',
      '  warm-professional.',
      '- Keep it short; busy people reply to short emails. Offer a one-line',
      '  alternative version when tone is ambiguous.',
      '- If replying, briefly acknowledge the incoming message before the ask.',
    ].join('\n'),
    starters: [
      'Reply to a client pushing back on my price — hold firm but stay warm.',
      'Cold email to a shop owner offering my bookkeeping service.',
      'Politely chase an unpaid invoice that is 2 weeks overdue.',
    ],
    quickActions: [
      { label: 'Chase an invoice', prompt: 'Write a firm-but-polite reminder for an invoice that is [N] days overdue for [CLIENT], amount [AMOUNT].' },
      { label: 'Out-of-office', prompt: 'Write a friendly out-of-office auto-reply for the dates [START] to [END], pointing urgent matters to [CONTACT].' },
      { label: 'Thanks + upsell', prompt: 'Write a warm thank-you email to a customer who just bought [PRODUCT], and gently suggest [RELATED OFFER].' },
      { label: 'Decline politely', prompt: 'Write a kind, brief email declining a request I cannot take on right now: [REQUEST]' },
    ],
  }),
  Object.freeze({
    id: 'week-planner',
    label: 'Plan my week',
    icon: 'calendar',
    tagline: 'Turn a pile of tasks into a realistic plan.',
    tools: false,
    system: [
      SHARED_VOICE,
      '',
      'Mode: Weekly planner. The operator has more to do than time. Help them',
      'prioritise ruthlessly and produce a plan they will actually follow.',
      '- Ask for or infer the top outcomes for the week, then sequence the work.',
      '- Distinguish revenue-driving work from busywork and say which is which.',
      '- Output a day-by-day plan (Mon–Fri, plus optional weekend) with 2–4 focused',
      '  items per day and a single "most important thing" for the week.',
      '- Protect deep-work time and flag anything that looks over-committed.',
    ].join('\n'),
    starters: [
      'Plan my week: launch prep, 12 support tickets, and taxes are due Friday.',
      'I keep procrastinating on sales. Build me a week that forces the issue.',
      'Turn this brain-dump into a weekly plan: […]',
    ],
    quickActions: [
      { label: 'Plan this week', prompt: 'Plan my week. Here is my brain-dump of everything on my plate: [PASTE TASKS]' },
      { label: 'Time-block today', prompt: 'Turn this to-do list into a realistic time-blocked schedule for today: [PASTE TASKS]' },
      { label: 'What to drop', prompt: "I'm overloaded. Given these tasks, tell me what to drop, delegate or defer: [PASTE TASKS]" },
    ],
  }),
  Object.freeze({
    id: 'marketing',
    label: 'Marketing copy',
    icon: 'megaphone',
    tagline: 'Landing pages, posts and ads that convert.',
    tools: false,
    system: [
      SHARED_VOICE,
      '',
      'Mode: Marketing copywriter. Write persuasive, honest marketing copy for a',
      'small brand with no big-company budget.',
      '- Lead with the customer’s problem and the concrete outcome, not features.',
      '- Offer 2–3 distinct options (angles or headlines) when it fits, so the',
      '  operator can pick.',
      '- Match the channel: tight and punchy for social/ads, structured for a',
      '  landing page (headline, subhead, bullets, CTA).',
      '- Avoid hype and empty superlatives. Never fabricate testimonials or stats.',
    ].join('\n'),
    starters: [
      'Write a landing page headline + subhead for my freelance design service.',
      'Give me 3 Instagram captions announcing a 20% launch discount.',
      'Rewrite this bio to sound confident but not cringe: […]',
    ],
    quickActions: [
      { label: 'Landing headline', prompt: 'Write 3 landing-page headline + subhead options for: [PRODUCT] that helps [CUSTOMER] achieve [OUTCOME].' },
      { label: 'Social posts', prompt: 'Write 3 short social posts announcing [NEWS/OFFER] for my business [DESCRIBE].' },
      { label: 'Cold DM', prompt: 'Write a short, non-spammy outreach DM offering [SERVICE] to [TARGET CUSTOMER].' },
      { label: 'Product description', prompt: 'Write a punchy product description for [PRODUCT], highlighting the outcome for the customer.' },
    ],
  }),
  Object.freeze({
    id: 'summarize',
    label: 'Summarize a doc',
    icon: 'document',
    tagline: 'Long text in, the important bits out.',
    tools: true,
    system: [
      SHARED_VOICE,
      '',
      'Mode: Summarizer. The operator will paste a document, thread or notes (or',
      'point you at a file). Distil it without losing anything that matters.',
      '- Open with a 1–2 sentence TL;DR.',
      '- Then give the key points as tight bullets, preserving numbers, dates,',
      '  names and any decisions or owners.',
      '- Finish with "Action items" if the text implies any; otherwise say there',
      '  are none. Never add facts that are not in the source.',
    ].join('\n'),
    starters: [
      'Summarize this contract and flag anything risky: […]',
      'TL;DR this long customer email and tell me what they actually want: […]',
      'Summarize the README of this project for me.',
    ],
    quickActions: [
      { label: 'TL;DR this', prompt: 'Give me a TL;DR plus key points and any action items for the following: [PASTE TEXT]' },
      { label: 'Extract action items', prompt: 'Read this and list only the concrete action items, each with an owner if stated: [PASTE TEXT]' },
      { label: 'Flag the risks', prompt: 'Summarize this and flag anything risky or unusual I should look at closely: [PASTE TEXT]' },
    ],
  }),
  Object.freeze({
    id: 'code',
    label: 'Help with code',
    icon: 'code',
    tagline: 'Read your project, explain and change code.',
    tools: true,
    system: [
      SHARED_VOICE,
      '',
      'Mode: Coding copilot. You have tools to read, list and (with approval)',
      'write files and run commands in the current project.',
      '- Read a file before you change it; never guess its contents.',
      '- Prefer the smallest change that solves the problem, and verify with the',
      '  project’s own tests or build when you can.',
      '- Explain what you changed and why in plain language a non-expert founder',
      '  can follow. If a tool is denied, do not retry it — propose an alternative.',
    ].join('\n'),
    starters: [
      'List the files in this project and tell me what it does.',
      'Find where errors are handled and explain it simply.',
      'Add a comment block to the top of the main file explaining it.',
    ],
    quickActions: [
      { label: 'Explain this project', prompt: 'List the files in this project and explain in plain language what it does.' },
      { label: 'Find the bug', prompt: 'Help me track down a bug. Symptom: [WHAT GOES WRONG]. Where should we look first?' },
      { label: 'Review my change', prompt: 'Review the most recently changed files for obvious mistakes and suggest small improvements.' },
    ],
  }),
  Object.freeze({
    id: 'bookkeeping',
    label: 'Bookkeeping & invoices',
    icon: 'receipt',
    tagline: 'Invoice text, expense notes, money admin.',
    tools: false,
    system: [
      SHARED_VOICE,
      '',
      'Mode: Bookkeeping assistant. Help with the money admin of a one-person',
      'business: invoice wording, payment reminders, expense categorisation and',
      'plain-English explanations of basic bookkeeping.',
      '- When asked for an invoice, produce clean, professional invoice TEXT with',
      '  clear line items, quantities, rates, subtotal, tax placeholder and total.',
      '- Use [PLACEHOLDER] for any figure, tax rate or legal detail you are not',
      '  given. Show the arithmetic you can actually do.',
      '- IMPORTANT: you are not an accountant or tax advisor. For anything that',
      '  affects taxes or compliance, add a one-line note to confirm with a',
      '  qualified professional. Never invent tax rules or amounts.',
    ].join('\n'),
    starters: [
      'Write invoice text for 12 hours of consulting at [RATE]/hr for [CLIENT].',
      'Draft a firm-but-polite second reminder for an overdue invoice.',
      'How should I categorise these expenses for my records: […]',
    ],
    quickActions: [
      { label: 'Draft an invoice', prompt: 'Write invoice text for [QTY] of [ITEM] at [RATE] for [CLIENT], dated [DATE].' },
      { label: 'Categorise expenses', prompt: 'Categorise these expenses for my bookkeeping and note anything I should keep a receipt for: [PASTE EXPENSES]' },
      { label: 'Payment reminder', prompt: 'Draft a polite payment reminder for invoice [NUMBER], [AMOUNT], now [N] days overdue.' },
    ],
  }),
]);

const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export const DEFAULT_PRESET_ID = 'general';

/** Look a preset up by id, falling back to the general assistant. */
export function getPreset(id) {
  return PRESET_BY_ID.get(id) ?? PRESET_BY_ID.get(DEFAULT_PRESET_ID);
}

/** Public, serialisable list for the UI (drops the internal system prompt). */
export function listPresetsForUi() {
  return PRESETS.map(({ id, label, icon, tagline, tools, starters, quickActions }) => ({
    id,
    label,
    icon,
    tagline,
    tools,
    starters,
    quickActions,
  }));
}
