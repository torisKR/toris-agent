import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createId } from '../core/ids.js';
import { normalizeDesignCapture } from './design.js';

function pngFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  try {
    return Buffer.from(dataUrl.slice(comma + 1), 'base64');
  } catch {
    return null;
  }
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
}
