import { Store } from '../core/store.js';
import { createId } from '../core/ids.js';
import { createContent, updateContent } from './content.js';

const COLLECTION = 'studio-contents';

export class ContentStore {
  constructor(home, options = {}) {
    this.store = new Store(home);
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || (() => createId('cnt'));
    this.pending = Promise.resolve();
  }

  async init() {
    await this.store.init();
    return this;
  }

  #serial(task) {
    const result = this.pending.then(task, task);
    this.pending = result.catch(() => undefined);
    return result;
  }

  async list() {
    await this.pending;
    const items = await this.store.readCollection(COLLECTION);
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id) {
    return (await this.list()).find((item) => item.id === id) || null;
  }

  create(input) {
    return this.#serial(async () => {
      const current = await this.store.readCollection(COLLECTION);
      const content = createContent(input, { id: this.idFactory(), now: this.now });
      await this.store.writeCollection(COLLECTION, [...current, content]);
      return content;
    });
  }

  update(id, patch) {
    return this.#serial(async () => {
      const current = await this.store.readCollection(COLLECTION);
      const index = current.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('Unknown content: ' + id);
      const content = updateContent(current[index], patch, this.now);
      const next = current.with(index, content);
      await this.store.writeCollection(COLLECTION, next);
      return content;
    });
  }
}
