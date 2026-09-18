const state = {
  token: '',
  status: null,
  artifacts: [],
  serial: '',
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
  const ready = Boolean(status?.ready || status?.adb);
  const badge = $('adb-badge');
  badge.textContent = ready ? 'adb ready' : 'adb optional';
  badge.className = `badge${ready ? ' pass' : ''}`;
  $('adb-path').textContent = status?.adb || 'not on PATH';
  $('emulator-path').textContent = status?.emulator || 'not on PATH';
  $('adb-version').textContent = status?.version || '—';
  $('device-count').textContent = String(status?.devices?.length || 0);
  $('adb-hint').textContent = ready
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

function renderArtifacts() {
  const items = state.artifacts || [];
  $('artifact-empty').hidden = items.length > 0;
  $('artifact-list').hidden = items.length === 0;
  const list = $('artifact-list');
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement(item.image ? 'a' : 'div');
    row.className = 'android-hit';
    if (item.image && item.rel) {
      row.href = mediaHref(item.rel);
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
    list.append(row);
  }
}

async function refresh() {
  const [status, artifacts] = await Promise.all([
    api('/api/android'),
    api('/api/android/artifacts'),
  ]);
  state.status = status;
  state.artifacts = artifacts.items || [];
  renderStatus();
  renderDevices();
  renderArtifacts();
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

const session = await api('/api/session');
state.token = session.token;
await refresh();
window.setInterval(() => {
  refresh().catch(() => undefined);
}, 15000);
