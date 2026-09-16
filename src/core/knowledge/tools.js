import { KnowledgeStore } from './store.js';
import { searchIndex } from './search.js';
import { matchDomains } from './context.js';
import { proposeReflections, renderReflection } from './reflect.js';
import { splitTags } from './markdown.js';

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * Chat tools for the secretary layer. knowledge_write is gated the same way
 * as write_file: needsApproval, which auto-runs at L3+ and asks below that.
 *
 * @param {{home:string, projectPath?:string, session?:{activeDomains?:string[]}}} opts
 */
export function createKnowledgeTools({ home, projectPath, session } = {}) {
  const state = session ?? { activeDomains: [] };
  if (!Array.isArray(state.activeDomains)) state.activeDomains = [];
  const store = home ? new KnowledgeStore({ home, projectPath }) : null;

  const requireStore = async () => {
    if (!store) return 'No toris home is configured, so knowledge is unavailable.';
    const status = await store.status();
    if (!status.ok) {
      await store.init({ seed: true });
    }
    return null;
  };

  return [
    {
      name: 'knowledge_search',
      description:
        'Search local secretary knowledge (USER.md, MEMORY.md, domain nodes, tacit notes). ' +
        'Use this before inventing facts about the operator, their stack, or how they ship.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords or tags to recall' },
          domain: { type: 'string', description: 'Optional domain slug to scope the search' },
          limit: { type: 'number', description: 'Max hits, default 8' },
        },
        required: ['query'],
      },
      run: async ({ query, domain, limit }) => {
        const blocked = await requireStore();
        if (blocked) return blocked;
        const index = await store.loadIndex();
        const hits = searchIndex(index, query, { domain, limit: limit ?? 8 });
        return stringify({ query, hits });
      },
    },
    {
      name: 'memory_get',
      description:
        'Read USER.md, MEMORY.md, or one domain pack (DOMAIN.md + nodes + DAG). ' +
        'Prefer this over guessing operator facts.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'user | memory | domain | status',
          },
          domain: { type: 'string', description: 'Domain slug when target is domain' },
        },
      },
      run: async ({ target = 'status', domain } = {}) => {
        const blocked = await requireStore();
        if (blocked) return blocked;
        const name = String(target || 'status').toLowerCase();
        if (name === 'user') return stringify(await store.readUser());
        if (name === 'memory') return stringify(await store.readMemory());
        if (name === 'status') return stringify(await store.status());
        if (name === 'domain') {
          if (!domain) return 'memory_get target=domain needs a domain slug.';
          return stringify(await store.inspectDomain(domain));
        }
        return `Unknown memory_get target "${target}". Use user, memory, domain, or status.`;
      },
    },
    {
      name: 'domain_activate',
      description:
        'Pin a domain pack for this chat session so later turns keep its context. ' +
        'Does not write files. Pass slug=none to clear.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Domain slug, or "none" to clear' },
        },
        required: ['slug'],
      },
      run: async ({ slug }) => {
        const blocked = await requireStore();
        if (blocked) return blocked;
        if (!slug || slug === 'none' || slug === 'clear') {
          state.activeDomains = [];
          return stringify({ activeDomains: [] });
        }
        const domains = await store.listDomains();
        const hit = domains.find((domain) => domain.slug === slug);
        if (!hit) {
          const matched = matchDomains(domains, slug);
          return stringify({
            error: `Unknown domain "${slug}"`,
            suggestions: matched.map((domain) => domain.slug),
            available: domains.map((domain) => domain.slug),
          });
        }
        if (!state.activeDomains.includes(hit.slug)) state.activeDomains.push(hit.slug);
        return stringify({ activeDomains: state.activeDomains, domain: hit });
      },
    },
    {
      name: 'knowledge_write',
      description:
        'Write durable secretary knowledge: append USER.md or MEMORY.md, add a domain node, ' +
        'or capture a tacit note. Below autonomy L3 this asks first. Prefer a proposed ' +
        'tacit note after successful work rather than dumping session logs into MEMORY.md.',
      needsApproval: true,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'user | memory | node | tacit | inbox' },
          domain: { type: 'string' },
          id: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'string', description: 'Comma-separated tags' },
          content: { type: 'string' },
          mode: { type: 'string', description: 'append (default for user/memory) or replace' },
        },
        required: ['target', 'content'],
      },
      run: async ({ target, domain, id, title, tags, content, mode }) => {
        const blocked = await requireStore();
        if (blocked) return blocked;
        const name = String(target).toLowerCase();
        const tagList = splitTags(tags);
        if (name === 'user') {
          const written =
            mode === 'replace' ? await store.writeUser(content) : await store.appendUser(content);
          return stringify({ ok: true, target: 'user', ...written });
        }
        if (name === 'memory') {
          const written =
            mode === 'replace' ? await store.writeMemory(content) : await store.appendMemory(content);
          return stringify({ ok: true, target: 'memory', ...written });
        }
        if (name === 'node') {
          if (!domain) return 'knowledge_write target=node needs a domain slug.';
          const node = await store.addNode(domain, { id, title, tags: tagList, body: content });
          return stringify({ ok: true, target: 'node', node });
        }
        if (name === 'tacit') {
          const note = await store.addTacit(domain, { id, title, tags: tagList, body: content });
          return stringify({ ok: true, target: 'tacit', note });
        }
        if (name === 'inbox') {
          const note = await store.addTacit(null, {
            id,
            title,
            tags: tagList,
            body: content,
            inbox: true,
          });
          return stringify({ ok: true, target: 'inbox', note });
        }
        return `Unknown knowledge_write target "${target}". Use user, memory, node, tacit, or inbox.`;
      },
    },
    {
      name: 'knowledge_reflect',
      description:
        'Propose (do not silently write) a tacit note from recent user/assistant text. ' +
        'The operator accepts with /reflect accept or toris knowledge reflect --write.',
      inputSchema: {
        type: 'object',
        properties: {
          user: { type: 'string' },
          assistant: { type: 'string' },
          domain: { type: 'string' },
        },
      },
      run: async ({ user, assistant, domain } = {}) => {
        const result = proposeReflections({ user, assistant, domain });
        return renderReflection(result);
      },
    },
  ];
}
