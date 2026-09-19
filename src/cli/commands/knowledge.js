import { readFile } from 'node:fs/promises';

import { EXIT, UsageError } from '../../core/errors.js';
import { Store } from '../../core/store.js';
import {
  KnowledgeStore,
  searchIndex,
  proposeReflections,
  proposeFromRun,
  looksLikeRunId,
  renderReflection,
  acceptReflections,
  STARTER_DOMAIN_SLUGS,
  EDGE_KINDS,
  listKnowledgePacks,
  installKnowledgePack,
} from '../../core/knowledge/index.js';
import { printJson, line, table, keyValues, c } from '../output.js';

const ACTIONS = new Set([
  'init',
  'status',
  'domains',
  'domain',
  'node',
  'tacit',
  'search',
  'reflect',
  'memory',
  'user',
  'pack',
]);

function storeOf(ctx, flags) {
  const projectPath =
    flags.project === true || flags.project === undefined
      ? ctx.cwd
      : typeof flags.project === 'string'
        ? flags.project
        : ctx.cwd;
  return new KnowledgeStore({
    home: ctx.home,
    projectPath: flags['project-knowledge'] ? projectPath : ctx.cwd,
  });
}

async function ensure(store, { seed = false } = {}) {
  const status = await store.status();
  if (!status.ok || seed) return store.init({ seed: seed || !status.ok });
  return status;
}

function flagString(flags, ...keys) {
  for (const key of keys) {
    if (typeof flags[key] === 'string') return flags[key];
  }
  return undefined;
}

function printStatus(status) {
  line(c.bold('toris knowledge'));
  line();
  keyValues([
    ['root', status.root],
    ['project', status.projectRoot || '—'],
    ['domains', String(status.domains)],
    ['inbox', String(status.inbox)],
    ['USER.md', `${status.userBytes}/${status.userLimit} bytes`],
    ['MEMORY.md', `${status.memoryBytes}/${status.memoryLimit} bytes`],
  ]);
  if (status.domainSlugs?.length) {
    line();
    line(c.dim(`  ${status.domainSlugs.join(', ')}`));
  }
}

export async function cmdKnowledge(ctx, positionals, flags) {
  const action = positionals[0] || 'status';
  if (!ACTIONS.has(action)) {
    throw new UsageError(
      `Unknown knowledge subcommand "${action}". Use init|status|domains|node|tacit|search|reflect|memory|pack.`,
    );
  }
  const store = storeOf(ctx, flags);
  const rest = positionals.slice(1);

  if (action === 'init') return cmdInit(ctx, store);
  if (action === 'status') return cmdStatus(ctx, store);
  if (action === 'domains' || action === 'domain') return cmdDomains(ctx, store, rest, flags);
  if (action === 'node') return cmdNode(ctx, store, rest, flags);
  if (action === 'tacit') return cmdTacit(ctx, store, rest, flags);
  if (action === 'search') return cmdSearch(ctx, store, rest, flags);
  if (action === 'reflect') return cmdReflect(ctx, store, rest, flags);
  if (action === 'memory' || action === 'user') return cmdMemory(ctx, store, action, rest, flags);
  if (action === 'pack') return cmdPack(ctx, store, rest, flags);
  throw new UsageError(`Unknown knowledge subcommand "${action}".`);
}

async function cmdInit(ctx, store) {
  const status = await store.init({ seed: true });
  if (ctx.json) {
    printJson({ ok: true, ...status, starters: STARTER_DOMAIN_SLUGS });
    return EXIT.OK;
  }
  line(`${c.green('+')} Knowledge store ready`);
  printStatus(status);
  line();
  line(`Next: ${c.cyan('toris knowledge search flutter')} or ${c.cyan('toris knowledge domains list')}`);
  return EXIT.OK;
}

async function cmdStatus(ctx, store) {
  const status = await store.status();
  if (ctx.json) {
    printJson(status);
    return EXIT.OK;
  }
  if (!status.ok) {
    line(c.yellow('Knowledge store not created yet.'));
    line(`Run ${c.cyan('toris knowledge init')} to seed USER.md, MEMORY.md, and starter domains.`);
    return EXIT.OK;
  }
  printStatus(status);
  return EXIT.OK;
}

