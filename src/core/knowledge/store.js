import { mkdir, readFile, writeFile, readdir, rename, cp, unlink } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';

import { TorisError } from '../errors.js';
import { parseDagDocument, renderDagDocument, addDagEdge, detectCycles, EDGE_KINDS } from './dag.js';
import { parseFrontmatter, renderFrontmatter, splitTags, requireSlug, slugify } from './markdown.js';
import {
  knowledgeDir,
  projectKnowledgeDir,
  domainDir,
  nodeDir,
  tacitDir,
  inboxDir,
  PACKS_DIR,
  TEMPLATES_DIR,
  STARTER_DOMAIN_SLUGS,
  USER_FILE,
  MEMORY_FILE,
  INDEX_FILE,
  DAG_FILE,
  DOMAIN_FILE,
} from './paths.js';

/** Hermes-style bounds. Over-limit writes are compressed rather than rejected. */
export const USER_MD_LIMIT = 8_000;
export const MEMORY_MD_LIMIT = 12_000;

const INDEX_VERSION = 1;

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

async function listMarkdown(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Keep the head (identity) and the tail (most recent facts). The middle of a
 * long USER.md/MEMORY.md is the first thing a secretary should compress.
 */
export function compressBounded(text, limit, label) {
  const source = String(text ?? '');
  if (Buffer.byteLength(source, 'utf8') <= limit) {
    return { text: source, compressed: false, bytes: Buffer.byteLength(source, 'utf8') };
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(source);
  const notice = `\n\n<!-- compressed ${label}: kept head + tail; original ${bytes.length} bytes, bound ${limit} -->\n\n`;
  const noticeBytes = encoder.encode(notice).length;
  const keep = Math.max(200, limit - noticeBytes);
  const head = Math.floor(keep * 0.35);
  const tail = keep - head;
  const next = `${decoder.decode(bytes.slice(0, head)).trimEnd()}${notice}${decoder.decode(bytes.slice(-tail)).trimStart()}`;
  return { text: next, compressed: true, bytes: Buffer.byteLength(next, 'utf8') };
}

function parseNamedMarkdown(text, fallbackId) {
  const { meta, body } = parseFrontmatter(text ?? '');
  const tags = splitTags(meta.tags);
  const id = requireSlug(meta.id || fallbackId, 'id');
  return {
    id,
    title: meta.title || id,
    tags,
    skills: splitTags(meta.skills),
    when: meta.when || '',
    anti: meta.anti || '',
    body,
    meta,
  };
}

function excerptOf(body, size = 180) {
  const compact = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length <= size ? compact : `${compact.slice(0, size - 1)}…`;
}

/**
 * Local-first knowledge store. Home lives at `~/.toris/knowledge/`; a project
 * may overlay `.toris/knowledge/`. Plain markdown + dag.json, no hosted DB.
 */
export class KnowledgeStore {
  /**
   * @param {{home:string, projectPath?:string, now?:() => Date}} opts
   */
  constructor({ home, projectPath, now = () => new Date() } = {}) {
    if (!home) throw new TorisError('KnowledgeStore needs a toris home directory.', 'E_INVALID_ARG');
    this.home = home;
    this.projectPath = projectPath || null;
    this.now = now;
    this.root = knowledgeDir(home);
    this.projectRoot = projectKnowledgeDir(projectPath);
  }

  roots() {
    return [this.root, this.projectRoot].filter(Boolean);
  }

  async init({ seed = true } = {}) {
    await mkdir(this.root, { recursive: true });
    await mkdir(join(this.root, 'domains'), { recursive: true });
    await mkdir(inboxDir(this.root), { recursive: true });
    if (!(await exists(join(this.root, USER_FILE)))) {
      await atomicWrite(join(this.root, USER_FILE), await readFile(join(TEMPLATES_DIR, USER_FILE), 'utf8'));
    }
    if (!(await exists(join(this.root, MEMORY_FILE)))) {
      await atomicWrite(join(this.root, MEMORY_FILE), await readFile(join(TEMPLATES_DIR, MEMORY_FILE), 'utf8'));
    }
    if (seed) await this.seedStarterPacks();
    await this.rebuildIndex();
    return this.status();
  }

  async seedStarterPacks() {
    for (const slug of STARTER_DOMAIN_SLUGS) {
      const target = domainDir(this.root, slug);
      if (await exists(join(target, DOMAIN_FILE))) continue;
      await cp(join(PACKS_DIR, slug), target, { recursive: true });
    }
  }

  async status() {
    const initialized = await exists(join(this.root, USER_FILE));
    const domains = initialized ? await this.listDomains() : [];
    const user = initialized ? await this.readBounded(USER_FILE, USER_MD_LIMIT) : null;
    const memory = initialized ? await this.readBounded(MEMORY_FILE, MEMORY_MD_LIMIT) : null;
    const inbox = initialized ? (await listMarkdown(inboxDir(this.root))).length : 0;
    return {
      ok: initialized,
      root: this.root,
      projectRoot: this.projectRoot,
      domains: domains.length,
      domainSlugs: domains.map((d) => d.slug),
      inbox,
      userBytes: user?.bytes ?? 0,
      memoryBytes: memory?.bytes ?? 0,
      userLimit: USER_MD_LIMIT,
      memoryLimit: MEMORY_MD_LIMIT,
    };
  }

  async readBounded(name, limit) {
    const text = (await readText(join(this.root, name))) ?? '';
    return { text, bytes: Buffer.byteLength(text, 'utf8'), limit, over: Buffer.byteLength(text, 'utf8') > limit };
  }

  async readUser() {
    return this.readBounded(USER_FILE, USER_MD_LIMIT);
  }

  async readMemory() {
    return this.readBounded(MEMORY_FILE, MEMORY_MD_LIMIT);
  }

  async writeUser(text, { compress = true } = {}) {
    return this.#writeBounded(USER_FILE, text, USER_MD_LIMIT, compress, 'USER.md');
  }

  async writeMemory(text, { compress = true } = {}) {
    return this.#writeBounded(MEMORY_FILE, text, MEMORY_MD_LIMIT, compress, 'MEMORY.md');
  }

  async appendUser(chunk) {
    const current = await this.readUser();
    return this.writeUser(`${current.text.trimEnd()}\n\n${String(chunk).trim()}\n`);
  }

  async appendMemory(chunk) {
    const current = await this.readMemory();
    return this.writeMemory(`${current.text.trimEnd()}\n\n${String(chunk).trim()}\n`);
  }

  async #writeBounded(name, text, limit, compress, label) {
    const next = compress ? compressBounded(text, limit, label) : { text, compressed: false, bytes: Buffer.byteLength(text, 'utf8') };
    if (!compress && next.bytes > limit) {
      throw new TorisError(`${label} is ${next.bytes} bytes; bound is ${limit}. Compress or shorten it.`, 'E_KNOWLEDGE_BOUND');
    }
    await atomicWrite(join(this.root, name), next.text.endsWith('\n') ? next.text : `${next.text}\n`);
    await this.rebuildIndex();
    return { ...next, path: join(this.root, name) };
  }

  resolveRoot(source = 'home') {
    if (source === 'project') {
      if (!this.projectRoot) {
        throw new TorisError('No project knowledge dir. Pass cwd or create .toris/knowledge/.', 'E_NO_PROJECT_KNOWLEDGE');
      }
      return this.projectRoot;
    }
    return this.root;
  }

  async listDomains() {
    const found = [];
    for (const root of this.roots()) {
      const source = root === this.projectRoot ? 'project' : 'home';
      let entries = [];
      try {
        entries = await readdir(join(root, 'domains'), { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const loaded = await this.#loadDomainMeta(root, entry.name, source);
        if (loaded) found.push(loaded);
      }
    }
    return found.sort((a, b) => a.slug.localeCompare(b.slug) || a.source.localeCompare(b.source));
  }

  async #loadDomainMeta(root, slug, source) {
    const text = await readText(join(domainDir(root, slug), DOMAIN_FILE));
    if (text == null) return null;
    const parsed = parseNamedMarkdown(text, slug);
    const nodes = await listMarkdown(nodeDir(root, slug));
    const tacit = await listMarkdown(tacitDir(root, slug));
    const dag = parseDagDocument((await readText(join(domainDir(root, slug), DAG_FILE))) ?? '');
    return {
      slug,
      source,
      root,
      title: parsed.title,
      when: parsed.when,
      anti: parsed.anti,
      skills: parsed.skills,
      tags: parsed.tags,
      body: parsed.body,
      nodeCount: nodes.length,
      tacitCount: tacit.length,
      edgeCount: dag.edges.length,
    };
  }

  async inspectDomain(slug, source) {
    const id = requireSlug(slug, 'domain');
    const candidates = source
      ? [{ root: this.resolveRoot(source), source }]
      : this.roots().map((root) => ({ root, source: root === this.projectRoot ? 'project' : 'home' }));
    for (const candidate of candidates) {
      const meta = await this.#loadDomainMeta(candidate.root, id, candidate.source);
      if (!meta) continue;
      const nodes = await this.listNodes(id, candidate.source);
      const tacit = await this.listTacit(id, candidate.source);
      const dag = parseDagDocument((await readText(join(domainDir(candidate.root, id), DAG_FILE))) ?? '');
      const cycles = detectCycles(dag.edges);
      return { ...meta, nodes, tacit, edges: dag.edges, cycles };
    }
    throw new TorisError(`Unknown domain "${id}".`, 'E_UNKNOWN_DOMAIN');
  }

  async addDomain({ slug, title, body, when, anti, skills, tags, source = 'home' } = {}) {
    const id = requireSlug(slug || title, 'domain');
    const root = this.resolveRoot(source);
    const dir = domainDir(root, id);
    if (await exists(join(dir, DOMAIN_FILE))) {
      throw new TorisError(`Domain "${id}" already exists.`, 'E_DOMAIN_EXISTS');
    }
    await mkdir(nodeDir(root, id), { recursive: true });
    await mkdir(tacitDir(root, id), { recursive: true });
    const markdown = renderFrontmatter(
      {
        slug: id,
        title: title || id,
        when: when || '',
        anti: anti || '',
        skills: splitTags(skills),
        tags: splitTags(tags),
      },
      body || `# ${title || id}\n\nWhat this domain is, when to use it, and what it is not for.\n`,
    );
    await atomicWrite(join(dir, DOMAIN_FILE), markdown);
    await atomicWrite(join(dir, DAG_FILE), renderDagDocument([]));
    await this.rebuildIndex();
    return this.inspectDomain(id, source);
  }

  async listNodes(slug, source = 'home') {
    const id = requireSlug(slug, 'domain');
    const root = this.resolveRoot(source);
    const names = await listMarkdown(nodeDir(root, id));
    const nodes = [];
    for (const name of names) {
      nodes.push(await this.getNode(id, basename(name, '.md'), source));
    }
    return nodes;
  }

  async getNode(slug, nodeId, source = 'home') {
    const domain = requireSlug(slug, 'domain');
    const id = requireSlug(nodeId, 'node');
    const root = this.resolveRoot(source);
    const path = join(nodeDir(root, domain), `${id}.md`);
    const text = await readText(path);
    if (text == null) throw new TorisError(`Unknown node "${domain}/${id}".`, 'E_UNKNOWN_NODE');
    const parsed = parseNamedMarkdown(text, id);
    return { ...parsed, domain, source, path, kind: 'node' };
  }

  async addNode(slug, { id, title, tags, body, source = 'home' } = {}) {
    const domain = requireSlug(slug, 'domain');
    const root = this.resolveRoot(source);
    if (!(await exists(join(domainDir(root, domain), DOMAIN_FILE)))) {
      throw new TorisError(`Unknown domain "${domain}".`, 'E_UNKNOWN_DOMAIN');
    }
    const nodeId = requireSlug(id || title, 'node');
    const path = join(nodeDir(root, domain), `${nodeId}.md`);
    if (await exists(path)) throw new TorisError(`Node "${domain}/${nodeId}" already exists.`, 'E_NODE_EXISTS');
    await mkdir(nodeDir(root, domain), { recursive: true });
    const markdown = renderFrontmatter(
      { id: nodeId, title: title || nodeId, tags: splitTags(tags) },
      body || '',
    );
    await atomicWrite(path, markdown);
    await this.rebuildIndex();
    return this.getNode(domain, nodeId, source);
  }

  /**
   * Rewrite one existing node markdown file (title and/or body). Id, tags,
   * and dag.json stay as they are. Unknown domain / node / empty title throw
   * before any write.
   */
  async updateNode(slug, nodeId, { title, body, source = 'home' } = {}) {
    const domain = requireSlug(slug, 'domain');
    const root = this.resolveRoot(source);
    if (!(await exists(join(domainDir(root, domain), DOMAIN_FILE)))) {
      throw new TorisError(`Unknown domain "${domain}".`, 'E_UNKNOWN_DOMAIN');
    }
    const current = await this.getNode(domain, nodeId, source);
    const nextTitle = title !== undefined ? String(title).trim() : current.title;
    if (!nextTitle) {
      throw new TorisError('Title is required.', 'E_INVALID_KNOWLEDGE');
    }
    const nextBody = body !== undefined ? String(body) : current.body;
    const markdown = renderFrontmatter({ ...current.meta, id: current.id, title: nextTitle }, nextBody);
    await atomicWrite(current.path, markdown);
    await this.rebuildIndex();
    return this.getNode(domain, current.id, source);
  }

  /**
   * Delete one node markdown file and drop dag.json edges that touch it.
   * Unknown domain / node throw before any write.
   */
  async removeNode(slug, nodeId, source = 'home') {
    const domain = requireSlug(slug, 'domain');
    const root = this.resolveRoot(source);
    if (!(await exists(join(domainDir(root, domain), DOMAIN_FILE)))) {
      throw new TorisError(`Unknown domain "${domain}".`, 'E_UNKNOWN_DOMAIN');
    }
    const id = requireSlug(nodeId, 'node');
    const path = join(nodeDir(root, domain), `${id}.md`);
    if (!(await exists(path))) throw new TorisError(`Unknown node "${domain}/${id}".`, 'E_UNKNOWN_NODE');
    const dagPath = join(domainDir(root, domain), DAG_FILE);
    const current = parseDagDocument((await readText(dagPath)) ?? '');
    const remaining = current.edges.filter((edge) => edge.from !== id && edge.to !== id);
    const droppedEdges = current.edges.filter((edge) => edge.from === id || edge.to === id);
    await unlink(path);
    await atomicWrite(dagPath, renderDagDocument(remaining));
    await this.rebuildIndex();
    return { ok: true, removed: true, domain, source, id, droppedEdges, edges: remaining };
  }

  async link(slug, { from, to, kind = 'supports', source = 'home' } = {}) {
    const domain = requireSlug(slug, 'domain');
    const root = this.resolveRoot(source);
    const path = join(domainDir(root, domain), DAG_FILE);
    if (!(await exists(join(domainDir(root, domain), DOMAIN_FILE)))) {
      throw new TorisError(`Unknown domain "${domain}".`, 'E_UNKNOWN_DOMAIN');
    }
    const fromId = requireSlug(from, 'from');
    const toId = requireSlug(to, 'to');
    await this.getNode(domain, fromId, source);
    await this.getNode(domain, toId, source);
    const current = parseDagDocument((await readText(path)) ?? '');
    const edges = addDagEdge(current.edges, { from: fromId, to: toId, kind });
    await atomicWrite(path, renderDagDocument(edges));
    await this.rebuildIndex();
    return { domain, source, edges, added: { from: fromId, to: toId, kind } };
  }

  async listTacit(slug, source = 'home') {
    const domain = requireSlug(slug, 'domain');
    const root = this.resolveRoot(source);
    const names = await listMarkdown(tacitDir(root, domain));
    const notes = [];
    for (const name of names) {
      const id = basename(name, '.md');
      const path = join(tacitDir(root, domain), name);
      const parsed = parseNamedMarkdown(await readFile(path, 'utf8'), id);
      notes.push({ ...parsed, domain, source, path, kind: 'tacit' });
    }
    return notes;
  }

  async addTacit(slug, { id, title, tags, body, source = 'home', inbox = false } = {}) {
    const noteId = requireSlug(id || title || `tacit-${this.now().toISOString().slice(0, 10)}`, 'tacit');
    const markdown = renderFrontmatter(
      {
        id: noteId,
        title: title || noteId,
        tags: splitTags(tags).length ? splitTags(tags) : ['tacit'],
        captured: this.now().toISOString(),
        domain: slug || '',
      },
      body || '',
    );
    if (inbox || !slug) {
      const path = join(inboxDir(this.root), `${noteId}.md`);
      await mkdir(inboxDir(this.root), { recursive: true });
      if (await exists(path)) throw new TorisError(`Inbox note "${noteId}" already exists.`, 'E_NODE_EXISTS');
      await atomicWrite(path, markdown);
      await this.rebuildIndex();
      return { id: noteId, title: title || noteId, path, kind: 'inbox', domain: slug || null };
    }
    const domain = requireSlug(slug, 'domain');
    const root = this.resolveRoot(source);
    if (!(await exists(join(domainDir(root, domain), DOMAIN_FILE)))) {
      throw new TorisError(`Unknown domain "${domain}".`, 'E_UNKNOWN_DOMAIN');
    }
    await mkdir(tacitDir(root, domain), { recursive: true });
    const path = join(tacitDir(root, domain), `${noteId}.md`);
    if (await exists(path)) throw new TorisError(`Tacit note "${domain}/${noteId}" already exists.`, 'E_NODE_EXISTS');
    await atomicWrite(path, markdown);
    await this.rebuildIndex();
    return { id: noteId, title: title || noteId, domain, source, path, kind: 'tacit' };
  }

  async listInbox() {
    const names = await listMarkdown(inboxDir(this.root));
    const notes = [];
    for (const name of names) {
      const path = join(inboxDir(this.root), name);
      const parsed = parseNamedMarkdown(await readFile(path, 'utf8'), basename(name, '.md'));
      notes.push({ ...parsed, path, kind: 'inbox', domain: parsed.meta.domain || null });
    }
    return notes;
  }

  async promoteTacit(noteId, { domain, source = 'home' } = {}) {
    const id = requireSlug(noteId, 'tacit');
    const slug = requireSlug(domain, 'domain');
    const inboxPath = join(inboxDir(this.root), `${id}.md`);
    const text = await readText(inboxPath);
    if (text == null) throw new TorisError(`No inbox note "${id}".`, 'E_UNKNOWN_NODE');
    const parsed = parseNamedMarkdown(text, id);
    const created = await this.addTacit(slug, {
      id,
      title: parsed.title,
      tags: parsed.tags,
      body: parsed.body,
      source,
    });
    await unlink(inboxPath);
    await this.rebuildIndex();
    return created;
  }

  async rebuildIndex() {
    const entries = [];
    const pushFile = async ({ kind, domain, id, path, source }) => {
      const text = await readText(path);
      if (text == null) return;
      const parsed = parseNamedMarkdown(text, id);
      entries.push({
        kind,
        domain: domain || null,
        id: parsed.id,
        title: parsed.title,
        tags: parsed.tags,
        skills: parsed.skills,
        path,
        source,
        excerpt: excerptOf(parsed.body),
      });
    };

    for (const root of this.roots()) {
      const source = root === this.projectRoot ? 'project' : 'home';
      await pushFile({ kind: 'user', id: 'USER', path: join(root, USER_FILE), source });
      await pushFile({ kind: 'memory', id: 'MEMORY', path: join(root, MEMORY_FILE), source });
      for (const name of await listMarkdown(inboxDir(root))) {
        await pushFile({
          kind: 'inbox',
          id: basename(name, '.md'),
          path: join(inboxDir(root), name),
          source,
        });
      }
      let domains = [];
      try {
        domains = await readdir(join(root, 'domains'), { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of domains) {
        if (!entry.isDirectory()) continue;
        const slug = entry.name;
        await pushFile({
          kind: 'domain',
          domain: slug,
          id: slug,
          path: join(domainDir(root, slug), DOMAIN_FILE),
          source,
        });
        for (const name of await listMarkdown(nodeDir(root, slug))) {
          await pushFile({
            kind: 'node',
            domain: slug,
            id: basename(name, '.md'),
            path: join(nodeDir(root, slug), name),
            source,
          });
        }
        for (const name of await listMarkdown(tacitDir(root, slug))) {
          await pushFile({
            kind: 'tacit',
            domain: slug,
            id: basename(name, '.md'),
            path: join(tacitDir(root, slug), name),
            source,
          });
        }
      }
    }

    const index = {
      version: INDEX_VERSION,
      updatedAt: this.now().toISOString(),
      entries,
    };
    await atomicWrite(join(this.root, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
    return index;
  }

  async loadIndex() {
    const raw = await readText(join(this.root, INDEX_FILE));
    if (!raw) return this.rebuildIndex();
    try {
      return JSON.parse(raw);
    } catch {
      return this.rebuildIndex();
    }
  }
}

export { EDGE_KINDS, slugify };
