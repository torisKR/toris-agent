const AGENT_STORAGE_KEY = 'toris.studio.agentId';
const GUI_SLASH = {
  help: 'help', '?': 'help', h: 'help',
  agent: 'agent', agents: 'agent', role: 'agent', roles: 'agent',
  clear: 'clear', cls: 'clear', reset: 'clear',
  studio: 'studio', gui: 'studio', ui: 'studio',
};
const state = {
  token: '',
  contents: [],
  selectedId: null,
  filter: 'all',
  surface: 'review',
  agents: [],
  agentId: 'toris',
  agentReady: false,
  agentReason: '',
  agentTui: 'toris\n/agent',
  threads: {},
  busy: false,
  abort: null,
};
const elements = Object.fromEntries(['review-queue','queue-count','workspace-empty','workspace-detail','detail-kind','detail-title','detail-status','media-preview','timeline-meta','evidence-list','post-form','video-import','video-file','render-form','render-text','render-duration','render-button','quality-list','toast','open-publish','publish-dialog','publish-check','publish-confirmation','publish-submit','review-shell','agent-shell','nav-review','nav-agent','agent-list','agent-count','agent-empty','agent-empty-copy','agent-chat','agent-log','agent-form','agent-input','agent-send','agent-stop','agent-tui-hint','agent-role-copy','agent-status-copy','agent-workspace'].map((id) => [id, document.getElementById(id)]));

function announce(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  window.setTimeout(() => elements.toast.classList.remove('is-visible'), 2200);
}

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.method && init.method !== 'GET') {
    init.headers.origin = location.origin;
    init.headers['x-toris-studio-token'] = state.token;
  }
  const response = await fetch(path, init);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error?.message || `요청 실패 (${response.status})`);
  return body;
}

function itemById(id) { return state.contents.find((item) => item.id === id); }
function shortTime(value) { return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }

function renderQueue() {
  const items = state.filter === 'all' ? state.contents : state.contents.filter((item) => item.kind === state.filter || (state.filter === 'video' && item.kind === 'combined'));
  elements['queue-count'].textContent = String(items.length);
  elements['review-queue'].replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div'); empty.className = 'queue-empty'; empty.textContent = '이 필터에는 아직 콘텐츠가 없습니다.'; elements['review-queue'].append(empty); return;
  }
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `queue-item${item.id === state.selectedId ? ' is-selected' : ''}`; button.dataset.id = item.id;
    const top = document.createElement('span'); top.className = 'queue-item-top';
    const kind = document.createElement('span'); kind.className = 'queue-kind'; kind.textContent = item.kind.toUpperCase();
    const status = document.createElement('span'); status.className = 'badge'; status.textContent = item.status;
    const title = document.createElement('strong'); title.textContent = item.title;
    const meta = document.createElement('small'); meta.textContent = `${item.channels.join(' · ') || 'local'} · ${shortTime(item.updatedAt)}`;
    top.append(kind, status); button.append(top, title, meta); button.addEventListener('click', () => select(item.id)); elements['review-queue'].append(button);
  }
}

function renderQuality(item) {
  elements['quality-list'].replaceChildren();
  const rules = item.quality?.rules || [{ name: '상태', measured: item.media ? '원본 확인됨 · 렌더 대기' : '렌더 후 측정값이 표시됩니다.', passed: null }];
  for (const rule of rules) {
    const row = document.createElement('div'); row.className = 'quality-row';
    const name = document.createElement('span'); name.textContent = rule.name;
    const measured = document.createElement('span'); measured.textContent = String(rule.measured ?? '—');
    const result = document.createElement('strong'); result.textContent = rule.passed == null ? 'WAIT' : rule.passed ? 'PASS' : 'FAIL';
    if (rule.passed === false) result.style.color = 'var(--failure)';
    row.append(name, measured, result); elements['quality-list'].append(row);
  }
}

