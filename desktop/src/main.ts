import './styles.css';
import { getBridge, type BridgeEvent } from './bridge';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { FALLBACK_PRESETS, type UiPreset } from './presets-ui';
import {
  loadConversations,
  saveConversations,
  loadSettings,
  saveSettings,
  deriveTitle,
  uid,
  hasStored,
  SETTINGS_KEY,
  type Conversation,
  type Message,
  type Settings,
  type ToolActivity,
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
          <div class="composer-hint">Enter to send · Shift+Enter for a new line</div>
        </div>
      </main>
    </div>
    <div class="modal-backdrop" id="settingsModal" hidden></div>
    <div class="modal-backdrop" id="onboarding" hidden></div>
  `;

  $('#newChat')!.addEventListener('click', () => startNewChat());
  $('#openSettings')!.addEventListener('click', openSettings);
  $('#toggleSidebar')!.addEventListener('click', () => $('#sidebar')!.classList.toggle('open'));

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

function renderSidebar() {
  const list = $('#convList')!;
  if (!state.conversations.length) {
    list.innerHTML = `<div class="empty-hint">No conversations yet.</div>`;
    return;
  }
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  list.innerHTML = sorted
    .map(
      (c) => `
      <div class="conv-item ${c.id === state.activeId ? 'active' : ''}" data-id="${c.id}">
        <span class="conv-title">${escapeText(c.title)}</span>
        <button class="conv-del" data-del="${c.id}" title="Delete">${icon('trash')}</button>
      </div>`,
    )
    .join('');
  list.querySelectorAll<HTMLElement>('.conv-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.conv-del')) return;
      selectConversation(el.dataset.id!);
    });
  });
  list.querySelectorAll<HTMLElement>('.conv-del').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(el.dataset.del!);
    });
  });
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
  scrollToBottom();
}

function renderEmptyState(presetId: string): string {
  const p = preset(presetId);
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
    el.addEventListener('click', () => {
      const input = $<HTMLTextAreaElement>('#input')!;
      input.value = el.dataset.starter!;
      autoGrow();
      input.focus();
    });
  });
}

function renderMessageHtml(m: Message): string {
  if (m.role === 'user') {
    return `
      <div class="msg msg-user" data-id="${m.id}">
        <div class="bubble"><div class="content">${escapeText(m.content).replace(/\n/g, '<br>')}</div></div>
        <div class="avatar you">You</div>
      </div>`;
  }
  const toolsHtml = (m.tools ?? []).map(renderToolHtml).join('');
  return `
    <div class="msg msg-assistant" data-id="${m.id}">
      <div class="avatar bot">${icon('bolt')}</div>
      <div class="bubble">
        <div class="tools">${toolsHtml}</div>
        <div class="content" data-raw="${encodeURIComponent(m.content)}"></div>
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

  const prof = state.profiles.find((p) => p.id === c!.profileId);
  const assistant: Message = {
    id: uid('a'),
    role: 'assistant',
    content: '',
    tools: [],
    demo: !prof || prof.demo || !prof.usable,
    provider: prof?.provider,
    model: prof?.model,
  };
  c.messages.push(assistant);
  persist();

  input.value = '';
  autoGrow();
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
      finalizeTurn(evt, 'interrupted');
      break;
    case 'error':
      finalizeTurn(evt, `⚠️ ${evt.message}`);
      break;
    case 'notice':
      showNotice(evt.message);
      break;
    default:
      break;
  }
}

function applyProviders(evt: BridgeEvent) {
  if (Array.isArray(evt.presets)) state.presets = evt.presets;
  if (Array.isArray(evt.profiles)) state.profiles = evt.profiles;
  if (evt.keys) state.keys = evt.keys;
  if (evt.defaultAutonomy && !hasStored(SETTINGS_KEY)) {
    state.settings.autonomy = evt.defaultAutonomy;
  }
  // Drop a stored profile selection that no longer exists.
  if (!state.profiles.some((p) => p.id === state.settings.profileId)) {
    state.settings.profileId = 'demo';
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

function finalizeTurn(evt: BridgeEvent, override?: string) {
  const s = state.streaming;
  if (!s || s.messageId !== evt.messageId) {
    // A late event for an inactive stream; ignore.
    return;
  }
  if (override) {
    s.raw = s.raw ? `${s.raw}\n\n${override}` : override;
  } else if (typeof evt.text === 'string' && evt.text.length >= s.raw.length) {
    s.raw = evt.text;
  }
  s.msg.content = s.raw;
  s.contentEl.innerHTML = renderMarkdown(s.raw);
  const conv = state.conversations.find((c) => c.id === s.conversationId);
  if (conv) conv.updatedAt = Date.now();
  persist();
  state.streaming = null;
  setStreamingUi(false);
  renderSidebar();
  $<HTMLTextAreaElement>('#input')!.focus();
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
            ${API_PROVIDERS.map(
              (p) => `
              <div class="key-row">
                <label>${p} <span class="dot ${state.keys.api?.[p] ? 'on' : 'off'}"></span></label>
                <input type="password" placeholder="${state.keys.api?.[p] ? 'key set — enter to replace' : `${p.toUpperCase()}_API_KEY`}" data-key="${p}" />
                <button class="mini" data-savekey="${p}">Save</button>
              </div>`,
            ).join('')}
          </div>
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
      inp.value = '';
    });
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

function renderOnboarding() {
  const modal = $('#onboarding')!;
  modal.hidden = false;
  modal.innerHTML = `
    <div class="modal onboard">
      <div class="onboard-hero">
        <div class="brand-mark big">${icon('bolt')}</div>
        <h1>Welcome to toris</h1>
        <p>Your AI copilot for running a one-person business (1인 사업가). It streams like ChatGPT, keeps everything local, and can actually use tools on your project.</p>
      </div>
      <div class="onboard-modes">
        <div class="onboard-modes-label">Choose a starting mode</div>
        <div class="preset-grid">
          ${state.presets
            .map(
              (p) => `
            <button class="preset-card" data-onboard-preset="${p.id}">
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
        <button class="primary" id="onboardStart">Start chatting</button>
      </div>
    </div>`;

  let chosen = state.settings.presetId;
  modal.querySelectorAll<HTMLElement>('[data-onboard-preset]').forEach((el) => {
    el.addEventListener('click', () => {
      chosen = el.dataset.onboardPreset!;
      modal.querySelectorAll('.preset-card').forEach((c) => c.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
  $('#onboardStart')!.addEventListener('click', () => {
    // Hide first so a storage hiccup can never leave the user stuck on onboarding.
    modal.hidden = true;
    state.settings.presetId = chosen;
    state.settings.onboarded = true;
    saveSettings(state.settings);
    const c = activeConversation();
    if (c) c.presetId = chosen;
    persist();
    renderTopbar();
    renderMessages();
    $<HTMLTextAreaElement>('#input')!.focus();
  });
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
