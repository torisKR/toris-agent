import './styles.css';
import { getBridge, type BridgeEvent } from './bridge';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { FALLBACK_PRESETS, type UiPreset, type QuickAction } from './presets-ui';
import {
  loadConversations,
  saveConversations,
  loadSettings,
  saveSettings,
  deriveTitle,
  uid,
  hasStored,
  SETTINGS_KEY,
  loadTemplates,
  addTemplate,
  removeTemplate,
  type Conversation,
  type Message,
  type Settings,
  type ToolActivity,
  type Template,
} from './store';

interface ProfileInfo {
  id: string;
  provider: string;
  model: string;
  usable: boolean;
  demo: boolean;
}

const AUTONOMY_LEVELS = [
  { id: 'L1', label: 'L1 · plan only' },
  { id: 'L2', label: 'L2 · ask before changes' },
  { id: 'L3', label: 'L3 · auto-approve (recommended)' },
  { id: 'L4', label: 'L4 · push to side branch' },
  { id: 'L5', label: 'L5 · fully autonomous' },
];

const bridge = getBridge();

const state = {
  presets: FALLBACK_PRESETS as UiPreset[],
  profiles: [{ id: 'demo', provider: 'demo', model: 'demo', usable: true, demo: true }] as ProfileInfo[],
  keys: { api: {} as Record<string, boolean>, cli: {} as Record<string, boolean> },
  conversations: loadConversations(),
  settings: loadSettings() as Settings,
  templates: loadTemplates(),
  workspace: '' as string,
  search: '' as string,
  renamingId: null as string | null,
  keyStatus: {} as Record<string, { ok: boolean; message: string; pending?: boolean }>,
  activeId: null as string | null,
  ready: false,
  isReal: bridge.isReal,
  streaming: null as null | {
    conversationId: string;
    messageId: string;
    raw: string;
    contentEl: HTMLElement;
    toolsEl: HTMLElement;
    msg: Message;
  },
  lastSend: null as null | { text: string; conversationId: string },
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector(sel);

function preset(id: string): UiPreset {
  return state.presets.find((p) => p.id === id) ?? state.presets[0];
}
function activeConversation(): Conversation | null {
  return state.conversations.find((c) => c.id === state.activeId) ?? null;
}
function persist() {
  saveConversations(state.conversations);
}

// --- shell ------------------------------------------------------------------

function mount() {
  const app = $('#app')!;
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark">${icon('bolt')}</div>
          <div class="brand-text"><strong>toris</strong><span>solo copilot</span></div>
        </div>
        <button class="new-chat" id="newChat">${icon('plus')}<span>New chat</span></button>
        <div class="conv-search">
          ${icon('search')}
          <input id="convSearch" type="text" placeholder="Search chats…" autocomplete="off" />
        </div>
        <div class="conv-list" id="convList"></div>
        <div class="sidebar-foot">
          <button class="ghost-btn" id="openSettings">${icon('settings')}<span>Settings</span></button>
          <div class="mode-tag" id="modeTag"></div>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <button class="icon-btn only-narrow" id="toggleSidebar" title="Toggle sidebar">${icon('menu')}</button>
          <div class="selectors">
            <label class="sel">
              <span>Mode</span>
              <select id="presetSel"></select>
            </label>
            <label class="sel">
              <span>Model</span>
              <select id="profileSel"></select>
            </label>
            <label class="sel">
              <span>Autonomy</span>
              <select id="autonomySel"></select>
            </label>
          </div>
          <div class="topbar-right">
            <span class="badge" id="demoBadge" hidden>Demo</span>
            <button class="icon-btn" id="renameConv" title="Rename chat">${icon('pencil')}</button>
            <button class="icon-btn" id="exportConv" title="Export to Markdown">${icon('download')}</button>
          </div>
        </header>
        <div class="chat-scroll" id="chatScroll">
          <div class="messages" id="messages"></div>
        </div>
        <div class="composer-wrap">
          <div class="composer">
            <textarea id="input" rows="1" placeholder="Message toris…"></textarea>
            <button class="send-btn" id="sendBtn" title="Send">${icon('send')}</button>
            <button class="send-btn stop-btn" id="stopBtn" title="Stop" hidden>${icon('stop')}</button>
          </div>
          <div class="composer-hint">
            <span>Enter to send · Shift+Enter for a new line</span>
            <button class="link-btn" id="saveTemplate" title="Save the current prompt as a reusable template">${icon('bookmark')} Save as template</button>
          </div>
        </div>
      </main>
    </div>
    <div class="modal-backdrop" id="settingsModal" hidden></div>
    <div class="modal-backdrop" id="onboarding" hidden></div>
  `;

  $('#newChat')!.addEventListener('click', () => startNewChat());
  $('#openSettings')!.addEventListener('click', openSettings);
  $('#toggleSidebar')!.addEventListener('click', () => $('#sidebar')!.classList.toggle('open'));
  $('#renameConv')!.addEventListener('click', () => beginRename(state.activeId));
  $('#exportConv')!.addEventListener('click', exportActiveConversation);

  const searchInput = $<HTMLInputElement>('#convSearch')!;
  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    renderSidebar();
  });

  const input = $<HTMLTextAreaElement>('#input')!;
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  $('#sendBtn')!.addEventListener('click', onSend);
  $('#stopBtn')!.addEventListener('click', onStop);
  $('#saveTemplate')!.addEventListener('click', saveCurrentAsTemplate);

  const presetSel = $<HTMLSelectElement>('#presetSel')!;
  presetSel.addEventListener('change', () => {
    state.settings.presetId = presetSel.value;
    const c = activeConversation();
    if (c) {
      c.presetId = presetSel.value;
      persist();
    }
    saveSettings(state.settings);
    renderTopbar();
    if (!activeConversation()?.messages.length) renderMessages();
  });
  const profileSel = $<HTMLSelectElement>('#profileSel')!;
  profileSel.addEventListener('change', () => {
    state.settings.profileId = profileSel.value;
    const c = activeConversation();
    if (c) {
      c.profileId = profileSel.value;
      persist();
    }
    saveSettings(state.settings);
    renderTopbar();
  });
  const autonomySel = $<HTMLSelectElement>('#autonomySel')!;
  autonomySel.addEventListener('change', () => {
    state.settings.autonomy = autonomySel.value;
    const c = activeConversation();
    if (c) {
      c.autonomy = autonomySel.value;
      persist();
    }
    saveSettings(state.settings);
  });
}

function autoGrow() {
  const input = $<HTMLTextAreaElement>('#input')!;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

// --- rendering --------------------------------------------------------------

function matchesSearch(c: Conversation, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (c.title.toLowerCase().includes(needle)) return true;
  return c.messages.some((m) => (m.content ?? '').toLowerCase().includes(needle));
}

function renderSidebar() {
  const list = $('#convList')!;
  if (!state.conversations.length) {
    list.innerHTML = `<div class="empty-hint">No conversations yet.</div>`;
    return;
  }
  const q = state.search.trim();
  const sorted = [...state.conversations]
    .filter((c) => matchesSearch(c, q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!sorted.length) {
    list.innerHTML = `<div class="empty-hint">No chats match “${escapeText(q)}”.</div>`;
    return;
  }
  list.innerHTML = sorted
    .map((c) => {
      if (c.id === state.renamingId) {
        return `
      <div class="conv-item renaming" data-id="${c.id}">
        <input class="conv-rename" data-rename="${c.id}" value="${escapeAttr(c.title)}" />
      </div>`;
      }
      return `
      <div class="conv-item ${c.id === state.activeId ? 'active' : ''}" data-id="${c.id}">
        <span class="conv-title">${escapeText(c.title)}</span>
        <span class="conv-actions">
          <button class="conv-icon" data-rename-btn="${c.id}" title="Rename">${icon('pencil')}</button>
          <button class="conv-icon danger" data-del="${c.id}" title="Delete">${icon('trash')}</button>
        </span>
      </div>`;
    })
    .join('');
  list.querySelectorAll<HTMLElement>('.conv-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.conv-actions') || t.closest('.conv-rename')) return;
      selectConversation(el.dataset.id!);
    });
  });
  list.querySelectorAll<HTMLElement>('[data-del]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(el.dataset.del!);
    });
  });
  list.querySelectorAll<HTMLElement>('[data-rename-btn]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      beginRename(el.dataset.renameBtn!);
    });
  });
  const renameInput = list.querySelector<HTMLInputElement>('.conv-rename');
  if (renameInput) {
    renameInput.focus();
    renameInput.select();
    const commit = () => commitRename(renameInput.dataset.rename!, renameInput.value);
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        state.renamingId = null;
        renderSidebar();
      }
    });
    renameInput.addEventListener('blur', commit);
  }
}

function beginRename(id: string | null) {
  if (!id) return;
  state.renamingId = id;
  renderSidebar();
}

function commitRename(id: string, value: string) {
  const c = state.conversations.find((x) => x.id === id);
  const name = value.trim();
  if (c && name) {
    c.title = name.length > 60 ? name.slice(0, 60) : name;
    persist();
  }
  state.renamingId = null;
  renderSidebar();
}

async function exportActiveConversation() {
  const c = activeConversation();
  if (!c || !c.messages.length) {
    showNotice('Nothing to export yet — send a message first.');
    return;
  }
  bridge.send({ type: 'export-conversation', conversationId: c.id, conversation: c });
}

function renderTopbar() {
  const c = activeConversation();
  const presetId = c?.presetId ?? state.settings.presetId;
  const profileId = c?.profileId ?? state.settings.profileId;
  const autonomy = c?.autonomy ?? state.settings.autonomy;

  const presetSel = $<HTMLSelectElement>('#presetSel')!;
  presetSel.innerHTML = state.presets
    .map((p) => `<option value="${p.id}" ${p.id === presetId ? 'selected' : ''}>${escapeText(p.label)}</option>`)
    .join('');
  const profileSel = $<HTMLSelectElement>('#profileSel')!;
  profileSel.innerHTML = state.profiles
    .map((p) => {
      const label = p.demo ? 'Demo (no key)' : `${p.id} · ${p.provider}${p.usable ? '' : ' (needs key)'}`;
      return `<option value="${p.id}" ${p.id === profileId ? 'selected' : ''}>${escapeText(label)}</option>`;
    })
    .join('');
  const autonomySel = $<HTMLSelectElement>('#autonomySel')!;
  autonomySel.innerHTML = AUTONOMY_LEVELS.map(
    (a) => `<option value="${a.id}" ${a.id === autonomy ? 'selected' : ''}>${a.label}</option>`,
  ).join('');

  const prof = state.profiles.find((p) => p.id === profileId);
  const isDemo = !prof || prof.demo || !prof.usable;
  const badge = $('#demoBadge')!;
  badge.hidden = !isDemo;

  const modeTag = $('#modeTag')!;
  modeTag.innerHTML = `${icon(preset(presetId).icon)}<span>${escapeText(preset(presetId).label)}</span>`;
}

function renderMessages() {
  const wrap = $('#messages')!;
  const c = activeConversation();
  if (!c || c.messages.length === 0) {
    wrap.innerHTML = renderEmptyState(c?.presetId ?? state.settings.presetId);
    wireEmptyState();
    return;
  }
  wrap.innerHTML = c.messages.map(renderMessageHtml).join('');
  wrap.querySelectorAll<HTMLElement>('.msg-assistant .content').forEach((el) => {
    const raw = decodeURIComponent(el.dataset.raw || '');
    el.innerHTML = renderMarkdown(raw);
  });
  wireMessageActions(wrap);
  scrollToBottom();
}

function wireMessageActions(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-copy]').forEach((el) => {
    el.addEventListener('click', () => copyToClipboard(decodeURIComponent(el.dataset.copy || ''), el));
  });
  root.querySelectorAll<HTMLElement>('[data-retry]').forEach((el) => {
    el.addEventListener('click', () => retryMessage(el.dataset.retry!));
  });
}

async function copyToClipboard(text: string, btn?: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for webviews that block the async clipboard API.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* give up silently */
    }
    ta.remove();
  }
  if (btn) {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1200);
  }
}

function retryMessage(messageId: string) {
  const c = activeConversation();
  if (!c || state.streaming) return;
  const idx = c.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return;
  const failed = c.messages[idx];
  const text = failed.retryText;
  if (!text) return;
  // Drop the failed assistant message and re-run the same user turn.
  c.messages.splice(idx, 1);
  persist();
  renderMessages();
  runTurn(c, text);
}

function renderEmptyState(presetId: string): string {
  const p = preset(presetId);
  const quickActions = p.quickActions ?? [];
  const saved: Template[] = state.templates[presetId] ?? [];
  const quickHtml = quickActions.length
    ? `
      <div class="quick-block">
        <div class="starters-label">Quick actions</div>
        <div class="quick-row">
          ${quickActions
            .map(
              (qa, i) =>
                `<button class="quick-chip" data-quick="${i}" title="${escapeAttr(qa.prompt)}">${icon('bolt')}${escapeText(qa.label)}</button>`,
            )
            .join('')}
        </div>
      </div>`
    : '';
  const savedHtml = saved.length
    ? `
      <div class="quick-block">
        <div class="starters-label">Your saved templates</div>
        <div class="quick-row">
          ${saved
            .map(
              (t) =>
                `<span class="quick-chip saved" data-tpl="${t.id}" title="${escapeAttr(t.prompt)}">${icon('bookmark')}${escapeText(t.label)}<button class="chip-del" data-tpl-del="${t.id}" title="Remove">${icon('x')}</button></span>`,
            )
            .join('')}
        </div>
      </div>`
    : '';
  return `
    <div class="empty-state">
      <div class="welcome">
        <div class="welcome-mark">${icon('bolt')}</div>
        <h1>What can I help you ship today?</h1>
        <p>Your AI copilot for running a one-person business. Pick a mode, or just start typing.</p>
      </div>
      <div class="preset-grid">
        ${state.presets
          .map(
            (pp) => `
          <button class="preset-card ${pp.id === presetId ? 'selected' : ''}" data-preset="${pp.id}">
            <span class="preset-ico">${icon(pp.icon)}</span>
            <span class="preset-name">${escapeText(pp.label)}</span>
            <span class="preset-tag">${escapeText(pp.tagline)}</span>
          </button>`,
          )
          .join('')}
      </div>
      ${quickHtml}
      ${savedHtml}
      <div class="starters">
        <div class="starters-label">Try in <strong>${escapeText(p.label)}</strong> mode:</div>
        ${p.starters
          .map((s) => `<button class="starter" data-starter="${escapeAttr(s)}">${escapeText(s)}</button>`)
          .join('')}
      </div>
    </div>`;
}

function wireEmptyState() {
  document.querySelectorAll<HTMLElement>('.preset-card').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.preset!;
      state.settings.presetId = id;
      const c = activeConversation();
      if (c) {
        c.presetId = id;
        persist();
      }
      saveSettings(state.settings);
      renderTopbar();
      renderMessages();
    });
  });
  document.querySelectorAll<HTMLElement>('.starter').forEach((el) => {
    el.addEventListener('click', () => fillComposer(el.dataset.starter!));
  });
  const presetId = activeConversation()?.presetId ?? state.settings.presetId;
  const quickActions: QuickAction[] = preset(presetId).quickActions ?? [];
  document.querySelectorAll<HTMLElement>('[data-quick]').forEach((el) => {
    el.addEventListener('click', () => {
      const qa = quickActions[Number(el.dataset.quick)];
      if (qa) useQuickPrompt(qa.prompt);
    });
  });
  const saved: Template[] = state.templates[presetId] ?? [];
  document.querySelectorAll<HTMLElement>('[data-tpl]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-tpl-del]')) return;
      const t = saved.find((x) => x.id === el.dataset.tpl);
      if (t) useQuickPrompt(t.prompt);
    });
  });
  document.querySelectorAll<HTMLElement>('[data-tpl-del]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      state.templates = removeTemplate(presetId, el.dataset.tplDel!);
      renderMessages();
    });
  });
}

/** Put text in the composer and focus it (for editing before sending). */
function fillComposer(text: string) {
  const input = $<HTMLTextAreaElement>('#input')!;
  input.value = text;
  autoGrow();
  input.focus();
}

/**
 * Run a quick action: templates with a [PLACEHOLDER] load into the composer so
 * the operator can fill them; self-contained ones send with a single click.
 */
function useQuickPrompt(prompt: string) {
  if (/\[[^\]]+\]/.test(prompt)) {
    fillComposer(prompt);
    // Select the first placeholder so it's easy to replace.
    const input = $<HTMLTextAreaElement>('#input')!;
    const m = /\[[^\]]+\]/.exec(prompt);
    if (m) input.setSelectionRange(m.index, m.index + m[0].length);
  } else {
    fillComposer(prompt);
    onSend();
  }
}

function copyBtn(m: Message): string {
  return `<button class="msg-copy" data-copy="${encodeURIComponent(m.content)}" title="Copy">${icon('copy')}</button>`;
}

function renderMessageHtml(m: Message): string {
  if (m.role === 'user') {
    return `
      <div class="msg msg-user" data-id="${m.id}">
        <div class="bubble"><div class="content">${escapeText(m.content).replace(/\n/g, '<br>')}</div></div>
        <div class="msg-tools-col">${copyBtn(m)}</div>
        <div class="avatar you">You</div>
      </div>`;
  }
  const toolsHtml = (m.tools ?? []).map(renderToolHtml).join('');
  const retry = m.error
    ? `<button class="msg-retry" data-retry="${m.id}">${icon('refresh')} Retry</button>`
    : '';
  return `
    <div class="msg msg-assistant ${m.error ? 'msg-error' : ''}" data-id="${m.id}">
      <div class="avatar bot">${icon('bolt')}</div>
      <div class="bubble">
        <div class="tools">${toolsHtml}</div>
        <div class="content" data-raw="${encodeURIComponent(m.content)}"></div>
        <div class="msg-foot">${m.content ? copyBtn(m) : ''}${retry}</div>
      </div>
    </div>`;
}

function renderToolHtml(t: ToolActivity): string {
  const cmd = t.input?.command ?? t.input?.path ?? '';
  const summary = `${t.name}${cmd ? ` · ${escapeText(String(cmd))}` : ''}`;
  if (t.status === 'awaiting') {
    return `
      <div class="tool tool-awaiting" data-callid="${t.callId}">
        <div class="tool-head">${icon('tool')}<span>Approve <strong>${escapeText(t.name)}</strong>?</span></div>
        <div class="tool-body"><code>${escapeText(String(cmd))}</code></div>
        <div class="tool-actions">
          <button class="approve" data-approve="${t.callId}">${icon('check')} Approve</button>
          <button class="deny" data-deny="${t.callId}">${icon('x')} Deny</button>
        </div>
      </div>`;
  }
  const cls =
    t.status === 'error' ? 'tool-error' : t.status === 'denied' ? 'tool-denied' : t.status === 'running' ? 'tool-running' : 'tool-done';
  const glyph = t.status === 'error' || t.status === 'denied' ? icon('x') : t.status === 'running' ? icon('tool') : icon('check');
  const label =
    t.status === 'running' ? `Running ${summary}…` : t.status === 'denied' ? `Denied ${summary}` : t.status === 'error' ? `${summary} failed` : `Ran ${summary}`;
  return `<div class="tool ${cls}">${glyph}<span>${escapeText(label)}</span></div>`;
}

function scrollToBottom() {
  const sc = $('#chatScroll')!;
  sc.scrollTop = sc.scrollHeight;
}

// --- actions ----------------------------------------------------------------

function startNewChat(): Conversation {
  const conv: Conversation = {
    id: uid('conv'),
    title: 'New chat',
    presetId: state.settings.presetId,
    profileId: state.settings.profileId,
    autonomy: state.settings.autonomy,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  state.conversations.push(conv);
  state.activeId = conv.id;
  persist();
  renderSidebar();
  renderTopbar();
  renderMessages();
  $<HTMLTextAreaElement>('#input')!.focus();
  return conv;
}

function selectConversation(id: string) {
  state.activeId = id;
  renderSidebar();
  renderTopbar();
  renderMessages();
}

function deleteConversation(id: string) {
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.activeId === id) state.activeId = state.conversations[0]?.id ?? null;
  persist();
  renderSidebar();
  renderTopbar();
  renderMessages();
}

function onSend() {
  const input = $<HTMLTextAreaElement>('#input')!;
  const text = input.value.trim();
  if (!text || state.streaming) return;

  let c = activeConversation();
  if (!c) c = startNewChat();

  const userMsg: Message = { id: uid('u'), role: 'user', content: text };
  c.messages.push(userMsg);
  if (c.title === 'New chat') c.title = deriveTitle(text);
  c.updatedAt = Date.now();
  persist();

  input.value = '';
  autoGrow();
  runTurn(c, text);
}

/** Append a streaming assistant message for `text` and drive the turn. */
function runTurn(c: Conversation, text: string) {
  const prof = state.profiles.find((p) => p.id === c.profileId);
  const assistant: Message = {
    id: uid('a'),
    role: 'assistant',
    content: '',
    tools: [],
    demo: !prof || prof.demo || !prof.usable,
    provider: prof?.provider,
    model: prof?.model,
    retryText: text,
  };
  c.messages.push(assistant);
  c.updatedAt = Date.now();
  persist();

  renderSidebar();
  renderMessages();

  // Point the streamer at the freshly rendered assistant node.
  const node = document.querySelector(`.msg[data-id="${assistant.id}"]`)!;
  state.streaming = {
    conversationId: c.id,
    messageId: assistant.id,
    raw: '',
    contentEl: node.querySelector('.content') as HTMLElement,
    toolsEl: node.querySelector('.tools') as HTMLElement,
    msg: assistant,
  };
  state.lastSend = { text, conversationId: c.id };
  setStreamingUi(true);

  bridge.send({
    type: 'send',
    conversationId: c.id,
    messageId: assistant.id,
    text,
    profileId: c.profileId,
    presetId: c.presetId,
    autonomy: c.autonomy,
  });
}

function onStop() {
  if (!state.streaming) return;
  bridge.send({ type: 'abort', conversationId: state.streaming.conversationId });
}

function saveCurrentAsTemplate() {
  const input = $<HTMLTextAreaElement>('#input')!;
  const text = input.value.trim();
  if (!text) {
    showNotice('Type a prompt first, then save it as a template.');
    return;
  }
  const presetId = activeConversation()?.presetId ?? state.settings.presetId;
  const label = deriveTitle(text);
  state.templates = addTemplate(presetId, label, text);
  showNotice(`Saved a template for “${preset(presetId).label}”. Find it on the welcome screen.`);
  if (!activeConversation()?.messages.length) renderMessages();
}

function setStreamingUi(on: boolean) {
  $('#sendBtn')!.hidden = on;
  $('#stopBtn')!.hidden = !on;
  ($('#input') as HTMLTextAreaElement).disabled = false;
}

// --- bridge events ----------------------------------------------------------

function handleEvent(evt: BridgeEvent) {
  switch (evt.type) {
    case 'ready':
      applyProviders(evt);
      state.ready = true;
      boot();
      break;
    case 'providers':
      applyProviders(evt);
      renderTopbar();
      renderSettingsBody();
      break;
    case 'text':
      onTextDelta(evt);
      break;
    case 'tool-start':
      onToolStart(evt);
      break;
    case 'tool-end':
      updateTool(evt.messageId, evt.name, 'done');
      break;
    case 'tool-error':
      updateTool(evt.messageId, evt.name, 'error', evt.error);
      break;
    case 'tool-denied':
      updateTool(evt.messageId, evt.name, 'denied');
      break;
    case 'tool-approval-request':
      onApprovalRequest(evt);
      break;
    case 'turn-end':
      finalizeTurn(evt);
      break;
    case 'aborted':
      finalizeTurn(evt, { override: '_interrupted._' });
      break;
    case 'error':
      finalizeTurn(evt, { override: `⚠️ ${evt.message}`, isError: true });
      break;
    case 'notice':
      showNotice(evt.message);
      break;
    case 'key-validation':
      onKeyValidation(evt);
      break;
    case 'workspace':
      onWorkspace(evt);
      break;
    case 'export-result':
      onExportResult(evt);
      break;
    case 'bridge-closed':
      showNotice('The local engine stopped. Restart the app to reconnect.');
      break;
    default:
      break;
  }
}

function applyProviders(evt: BridgeEvent) {
  if (Array.isArray(evt.presets)) state.presets = evt.presets;
  if (Array.isArray(evt.profiles)) state.profiles = evt.profiles;
  if (evt.keys) state.keys = evt.keys;
  if (typeof evt.cwd === 'string') state.workspace = evt.cwd;
  if (evt.defaultAutonomy && !hasStored(SETTINGS_KEY)) {
    state.settings.autonomy = evt.defaultAutonomy;
  }
  // Drop a stored profile selection that no longer exists.
  if (!state.profiles.some((p) => p.id === state.settings.profileId)) {
    state.settings.profileId = 'demo';
  }
  // Re-apply a previously chosen workspace once, on the first ready event.
  if (evt.type === 'ready' && state.settings.workspace && state.settings.workspace !== evt.cwd) {
    bridge.send({ type: 'set-cwd', path: state.settings.workspace });
  }
}

function isForStreaming(evt: BridgeEvent): boolean {
  return !!state.streaming && evt.conversationId === state.streaming.conversationId && evt.messageId === state.streaming.messageId;
}

function onTextDelta(evt: BridgeEvent) {
  if (!isForStreaming(evt)) return;
  const s = state.streaming!;
  s.raw += evt.delta;
  s.contentEl.innerHTML = renderMarkdown(s.raw) + '<span class="caret"></span>';
  scrollToBottom();
}

function onToolStart(evt: BridgeEvent) {
  if (!isForStreaming(evt)) return;
  const s = state.streaming!;
  const tool: ToolActivity = { name: evt.name, input: evt.input, status: 'running' };
  s.msg.tools = s.msg.tools ?? [];
  s.msg.tools.push(tool);
  renderTools();
}

function updateTool(messageId: string, name: string, status: ToolActivity['status'], error?: string) {
  const s = state.streaming;
  if (!s || s.messageId !== messageId) return;
  const tools = s.msg.tools ?? [];
  // Update the most recent matching running/awaiting tool.
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].name === name && (tools[i].status === 'running' || tools[i].status === 'awaiting')) {
      tools[i].status = status;
      if (error) tools[i].error = error;
      break;
    }
  }
  renderTools();
}

function onApprovalRequest(evt: BridgeEvent) {
  if (!isForStreaming(evt)) return;
  const s = state.streaming!;
  s.msg.tools = s.msg.tools ?? [];
  s.msg.tools.push({ name: evt.name, input: evt.input, status: 'awaiting', callId: evt.callId });
  renderTools();
}

function renderTools() {
  const s = state.streaming;
  if (!s) return;
  s.toolsEl.innerHTML = (s.msg.tools ?? []).map(renderToolHtml).join('');
  s.toolsEl.querySelectorAll<HTMLElement>('[data-approve]').forEach((el) => {
    el.addEventListener('click', () => decideApproval(el.dataset.approve!, true));
  });
  s.toolsEl.querySelectorAll<HTMLElement>('[data-deny]').forEach((el) => {
    el.addEventListener('click', () => decideApproval(el.dataset.deny!, false));
  });
  scrollToBottom();
}

function decideApproval(callId: string, allow: boolean) {
  const s = state.streaming;
  if (s) {
    const t = (s.msg.tools ?? []).find((x) => x.callId === callId);
    if (t) t.status = allow ? 'running' : 'denied';
    renderTools();
  }
  bridge.send({ type: 'approval', callId, allow });
}

function finalizeTurn(evt: BridgeEvent, opts: { override?: string; isError?: boolean } = {}) {
  const s = state.streaming;
  if (!s || s.messageId !== evt.messageId) {
    // A late event for an inactive stream; ignore.
    return;
  }
  if (opts.override) {
    s.raw = s.raw ? `${s.raw}\n\n${opts.override}` : opts.override;
  } else if (typeof evt.text === 'string' && evt.text.length >= s.raw.length) {
    s.raw = evt.text;
  }
  s.msg.content = s.raw;
  s.msg.error = Boolean(opts.isError);
  s.contentEl.innerHTML = renderMarkdown(s.raw);
  const conv = state.conversations.find((c) => c.id === s.conversationId);
  if (conv) conv.updatedAt = Date.now();
  persist();
  state.streaming = null;
  setStreamingUi(false);
  renderSidebar();
  // Redraw so per-message copy / retry controls attach to the finished turn.
  renderMessages();
  $<HTMLTextAreaElement>('#input')!.focus();
}

function onKeyValidation(evt: BridgeEvent) {
  state.keyStatus[evt.provider] = { ok: evt.ok, message: evt.message };
  renderSettingsBody();
  renderOnboardingProviderStatus();
}

function onWorkspace(evt: BridgeEvent) {
  state.workspace = evt.cwd ?? state.workspace;
  if (evt.ok && evt.cwd) {
    state.settings.workspace = evt.cwd;
    saveSettings(state.settings);
  }
  renderTopbar();
  renderSettingsBody();
  showNotice(evt.message);
}

function onExportResult(evt: BridgeEvent) {
  if (evt.markdown) void copyToClipboard(evt.markdown);
  if (evt.ok && evt.path) {
    showNotice(`Exported to ${evt.path} (also copied to clipboard).`);
  } else if (evt.markdown) {
    showNotice(evt.message || 'Exported: copied to clipboard.');
  } else {
    showNotice(evt.message || 'Export failed.');
  }
}

function showNotice(message: string) {
  const wrap = $('#messages')!;
  const div = document.createElement('div');
  div.className = 'notice';
  div.textContent = message;
  wrap.appendChild(div);
  scrollToBottom();
}

// --- settings modal ---------------------------------------------------------

function openSettings() {
  const modal = $('#settingsModal')!;
  modal.hidden = false;
  renderSettingsBody();
}

function closeSettings() {
  $('#settingsModal')!.hidden = true;
}

const API_PROVIDERS = ['anthropic', 'openai', 'grok'];

function renderSettingsBody() {
  const modal = $('#settingsModal')!;
  if (modal.hidden) return;
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h2>${icon('settings')} Settings</h2>
        <button class="icon-btn" id="closeSettings">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <section>
          <h3>Provider & keys</h3>
          <p class="muted">
            ${state.isReal ? 'Keys are held in memory by the local engine only and are never written to disk.' : 'Browser preview — keys are simulated. Run the desktop app for real calls.'}
            Default to <strong>Demo</strong> when no key is set, so the app always works.
          </p>
          <div class="key-rows">
            ${API_PROVIDERS.map((p) => {
              const st = state.keyStatus[p];
              const statusHtml = st
                ? `<div class="key-status ${st.pending ? 'pending' : st.ok ? 'ok' : 'bad'}">${st.pending ? 'Validating…' : escapeText(st.message)}</div>`
                : '';
              return `
              <div class="key-block">
                <div class="key-row">
                  <label>${p} <span class="dot ${state.keys.api?.[p] ? 'on' : 'off'}"></span></label>
                  <input type="password" placeholder="${state.keys.api?.[p] ? 'key set — enter to replace' : `${p.toUpperCase()}_API_KEY`}" data-key="${p}" />
                  <button class="mini ghost" data-validatekey="${p}">Validate</button>
                  <button class="mini" data-savekey="${p}">Save</button>
                </div>
                ${statusHtml}
              </div>`;
            }).join('')}
          </div>
        </section>
        <section>
          <h3>Project workspace</h3>
          <p class="muted">Choose a folder the file tools (list/read/write, run command) operate in. Leave blank to use the app's default directory.</p>
          <div class="workspace-row">
            <input type="text" id="workspacePath" placeholder="/path/to/your/project" value="${escapeAttr(state.settings.workspace ?? '')}" />
            <button class="mini" id="setWorkspaceBtn">Set</button>
            <button class="mini ghost" id="clearWorkspaceBtn">Reset</button>
          </div>
          <div class="workspace-current">${icon('folder')}<span>${escapeText(state.workspace || 'default')}</span></div>
        </section>
        <section>
          <h3>Add a model profile</h3>
          <p class="muted">Give a provider a concrete model id to make it selectable. Model ids are yours to choose (nothing is hardcoded).</p>
          <div class="profile-add">
            <input type="text" id="npId" placeholder="name (e.g. sonnet)" />
            <select id="npProvider">${API_PROVIDERS.map((p) => `<option value="${p}">${p}</option>`).join('')}</select>
            <input type="text" id="npModel" placeholder="model id (e.g. claude-3-5-sonnet-latest)" />
            <button class="mini" id="addProfileBtn">Add</button>
          </div>
          <div class="profile-list">
            ${state.profiles
              .map(
                (p) =>
                  `<span class="pill ${p.usable ? 'ok' : 'muted'}">${escapeText(p.id)} · ${escapeText(p.provider)}${p.usable ? '' : ' (needs key)'}</span>`,
              )
              .join('')}
          </div>
        </section>
        <section>
          <h3>Default autonomy</h3>
          <p class="muted">Below L3, changes and commands ask for approval first.</p>
          <select id="setAutonomy">${AUTONOMY_LEVELS.map((a) => `<option value="${a.id}" ${a.id === state.settings.autonomy ? 'selected' : ''}>${a.label}</option>`).join('')}</select>
        </section>
      </div>
    </div>`;

  $('#closeSettings')!.addEventListener('click', closeSettings);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeSettings();
  });
  modal.querySelectorAll<HTMLElement>('[data-savekey]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = el.dataset.savekey!;
      const inp = modal.querySelector<HTMLInputElement>(`[data-key="${p}"]`)!;
      bridge.send({ type: 'set-key', provider: p, key: inp.value });
      state.keyStatus[p] = { ok: true, message: 'Key saved (held in memory only).' };
      inp.value = '';
      renderSettingsBody();
    });
  });
  modal.querySelectorAll<HTMLElement>('[data-validatekey]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = el.dataset.validatekey!;
      const inp = modal.querySelector<HTMLInputElement>(`[data-key="${p}"]`)!;
      state.keyStatus[p] = { ok: false, pending: true, message: 'Validating…' };
      renderSettingsBody();
      bridge.send({ type: 'validate-key', provider: p, key: inp.value, requestId: uid('vk') });
    });
  });
  $('#setWorkspaceBtn')!.addEventListener('click', () => {
    const path = $<HTMLInputElement>('#workspacePath')!.value.trim();
    bridge.send({ type: 'set-cwd', path });
  });
  $('#clearWorkspaceBtn')!.addEventListener('click', () => {
    $<HTMLInputElement>('#workspacePath')!.value = '';
    state.settings.workspace = undefined;
    saveSettings(state.settings);
    bridge.send({ type: 'set-cwd', path: '' });
  });
  $('#addProfileBtn')!.addEventListener('click', () => {
    const id = $<HTMLInputElement>('#npId')!.value.trim();
    const provider = $<HTMLSelectElement>('#npProvider')!.value;
    const model = $<HTMLInputElement>('#npModel')!.value.trim();
    if (!id || !model) return;
    bridge.send({ type: 'add-profile', id, provider, model });
    state.settings.profileId = id;
    saveSettings(state.settings);
  });
  $<HTMLSelectElement>('#setAutonomy')!.addEventListener('change', (e) => {
    state.settings.autonomy = (e.target as HTMLSelectElement).value;
    saveSettings(state.settings);
    renderTopbar();
  });
}

