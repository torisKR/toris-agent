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
  messages: [],
  design: null,
  captures: [],
};
const elements = Object.fromEntries(['review-queue','queue-count','workspace-empty','workspace-detail','detail-kind','detail-title','detail-status','media-preview','timeline-meta','evidence-list','post-form','video-import','video-file','render-form','render-text','render-duration','render-button','quality-list','toast','open-publish','publish-dialog','publish-check','publish-confirmation','publish-submit','review-shell','agent-shell','nav-review','nav-agent','nav-design','agent-list','agent-count','agent-empty','agent-empty-copy','agent-chat','agent-log','agent-form','agent-input','agent-send','agent-tui-hint','agent-role-copy','agent-status-copy','agent-workspace','design-shell','design-count','design-captures','design-url-form','design-url','design-sample','design-frame','design-empty-copy','design-meta','design-meta-url','design-meta-selector','design-meta-tag','design-styles','design-html','design-shot','design-agent-form','design-note','design-send','design-agent-status','design-bookmarklet','design-workspace'].map((id) => [id, document.getElementById(id)]));

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
  if (location.hash === '#agent' || location.hash.startsWith('#agent/')) return 'agent';
  if (location.hash === '#design' || location.hash.startsWith('#design') || location.hash.startsWith('#ingest=')) return 'design';
  return 'review';
}

function readAgentId() {
  const params = new URLSearchParams(location.search);
  if (params.get('id')) return params.get('id');
  const hash = location.hash.match(/^#agent\/([^/]+)/);
  if (hash) return hash[1];
  return state.agentId || 'toris';
}

function showSurface(name, options = {}) {
  state.surface = name === 'agent' || name === 'design' ? name : 'review';
  if (state.surface === 'agent') state.agentId = options.agentId || readAgentId();
  elements['review-shell'].hidden = state.surface !== 'review';
  elements['agent-shell'].hidden = state.surface !== 'agent';
  elements['design-shell'].hidden = state.surface !== 'design';
  elements['nav-review'].setAttribute('aria-current', state.surface === 'review' ? 'page' : 'false');
  elements['nav-agent'].setAttribute('aria-current', state.surface === 'agent' ? 'page' : 'false');
  elements['nav-design'].setAttribute('aria-current', state.surface === 'design' ? 'page' : 'false');
  let url = '/';
  if (state.surface === 'agent') {
    url = state.agentId && state.agentId !== 'toris' ? `/agent?id=${encodeURIComponent(state.agentId)}` : '/agent';
  } else if (state.surface === 'design') {
    url = '/design';
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
    button.addEventListener('click', () => {
      state.agentId = agent.id;
      state.messages = [];
      showSurface('agent', { agentId: agent.id });
    });
    elements['agent-list'].append(button);
  }
}

function renderAgentWorkspace() {
  const agent = currentAgent();
  const hasTurns = state.messages.length > 0;
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
  elements['agent-send'].disabled = !state.agentReady;
  elements['agent-send'].setAttribute('aria-disabled', String(!state.agentReady));
  elements['agent-input'].disabled = !state.agentReady;
  elements['design-send'].disabled = !state.agentReady || !state.design;
  elements['design-send'].setAttribute('aria-disabled', String(!state.agentReady || !state.design));
  elements['design-agent-status'].textContent = state.agentReady
    ? '선택한 요소가 있으면 같은 로컬 에이전트에게 보냅니다.'
    : (state.agentReason || '연결 대기');
  renderAgentLog();
}

function renderAgentLog() {
  elements['agent-log'].replaceChildren();
  for (const turn of state.messages) {
    const article = document.createElement('article');
    article.className = `chat-turn${turn.role === 'user' ? ' is-user' : ''}`;
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
  renderAgents();
  renderAgentWorkspace();
}

function renderDesignCaptures() {
  const items = state.captures;
  elements['design-count'].textContent = String(items.length);
  elements['design-captures'].replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = '아직 캡처가 없습니다. 가운데에서 페이지를 열고 요소를 클릭하세요.';
    elements['design-captures'].append(empty);
    return;
  }
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `queue-item${item.id && item.id === state.design?.id ? ' is-selected' : ''}`;
    const top = document.createElement('span');
    top.className = 'queue-item-top';
    const kind = document.createElement('span');
    kind.className = 'queue-kind';
    kind.textContent = (item.tagName || 'EL').toUpperCase();
    const title = document.createElement('strong');
    title.textContent = item.selector || item.url;
    const meta = document.createElement('small');
    meta.textContent = item.url;
    top.append(kind);
    button.append(top, title, meta);
    button.addEventListener('click', () => {
      state.design = item;
      renderDesign();
    });
    elements['design-captures'].append(button);
  }
}