function renderWorkspace() {
  const item = itemById(state.selectedId);
  elements['workspace-empty'].hidden = Boolean(item); elements['workspace-detail'].hidden = !item;
  if (!item) { elements['render-button'].disabled = true; return; }
  elements['detail-kind'].textContent = item.kind.toUpperCase(); elements['detail-title'].textContent = item.title; elements['detail-status'].textContent = item.status;
  elements['timeline-meta'].textContent = item.media ? `${Math.round(item.media.size / 1024)} KB · LOCAL MP4` : 'LOCAL DRAFT';
  elements['media-preview'].replaceChildren();
  if (item.media) {
    const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.src = `/api/contents/${item.id}/media`; elements['media-preview'].append(video);
  } else {
    const preview = document.createElement('article'); preview.className = 'post-preview';
    const title = document.createElement('h3'); title.textContent = item.brief?.headline || item.title;
    const body = document.createElement('p'); body.textContent = item.brief?.body || '본문을 추가하면 이곳에서 실제 읽기 흐름을 확인할 수 있습니다.';
    preview.append(title, body); elements['media-preview'].append(preview);
  }
  const evidence = [
    `로컬 저장 · ${shortTime(item.createdAt)}`,
    item.media ? `원본 ${item.media.name} · SHA-256 기록` : `채널 ${item.channels.join(', ') || '미지정'} · 외부 호출 없음`,
    `현재 상태 ${item.status}`,
  ];
  elements['evidence-list'].replaceChildren(...evidence.map((text) => { const li = document.createElement('li'); li.textContent = text; return li; }));
  renderQuality(item);
  const busy = ['queued', 'running', 'rendering'].includes(item.status);
  elements['render-button'].disabled = !item.media || busy;
  elements['render-button'].textContent = busy ? '렌더 진행 중' : `${elements['render-duration'].value}초 렌더 시작`;
  elements['open-publish'].disabled = !(item.quality?.passed === true);
}

function select(id) { state.selectedId = id; renderQueue(); renderWorkspace(); document.getElementById('content-workspace').focus(); }

async function refresh(preferredId) {
  const response = await api('/api/contents'); state.contents = response.items; state.selectedId = preferredId || state.selectedId || state.contents[0]?.id || null; renderQueue(); renderWorkspace();
}

elements['post-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const created = await api('/api/contents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'post', title: form.get('title'), brief: { headline: form.get('title'), body: form.get('body'), channels: String(form.get('channels')).split(',') } }) });
    formElement.reset(); await refresh(created.id); announce('로컬 게시물 초안을 저장했습니다.');
  } catch (error) { announce(error.message); }
});

elements['video-import'].addEventListener('submit', async (event) => {
  event.preventDefault(); const formElement = event.currentTarget; const file = elements['video-file'].files[0]; if (!file) return;
  try {
    const created = await api('/api/contents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'video', title: file.name }) });
    const uploaded = await api(`/api/contents/${created.id}/upload`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'x-file-name': file.name }, body: file });
    formElement.reset(); await refresh(uploaded.id); announce('MP4를 로컬 검토 큐에 넣었습니다.');
  } catch (error) { announce(error.message); }
});

async function waitForJob(id) {
  for (let attempt = 0; attempt < 1_800; attempt += 1) {
    const job = await api(`/api/jobs/${id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new Error('렌더 상태 확인 시간이 초과되었습니다.');
}

elements['render-duration'].addEventListener('change', () => renderWorkspace());
elements['render-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const item = itemById(state.selectedId);
  if (!item?.media) return;
  elements['render-button'].disabled = true;
  elements['render-button'].textContent = '렌더 요청 중';
  try {
    const job = await api('/api/renders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentId: item.id, title: item.title, text: elements['render-text'].value || item.title, targetDuration: Number(elements['render-duration'].value) }) });
    announce('로컬 렌더를 시작했습니다.');
    const completed = await waitForJob(job.id);
    await refresh(item.id);
    if (completed.status !== 'succeeded') throw new Error(completed.error || '렌더에 실패했습니다.');
    announce('렌더와 품질 검사가 끝났습니다.');
  } catch (error) {
    await refresh(item.id);
    announce(error.message);
  }
});

const filterButtons = [...document.querySelectorAll('[data-filter]')];
for (const button of filterButtons) button.addEventListener('click', () => {
  for (const candidate of filterButtons) {
    const active = candidate === button;
    candidate.classList.toggle('is-active', active);
    candidate.setAttribute('aria-pressed', String(active));
  }
  state.filter = button.dataset.filter;
  renderQueue();
});

elements['open-publish'].addEventListener('click', () => { const item = itemById(state.selectedId); if (!item) return; elements['publish-confirmation'].placeholder = `PUBLISH ${item.id}`; elements['publish-dialog'].showModal(); });
elements['publish-dialog'].addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  elements['publish-dialog'].close();
  elements['open-publish'].focus();
});
function updatePublishGate() { const item = itemById(state.selectedId); elements['publish-submit'].disabled = !item || !elements['publish-check'].checked || elements['publish-confirmation'].value !== `PUBLISH ${item.id}`; }
elements['publish-check'].addEventListener('change', updatePublishGate); elements['publish-confirmation'].addEventListener('input', updatePublishGate);
elements['publish-submit'].addEventListener('click', async () => {
  const item = itemById(state.selectedId);
  if (!item) return;
  elements['publish-submit'].disabled = true;
  try {
    const review = await api(`/api/contents/${item.id}/review`);
    const result = await api(`/api/contents/${item.id}/release-check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmPublicPublish: true, confirmationText: elements['publish-confirmation'].value, contentHash: review.contentHash }) });
    announce(result.reason);
  } catch (error) { announce(error.message); }
  updatePublishGate();
});

