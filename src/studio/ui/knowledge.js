const state = {
  token: '',
  domains: [],
  selected: null,
  detail: null,
  nodeId: null,
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

function renderDomains() {
  $('domain-count').textContent = String(state.domains.length);
  const list = $('domain-list');
  list.replaceChildren();
  if (state.domains.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = 'No domains yet. Seed the store from the inspector.';
    list.append(empty);
    return;
  }
  for (const domain of state.domains) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `queue-item${domain.slug === state.selected ? ' is-selected' : ''}`;
    const top = document.createElement('span');
    top.className = 'queue-item-top';
    const kind = document.createElement('span');
    kind.className = 'queue-kind';
    kind.textContent = domain.source || 'home';
    const count = document.createElement('span');
    count.className = 'badge';
    count.textContent = `${domain.nodeCount} nodes`;
    const title = document.createElement('strong');
    title.textContent = domain.title || domain.slug;
    const meta = document.createElement('small');
    meta.textContent = `${domain.slug} · ${domain.edgeCount} edges`;
    top.append(kind, count);
    button.append(top, title, meta);
    button.addEventListener('click', () => selectDomain(domain.slug));
    list.append(button);
  }
}

function selectedNode() {
  return state.detail?.nodes?.find((node) => node.id === state.nodeId) || null;
}

function renderDetail() {
  const detail = state.detail;
  $('knowledge-empty').hidden = Boolean(detail);
  $('knowledge-detail').hidden = !detail;
  if (!detail) return;
  $('detail-slug').textContent = detail.slug;
  $('detail-title').textContent = detail.title;
  $('detail-source').textContent = detail.source;
  $('detail-when').textContent = detail.when || detail.anti || '';
  const node = selectedNode();
  $('node-body').textContent = node ? node.body : detail.body || '';

  const nodes = $('node-list');
  nodes.replaceChildren();
  for (const item of detail.nodes || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `knowledge-hit${item.id === state.nodeId ? ' is-selected' : ''}`;
    const title = document.createElement('strong');
    title.textContent = item.title;
    const meta = document.createElement('small');
    meta.textContent = `${item.id} · ${(item.tags || []).join(', ')}`;
    button.append(title, meta);
    button.addEventListener('click', () => {
      state.nodeId = item.id;
      renderDetail();
    });
    nodes.append(button);
  }

  const edges = $('edge-list');
  edges.replaceChildren();
  for (const edge of detail.edges || []) {
    const row = document.createElement('div');
    row.className = 'knowledge-hit';
    const title = document.createElement('strong');
    title.textContent = edge.from;
    const meta = document.createElement('small');
    meta.textContent = `${edge.kind} → ${edge.to}`;
    row.append(title, meta);
    edges.append(row);
  }
  if (!detail.edges?.length) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = 'No DAG edges yet.';
    edges.append(empty);
  }
}

async function selectDomain(slug) {
  state.selected = slug;
  state.detail = await api(`/api/knowledge/domains/${encodeURIComponent(slug)}`);
  state.nodeId = state.detail.nodes?.[0]?.id || null;
  renderDomains();
  renderDetail();
}

async function refresh() {
  const overview = await api('/api/knowledge');
  state.domains = overview.domains || [];
  if (!overview.ok) {
    state.detail = null;
    renderDomains();
    renderDetail();
    return;
  }
  renderDomains();
  if (state.selected && state.domains.some((domain) => domain.slug === state.selected)) {
    await selectDomain(state.selected);
  } else if (state.domains[0]) {
    await selectDomain(state.domains[0].slug);
  } else {
    state.detail = null;
    renderDetail();
  }
}

$('seed-store').addEventListener('click', async () => {
  try {
    await api('/api/knowledge/init', { method: 'POST' });
    announce('Seeded local knowledge store.');
    await refresh();
  } catch (error) {
    announce(error.message);
  }
});

$('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('search-q').value.trim();
  const box = $('search-hits');
  box.replaceChildren();
  if (!query) return;
  try {
    const result = await api(`/api/knowledge/search?q=${encodeURIComponent(query)}`);
    for (const hit of result.hits || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'knowledge-hit';
      const title = document.createElement('strong');
      title.textContent = hit.title;
      const meta = document.createElement('small');
      meta.textContent = `${hit.kind} · ${hit.domain ? `${hit.domain}/` : ''}${hit.id}`;
      button.append(title, meta);
      button.addEventListener('click', () => {
        if (hit.domain) selectDomain(hit.domain);
      });
      box.append(button);
    }
    if (!result.hits?.length) {
      const empty = document.createElement('div');
      empty.className = 'queue-empty';
      empty.textContent = 'No hits.';
      box.append(empty);
    }
  } catch (error) {
    announce(error.message);
  }
});

$('add-node-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selected) {
    announce('Pick a domain first.');
    return;
  }
  try {
    await api(`/api/knowledge/domains/${encodeURIComponent(state.selected)}/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: $('new-title').value, body: $('new-body').value }),
    });
    $('add-node-form').reset();
    announce('Node saved.');
    await selectDomain(state.selected);
  } catch (error) {
    announce(error.message);
  }
});

$('add-edge-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selected) {
    announce('Pick a domain first.');
    return;
  }
  try {
    await api(`/api/knowledge/domains/${encodeURIComponent(state.selected)}/edges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: $('edge-from').value,
        to: $('edge-to').value,
        kind: $('edge-kind').value,
      }),
    });
    $('add-edge-form').reset();
    announce('Edge saved.');
    await selectDomain(state.selected);
  } catch (error) {
    announce(error.message);
  }
});

const session = await api('/api/session');
state.token = session.token;
await refresh();
