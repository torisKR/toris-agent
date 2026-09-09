// Display metadata for the solo-entrepreneur presets. This mirrors the public
// fields the backend (`src/desktop/presets.js`) sends in its `ready` event and
// is used only when running the frontend outside Tauri (browser dev/mock),
// where there is no Node bridge to provide them. The authoritative system
// prompts live in the backend and are never duplicated here.

export interface UiPreset {
  id: string;
  label: string;
  icon: string;
  tagline: string;
  tools: boolean;
  starters: string[];
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
  },
];
