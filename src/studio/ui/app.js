const AGENT_ID_KEY = 'toris.studio.agentId';
const TRANSCRIPT_KEY = 'toris.studio.agent.transcripts';
const KNOWLEDGE_PIN_KEY = 'toris.studio.knowledge.pin';
const MAX_STORED_TURNS = 40;

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
  design: null,
  captures: [],
  tray: [],
  patches: [],
  patchFilter: 'pending',
  selectedPatchId: null,
  patchDetail: null,
  selectedHunk: '',
};
const elementIds = [
  'review-queue','queue-count','workspace-empty','workspace-detail','detail-kind','detail-title','detail-status','media-preview','timeline-meta','evidence-list','post-form','video-import','video-file','render-form','render-text','render-duration','render-button','quality-list','toast','open-publish','publish-dialog','publish-check','publish-confirmation','publish-submit','review-shell','agent-shell','nav-review','nav-agent','nav-design','nav-patches','agent-list','agent-count','agent-empty','agent-empty-copy','agent-chat','agent-log','agent-form','agent-input','agent-send','agent-stop','agent-tui-hint','agent-role-copy','agent-status-copy','agent-workspace','design-shell','design-count','design-captures','design-url-form','design-url','design-sample','design-frame','design-empty-copy','design-meta','design-meta-url','design-meta-selector','design-meta-tag','design-styles','design-html','design-shot','design-item-form','design-item-note','design-item-save','design-item-remove','design-agent-form','design-note','design-send','design-agent-status','design-bookmarklet','design-workspace','patches-shell','patch-count','patch-queue','patch-workspace','patch-empty','patch-detail','patch-kind','patch-heading','patch-status','patch-truncated','patch-diff','patch-empty-copy','patch-meta','patch-meta-origin','patch-meta-files','patch-meta-stats','patch-meta-autonomy','patch-apply','patch-discard','patch-review-form','patch-note','patch-review-send','patch-review-status',
];
const elements = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));

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

function readSurface() {
  if (location.pathname === '/agent' || location.pathname.startsWith('/agent/')) return 'agent';
  if (location.pathname === '/design' || location.pathname.startsWith('/design/')) return 'design';
  if (location.pathname === '/patches' || location.pathname.startsWith('/patches/')) return 'patches';
  if (location.hash === '#agent' || location.hash.startsWith('#agent/')) return 'agent';
  if (location.hash === '#design' || location.hash.startsWith('#design') || location.hash.startsWith('#ingest=')) return 'design';
  if (location.hash === '#patches' || location.hash.startsWith('#patches')) return 'patches';
  return 'review';
}

function storedAgentId() {
  try { return localStorage.getItem(AGENT_ID_KEY) || ''; } catch { return ''; }
}

function rememberAgent(id) {
  try { localStorage.setItem(AGENT_ID_KEY, id); } catch { /* private mode */ }
}