function storedAgentId() {
  try { return localStorage.getItem(AGENT_STORAGE_KEY) || ''; } catch { return ''; }
}

function rememberAgent(id) {
  try { localStorage.setItem(AGENT_STORAGE_KEY, id); } catch { /* private mode */ }
}

function readSurface() {
  if (location.pathname === '/agent' || location.pathname.startsWith('/agent/')) return 'agent';
  if (location.hash === '#agent' || location.hash.startsWith('#agent/')) return 'agent';
  return 'review';
}

function readAgentId() {
  const params = new URLSearchParams(location.search);
  if (params.get('id')) return params.get('id');
  const hash = location.hash.match(/^#agent\/([^/]+)/);
  if (hash) return hash[1];
  return storedAgentId() || state.agentId || 'toris';
}

function threadOf(id = state.agentId) {
  if (!state.threads[id]) state.threads[id] = [];
  return state.threads[id];
}

function parseGuiSlash(input) {
  const raw = String(input || '').trim();
  if (!raw.startsWith('/')) return null;
  const parts = raw.slice(1).split(/\s+/).filter(Boolean);
  const head = (parts[0] || '').toLowerCase();
  const name = GUI_SLASH[head] || head;
  return { name, args: parts.slice(1), known: Boolean(GUI_SLASH[head]), raw };
}

function showSurface(name, options = {}) {
  state.surface = name === 'agent' ? 'agent' : 'review';
  if (state.surface === 'agent') {
    state.agentId = options.agentId || readAgentId();
    rememberAgent(state.agentId);
  }
  elements['review-shell'].hidden = state.surface !== 'review';
  elements['agent-shell'].hidden = state.surface !== 'agent';
  elements['nav-review'].setAttribute('aria-current', state.surface === 'review' ? 'page' : 'false');
  elements['nav-agent'].setAttribute('aria-current', state.surface === 'agent' ? 'page' : 'false');
  const url = state.surface === 'agent'
    ? (state.agentId && state.agentId !== 'toris' ? `/agent?id=${encodeURIComponent(state.agentId)}` : '/agent')
    : '/';
  if (!options.replace) history.pushState({ surface: state.surface, agentId: state.agentId }, '', url);
  else history.replaceState({ surface: state.surface, agentId: state.agentId }, '', url);
  if (state.surface === 'agent') {
    renderAgents();
    renderAgentWorkspace();
    elements['agent-workspace'].focus();
  }
}

function currentAgent() {
  return state.agents.find((item) => item.id === state.agentId) || state.agents[0] || { id: 'toris', title: 'Toris', summary: '', category: 'core', writes: true };
}

function renderAgents() {
  const items = state.agents;
  elements['agent-count'].textContent = String(items.length);
  elements['agent-list'].replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = '에이전트 목록을 불러오지 못했습니다.';
    elements['agent-list'].append(empty);
    return;
  }
  for (const agent of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `queue-item${agent.id === state.agentId ? ' is-selected' : ''}`;
    button.dataset.id = agent.id;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(agent.id === state.agentId));
    const top = document.createElement('span');
    top.className = 'queue-item-top';
    const kind = document.createElement('span');
    kind.className = 'queue-kind';
    kind.textContent = agent.category.toUpperCase();
    const status = document.createElement('span');
    status.className = 'badge';
    status.textContent = agent.writes ? 'writes' : 'read';
    const title = document.createElement('strong');
    title.textContent = agent.title;
    const meta = document.createElement('small');
    meta.textContent = agent.summary;
    top.append(kind, status);
    button.append(top, title, meta);
    button.addEventListener('click', () => showSurface('agent', { agentId: agent.id }));
    elements['agent-list'].append(button);
  }
}

