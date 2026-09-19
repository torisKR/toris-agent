const state = {
  token: '',
  brief: null,
};

const $ = (id) => document.getElementById(id);

function announce(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
}

function showBudgetError(message) {
  const node = $('budget-error');
  node.hidden = !message;
  node.textContent = message || '';
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

function formatUsd(value) {
  if (value == null) return '';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return `$${amount.toFixed(4)}`;
}

function verifyLabel(value) {
  if (value === 'pass') return 'pass';
  if (value === 'fail') return 'fail';
  return 'n/a';
}

function renderSpend() {
  const spend = state.brief?.spend;
  $('brief-day').textContent = state.brief?.day || '—';
  if (!spend) {
    $('spend-today').textContent = '—';
    $('spend-budget').textContent = '';
    $('spend-remaining').textContent = '';
    $('spend-runs').textContent = '—';
    $('budget-usd').value = '';
    return;
  }
  $('spend-today').textContent = formatUsd(spend.spentUsd) || '—';
  $('spend-budget').textContent = formatUsd(spend.capUsd);
  $('spend-remaining').textContent = formatUsd(spend.remainingUsd);
  $('spend-runs').textContent = String(spend.runCount ?? 0);
  $('budget-usd').value = spend.capUsd == null ? '' : String(spend.capUsd);
}

function renderRuns() {
  const runs = state.brief?.runs || [];
  const has = runs.length > 0;
  $('runs-empty').hidden = has;
  $('runs-list').hidden = !has;
  const rows = $('run-rows');
  rows.replaceChildren();
  for (const run of runs) {
    const row = document.createElement('article');
    row.className = 'brief-row';
    row.setAttribute('role', 'listitem');

    const top = document.createElement('div');
    top.className = 'brief-row-top';
    const id = document.createElement('strong');
    id.textContent = run.id;
    const badge = document.createElement('span');
    const verify = verifyLabel(run.verify);
    badge.className = `badge${verify === 'pass' ? ' pass' : verify === 'fail' ? ' fail' : ''}`;
    badge.textContent = `${run.status || 'unknown'} · ${verify}`;
    top.append(id, badge);

    const goal = document.createElement('p');
    goal.className = 'brief-goal';
    goal.textContent = run.goal || '';

    row.append(top, goal);
    if (run.at) {
      const meta = document.createElement('small');
      meta.textContent = run.at;
      row.append(meta);
    }
    rows.append(row);
  }
}

function renderDaemon() {
  const daemon = state.brief?.daemon;
  const running = Boolean(daemon?.running);
  const badge = $('daemon-badge');
  badge.textContent = running ? 'running' : 'stopped';
  badge.className = `badge${running ? ' pass' : ''}`;
  $('daemon-pid').textContent = running && daemon.pid != null ? String(daemon.pid) : '—';

  const nextRow = $('daemon-next-row');
  if (daemon?.nextDueAt) {
    nextRow.hidden = false;
    $('daemon-next').textContent = `${daemon.nextDueAt}${daemon.nextId ? `  ${daemon.nextId}` : ''}`;
  } else {
    nextRow.hidden = true;
    $('daemon-next').textContent = '—';
  }

  const scheduleRow = $('daemon-schedules-row');
  if (daemon?.scheduleCount > 0) {
    scheduleRow.hidden = false;
    $('daemon-schedules').textContent = `${daemon.schedulesEnabled} enabled / ${daemon.scheduleCount}`;
  } else {
    scheduleRow.hidden = true;
    $('daemon-schedules').textContent = '—';
  }

  $('daemon-hint').textContent = running
    ? 'Local-only. This page does not start, stop, or enqueue work.'
    : 'Start with `toris daemon start` (loopback files only). This page does not start it.';
}

function renderKnowledge() {
  const knowledge = state.brief?.knowledge;
  const headlines = knowledge?.available ? knowledge.headlines || [] : [];
  const section = $('knowledge-section');
  const show = headlines.length > 0;
  section.hidden = !show;
  const list = $('knowledge-hits');
  list.replaceChildren();
  if (!show) return;
  for (const item of headlines) {
    const row = document.createElement('div');
    row.className = 'brief-hit';
    const title = document.createElement('strong');
    title.textContent = item.title || item.id;
    const meta = document.createElement('small');
    meta.textContent = item.domain ? `${item.kind} · ${item.domain}/${item.id}` : `${item.kind} · ${item.id}`;
    row.append(title, meta);
    list.append(row);
  }
}

function render() {
  renderSpend();
  renderRuns();
  renderDaemon();
  renderKnowledge();
}

async function refresh() {
  state.brief = await api('/api/brief');
  render();
}

async function saveBudget(value) {
  showBudgetError('');
  const submit = $('budget-save');
  const clear = $('budget-clear');
  submit.disabled = true;
  clear.disabled = true;
  try {
    state.brief = await api('/api/brief/budget', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxDailyCostUsd: value }),
    });
    render();
    announce(value == null || value === '' ? 'Daily budget cleared.' : 'Daily budget saved.');
  } catch (error) {
    showBudgetError(error.message);
    announce(error.message);
    throw error;
  } finally {
    submit.disabled = false;
    clear.disabled = false;
  }
}

$('refresh-brief').addEventListener('click', async () => {
  try {
    await refresh();
    announce('Refreshed.');
  } catch (error) {
    announce(error.message);
  }
});

$('budget-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = $('budget-usd').value.trim();
  if (!raw) {
    showBudgetError('Enter a daily budget, or Clear.');
    return;
  }
  try {
    await saveBudget(Number(raw));
  } catch {
    // announced in saveBudget
  }
});

$('budget-clear').addEventListener('click', async () => {
  try {
    await saveBudget(null);
  } catch {
    // announced in saveBudget
  }
});

const session = await api('/api/session');
state.token = session.token;
await refresh();
window.setInterval(() => {
  refresh().catch(() => undefined);
}, 15000);