function loadTranscripts() {
  try {
    const raw = JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

function persistTranscripts() {
  try {
    const slim = {};
    for (const [id, turns] of Object.entries(state.threads)) {
      slim[id] = (turns || [])
        .filter((item) => (item.role === 'user' || item.role === 'assistant') && !item.streaming)
        .slice(-MAX_STORED_TURNS)
        .map((item) => ({ role: item.role, content: item.content, agent: item.agent, tools: item.tools }));
    }
    localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(slim));
  } catch { /* private mode */ }
}

function threadOf(id = state.agentId) {
  if (!state.threads[id]) state.threads[id] = [];
  return state.threads[id];
}

function readAgentId() {
  const params = new URLSearchParams(location.search);
  if (params.get('id')) return params.get('id');
  const hash = location.hash.match(/^#agent\/([^/]+)/);
  if (hash) return hash[1];
  return storedAgentId() || state.agentId || 'toris';
}

function showSurface(name, options = {}) {
  state.surface = name === 'agent' || name === 'design' || name === 'patches' ? name : 'review';
  if (state.surface === 'agent') {
    state.agentId = options.agentId || readAgentId();
    rememberAgent(state.agentId);
  }
  elements['review-shell'].hidden = state.surface !== 'review';
  elements['agent-shell'].hidden = state.surface !== 'agent';
  elements['design-shell'].hidden = state.surface !== 'design';
  elements['patches-shell'].hidden = state.surface !== 'patches';
  elements['nav-review'].setAttribute('aria-current', state.surface === 'review' ? 'page' : 'false');
  elements['nav-agent'].setAttribute('aria-current', state.surface === 'agent' ? 'page' : 'false');
  elements['nav-design'].setAttribute('aria-current', state.surface === 'design' ? 'page' : 'false');
  elements['nav-patches'].setAttribute('aria-current', state.surface === 'patches' ? 'page' : 'false');
  let url = '/';
  if (state.surface === 'agent') {
    url = state.agentId && state.agentId !== 'toris' ? `/agent?id=${encodeURIComponent(state.agentId)}` : '/agent';
  } else if (state.surface === 'design') {
    url = '/design';
  } else if (state.surface === 'patches') {
    url = '/patches';
  }
  if (!options.replace) history.pushState({ surface: state.surface, agentId: state.agentId }, '', url);
  else history.replaceState({ surface: state.surface, agentId: state.agentId }, '', url);
  if (state.surface === 'agent') {
    renderAgents();
    renderAgentWorkspace();
    elements['agent-workspace'].focus();
  }
  if (state.surface === 'design') {
    renderDesign();
    elements['design-workspace'].focus();
  }
  if (state.surface === 'patches') {
    refreshPatches().catch((error) => announce(error.message));
    elements['patch-workspace'].focus();
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
  elements['agent-input'].disabled = busy || !state.agentReady;
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
  syncDesignSend();
  elements['design-agent-status'].textContent = state.agentReady
    ? (state.tray.length ? `트레이 ${state.tray.length}개를 같은 로컬 에이전트에게 보냅니다.` : '요소를 고르면 트레이에 쌓입니다.')
    : (state.agentReason || '연결 대기');
  renderAgentLog();
}

function syncDesignSend() {
  const ready = state.agentReady && state.tray.length > 0;
  elements['design-send'].disabled = !ready;
  elements['design-send'].setAttribute('aria-disabled', String(!ready));
}

function renderAgentLog() {
  elements['agent-log'].replaceChildren();
  for (const turn of threadOf()) {
    const article = document.createElement('article');
    article.className = `chat-turn${turn.role === 'user' ? ' is-user' : ''}${turn.streaming ? ' is-streaming' : ''}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = turn.role === 'user' ? 'YOU' : (turn.agent || 'TORIS').toUpperCase();
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

function knowledgePinFromStorage() {
  try {
    const raw = JSON.parse(localStorage.getItem(KNOWLEDGE_PIN_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const domain = String(raw.domain || '').trim();
    const nodeId = String(raw.nodeId || raw.id || '').trim();
    return domain && nodeId ? { domain, nodeId } : null;
  } catch {
    return null;
  }
}

function clearKnowledgePin() {
  try { localStorage.removeItem(KNOWLEDGE_PIN_KEY); } catch { /* private mode */ }
}

async function streamAgentTurn({ agent, message, history, tray, signal, onEvent }) {
  const payload = { agent, message, history };
  if (tray) payload.tray = true;
  const knowledge = knowledgePinFromStorage();
  if (knowledge) payload.knowledge = knowledge;
  const response = await fetch('/api/agent/turn', {
    method: 'POST',
    headers: {
      origin: location.origin,
      'x-toris-studio-token': state.token,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal,
  });
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/event-stream')) {
    const body = type.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(body?.error?.message || `요청 실패 (${response.status})`);
    if (knowledge) clearKnowledgePin();
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
  if (knowledge) clearKnowledgePin();
  return result;
}

function renderDesignCaptures() {
  const items = state.tray;
  elements['design-count'].textContent = String(items.length);
  elements['design-captures'].replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = '아직 주석이 없습니다. 가운데에서 페이지를 열고 요소를 클릭하세요.';
    elements['design-captures'].append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `tray-item${item.id && item.id === state.design?.id ? ' is-selected' : ''}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'queue-item';
    const top = document.createElement('span');
    top.className = 'queue-item-top';
    const kind = document.createElement('span');
    kind.className = 'queue-kind';
    kind.textContent = (item.tagName || 'EL').toUpperCase();
    const title = document.createElement('strong');
    title.textContent = item.selector || item.url;
    const meta = document.createElement('small');
    meta.textContent = item.note || item.url;
    top.append(kind);
    button.append(top, title, meta);
    button.addEventListener('click', () => {
      state.design = item;
      renderDesign();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button quiet tray-remove';
    remove.textContent = '빼기';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeTrayItem(item.id).catch((error) => announce(error.message));
    });
    row.append(button, remove);
    elements['design-captures'].append(row);
  }
}

function safeScreenshot(value) {
  return typeof value === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=\s]+$/.test(value)
    ? value
    : null;
}

function renderDesign() {
  const capture = state.design;
  const has = Boolean(capture);
  elements['design-empty-copy'].hidden = has;
  elements['design-meta'].hidden = !has;
  elements['design-styles'].hidden = !has;
  elements['design-html'].hidden = !has;
  elements['design-item-form'].hidden = !has;
  const shot = safeScreenshot(capture?.screenshotDataUrl);
  elements['design-shot'].hidden = !shot;
  if (shot) elements['design-shot'].src = shot;
  else elements['design-shot'].removeAttribute('src');
  if (has) {
    elements['design-meta-url'].textContent = capture.url || '';
    elements['design-meta-selector'].textContent = capture.selector || '';
    elements['design-meta-tag'].textContent = capture.tagName || '';
    const styles = capture.computedStyle || {};
    elements['design-styles'].textContent = Object.entries(styles).map(([key, value]) => `${key}: ${value}`).join('\n');
    elements['design-html'].textContent = capture.outerHTML || '';
    if (elements['design-item-note'] !== document.activeElement) {
      elements['design-item-note'].value = capture.note || '';
    }
  }
  syncDesignSend();
  renderDesignCaptures();
}

async function loadTray() {
  const tray = await api('/api/design/tray');
  state.tray = tray.items || [];
  if (state.design?.id) {
    state.design = state.tray.find((item) => item.id === state.design.id) || state.tray[0] || null;
  } else if (!state.design) {
    state.design = state.tray[0] || null;
  }
  renderDesign();
}

async function applyCapture(raw) {
  const saved = await api('/api/design/captures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(raw),
  });
  const { tray, ...record } = saved;
  state.design = { ...record, screenshotDataUrl: safeScreenshot(raw.screenshotDataUrl) };
  state.tray = tray?.items || [state.design];
  state.captures = [state.design, ...state.captures.filter((item) => item.id !== record.id)];
  renderDesign();
  announce('요소를 트레이에 넣었습니다.');
}

async function removeTrayItem(id) {
  const tray = await api(`/api/design/tray/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.tray = tray.items || [];
  if (state.design?.id === id) state.design = state.tray[0] || null;
  renderDesign();
  announce('트레이에서 뺐습니다.');
}

function ingestFromHash() {
  const hash = location.hash || '';
  if (!hash.startsWith('#ingest=')) return null;
  try {
    const value = JSON.parse(decodeURIComponent(hash.slice(8)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin && event.origin !== 'null') return;
  const data = event.data;
  if (!data || data.type !== 'toris:design-capture' || !data.capture) return;
  applyCapture(data.capture).catch((error) => announce(error.message));
});

elements['design-url-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const target = elements['design-url'].value.trim();
  if (!target) return;
  elements['design-frame'].src = `/design/frame?url=${encodeURIComponent(target)}`;
});

elements['design-sample'].addEventListener('click', () => {
  elements['design-frame'].src = '/design/sample';
});

elements['design-item-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.design?.id) return;
  const note = elements['design-item-note'].value.trim();
  await api(`/api/design/captures/${encodeURIComponent(state.design.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  await loadTray();
  announce('요소 메모를 저장했습니다.');
});

elements['design-item-remove'].addEventListener('click', () => {
  if (!state.design?.id) return;
  removeTrayItem(state.design.id).catch((error) => announce(error.message));
});

elements['design-agent-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.tray.length || !state.agentReady) return;
  const text = elements['design-note'].value.trim() || 'Inspect and fix the selected UI elements.';
  elements['design-send'].disabled = true;
  try {
    const result = await streamAgentTurn({
      agent: state.agentId,
      message: text,
      history: [],
      tray: true,
    });
    announce(`${result.agent?.title || '에이전트'}가 트레이 ${state.tray.length}개를 받았습니다.`);
    elements['design-note'].value = '';
    await api('/api/design/tray/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    state.tray = [];
    state.design = null;
  } catch (error) {
    announce(error.message);
  }
  renderDesign();
});

window.addEventListener('popstate', () => {
  showSurface(readSurface(), { replace: true });
});

for (const link of [elements['nav-review'], elements['nav-agent'], elements['nav-design'], elements['nav-patches']]) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showSurface(link.dataset.surface);
  });
}