function setAgentBusy(busy) {
  state.busy = busy;
  elements['agent-send'].hidden = busy;
  elements['agent-send'].disabled = busy || !state.agentReady;
  elements['agent-send'].setAttribute('aria-disabled', String(busy || !state.agentReady));
  elements['agent-stop'].hidden = !busy;
  elements['agent-input'].disabled = busy;
}

function renderAgentWorkspace() {
  const agent = currentAgent();
  const hasTurns = threadOf().length > 0;
  elements['agent-empty'].hidden = hasTurns;
  elements['agent-chat'].hidden = false;
  elements['agent-empty-copy'].textContent = state.agentReady
    ? `터미널에서는 toris --agent ${agent.id} 또는 /agent ${agent.id}로 엽니다.`
    : (state.agentReason || '모델이 연결되면 대화를 시작할 수 있습니다.');
  elements['agent-tui-hint'].textContent = state.agentTui || `toris --agent ${agent.id}\n/agent ${agent.id}`;
  elements['agent-role-copy'].textContent = `${agent.title} · ${agent.summary}`;
  elements['agent-status-copy'].textContent = state.agentReady
    ? '로컬 채팅 준비됨. 보내기는 이 브라우저에서만 동작합니다.'
    : (state.agentReason || '연결 대기');
  setAgentBusy(state.busy);
  renderAgentLog();
}

