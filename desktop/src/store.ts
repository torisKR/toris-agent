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

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations(list: Conversation[]): void {
  localStorage.setItem(CONV_KEY, JSON.stringify(list));
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SET_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SET_KEY, JSON.stringify(s));
}

export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 42 ? clean.slice(0, 42) + '…' : clean;
}