elements['agent-input'].addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  elements['agent-form'].requestSubmit();
});

elements['agent-stop'].addEventListener('click', () => state.abort?.abort());

elements['agent-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = elements['agent-input'].value.trim();
  if (!text || !state.agentReady || state.busy) return;
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
    persistTranscripts();
    announce(`${result.agent?.title || '에이전트'}가 답했습니다.`);
  } catch (error) {
    const aborted = error.name === 'AbortError';
    assistant.streaming = false;
    if (!assistant.content) assistant.content = aborted ? '중단했습니다.' : error.message;
    persistTranscripts();
    announce(aborted ? '응답을 중단했습니다.' : error.message);
  }
  state.abort = null;
  setAgentBusy(false);
  renderAgentWorkspace();
});

function patchById(id) {
  return state.patches.find((item) => item.id === id) || (state.patchDetail?.id === id ? state.patchDetail : null);
}

function originLabel(path) {
  const value = String(path || '');
  const parts = value.split('/').filter(Boolean);
  return parts.length ? parts.slice(-2).join('/') : value || '(no origin)';
}

function diffLineClass(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line is-file';
  if (line.startsWith('@@')) return 'diff-line is-hunk';
  if (line.startsWith('+')) return 'diff-line is-add';
  if (line.startsWith('-')) return 'diff-line is-del';
  return 'diff-line';
}

