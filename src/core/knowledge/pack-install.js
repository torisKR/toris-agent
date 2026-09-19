import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TorisError } from '../errors.js';
import { parseDagDocument } from './dag.js';
import { parseFrontmatter, requireSlug, splitTags } from './markdown.js';
import { DAG_FILE, DOMAIN_FILE, domainDir } from './paths.js';

/** Opt-in starter packs shipped in the repo. Copied locally — never fetched. */
export const KNOWLEDGE_PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..', 'packs', 'knowledge');

export const KNOWLEDGE_PACK_SLUGS = Object.freeze([
  'product-growth',
  'flutter-expo-android',
  'solo-revenue',
  'toris-ops',
]);

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function packDir(slug) {
  return join(KNOWLEDGE_PACKS_DIR, requireSlug(slug, 'pack'));
}

function excerptOf(body, size = 140) {
  const compact = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length <= size ? compact : `${compact.slice(0, size - 1)}…`;
}

async function listNodeFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Read one shipped pack from disk. Does not touch ~/.toris.
 * @param {string} slug
 */
export async function loadKnowledgePack(slug) {
  const id = requireSlug(slug, 'pack');
  if (!KNOWLEDGE_PACK_SLUGS.includes(id)) {
    throw new TorisError(`Unknown starter pack "${id}".`, 'E_UNKNOWN_PACK');
  }
  const dir = packDir(id);
  const domainText = await readText(join(dir, DOMAIN_FILE));
  if (domainText == null) {
    throw new TorisError(`Unknown starter pack "${id}".`, 'E_UNKNOWN_PACK');
  }
  const parsed = parseFrontmatter(domainText, `${id}/DOMAIN.md`);
  const nodes = [];
  for (const name of await listNodeFiles(join(dir, 'nodes'))) {
    const text = await readText(join(dir, 'nodes', name));
    if (text == null) continue;
    const node = parseFrontmatter(text, `${id}/nodes/${name}`);
    const nodeId = requireSlug(node.meta.id || basename(name, '.md'), 'node');
    nodes.push({
      id: nodeId,
      title: node.meta.title || nodeId,
      tags: splitTags(node.meta.tags),
      body: node.body,
    });
  }
  const dag = parseDagDocument((await readText(join(dir, DAG_FILE))) ?? '');
  return {
    slug: id,
    title: parsed.meta.title || id,
    description: excerptOf(parsed.body),
    when: parsed.meta.when || '',
    anti: parsed.meta.anti || '',
    skills: splitTags(parsed.meta.skills),
    tags: splitTags(parsed.meta.tags),
    body: parsed.body,
    nodes,
    edges: dag.edges,
    dir,
  };
}

async function homeDomainExists(store, slug) {
  try {
    await store.inspectDomain(slug, 'home');
    return true;
  } catch (error) {
    if (error.code === 'E_UNKNOWN_DOMAIN') return false;
    throw error;
  }
}

/**
 * Read-only catalog. Never writes USER.md, MEMORY.md, or domain files.
 * @param {import('./store.js').KnowledgeStore} store
 */
export async function listKnowledgePacks(store) {
  const installed = new Set((await store.listDomains()).map((domain) => domain.slug));
  const packs = [];
  for (const slug of KNOWLEDGE_PACK_SLUGS) {
    const pack = await loadKnowledgePack(slug);
    packs.push({
      slug: pack.slug,
      title: pack.title,
      description: pack.description,
      nodeCount: pack.nodes.length,
      edgeCount: pack.edges.length,
      installed: installed.has(pack.slug),
      dir: pack.dir,
    });
  }
  return { packs, root: KNOWLEDGE_PACKS_DIR };
}

async function replaceHomeDomain(store, slug) {
  await rm(domainDir(store.root, slug), { recursive: true, force: true });
}

/**
 * Copy one shipped pack into the home store via addDomain + addNode + link.
 * Refuses when the domain exists unless `force` (CLI only). Never writes
 * USER.md or MEMORY.md. Never fetches the network.
 * @param {import('./store.js').KnowledgeStore} store
 * @param {string} slug
 * @param {{force?: boolean}} [opts]
 */
export async function installKnowledgePack(store, slug, { force = false } = {}) {
  const pack = await loadKnowledgePack(slug);
  if (await homeDomainExists(store, pack.slug)) {
    if (!force) {
      throw new TorisError(`Domain "${pack.slug}" already exists.`, 'E_DOMAIN_EXISTS');
    }
    await replaceHomeDomain(store, pack.slug);
  }
  const domain = await store.addDomain({
    slug: pack.slug,
    title: pack.title,
    body: pack.body,
    when: pack.when,
    anti: pack.anti,
    skills: pack.skills,
    tags: pack.tags,
  });
  const nodes = [];
  for (const node of pack.nodes) {
    nodes.push(await store.addNode(pack.slug, node));
  }
  const edges = [];
  for (const edge of pack.edges) {
    const linked = await store.link(pack.slug, edge);
    edges.push(linked.added);
  }
  return {
    ok: true,
    written: true,
    slug: pack.slug,
    title: domain.title,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    forced: Boolean(force),
    dir: pack.dir,
    domain,
  };
}
