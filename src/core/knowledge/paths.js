import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** Builtin starter packs shipped with the package. */
export const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'packs');
export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

export const STARTER_DOMAIN_SLUGS = Object.freeze([
  'product-growth',
  'flutter-android',
  'expo-android',
  'toris-ops',
  'solo-revenue',
]);

export function knowledgeDir(home) {
  return join(home, 'knowledge');
}

export function projectKnowledgeDir(projectPath) {
  return projectPath ? join(projectPath, '.toris', 'knowledge') : null;
}

export function knowledgeSearchRoots({ home, projectPath } = {}) {
  return [home ? knowledgeDir(home) : null, projectKnowledgeDir(projectPath)].filter(Boolean);
}

export function domainDir(root, slug) {
  return join(root, 'domains', slug);
}

export function nodeDir(root, slug) {
  return join(domainDir(root, slug), 'nodes');
}

export function tacitDir(root, slug) {
  return join(domainDir(root, slug), 'tacit');
}

export function inboxDir(root) {
  return join(root, 'inbox');
}

export const USER_FILE = 'USER.md';
export const MEMORY_FILE = 'MEMORY.md';
export const INDEX_FILE = 'index.json';
export const DAG_FILE = 'dag.json';
export const DOMAIN_FILE = 'DOMAIN.md';
