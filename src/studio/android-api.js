import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
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
 * Resolve `~/.toris` and `~/.toris/android` to real paths so a symlinked
 * TORIS_HOME (or macOS /var → /private/var) still compares equal.
 */
export async function resolveAndroidRoots(home) {
  const torisHome = await realpathIfExists(home);
  if (!torisHome) {
    return { torisHome: resolve(home), root: resolve(androidHome(resolve(home))), missing: true };
  }
  const homeRoot = resolve(androidHome(torisHome));
  if (!inside(torisHome, homeRoot)) {
    throw new HttpError(400, 'android artifact root escaped home');
  }
  const root = await realpathIfExists(homeRoot) || await realpathIfExists(resolve(androidHome(resolve(home))));
  if (!root) return { torisHome, root: homeRoot, missing: true };
  if (!inside(torisHome, root)) {
    throw new HttpError(400, 'android artifact root escaped home');
  }
  return { torisHome, root, missing: false };
}

/**
 * Newest regular files under `~/.toris/android/`. Never reports a path
 * outside the Toris home. Missing directory is an empty list.
 */
export async function listAndroidArtifacts(home, { limit = ARTIFACT_LIMIT } = {}) {
  const { torisHome, root, missing } = await resolveAndroidRoots(home);
  if (missing) return { ok: true, items: [] };
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
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
    if (!inside(root, canonical) || !inside(torisHome, canonical)) continue;
    const rel = relative(root, canonical).split(sep).join('/');
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

/** Resolve an image under `~/.toris/android/` or throw. Rejects traversal. */
export async function resolveAndroidImage(home, relPath) {
  const { torisHome, root, missing } = await resolveAndroidRoots(home);
  if (missing) throw new HttpError(404, 'android artifact not found');
  const candidate = resolveStaticFile(root, String(relPath || ''));
  const mime = IMAGE_TYPES.get(extname(candidate).toLowerCase());
  if (!mime) throw new HttpError(400, 'only image artifacts can be served');
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
  return { path: canonicalPath, mime, bytes: info.size };
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
