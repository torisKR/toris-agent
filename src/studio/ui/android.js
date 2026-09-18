const state = {
  token: '',
  status: null,
  artifacts: [],
  selected: new Set(),
  serial: '',
  agentReady: false,
};

const $ = (id) => document.getElementById(id);

function announce(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
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
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mediaHref(rel) {
  return `/api/android/media?path=${encodeURIComponent(rel)}`;
}

function renderStatus() {
  const status = state.status;
  const present = Boolean(status?.adb);
  const ready = Boolean(status?.ok && present);
  const badge = $('adb-badge');
  badge.textContent = ready ? 'adb ready' : present ? 'adb error' : 'adb optional';
  badge.className = `badge${ready ? ' pass' : ''}`;
  $('adb-path').textContent = status?.adb || 'not on PATH';
  $('emulator-path').textContent = status?.emulator || 'not on PATH';
  $('adb-version').textContent = status?.version || '—';
  $('device-count').textContent = String(status?.devices?.length || 0);
  $('adb-hint').textContent = status?.error
    ? status.error
    : ready
      ? 'Local-only. Screenshot and logcat write under ~/.toris/android/. Install stays on the CLI.'
      : 'adb is optional. Install Android platform-tools, or skip — the rest of Studio does not need it.';
}

function renderDevices() {
  const devices = state.status?.devices || [];
  const has = devices.length > 0;
  $('device-empty').hidden = has;
  $('device-list').hidden = !has;
  if (!has) {
    state.serial = '';
    $('device-rows').replaceChildren();
    return;
  }
  if (!devices.some((device) => device.serial === state.serial)) {
    state.serial = devices[0].serial;
  }
  const rows = $('device-rows');
  rows.replaceChildren();
  for (const device of devices) {
    const row = document.createElement('tr');
    row.className = device.serial === state.serial ? 'is-selected' : '';
    row.dataset.serial = device.serial;
    const serial = document.createElement('th');
    serial.scope = 'row';
    serial.textContent = device.serial;
    const deviceState = document.createElement('td');
    deviceState.textContent = device.state || '—';
    const model = document.createElement('td');
    model.textContent = device.model || device.product || '—';
    row.append(serial, deviceState, model);
    row.addEventListener('click', () => {
      state.serial = device.serial;
      renderDevices();
    });
    rows.append(row);
  }
}

function selectedRels() {
  return [...state.selected].filter((rel) => state.artifacts.some((item) => item.rel === rel));
}

function syncSend() {
  const selected = selectedRels();
  const note = $('android-note').value.trim();
  const ready = selected.length > 0 && Boolean(note) && state.agentReady;
  $('android-send').disabled = !ready;
  $('android-send').setAttribute('aria-disabled', String(!ready));
  if (!state.agentReady) {
    $('android-agent-status').textContent = 'Coding agent is not ready. Run `toris connect` in a terminal.';
    return;
  }
  if (selected.length === 0) {
    $('android-agent-status').textContent = 'Select at least one local artifact.';
    return;
  }
  if (!note) {
    $('android-agent-status').textContent = 'Write one instruction to send with the selected evidence.';
    return;
  }
  $('android-agent-status').textContent = `${selected.length} artifact${selected.length === 1 ? '' : 's'} will attach to one agent turn.`;
}

function renderArtifacts() {
  const items = state.artifacts || [];
  const known = new Set(items.map((item) => item.rel).filter(Boolean));
  state.selected = new Set([...state.selected].filter((rel) => known.has(rel)));
  $('artifact-empty').hidden = items.length > 0;
  $('artifact-list').hidden = items.length === 0;
  const list = $('artifact-list');
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    const picked = Boolean(item.rel && state.selected.has(item.rel));
    row.className = `android-hit${picked ? ' is-selected' : ''}`;
    row.setAttribute('aria-pressed', String(picked));
    if (item.image && item.rel) {
      const img = document.createElement('img');
      img.className = 'android-thumb';
      img.alt = item.name;
      img.src = mediaHref(item.rel);
      row.append(img);
    }
    const title = document.createElement('strong');
    title.textContent = item.name;
    const meta = document.createElement('small');
    meta.textContent = `${item.rel || item.name} · ${formatBytes(item.bytes)} · ${item.mtime || ''}`;
    row.append(title, meta);
    row.addEventListener('click', () => {
      if (!item.rel) return;
      if (state.selected.has(item.rel)) state.selected.delete(item.rel);
      else state.selected.add(item.rel);
      renderArtifacts();
    });
    list.append(row);
  }
  syncSend();
}

async function refresh() {
  const [statusResult, artifactsResult, agentResult] = await Promise.allSettled([
    api('/api/android'),
    api('/api/android/artifacts'),
    api('/api/agent/status'),
  ]);
  const errors = [];
  if (statusResult.status === 'fulfilled') state.status = statusResult.value;
  else errors.push(statusResult.reason?.message || 'status failed');
  if (artifactsResult.status === 'fulfilled') state.artifacts = artifactsResult.value.items || [];
  else errors.push(artifactsResult.reason?.message || 'artifacts failed');
  if (agentResult.status === 'fulfilled') state.agentReady = Boolean(agentResult.value.ready);
  else errors.push(agentResult.reason?.message || 'agent status failed');
  renderStatus();
  renderDevices();
  renderArtifacts();
  if (errors.length) throw new Error(errors.join(' · '));
}

async function capture(path) {
  const body = {};
  if (state.serial) body.serial = state.serial;
  const result = await api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await refresh();
  return result;
}

$('refresh-android').addEventListener('click', async () => {
  try {
    await refresh();
    announce('Refreshed.');
  } catch (error) {
    announce(error.message);
  }
});

$('capture-screenshot').addEventListener('click', async () => {
  const button = $('capture-screenshot');
  button.disabled = true;
  try {
    const shot = await capture('/api/android/screenshot');
    announce(`Saved ${shot.path.split('/').pop() || 'screenshot'}.`);
  } catch (error) {
    announce(error.message);
  } finally {
    button.disabled = false;
  }
});

$('capture-logcat').addEventListener('click', async () => {
  const button = $('capture-logcat');
  button.disabled = true;
  try {
    const log = await capture('/api/android/logcat');
    announce(`Saved ${log.path.split('/').pop() || 'logcat'}.`);
  } catch (error) {
    announce(error.message);
  } finally {
    button.disabled = false;
  }
});

$('android-note').addEventListener('input', syncSend);

$('android-agent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const artifacts = selectedRels();
  const message = $('android-note').value.trim();
  if (!artifacts.length || !message || !state.agentReady) return;
  const button = $('android-send');
  button.disabled = true;
  try {
    const result = await api('/api/agent/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'implementer',
        message,
        android: { artifacts },
      }),
    });
    announce(`${result.agent?.title || 'Agent'} received ${artifacts.length} Android artifact${artifacts.length === 1 ? '' : 's'}.`);
    $('android-note').value = '';
    state.selected.clear();
    renderArtifacts();
  } catch (error) {
    announce(error.message);
    syncSend();
  }
});

const session = await api('/api/session');
state.token = session.token;
refresh().catch((error) => announce(error.message));
window.setInterval(() => {
  refresh().catch(() => undefined);
}, 15000);