function renderAgentLog() {
  elements['agent-log'].replaceChildren();
  for (const turn of threadOf()) {
    const article = document.createElement('article');
    article.className = `chat-turn${turn.role === 'user' ? ' is-user' : ''}${turn.streaming ? ' is-streaming' : ''}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = turn.role === 'user' ? 'YOU' : turn.role === 'system' ? 'STUDIO' : (turn.agent || 'TORIS').toUpperCase();
    const body = document.createElement('p');
    body.textContent = turn.content;
    article.append(who, body);
    if (turn.tools?.length) {
      for (const tool of turn.tools) {
        const meta = document.createElement('small');
        meta.className = 'chat-tool';
        meta.textContent = tool;
        article.append(meta);
      }
    }
    elements['agent-log'].append(article);
  }
  elements['agent-log'].scrollTop = elements['agent-log'].scrollHeight;
}

function note(content) {
  threadOf().push({ role: 'system', content });
  renderAgentWorkspace();
}

function handleAgentSlash(parsed) {
  if (parsed.name === 'help') {
    note('/agent [id]  역할 목록 또는 전환\n/clear       이 에이전트 대화만 지움\n/help        이 목록\nEnter 보내기 · Shift+Enter 줄바꿈');
    return true;
  }
  if (parsed.name === 'clear') {
    state.threads[state.agentId] = [];
    announce('이 에이전트 대화를 지웠습니다.');
    renderAgentWorkspace();
    return true;
  }
  if (parsed.name === 'studio') {
    note(state.agentTui || 'toris\n/agent');
    return true;
  }
  if (parsed.name === 'agent') {
    const id = parsed.args[0];
    if (!id) {
      note(state.agents.map((agent) => `${agent.id}  ${agent.title}`).join('\n') || '에이전트 목록이 없습니다.');
      return true;
    }
    const match = state.agents.find((agent) => agent.id === id || agent.id.startsWith(id));
    if (!match) {
      note(`unknown agent "${id}"`);
      return true;
    }
    showSurface('agent', { agentId: match.id });
    announce(`${match.title}로 전환했습니다.`);
    return true;
  }
  note(`unknown command ${parsed.raw}`);
  return true;
}

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let eventName = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      try { onEvent(eventName, JSON.parse(data.join('\n'))); } catch { /* drop a malformed event */ }
    }
  }
}

async function streamAgentTurn({ agent, message, history, signal, onEvent }) {
  const response = await fetch('/api/agent/turn', {
    method: 'POST',
    headers: {
      origin: location.origin,
      'x-toris-studio-token': state.token,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ agent, message, history }),
    signal,
  });
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/event-stream')) {
    const body = type.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(body?.error?.message || `요청 실패 (${response.status})`);
    return body;
  }
  let result = null;
  let streamError = null;
  await readSse(response, (event, data) => {
    onEvent?.(event, data);
    if (event === 'done') result = data;
    if (event === 'error') streamError = new Error(data.message || `요청 실패 (${data.status || 500})`);
  });
  if (streamError) throw streamError;
  if (!result) throw new Error('응답이 끝나기 전에 연결이 끊겼습니다.');
  return result;
}

async function loadAgents() {
  const status = await api(`/api/agent/status?agent=${encodeURIComponent(state.agentId)}`);
  state.agents = status.agents || [];
  state.agentReady = Boolean(status.ready);
  state.agentReason = status.reason || '';
  state.agentTui = status.tui || 'toris\n/agent';
  if (status.agent?.id) state.agentId = status.agent.id;
  rememberAgent(state.agentId);
  renderAgents();
  renderAgentWorkspace();
}

for (const link of [elements['nav-review'], elements['nav-agent']]) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showSurface(link.dataset.surface);
  });
}

window.addEventListener('popstate', () => {
  showSurface(readSurface(), { replace: true });
});

elements['agent-input'].addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  elements['agent-form'].requestSubmit();
});

elements['agent-stop'].addEventListener('click', () => state.abort?.abort());

elements['agent-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = elements['agent-input'].value.trim();
  if (!text || state.busy) return;
  const parsed = parseGuiSlash(text);
  if (parsed) {
    elements['agent-input'].value = '';
    handleAgentSlash(parsed);
    return;
  }
  if (!state.agentReady) return;
  elements['agent-input'].value = '';
  const thread = threadOf();
  thread.push({ role: 'user', content: text });
  const history = thread
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && !item.streaming)
    .slice(0, -1)
    .map((item) => ({ role: item.role, content: item.content }));
  const assistant = { role: 'assistant', agent: state.agentId, content: '', tools: [], streaming: true };
  thread.push(assistant);
  state.abort = new AbortController();
  setAgentBusy(true);
  renderAgentWorkspace();
  try {
    const result = await streamAgentTurn({
      agent: state.agentId,
      message: text,
      history,
      signal: state.abort.signal,
      onEvent: (event, data) => {
        if (event === 'text' && data.delta) assistant.content += data.delta;
        if (event === 'tool-start' && data.name) assistant.tools.push(data.name);
        renderAgentLog();
      },
    });
    assistant.agent = result.agent?.id || assistant.agent;
    assistant.content = result.text || assistant.content;
    assistant.tools = (result.events || []).filter((evt) => evt.type === 'tool-start').map((evt) => evt.name);
    assistant.streaming = false;
    announce(`${result.agent?.title || '에이전트'}가 답했습니다.`);
  } catch (error) {
    const aborted = error.name === 'AbortError';
    assistant.streaming = false;
    if (!assistant.content) assistant.content = aborted ? '중단했습니다.' : error.message;
    announce(aborted ? '응답을 중단했습니다.' : error.message);
  }
  state.abort = null;
  setAgentBusy(false);
  renderAgentWorkspace();
});

try {
  const session = await api('/api/session'); state.token = session.token; await refresh(); document.getElementById('live-status').textContent = `${new URL(session.origin).host} · local`;
  state.agentId = readAgentId();
  await loadAgents();
  showSurface(readSurface(), { replace: true, agentId: state.agentId });
} catch (error) { document.getElementById('live-status').textContent = 'local service unavailable'; announce(error.message); }