function hunkBlockAt(lines, index) {
  let start = index;
  while (start > 0 && !lines[start].startsWith('@@')) start -= 1;
  if (!lines[start] || !lines[start].startsWith('@@')) return '';
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('@@')) end += 1;
  return lines.slice(start, end).join('\n');
}

function renderPatchDiff(text) {
  const pre = elements['patch-diff'];
  pre.replaceChildren();
  const lines = String(text || '(empty diff)').split('\n');
  lines.forEach((line, index) => {
    const span = document.createElement('span');
    span.className = diffLineClass(line);
    span.textContent = line || ' ';
    if (state.selectedHunk && hunkBlockAt(lines, index) === state.selectedHunk) span.classList.add('is-chosen');
    span.addEventListener('click', () => {
      state.selectedHunk = hunkBlockAt(lines, index);
      renderPatchDiff(text);
      renderPatchWorkspace();
    });
    pre.append(span);
  });
}

function renderPatchQueue() {
  const items = state.patchFilter === 'all' ? state.patches : state.patches.filter((item) => item.status === state.patchFilter);
  elements['patch-count'].textContent = String(items.length);
  elements['patch-queue'].replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = state.patchFilter === 'pending' ? '대기 중인 패치가 없습니다.' : '이 필터에는 패치가 없습니다.';
    elements['patch-queue'].append(empty);
    return;
  }
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `queue-item${item.id === state.selectedPatchId ? ' is-selected' : ''}`;
    const top = document.createElement('span');
    top.className = 'queue-item-top';
    const kind = document.createElement('span');
    kind.className = 'queue-kind';
    kind.textContent = (item.autonomy || 'PATCH').toUpperCase();
    const status = document.createElement('span');
    status.className = 'badge';
    status.textContent = item.status;
    const title = document.createElement('strong');
    title.textContent = item.id;
    const meta = document.createElement('small');
    meta.textContent = `${item.fileCount || item.files?.length || 0} files · ${originLabel(item.originPath)}`;
    top.append(kind, status);
    button.append(top, title, meta);
    button.addEventListener('click', () => selectPatch(item.id).catch((error) => announce(error.message)));
    elements['patch-queue'].append(button);
  }
}

function renderPatchWorkspace() {
  const item = state.patchDetail && state.patchDetail.id === state.selectedPatchId ? state.patchDetail : patchById(state.selectedPatchId);
  const pending = item?.status === 'pending';
  elements['patch-empty'].hidden = Boolean(item);
  elements['patch-detail'].hidden = !item;
  elements['patch-empty-copy'].hidden = Boolean(item);
  elements['patch-meta'].hidden = !item;
  elements['patch-apply'].disabled = !pending;
  elements['patch-discard'].disabled = !pending;
  elements['patch-review-send'].disabled = !item || !state.agentReady;
  if (!item) {
    elements['patch-review-status'].textContent = 'hunk를 고르면 메모와 함께 구현 에이전트에게 돌아갑니다.';
    return;
  }
  elements['patch-kind'].textContent = (item.source || 'PATCH').toUpperCase();
  elements['patch-heading'].textContent = item.id;
  elements['patch-status'].textContent = item.status;
  elements['patch-status'].className = `badge${item.status === 'applied' ? ' pass' : item.status === 'failed' || item.status === 'discarded' ? ' fail' : ''}`;
  elements['patch-truncated'].hidden = !item.truncated;
  elements['patch-meta-origin'].textContent = item.originPath || '';
  elements['patch-meta-files'].textContent = (item.files || []).join(', ') || `${item.fileCount || 0} files`;
  elements['patch-meta-stats'].textContent = item.stats || '—';
  elements['patch-meta-autonomy'].textContent = [item.autonomy, item.originTouched ? 'origin also changed' : null].filter(Boolean).join(' · ') || '—';
  if (item.diff != null) renderPatchDiff(item.diff);
  elements['patch-review-status'].textContent = state.selectedHunk
    ? '선택한 hunk가 메모와 함께 전달됩니다.'
    : (state.agentReady ? '리뷰 메모는 같은 로컬 에이전트 턴으로 갑니다.' : (state.agentReason || '연결 대기'));
}

