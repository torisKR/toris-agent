import { join } from 'node:path';
import { mkdir, readFile, writeFile, appendFile, readdir, rename } from 'node:fs/promises';

/**
 * File-backed store. One JSON document per collection, one file per run,
 * append-only JSONL per run for events.
 *
 * Chosen over SQLite so the package has zero native dependencies and
 * `npm i -g toris-agent` cannot fail to compile. State stays greppable.
 */
export class Store {
  /** @param {string} home */
  constructor(home) {
    this.home = home;
    this.runsDir = join(home, 'runs');
    this.eventsDir = join(home, 'events');
  }

  async init() {
    await mkdir(this.runsDir, { recursive: true });
    await mkdir(this.eventsDir, { recursive: true });
    return this;
  }

  #collectionPath(name) {
    return join(this.home, `${name}.json`);
  }

  async readCollection(name) {
    try {
      const parsed = JSON.parse(await readFile(this.#collectionPath(name), 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new Error(`Cannot read ${name}: ${err.message}`);
    }
  }

  /** Atomic write: temp file + rename, so a crash never truncates state. */
  async writeCollection(name, items) {
    await mkdir(this.home, { recursive: true });
    const target = this.#collectionPath(name);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
    return items;
  }

  /** Read-modify-write with an immutable updater. */
  async updateCollection(name, updater) {
    const current = await this.readCollection(name);
    const next = updater(current);
    await this.writeCollection(name, next);
    return next;
  }

  async saveRun(run) {
    await mkdir(this.runsDir, { recursive: true });
    const target = join(this.runsDir, `${run.id}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
    return run;
  }

  async getRun(runId) {
    try {
      return JSON.parse(await readFile(join(this.runsDir, `${runId}.json`), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`Cannot read run ${runId}: ${err.message}`);
    }
  }

  async listRuns() {
    let files = [];
    try {
      files = await readdir(this.runsDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const runs = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const run = await this.getRun(file.slice(0, -5));
      if (run) runs.push(run);
    }
    // Ids are time-prefixed, so descending id === newest first.
    return runs.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  async appendEvent(runId, event) {
    await mkdir(this.eventsDir, { recursive: true });
    await appendFile(join(this.eventsDir, `${runId}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  async readEvents(runId) {
    try {
      const raw = await readFile(join(this.eventsDir, `${runId}.jsonl`), 'utf8');
      return raw.split('\n').filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { type: 'corrupt', raw: line };
        }
      });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}
