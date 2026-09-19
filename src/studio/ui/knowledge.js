import { knowledgePinFromStorage, writeKnowledgePin } from './knowledge-pin-client.js';

const state = {
  token: '',
  domains: [],
  selected: null,
  detail: null,
  dag: null,
  nodeId: null,
  pin: null,
  reflect: null,
  reflectHidden: false,
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

function selectedDagNode() {
  return state.dag?.nodes?.find((node) => node.id === state.nodeId) || null;
}

function readPin() {
  return knowledgePinFromStorage();
}

function writePin(pin) {
  state.pin = pin;
  writeKnowledgePin(pin);
}

function isPinned(node) {
  return Boolean(state.pin && state.pin.domain === state.selected && state.pin.nodeId === node.id);
}

function dagTitle(id) {
  return state.dag?.nodes?.find((node) => node.id === id)?.title || id;
}

function renderNodes(detail) {
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
}

function renderLinkTargets(detail) {
  const select = $('new-target');
  if (!select) return;
  const current = select.value;
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None';
  select.append(none);
  for (const item of detail.nodes || []) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.title} (${item.id})`;
    select.append(option);
  }
  if (current && [...select.options].some((option) => option.value === current)) {
    select.value = current;
  }
}

function renderEdges(detail) {
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

function renderDag() {
  const panel = $('knowledge-dag');
  const list = $('dag-nodes');
  const excerpt = $('dag-excerpt');
  const nodes = state.dag?.nodes || [];
  list.replaceChildren();
  panel.hidden = nodes.length === 0;
  excerpt.hidden = true;
  excerpt.textContent = '';
  if (!nodes.length) return;

  const outgoing = new Map();
  for (const edge of state.dag.edges || []) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }

  for (const node of nodes) {
    const item = document.createElement('li');
    item.className = 'knowledge-dag-node';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `knowledge-hit${node.id === state.nodeId ? ' is-selected' : ''}`;
    const title = document.createElement('strong');
    title.textContent = node.title;
    const kind = document.createElement('small');
    kind.textContent = node.kind || 'node';
    button.append(title, kind);
    button.addEventListener('click', () => {
      state.nodeId = node.id;
      renderDetail();
    });
    const pin = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'knowledge-pin';
    box.checked = isPinned(node);
    box.addEventListener('change', () => {
      writePin(box.checked ? { domain: state.selected, nodeId: node.id } : null);
      renderDag();
    });
    pin.append(box, document.createTextNode(' use on next turn'));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button quiet';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!window.confirm(`Remove ${node.title || node.id}?`)) return;
      try {
        await api(`/api/knowledge/domains/${encodeURIComponent(state.selected)}/nodes/${encodeURIComponent(node.id)}/remove`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        announce(`Removed ${node.id}.`);
        await selectDomain(state.selected);
      } catch (error) {
        announce(error.message);
      }
    });
    item.append(button, pin, remove);
    const links = outgoing.get(node.id) || [];
    if (links.length) {
      const nest = document.createElement('ul');
      nest.className = 'knowledge-dag-edges';
      for (const edge of links) {
        const row = document.createElement('li');
        row.textContent = `${edge.kind} → ${dagTitle(edge.to)}`;
        nest.append(row);
      }
      item.append(nest);
    }
    list.append(item);
  }

  const selected = selectedDagNode();
  if (selected?.excerpt) {
    excerpt.hidden = false;
    excerpt.textContent = selected.excerpt;
  }
}

function renderDetail() {
  const detail = state.detail;
  $('knowledge-empty').hidden = Boolean(detail);
  $('knowledge-detail').hidden = !detail;
  if (!detail) {
    state.dag = null;
    renderDag();
    return;
  }
  $('detail-slug').textContent = detail.slug;
  $('detail-title').textContent = detail.title;
  $('detail-source').textContent = detail.source;
  $('detail-when').textContent = detail.when || detail.anti || '';
  const node = selectedNode();
  const dagNode = selectedDagNode();
  const form = $('edit-node-form');
  if (node || dagNode) {
    $('node-body').hidden = true;
    form.hidden = false;
    $('edit-title').value = node?.title || dagNode?.title || '';
    $('edit-kind').textContent = node?.kind || dagNode?.kind || 'node';
    $('edit-body').value = node?.body ?? '';
  } else {
    form.hidden = true;
    $('node-body').hidden = false;
    $('node-body').textContent = detail.body || '';
  }
  renderNodes(detail);
  renderEdges(detail);
  renderLinkTargets(detail);
  renderDag();
}

async function loadDag(slug) {
  try {
    return await api(`/api/knowledge/domains/${encodeURIComponent(slug)}/dag`);
  } catch {
    return { ok: true, slug, nodes: [], edges: [], nodeCount: 0, edgeCount: 0 };
  }
}

async function selectDomain(slug) {
  state.selected = slug;
  state.detail = await api(`/api/knowledge/domains/${encodeURIComponent(slug)}`);
  state.dag = await loadDag(slug);
  state.nodeId = state.detail.nodes?.[0]?.id || state.dag.nodes?.[0]?.id || null;
  renderDomains();
  renderDetail();
}

function renderReflect() {
  const proposal = !state.reflectHidden && state.reflect?.notable ? state.reflect.proposal : null;
  $('reflect-empty').hidden = Boolean(proposal);
  $('reflect-card').hidden = !proposal;
  $('reflect-badge').textContent = proposal ? 'verified' : 'opt-in';
  if (!proposal) return;
  $('reflect-domain').textContent = proposal.domain || 'inbox';
  $('reflect-goal').textContent = proposal.goal || proposal.title || '';
  $('reflect-outcome').textContent = proposal.outcome || '';
}

async function refreshReflect() {
  try {
    state.reflect = await api('/api/knowledge/reflect');
  } catch {
    state.reflect = { notable: false, proposal: null };
  }
  renderReflect();
}

async function refresh() {
  const overview = await api('/api/knowledge');
  state.domains = overview.domains || [];
  await refreshReflect();
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

$('edit-node-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selected || !state.nodeId) {
    announce('Pick a node first.');
    return;
  }
  try {
    await api(`/api/knowledge/domains/${encodeURIComponent(state.selected)}/nodes/${encodeURIComponent(state.nodeId)}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: $('edit-title').value,
        body: $('edit-body').value,
      }),
    });
    announce('Node saved.');
    state.detail = await api(`/api/knowledge/domains/${encodeURIComponent(state.selected)}`);
    state.dag = await loadDag(state.selected);
    renderDomains();
    renderDetail();
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
  const target = $('new-target').value.trim();
  try {
    const result = await api(`/api/knowledge/domains/${encodeURIComponent(state.selected)}/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: $('new-title').value,
        kind: $('new-kind').value,
        body: $('new-body').value,
        ...(target ? { target } : {}),
      }),
    });
    $('add-node-form').reset();
    announce(result.edge ? 'Node and edge saved.' : 'Node saved.');
    await selectDomain(state.selected);
  } catch (error) {
    announce(error.message);
  }
});

$('reflect-accept').addEventListener('click', async () => {
  try {
    const runId = state.reflect?.proposal?.runId;
    const result = await api('/api/knowledge/reflect/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(runId ? { runId } : {}),
    });
    announce(result.note?.path ? `Wrote ${result.note.path}` : 'Wrote tacit note.');
    await refresh();
  } catch (error) {
    announce(error.message);
  }
});

$('reflect-dismiss').addEventListener('click', async () => {
  try {
    await api('/api/knowledge/reflect/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    state.reflectHidden = true;
    renderReflect();
    announce('Dismissed. Nothing written.');
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
state.pin = readPin();
await refresh();