// --- onboarding -------------------------------------------------------------

const onboard = { step: 1, chosen: '' as string, provider: 'anthropic' as string };

function renderOnboarding() {
  onboard.step = 1;
  onboard.chosen = state.settings.presetId;
  onboard.provider = API_PROVIDERS[0];
  drawOnboarding();
}

function finishOnboarding() {
  const modal = $('#onboarding')!;
  // Hide first so a storage hiccup can never leave the user stuck on onboarding.
  modal.hidden = true;
  state.settings.presetId = onboard.chosen;
  state.settings.onboarded = true;
  saveSettings(state.settings);
  const c = activeConversation();
  if (c) c.presetId = onboard.chosen;
  persist();
  renderTopbar();
  renderMessages();
  $<HTMLTextAreaElement>('#input')!.focus();
}

function drawOnboarding() {
  const modal = $('#onboarding')!;
  modal.hidden = false;
  modal.innerHTML = onboard.step === 1 ? onboardStep1() : onboardStep2();
  if (onboard.step === 1) wireOnboardStep1();
  else wireOnboardStep2();
}

function onboardStep1(): string {
  return `
    <div class="modal onboard">
      <div class="onboard-hero">
        <div class="brand-mark big">${icon('bolt')}</div>
        <h1>Welcome to toris</h1>
        <p>Your AI copilot for running a one-person business (1인 사업가). It streams like ChatGPT, keeps everything local, and can actually use tools on your project.</p>
      </div>
      <div class="onboard-modes">
        <div class="onboard-modes-label">Step 1 of 2 · Choose a starting mode</div>
        <div class="preset-grid">
          ${state.presets
            .map(
              (p) => `
            <button class="preset-card ${p.id === onboard.chosen ? 'selected' : ''}" data-onboard-preset="${p.id}">
              <span class="preset-ico">${icon(p.icon)}</span>
              <span class="preset-name">${escapeText(p.label)}</span>
              <span class="preset-tag">${escapeText(p.tagline)}</span>
            </button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="onboard-foot">
        <span class="badge">Demo mode is on — no API key needed</span>
        <button class="primary" id="onboardNext">Continue ${icon('arrowRight')}</button>
      </div>
    </div>`;
}

function onboardStep2(): string {
  const st = state.keyStatus[onboard.provider];
  const statusHtml = st
    ? `<div class="key-status ${st.pending ? 'pending' : st.ok ? 'ok' : 'bad'}" id="onboardKeyStatus">${st.pending ? 'Validating…' : escapeText(st.message)}</div>`
    : `<div class="key-status" id="onboardKeyStatus"></div>`;
  return `
    <div class="modal onboard">
      <div class="onboard-hero">
        <div class="brand-mark big">${icon('bolt')}</div>
        <h1>Connect a provider</h1>
        <p>toris works right now in <strong>Demo mode</strong> with no key. To get real AI answers, add an API key — it's held in memory by the local engine only and never written to disk.</p>
      </div>
      <div class="onboard-provider">
        <div class="onboard-modes-label">Step 2 of 2 · Provider (optional)</div>
        <div class="provider-setup">
          <select id="onboardProvider">
            ${API_PROVIDERS.map((p) => `<option value="${p}" ${p === onboard.provider ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
          <input type="password" id="onboardKey" placeholder="Paste API key (optional)" />
          <button class="mini ghost" id="onboardValidate">Validate</button>
        </div>
        ${statusHtml}
        <p class="muted">You can always add or change this later in Settings, and switch between Demo and real models from the Model selector.</p>
      </div>
      <div class="onboard-foot">
        <button class="link-btn" id="onboardBack">${icon('arrowRight')} Back</button>
        <div class="onboard-foot-right">
          <button class="link-btn" id="onboardSkip">Skip — use Demo</button>
          <button class="primary" id="onboardStart">Start chatting</button>
        </div>
      </div>
    </div>`;
}

function wireOnboardStep1() {
  const modal = $('#onboarding')!;
  modal.querySelectorAll<HTMLElement>('[data-onboard-preset]').forEach((el) => {
    el.addEventListener('click', () => {
      onboard.chosen = el.dataset.onboardPreset!;
      modal.querySelectorAll('.preset-card').forEach((c) => c.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
  $('#onboardNext')!.addEventListener('click', () => {
    onboard.step = 2;
    drawOnboarding();
  });
}

function wireOnboardStep2() {
  $('#onboardBack')!.addEventListener('click', () => {
    onboard.step = 1;
    drawOnboarding();
  });
  $('#onboardSkip')!.addEventListener('click', finishOnboarding);
  $('#onboardStart')!.addEventListener('click', () => {
    // If a key was typed, save it before entering; validation is optional.
    const key = $<HTMLInputElement>('#onboardKey')!.value.trim();
    if (key) bridge.send({ type: 'set-key', provider: onboard.provider, key });
    finishOnboarding();
  });
  $<HTMLSelectElement>('#onboardProvider')!.addEventListener('change', (e) => {
    onboard.provider = (e.target as HTMLSelectElement).value;
    drawOnboarding();
  });
  $('#onboardValidate')!.addEventListener('click', () => {
    const key = $<HTMLInputElement>('#onboardKey')!.value.trim();
    state.keyStatus[onboard.provider] = { ok: false, pending: true, message: 'Validating…' };
    drawOnboarding();
    bridge.send({ type: 'validate-key', provider: onboard.provider, key, requestId: uid('vk') });
  });
}

/** Refresh the onboarding step-2 status when a validation result arrives. */
function renderOnboardingProviderStatus() {
  const modal = $('#onboarding')!;
  if (!modal.hidden && onboard.step === 2) drawOnboarding();
}

// --- helpers ----------------------------------------------------------------

function escapeText(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

// --- boot -------------------------------------------------------------------

function boot() {
  renderSidebar();
  renderTopbar();
  if (!state.activeId) {
    if (state.conversations.length) state.activeId = state.conversations[0].id;
  }
  if (!state.activeId) startNewChat();
  else renderMessages();

  if (!state.settings.onboarded) renderOnboarding();
}

mount();
bridge.onEvent(handleEvent);

// If the bridge never sends `ready` (unexpected), boot anyway after a moment so
// the UI is never stuck on a blank screen.
setTimeout(() => {
  if (!state.ready) boot();
}, 1500);
