import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import {
  androidHome,
  androidLogcat,
  androidScreenshot,
  androidStatus,
  inspectAndroidTools,
} from '../core/android.js';
import { TorisError } from '../core/errors.js';
import { HttpError, readJson, resolveStaticFile } from './http.js';

const ARTIFACT_LIMIT = 20;
const ARTIFACT_SELECT_LIMIT = 8;
const LOG_EXCERPT_LIMIT = 4_000;
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
]);

function inside(root, candidate) {
  const base = resolve(root);
  const value = resolve(candidate);
  return value === base || value.startsWith(`${base}${sep}`);
}

/** `realpath` when the path exists; `null` for a missing path. */
async function realpathIfExists(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function androidCoreOptions(options, extra = {}) {
  const android = options.android || {};
  const core = { home: options.home, ...extra };
  if (android.detect) core.detect = android.detect;
  if (android.exec) core.exec = android.exec;
  return core;
}

function androidFns(options) {
  const android = options.android || {};
  return {
    status: android.status || androidStatus,
    screenshot: android.screenshot || androidScreenshot,
    logcat: android.logcat || androidLogcat,
    listArtifacts: android.listArtifacts || listAndroidArtifacts,
  };
}

function optionalSerial(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'serial must be a string');
  const serial = value.trim();
  return serial || undefined;
}

function optionalLines(value) {
  if (value == null || value === '') return undefined;
  const lines = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(lines)) throw new HttpError(400, 'lines must be a number');
  return lines;
}

function androidHttpError(error) {
  if (error instanceof HttpError) throw error;
  if (error instanceof TorisError) {
    if (error.code === 'E_ADB_SERIAL' || error.code === 'E_USAGE') {
      throw new HttpError(400, error.message);
    }
    if (error.code === 'E_ADB_TIMEOUT') throw new HttpError(504, error.message);
    if (error.code === 'E_ADB_MISSING' || error.code === 'E_ADB') {
      throw new HttpError(409, error.message);
    }
  }
  throw error;
}

/**
 * Newest regular files under `~/.toris/android/`. Never reports a path
 * outside the Toris home. Missing directory is an empty list.
 */
export async function listAndroidArtifacts(home, { limit = ARTIFACT_LIMIT } = {}) {
  const torisHome = await realpathIfExists(home);
  if (!torisHome) return { ok: true, items: [] };
  const root = resolve(androidHome(torisHome));
  const canonicalRoot = await realpathIfExists(root);
  if (!canonicalRoot) return { ok: true, items: [] };
  if (!inside(torisHome, canonicalRoot)) {
    throw new HttpError(400, 'android artifact root escaped home');
  }
  let entries;
  try {
    entries = await readdir(canonicalRoot, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, items: [] };
    throw error;
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    const dir = entry.parentPath || entry.path;
    if (!dir) continue;
    const abs = join(dir, entry.name);
    let info;
    let canonical;
    try {
      [info, canonical] = await Promise.all([stat(abs), realpath(abs)]);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (!inside(canonicalRoot, canonical) || !inside(torisHome, canonical)) continue;
    const rel = relative(canonicalRoot, canonical).split(sep).join('/');
    if (!rel || rel.startsWith('..') || rel.includes('\0')) continue;
    items.push({
      name: entry.name,
      bytes: info.size,
      mtime: info.mtime.toISOString(),
      rel,
      image: IMAGE_TYPES.has(extname(entry.name).toLowerCase()),
    });
  }
  items.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
  return { ok: true, items: items.slice(0, Math.max(1, Math.trunc(limit) || ARTIFACT_LIMIT)) };
}

/** Relative paths the operator selected for one agent turn. */
export function androidArtifactRels(input = {}) {
  const fromObject = Array.isArray(input.android?.artifacts) ? input.android.artifacts : [];
  const fromArray = Array.isArray(input.androidArtifacts) ? input.androidArtifacts : [];
  return [...fromObject, ...fromArray]
    .filter((rel) => typeof rel === 'string' && rel.trim())
    .map((rel) => rel.trim())
    .slice(0, ARTIFACT_SELECT_LIMIT);
}

/**
 * Resolve any regular file under `~/.toris/android/` or throw.
 * Uses realpath so macOS `/var` vs `/private/var` still matches.
 */
export async function resolveAndroidArtifact(home, relPath) {
  const torisHome = await realpathIfExists(home);
  if (!torisHome) throw new HttpError(404, 'android artifact not found');
  const root = resolve(androidHome(torisHome));
  if (!inside(torisHome, root)) throw new HttpError(400, 'invalid android artifact path');
  const candidate = resolveStaticFile(root, String(relPath || ''));
  let canonicalRoot;
  let canonicalPath;
  try {
    [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(candidate)]);
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'android artifact not found');
    throw error;
  }
  if (!inside(canonicalRoot, canonicalPath) || !inside(torisHome, canonicalPath)) {
    throw new HttpError(400, 'invalid android artifact path');
  }
  const info = await stat(canonicalPath);
  if (!info.isFile()) throw new HttpError(404, 'android artifact not found');
  const ext = extname(canonicalPath).toLowerCase();
  const mime = IMAGE_TYPES.get(ext) || null;
  const rel = relative(canonicalRoot, canonicalPath).split(sep).join('/');
  if (!rel || rel.startsWith('..') || rel.includes('\0')) {
    throw new HttpError(400, 'invalid android artifact path');
  }
  return {
    path: canonicalPath,
    rel,
    name: basename(canonicalPath),
    mime,
    image: Boolean(mime),
    bytes: info.size,
  };
}