async function cmdDomains(ctx, store, rest, flags) {
  await ensure(store);
  const sub = rest[0] || 'list';
  if (sub === 'list') {
    const domains = await store.listDomains();
    if (ctx.json) {
      printJson({ domains });
      return EXIT.OK;
    }
    line(c.bold(`Domains (${domains.length})`));
    line();
    table(
      ['SLUG', 'SOURCE', 'NODES', 'TACIT', 'EDGES', 'TITLE'],
      domains.map((d) => [d.slug, d.source, d.nodeCount, d.tacitCount, d.edgeCount, d.title]),
    );
    return EXIT.OK;
  }
  if (sub === 'add') {
    const slug = rest[1] || flagString(flags, 'slug');
    if (!slug) throw new UsageError('Usage: toris knowledge domains add <slug> [--title] [--when]');
    const domain = await store.addDomain({
      slug,
      title: flagString(flags, 'title') || slug,
      when: flagString(flags, 'when'),
      anti: flagString(flags, 'anti'),
      body: flagString(flags, 'body'),
      source: flags.project ? 'project' : 'home',
    });
    if (ctx.json) {
      printJson({ ok: true, domain });
      return EXIT.OK;
    }
    line(`${c.green('+')} Domain ${c.bold(domain.slug)}`);
    return EXIT.OK;
  }
  if (sub === 'inspect') {
    const slug = rest[1];
    if (!slug) throw new UsageError('Usage: toris knowledge domains inspect <slug>');
    const domain = await store.inspectDomain(slug);
    if (ctx.json) {
      printJson({ domain });
      return EXIT.OK;
    }
    line(c.bold(domain.title));
    line();
    keyValues([
      ['slug', domain.slug],
      ['source', domain.source],
      ['when', domain.when || '—'],
      ['anti', domain.anti || '—'],
      ['skills', domain.skills?.join(', ') || '—'],
      ['nodes', String(domain.nodeCount)],
      ['edges', String(domain.edgeCount)],
      ['cycles', domain.cycles?.length ? domain.cycles.map((c) => c.join(' → ')).join('; ') : 'none'],
    ]);
    if (domain.nodes?.length) {
      line();
      table(
        ['NODE', 'TAGS', 'TITLE'],
        domain.nodes.map((n) => [n.id, n.tags.join(', '), n.title]),
      );
    }
    if (domain.edges?.length) {
      line();
      table(
        ['FROM', 'KIND', 'TO'],
        domain.edges.map((e) => [e.from, e.kind, e.to]),
      );
    }
    return EXIT.OK;
  }
  throw new UsageError('Usage: toris knowledge domains list|add|inspect');
}

async function cmdNode(ctx, store, rest, flags) {
  await ensure(store);
  const sub = rest[0];
  if (!sub) throw new UsageError('Usage: toris knowledge node add|list|get|link');
  if (sub === 'list') {
    const domain = rest[1];
    if (!domain) throw new UsageError('Usage: toris knowledge node list <domain>');
    const nodes = await store.listNodes(domain);
    if (ctx.json) {
      printJson({ domain, nodes });
      return EXIT.OK;
    }
    table(
      ['ID', 'TAGS', 'TITLE'],
      nodes.map((n) => [n.id, n.tags.join(', '), n.title]),
    );
    return EXIT.OK;
  }
  if (sub === 'get') {
    const domain = rest[1];
    const id = rest[2];
    if (!domain || !id) throw new UsageError('Usage: toris knowledge node get <domain> <id>');
    const node = await store.getNode(domain, id);
    if (ctx.json) {
      printJson({ node });
      return EXIT.OK;
    }
    line(c.bold(node.title));
    line();
    line(node.body);
    return EXIT.OK;
  }
  if (sub === 'add') {
    const domain = rest[1];
    if (!domain) throw new UsageError('Usage: toris knowledge node add <domain> --title <title> [--body] [--tags]');
    const title = flagString(flags, 'title') || rest[2];
    if (!title) throw new UsageError('node add needs --title');
    const node = await store.addNode(domain, {
      id: flagString(flags, 'id'),
      title,
      tags: flagString(flags, 'tags'),
      body: flagString(flags, 'body') || rest.slice(title === rest[2] ? 3 : 2).join(' '),
      source: flags.project ? 'project' : 'home',
    });
    if (ctx.json) {
      printJson({ ok: true, node });
      return EXIT.OK;
    }
    line(`${c.green('+')} Node ${c.bold(`${domain}/${node.id}`)}`);
    return EXIT.OK;
  }
  if (sub === 'link') {
    const domain = rest[1];
    const from = rest[2];
    const to = rest[3];
    if (!domain || !from || !to) {
      throw new UsageError(
        `Usage: toris knowledge node link <domain> <from> <to> [--kind ${EDGE_KINDS.join('|')}]`,
      );
    }
    const result = await store.link(domain, {
      from,
      to,
      kind: flagString(flags, 'kind') || 'supports',
      source: flags.project ? 'project' : 'home',
    });
    if (ctx.json) {
      printJson({ ok: true, ...result });
      return EXIT.OK;
    }
    line(`${c.green('+')} ${from} -[${result.added.kind}]-> ${to}`);
    return EXIT.OK;
  }
  throw new UsageError('Usage: toris knowledge node add|list|get|link');
}

