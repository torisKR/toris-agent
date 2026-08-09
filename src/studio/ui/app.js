const state = { token: '', contents: [], selectedId: null, filter: 'all' };
const elements = Object.fromEntries(['review-queue','queue-count','workspace-empty','workspace-detail','detail-kind','detail-title','detail-status','media-preview','timeline-meta','evidence-list','post-form','video-import','video-file','quality-list','toast','open-publish','publish-dialog','publish-check','publish-confirmation','publish-submit'].map((id) => [id, document.getElementById(id)]));

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
  if (!item) return;
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

for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { document.querySelector('.filter.is-active')?.classList.remove('is-active'); button.classList.add('is-active'); state.filter = button.dataset.filter; renderQueue(); });

elements['open-publish'].addEventListener('click', () => { const item = itemById(state.selectedId); if (!item) return; elements['publish-confirmation'].placeholder = `PUBLISH ${item.id}`; elements['publish-dialog'].showModal(); });
function updatePublishGate() { const item = itemById(state.selectedId); elements['publish-submit'].disabled = !item || !elements['publish-check'].checked || elements['publish-confirmation'].value !== `PUBLISH ${item.id}`; }
elements['publish-check'].addEventListener('change', updatePublishGate); elements['publish-confirmation'].addEventListener('input', updatePublishGate);
elements['publish-submit'].addEventListener('click', () => announce('공개 게시 어댑터는 아직 호출하지 않았습니다.'));

try {
  const session = await api('/api/session'); state.token = session.token; await refresh(); document.getElementById('live-status').textContent = `${new URL(session.origin).host} · local`;
} catch (error) { document.getElementById('live-status').textContent = 'local service unavailable'; announce(error.message); }