/** Resolve an image under `~/.toris/android/` or throw. Rejects traversal. */
export async function resolveAndroidImage(home, relPath) {
  const file = await resolveAndroidArtifact(home, relPath);
  if (!file.mime) throw new HttpError(400, 'only image artifacts can be served');
  return { path: file.path, mime: file.mime, bytes: file.bytes };
}

/**
 * Load selected artifacts as bounded turn evidence. Images keep the
 * canonical path (same shape Design Mode already attaches). Logs add a
 * short utf8 excerpt. Never reads a path outside `~/.toris/android/`.
 */
export async function loadAndroidEvidence(home, rels) {
  const items = [];
  for (const rel of androidArtifactRels({ androidArtifacts: rels })) {
    const file = await resolveAndroidArtifact(home, rel);
    let excerpt = '';
    if (!file.image) {
      const text = await readFile(file.path, 'utf8');
      excerpt = text.length > LOG_EXCERPT_LIMIT ? text.slice(-LOG_EXCERPT_LIMIT) : text;
    }
    items.push({ ...file, excerpt });
  }
  return items;
}

function formatAndroidEvidence(item, { index, total } = {}) {
  const name = item.rel || item.name || item.path || 'artifact';
  const heading = index
    ? `### ${index}${total ? `/${total}` : ''} ${name}`
    : `### ${name}`;
  const lines = [
    heading,
    item.path ? `Path: ${item.path}` : null,
    item.image && item.path ? `Screenshot: ${item.path}` : null,
    !item.image && item.excerpt
      ? `Log excerpt:\n\`\`\`\n${item.excerpt}\n\`\`\``
      : null,
  ];
  return lines.filter((line) => line != null && line !== '').join('\n');
}

/** Markdown block prepended to a Studio agent turn — same attach path as Design Mode. */
export function composeAndroidTurnMessage(message, evidence) {
  const text = String(message ?? '').trim();
  const items = (Array.isArray(evidence) ? evidence : []).filter(Boolean).slice(0, ARTIFACT_SELECT_LIMIT);
  if (items.length === 0) return text;
  const heading = items.length === 1
    ? '## Android evidence'
    : `## Android evidence (${items.length})`;
  const context = [
    heading,
    ...items.map((item, index) => formatAndroidEvidence(item, { index: index + 1, total: items.length })),
    'Treat this as device evidence from a local adb capture. Edit the source that produced this UI. Do not claim a visual fix without matching the screenshot. Use the logcat excerpt for crashes and errors only.',
  ].join('\n\n');
  return text ? `${text}\n\n${context}` : context;
}

/**
 * Additive Studio routes for /api/android. Reuses `androidStatus` /
 * `androidScreenshot` / `androidLogcat`. Does not expose install.
 */
export function registerAndroidRoutes(router, { sendJson, requireJson, options }) {
  const fns = androidFns(options);

  router.add('GET', '/api/android', async (_request, response) => {
    const core = androidCoreOptions(options);
    try {
      sendJson(response, 200, await fns.status(core));
    } catch (error) {
      if (
        error instanceof TorisError
        && (error.code === 'E_ADB' || error.code === 'E_ADB_MISSING' || error.code === 'E_ADB_TIMEOUT')
      ) {
        const tools = inspectAndroidTools(core);
        sendJson(response, 200, {
          ok: false,
          adb: tools.adb,
          emulator: tools.emulator,
          ready: false,
          version: null,
          devices: [],
          error: error.message,
        });
        return;
      }
      throw error;
    }
  });

  router.add('GET', '/api/android/artifacts', async (_request, response) => {
    sendJson(response, 200, await fns.listArtifacts(options.home));
  });

  router.add('GET', '/api/android/media', async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const file = await resolveAndroidImage(options.home, url.searchParams.get('path') || '');
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': String(file.bytes),
      'content-type': file.mime,
      'x-content-type-options': 'nosniff',
    });
    createReadStream(file.path).pipe(response);
  });

  router.add('POST', '/api/android/screenshot', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    try {
      const shot = await fns.screenshot(androidCoreOptions(options, {
        serial: optionalSerial(body.serial),
      }));
      sendJson(response, 200, {
        ok: true,
        path: shot.path,
        bytes: shot.bytes,
        serial: shot.serial ?? null,
      });
    } catch (error) {
      androidHttpError(error);
    }
  });

  router.add('POST', '/api/android/logcat', async (request, response) => {
    requireJson(request);
    const body = await readJson(request);
    try {
      const log = await fns.logcat(androidCoreOptions(options, {
        serial: optionalSerial(body.serial),
        lines: optionalLines(body.lines),
      }));
      sendJson(response, 200, {
        ok: true,
        path: log.path,
        bytes: log.bytes,
        serial: log.serial ?? null,
        lines: log.lines,
        tail: log.tail ?? '',
      });
    } catch (error) {
      androidHttpError(error);
    }
  });
}
