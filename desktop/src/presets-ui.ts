// Display metadata for the solo-entrepreneur presets. This mirrors the public
// fields the backend (`src/desktop/presets.js`) sends in its `ready` event and
// is used only when running the frontend outside Tauri (browser dev/mock),
// where there is no Node bridge to provide them. The authoritative system
// prompts live in the backend and are never duplicated here.

export interface QuickAction {
  label: string;
  prompt: string;
}

export interface UiPreset {
  id: string;
  label: string;
  icon: string;
  tagline: string;
  tools: boolean;
  starters: string[];
  quickActions: QuickAction[];
}

export const FALLBACK_PRESETS: UiPreset[] = [
  {
    id: 'general',
    label: 'General assistant',
    icon: 'sparkles',
    tagline: 'A capable all-round copilot for your business.',
    tools: true,
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
  },
  {
    id: 'email',
    label: 'Email & replies',
    icon: 'mail',
    tagline: 'Draft, reply to and tidy up email fast.',
    tools: false,
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
  },
  {
    id: 'week-planner',
    label: 'Plan my week',
    icon: 'calendar',
    tagline: 'Turn a pile of tasks into a realistic plan.',
    tools: false,
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
  },
  {
    id: 'marketing',
    label: 'Marketing copy',
    icon: 'megaphone',
    tagline: 'Landing pages, posts and ads that convert.',
    tools: false,
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
  },
  {
    id: 'summarize',
    label: 'Summarize a doc',
    icon: 'document',
    tagline: 'Long text in, the important bits out.',
    tools: true,
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
  },
  {
    id: 'code',
    label: 'Help with code',
    icon: 'code',
    tagline: 'Read your project, explain and change code.',
    tools: true,
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
  },
  {
    id: 'bookkeeping',
    label: 'Bookkeeping & invoices',
    icon: 'receipt',
    tagline: 'Invoice text, expense notes, money admin.',
    tools: false,
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
  },
];
