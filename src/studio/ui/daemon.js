const state = {
  token: '',
  snapshot: null,
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

function formatUptime(ms) {
  const seconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function truncate(value, max = 96) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function renderStatus() {
  const status = state.snapshot?.status;
  const running = Boolean(status?.running);
  const badge = $('worker-badge');
  badge.textContent = running ? 'running' : 'stopped';
  badge.className = `badge${running ? ' pass' : ''}`;
  $('worker-pid').textContent = running && status.pid != null ? String(status.pid) : '—';
  $('worker-uptime').textContent = running ? formatUptime(status.uptimeMs) : '—';
  $('worker-heartbeat').textContent = running && status.heartbeatAt ? status.heartbeatAt : '—';
  const next = status?.schedules?.nextDueAt;
  $('worker-next').textContent = next
    ? `${next}${status.schedules.nextId ? `  ${status.schedules.nextId}` : ''}`
    : 'none';
  const jobs = status?.jobs || {};
  $('worker-jobs').textContent = `${jobs.queued || 0} queued  ${jobs.running || 0} running  ${jobs.succeeded || 0} done`;
  $('worker-hint').textContent = running
    ? 'Local-only. Queue a one-shot below, or add a schedule. Studio will not start or stop the worker.'
    : 'Start with `toris daemon start` (loopback files only). Studio will not start it.';
}

function renderSchedules() {
  const schedules = state.snapshot?.schedules || [];
  $('schedule-count').textContent = String(schedules.length);
  $('schedule-empty').hidden = schedules.length > 0;
  $('schedule-list').hidden = schedules.length === 0;
  const rows = $('schedule-rows');
  rows.replaceChildren();
  for (const item of schedules) {
    const row = document.createElement('article');
    row.className = 'daemon-row';
    row.setAttribute('role', 'listitem');

    const top = document.createElement('div');
    top.className = 'daemon-row-top';
    const id = document.createElement('strong');
    id.textContent = item.id;
    const badge = document.createElement('span');
    badge.className = `badge${item.enabled ? ' pass' : ''}`;
    badge.textContent = item.enabled ? 'enabled' : 'disabled';
    top.append(id, badge);

    const goal = document.createElement('p');
    goal.className = 'daemon-goal';
    goal.textContent = truncate(item.goal);

    const meta = document.createElement('small');
    meta.textContent = `${item.expr} · next ${item.nextDueAt || '—'}${item.dryRun ? ' · dry-run' : ''}`;

    const actions = document.createElement('div');
    actions.className = 'row';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'button secondary';
    toggle.textContent = item.enabled ? 'Disable' : 'Enable';
    toggle.addEventListener('click', () => mutateSchedule(item.id, item.enabled ? 'disable' : 'enable'));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      if (window.confirm(`Remove ${item.id}?`)) mutateSchedule(item.id, 'remove');
    });
    actions.append(toggle, remove);

    row.append(top, goal, meta, actions);
    rows.append(row);
  }
}

function renderJobs() {
  const jobs = state.snapshot?.recentJobs || [];
  const list = $('job-list');
  list.replaceChildren();
  if (jobs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = 'No worker jobs yet.';
    list.append(empty);
    return;
  }
  for (const job of jobs) {
    const row = document.createElement('div');
    row.className = 'daemon-hit';
    const title = document.createElement('strong');
    title.textContent = truncate(job.goal || job.id, 72);
    const meta = document.createElement('small');
    meta.append(`${job.status}${job.dryRun ? ' · dry-run' : ''} · ${job.id}`);
    if (job.runId) {
      meta.append(' · ');
      const link = document.createElement('a');
      link.className = 'run-link';
      link.href = `#${encodeURIComponent(job.runId)}`;
      link.textContent = job.runId;
      meta.append(link);
    }
    if (job.scheduleId) meta.append(` · ${job.scheduleId}`);
    row.append(title, meta);
    list.append(row);
  }
}

async function refresh() {
  state.snapshot = await api('/api/daemon');
  renderStatus();
  renderSchedules();
  renderJobs();
}

async function mutateSchedule(id, action) {
  try {
    await api(`/api/daemon/schedules/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    announce(action === 'remove' ? `Removed ${id}.` : `${action === 'enable' ? 'Enabled' : 'Disabled'} ${id}.`);
    await refresh();
  } catch (error) {
    announce(error.message);
  }
}

function showQueueError(message) {
  const node = $('queue-run-error');
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = message;
}

$('refresh-status').addEventListener('click', async () => {
  try {
    await refresh();
    announce('Refreshed.');
  } catch (error) {
    announce(error.message);
  }
});

$('queue-run-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showQueueError('');
  const submit = $('queue-run-submit');
  submit.disabled = true;
  try {
    const autonomy = $('run-autonomy').value.trim();
    const budgetRaw = $('run-budget').value.trim();
    const body = {
      goal: $('run-goal').value,
      dryRun: $('run-dry-run').checked,
    };
    if (autonomy) body.autonomy = autonomy;
    if (budgetRaw) body.budgetUsd = Number(budgetRaw);
    const created = await api('/api/daemon/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('queue-run-form').reset();
    announce(`Queued ${created.job.id}.`);
    await refresh();
  } catch (error) {
    showQueueError(error.message);
    announce(error.message);
  } finally {
    submit.disabled = false;
  }
});

$('add-schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const created = await api('/api/daemon/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expr: $('new-expr').value,
        goal: $('new-goal').value,
        dryRun: $('new-dry-run').checked,
      }),
    });
    $('add-schedule-form').reset();
    announce(`Added ${created.schedule.id}.`);
    await refresh();
  } catch (error) {
    announce(error.message);
  }
});

const session = await api('/api/session');
state.token = session.token;
await refresh();
window.setInterval(() => {
  refresh().catch(() => undefined);
}, 5000);
