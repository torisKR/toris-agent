import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createId } from '../core/ids.js';
import {
  DESIGN_ANNOTATION_LIMIT,
  clipDesignNote,
  normalizeDesignCapture,
} from './design.js';

function pngFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  try {
    return Buffer.from(dataUrl.slice(comma + 1), 'base64');
  } catch {
    return null;
  }
}

function emptyTray() {
  return { version: 1, items: [], updatedAt: null };
}

export class DesignStore {
  constructor(home) {
    this.home = home;
    this.dir = join(home, 'studio', 'design');
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    return this;
  }

  #recordPath(id) {
    return join(this.dir, `${id}.json`);
  }

  #trayPath() {
    return join(this.dir, 'tray.json');
  }

  async save(input) {
    await this.init();
    const capture = normalizeDesignCapture(input);
    const id = createId('des');
    let screenshotPath = null;
    if (capture.screenshotDataUrl) {
      const png = pngFromDataUrl(capture.screenshotDataUrl);
      if (png && png.length > 0) {
        screenshotPath = join(this.dir, `${id}.png`);
        await writeFile(screenshotPath, png);
      }
    }
    const record = {
      id,
      url: capture.url,
      selector: capture.selector,
      outerHTML: capture.outerHTML,
      computedStyle: capture.computedStyle,
      text: capture.text,
      note: capture.note,
      tagName: capture.tagName,
      rect: capture.rect,
      screenshotPath,
      createdAt: new Date().toISOString(),
    };
    await writeFile(this.#recordPath(id), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  async get(id) {
    if (typeof id !== 'string' || !/^des_[a-z0-9]+$/i.test(id)) return null;
    try {
      return JSON.parse(await readFile(this.#recordPath(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async update(id, patch = {}) {
    const record = await this.get(id);
    if (!record) return null;
    const next = { ...record };
    if (Object.hasOwn(patch, 'note')) next.note = clipDesignNote(patch.note);
    await writeFile(this.#recordPath(id), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  async list() {
    await this.init();
    let files = [];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const ids = files.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    const items = [];
    for (const id of ids) {
      const record = await this.get(id);
      if (record) items.push(record);
    }
    return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async #readTrayFile() {
    try {
      const raw = JSON.parse(await readFile(this.#trayPath(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyTray();
      const items = Array.isArray(raw.items) ? raw.items : [];
      return {
        version: 1,
        items: items
          .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
          .slice(0, DESIGN_ANNOTATION_LIMIT)
          .map((item) => ({ id: item.id, note: clipDesignNote(item.note) })),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      };
    } catch (err) {
      if (err.code === 'ENOENT') return emptyTray();
      throw err;
    }
  }

  async presentTray(tray = emptyTray()) {
    const items = [];
    for (const item of tray.items) {
      const capture = await this.get(item.id);
      if (!capture) continue;
      items.push({ ...capture, note: item.note || capture.note || '' });
    }
    return { version: 1, items, updatedAt: tray.updatedAt };
  }

  async getTray() {
    await this.init();
    return this.presentTray(await this.#readTrayFile());
  }

  async saveTray(input = {}) {
    await this.init();
    const incoming = Array.isArray(input.items) ? input.items : [];
    const bounded = [];
    const seen = new Set();
    for (const item of incoming) {
      if (bounded.length >= DESIGN_ANNOTATION_LIMIT) break;
      const id = typeof item === 'string' ? item : item?.id;
      if (!id || seen.has(id)) continue;
      const capture = await this.get(id);
      if (!capture) continue;
      const note = clipDesignNote(typeof item === 'string' ? '' : item?.note ?? capture.note);
      if (note !== (capture.note || '')) await this.update(id, { note });
      bounded.push({ id, note });
      seen.add(id);
    }
    const tray = { version: 1, items: bounded, updatedAt: new Date().toISOString() };
    await writeFile(this.#trayPath(), `${JSON.stringify(tray, null, 2)}\n`);
    return this.presentTray(tray);
  }

  async addToTray(id, note) {
    const capture = await this.get(id);
    if (!capture) return null;
    const tray = await this.#readTrayFile();
    const rest = tray.items.filter((item) => item.id !== id);
    const nextNote = clipDesignNote(note ?? capture.note);
    return this.saveTray({
      items: [...rest, { id, note: nextNote }].slice(-DESIGN_ANNOTATION_LIMIT),
    });
  }

  async removeFromTray(id) {
    const tray = await this.#readTrayFile();
    return this.saveTray({ items: tray.items.filter((item) => item.id !== id) });
  }

  async clearTray() {
    return this.saveTray({ items: [] });
  }
}

/**
 * Empty the annotation tray only after a turn that attached it is accepted.
 * Turns that omit tray, empty trays, and callers that never get here
 * (auth / validation / model failures) leave tray.json alone.
 */
export async function consumeDesignTrayAfterAccept(store, trayRequested) {
  if (!trayRequested) return null;
  const tray = await store.getTray();
  if (!tray.items.length) return tray;
  return store.clearTray();
}