async function cmdTacit(ctx, store, rest, flags) {
  await ensure(store);
  const sub = rest[0];
  if (sub === 'add') {
    const domain = rest[1] && !rest[1].startsWith('-') ? rest[1] : flagString(flags, 'domain');
    const title = flagString(flags, 'title') || rest[2];
    if (!title) throw new UsageError('Usage: toris knowledge tacit add [domain] --title <title> [--body]');
    const note = await store.addTacit(domain, {
      title,
      tags: flagString(flags, 'tags'),
      body: flagString(flags, 'body'),
      inbox: Boolean(flags.inbox) || !domain,
    });
    if (ctx.json) {
      printJson({ ok: true, note });
      return EXIT.OK;
    }
    line(`${c.green('+')} Tacit ${note.kind === 'inbox' ? 'inbox ' : ''}${c.bold(note.id)}`);
    return EXIT.OK;
  }
  if (sub === 'promote') {
    const id = rest[1];
    const domain = flagString(flags, 'domain') || rest[2];
    if (!id || !domain) throw new UsageError('Usage: toris knowledge tacit promote <id> --domain <slug>');
    const note = await store.promoteTacit(id, { domain });
    if (ctx.json) {
      printJson({ ok: true, note });
      return EXIT.OK;
    }
    line(`${c.green('+')} Promoted ${c.bold(id)} → ${domain}/tacit`);
    return EXIT.OK;
  }
  if (sub === 'list' || !sub) {
    const domain = rest[1] || flagString(flags, 'domain');
    const inbox = await store.listInbox();
    const tacit = domain ? await store.listTacit(domain) : [];
    if (ctx.json) {
      printJson({ inbox, tacit });
      return EXIT.OK;
    }
    line(c.bold(`Inbox (${inbox.length})`));
    table(
      ['ID', 'TITLE'],
      inbox.map((n) => [n.id, n.title]),
    );
    if (domain) {
      line();
      line(c.bold(`${domain} tacit (${tacit.length})`));
      table(
        ['ID', 'TITLE'],
        tacit.map((n) => [n.id, n.title]),
      );
    }
    return EXIT.OK;
  }
  throw new UsageError('Usage: toris knowledge tacit add|promote|list');
}

async function cmdSearch(ctx, store, rest, flags) {
  await ensure(store);
  const query = rest.join(' ').trim() || flagString(flags, 'query', 'q');
  if (!query) throw new UsageError('Usage: toris knowledge search <query>');
  const index = await store.loadIndex();
  const hits = searchIndex(index, query, {
    domain: flagString(flags, 'domain'),
    kind: flagString(flags, 'kind'),
    limit: flags.limit ? Number(flags.limit) : 12,
  });
  if (ctx.json) {
    printJson({ query, hits });
    return EXIT.OK;
  }
  line(c.bold(`Search (${hits.length})`));
  line();
  table(
    ['SCORE', 'KIND', 'ID', 'TITLE'],
    hits.map((h) => [h.score, h.kind, h.domain ? `${h.domain}/${h.id}` : h.id, h.title]),
  );
  return EXIT.OK;
}

async function cmdReflect(ctx, store, rest, flags) {
  await ensure(store);
  const result = await resolveReflectProposal(ctx, store, rest, flags);
  // Default and --json are propose-only. --write / --yes is the operator accept.
  // No proposals (including failed verification) never writes, even with --write.
  if ((!flags.write && !flags.yes) || result.proposals.length === 0) {
    if (ctx.json) {
      printJson({ ok: true, written: false, ...result });
      return EXIT.OK;
    }
    line(renderReflection(result));
    return EXIT.OK;
  }
  const written = await acceptReflections(store, result);
  if (ctx.json) {
    printJson({ ok: true, written: true, notes: written, ...result });
    return EXIT.OK;
  }
  line(`${c.green('+')} Wrote ${written.length} tacit note(s)`);
  for (const note of written) line(`  ${note.path}`);
  return EXIT.OK;
}