function renderDesign() {
  const capture = state.design;
  const has = Boolean(capture);
  elements['design-empty-copy'].hidden = has;
  elements['design-meta'].hidden = !has;
  elements['design-styles'].hidden = !has;
  elements['design-html'].hidden = !has;
  const shot = capture?.screenshotDataUrl;
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
  }
  elements['design-send'].disabled = !state.agentReady || !has;
  elements['design-send'].setAttribute('aria-disabled', String(!state.agentReady || !has));
  renderDesignCaptures();
}

async function applyCapture(raw) {
  const saved = await api('/api/design/captures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(raw),
  });
  state.design = { ...saved, screenshotDataUrl: raw.screenshotDataUrl || null };
  state.captures = [state.design, ...state.captures.filter((item) => item.id !== saved.id)];
  renderDesign();
  announce('요소를 캡처했습니다.');
}

function ingestFromHash() {
  const hash = location.hash || '';
  if (!hash.startsWith('#ingest=')) return null;
  try {
    return JSON.parse(decodeURIComponent(hash.slice(8)));
  } catch {
    return null;
  }
}

window.addEventListener('message', (event) => {
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

elements['design-agent-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.design || !state.agentReady) return;
  const text = elements['design-note'].value.trim() || 'Inspect and fix the selected UI element.';
  elements['design-send'].disabled = true;
  try {
    const payload = {
      agent: state.agentId,
      message: text,
      history: [],
    };
    if (state.design.id) payload.designId = state.design.id;
    else payload.design = state.design;
    const result = await api('/api/agent/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    announce(`${result.agent?.title || '에이전트'}가 디자인 컨텍스트를 받았습니다.`);
    elements['design-note'].value = '';
  } catch (error) {
    announce(error.message);
  }
  renderDesign();
});

window.addEventListener('popstate', () => {
  showSurface(readSurface(), { replace: true });
});

for (const link of [elements['nav-review'], elements['nav-agent'], elements['nav-design']]) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showSurface(link.dataset.surface);
  });
}

elements['agent-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = elements['agent-input'].value.trim();
  if (!text || !state.agentReady) return;
  elements['agent-input'].value = '';
  state.messages.push({ role: 'user', content: text });
  renderAgentWorkspace();
  elements['agent-send'].disabled = true;
  try {
    const result = await api('/api/agent/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: state.agentId,
        message: text,
        history: state.messages.slice(0, -1).map((item) => ({ role: item.role, content: item.content })),
      }),
    });
    const tools = (result.events || []).filter((evt) => evt.type === 'tool-start').map((evt) => evt.name);
    state.messages.push({ role: 'assistant', agent: result.agent?.id, content: result.text, tools });
    announce(`${result.agent?.title || '에이전트'}가 답했습니다.`);
  } catch (error) {
    state.messages.push({ role: 'assistant', agent: state.agentId, content: error.message });
    announce(error.message);
  }
  renderAgentWorkspace();
});

try {
  const session = await api('/api/session'); state.token = session.token; await refresh(); document.getElementById('live-status').textContent = `${new URL(session.origin).host} · local`;
  state.agentId = readAgentId();
  await loadAgents();
  const bookmarklet = await api('/api/design/bookmarklet');
  elements['design-bookmarklet'].href = bookmarklet.href;
  const listed = await api('/api/design/captures');
  state.captures = listed.items || [];
  const ingested = ingestFromHash();
  showSurface(readSurface(), { replace: true, agentId: state.agentId });
  if (ingested) await applyCapture(ingested);
  else renderDesign();
} catch (error) { document.getElementById('live-status').textContent = 'local service unavailable'; announce(error.message); }