async function selectPatch(id) {
  state.selectedPatchId = id;
  state.selectedHunk = '';
  renderPatchQueue();
  if (!id) {
    state.patchDetail = null;
    renderPatchWorkspace();
    return;
  }
  state.patchDetail = await api(`/api/patches/${encodeURIComponent(id)}`);
  renderPatchQueue();
  renderPatchWorkspace();
}

async function refreshPatches(preferredId) {
  const query = state.patchFilter === 'all' ? '' : `?status=${encodeURIComponent(state.patchFilter)}`;
  const listed = await api(`/api/patches${query}`);
  state.patches = listed.items || [];
  const preferred = preferredId || state.selectedPatchId;
  state.selectedPatchId = (preferred && state.patches.some((item) => item.id === preferred)) ? preferred : (state.patches[0]?.id || null);
  if (state.selectedPatchId) state.patchDetail = await api(`/api/patches/${encodeURIComponent(state.selectedPatchId)}`);
  else state.patchDetail = null;
  renderPatchQueue();
  renderPatchWorkspace();
}

const patchFilters = [...document.querySelectorAll('[data-patch-status]')];
for (const button of patchFilters) button.addEventListener('click', () => {
  for (const candidate of patchFilters) {
    const active = candidate === button;
    candidate.classList.toggle('is-active', active);
    candidate.setAttribute('aria-pressed', String(active));
  }
  state.patchFilter = button.dataset.patchStatus;
  refreshPatches().catch((error) => announce(error.message));
});

elements['patch-apply'].addEventListener('click', async () => {
  if (!state.selectedPatchId) return;
  elements['patch-apply'].disabled = true;
  try {
    await api(`/api/patches/${encodeURIComponent(state.selectedPatchId)}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    announce('패치를 원본에 적용했습니다.');
    await refreshPatches(state.selectedPatchId);
  } catch (error) {
    announce(error.message);
    await refreshPatches(state.selectedPatchId);
  }
});

elements['patch-discard'].addEventListener('click', async () => {
  if (!state.selectedPatchId) return;
  elements['patch-discard'].disabled = true;
  try {
    await api(`/api/patches/${encodeURIComponent(state.selectedPatchId)}/discard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    announce('패치를 폐기했습니다.');
    await refreshPatches();
  } catch (error) {
    announce(error.message);
    await refreshPatches(state.selectedPatchId);
  }
});

elements['patch-review-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selectedPatchId || !state.agentReady) return;
  const note = elements['patch-note'].value.trim();
  if (!note && !state.selectedHunk) {
    announce('리뷰 메모나 hunk를 남겨 주세요.');
    return;
  }
  elements['patch-review-send'].disabled = true;
  try {
    const result = await api(`/api/patches/${encodeURIComponent(state.selectedPatchId)}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'implementer', note, hunk: state.selectedHunk }),
    });
    announce(`${result.agent?.title || '에이전트'}가 패치 리뷰를 받았습니다.`);
    elements['patch-note'].value = '';
    state.selectedHunk = '';
    renderPatchWorkspace();
  } catch (error) {
    announce(error.message);
  }
  renderPatchWorkspace();
});

try {
  const session = await api('/api/session'); state.token = session.token; await refresh(); document.getElementById('live-status').textContent = `${new URL(session.origin).host} · local`;
  state.threads = loadTranscripts();
  state.agentId = readAgentId();
  await loadAgents();
  const bookmarklet = await api('/api/design/bookmarklet');
  elements['design-bookmarklet'].href = bookmarklet.href;
  const listed = await api('/api/design/captures');
  state.captures = listed.items || [];
  await loadTray();
  const ingested = ingestFromHash();
  showSurface(readSurface(), { replace: true, agentId: state.agentId });
  if (ingested) await applyCapture(ingested);
  else renderDesign();
} catch (error) { document.getElementById('live-status').textContent = 'local service unavailable'; announce(error.message); }