async function resolveReflectProposal(ctx, store, rest, flags) {
  const domain = flagString(flags, 'domain');
  const domains = await store.listDomains();
  const runId = flagString(flags, 'from-run', 'run') || (looksLikeRunId(rest[0]) ? rest[0] : undefined);
  let text = flagString(flags, 'text');
  if (typeof flags.file === 'string') {
    text = await readFile(flags.file, 'utf8');
  }
  if (!text && !runId) {
    const leftover = rest.join(' ').trim();
    if (leftover && !looksLikeRunId(leftover)) text = leftover;
  }
  if (text && !runId) {
    return proposeReflections({ user: text, domain, domains });
  }
  if (!runId && !text && !ctx.store && !ctx.home) {
    throw new UsageError(
      'Usage: toris knowledge reflect [runId] [--from-run <id>] [--text "..."] [--file <path>] [--write] [--domain slug]',
    );
  }
  const runStore = ctx.store ?? new Store(ctx.home);
  return proposeFromRun(runStore, { runId, domain, domains });
}

async function cmdMemory(ctx, store, which, rest, flags) {
  await ensure(store);
  const sub = rest[0] || 'get';
  const reader = which === 'user' ? () => store.readUser() : () => store.readMemory();
  const writer = which === 'user' ? (text) => store.writeUser(text) : (text) => store.writeMemory(text);
  const append = which === 'user' ? (text) => store.appendUser(text) : (text) => store.appendMemory(text);
  if (sub === 'get') {
    const file = await reader();
    if (ctx.json) {
      printJson(file);
      return EXIT.OK;
    }
    line(file.text);
    return EXIT.OK;
  }
  if (sub === 'append' || sub === 'add') {
    const chunk = flagString(flags, 'text', 'body') || rest.slice(1).join(' ');
    if (!chunk) throw new UsageError(`Usage: toris knowledge ${which} append --text "..."`);
    const written = await append(chunk);
    if (ctx.json) {
      printJson({ ok: true, ...written });
      return EXIT.OK;
    }
    line(`${c.green('+')} Appended to ${which === 'user' ? 'USER.md' : 'MEMORY.md'} (${written.bytes} bytes)`);
    return EXIT.OK;
  }
  if (sub === 'set') {
    const chunk = flagString(flags, 'text', 'body') || rest.slice(1).join(' ');
    if (!chunk) throw new UsageError(`Usage: toris knowledge ${which} set --text "..."`);
    const written = await writer(chunk);
    if (ctx.json) {
      printJson({ ok: true, ...written });
      return EXIT.OK;
    }
    line(`${c.green('+')} Wrote ${which === 'user' ? 'USER.md' : 'MEMORY.md'}`);
    return EXIT.OK;
  }
  throw new UsageError(`Usage: toris knowledge ${which} get|append|set`);
}

async function cmdPack(ctx, store, rest, flags) {
  const sub = rest[0] || 'list';
  if (sub === 'list') {
    const listed = await listKnowledgePacks(store);
    if (ctx.json) {
      printJson({ ok: true, ...listed });
      return EXIT.OK;
    }
    line(c.bold(`Starter packs (${listed.packs.length})`));
    line();
    table(
      ['SLUG', 'INSTALLED', 'NODES', 'EDGES', 'TITLE'],
      listed.packs.map((pack) => [
        pack.slug,
        pack.installed ? 'yes' : 'no',
        pack.nodeCount,
        pack.edgeCount,
        pack.title,
      ]),
    );
    line();
    line(`Install one: ${c.cyan('toris knowledge pack install <slug>')}`);
    return EXIT.OK;
  }
  if (sub === 'install') {
    const slug = rest[1];
    if (!slug) throw new UsageError('Usage: toris knowledge pack install <slug> [--force]');
    const result = await installKnowledgePack(store, slug, { force: flags.force === true });
    if (ctx.json) {
      printJson(result);
      return EXIT.OK;
    }
    line(`${c.green('+')} Pack ${c.bold(result.slug)} (${result.nodeCount} nodes, ${result.edgeCount} edges)`);
    return EXIT.OK;
  }
  throw new UsageError('Usage: toris knowledge pack list|install');
}

cmdKnowledge.handlesFirstRun = true;
