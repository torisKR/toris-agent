// Local, offline conversation + settings persistence (localStorage). No server,
// no account — matching toris's local-first ethos.

export interface ToolActivity {
  name: string;
  input?: any;
  status: 'running' | 'done' | 'error' | 'denied' | 'awaiting';
  callId?: string;
  error?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolActivity[];
  demo?: boolean;
  provider?: string;
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  presetId: string;
  profileId: string;
  autonomy: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export interface Settings {
  profileId: string;
  presetId: string;
  autonomy: string;
  onboarded: boolean;
}

const CONV_KEY = 'toris.conversations.v1';
const SET_KEY = 'toris.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  profileId: 'demo',
  presetId: 'general',
  autonomy: 'L3',
  onboarded: false,
};

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Some webviews restrict or disable localStorage on custom protocols. Every
// access is guarded so a storage failure degrades to an in-memory session
// rather than breaking the UI (a save that throws must never abort a handler).
const memory = new Map<string, string>();

function readItem(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch {
    /* fall through to memory */
  }
  return memory.get(key) ?? null;
}

export function writeItem(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* keep the in-memory copy only */
  }
}

export function hasStored(key: string): boolean {
  try {
    if (localStorage.getItem(key) !== null) return true;
  } catch {
    /* ignore */
  }
  return memory.has(key);
}

export const CONVERSATIONS_KEY = CONV_KEY;
export const SETTINGS_KEY = SET_KEY;

export function loadConversations(): Conversation[] {
  try {
    const raw = readItem(CONV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations(list: Conversation[]): void {
  writeItem(CONV_KEY, JSON.stringify(list));
}

export function loadSettings(): Settings {
  try {
    const raw = readItem(SET_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  writeItem(SET_KEY, JSON.stringify(s));
}

export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 42 ? clean.slice(0, 42) + '…' : clean;
}
