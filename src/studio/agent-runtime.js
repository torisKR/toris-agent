import { loadConfig } from '../core/config.js';
import {
  listSurfaceAgents,
  loadAgentCatalogue,
  resolveSurfaceAgent,
  SURFACE_AGENT,
} from '../core/agents.js';
import { tuiAgentHint, studioAgentUrl } from '../core/access.js';
import {
  pickChatModel,
  assertChatUsable,
  cliBinFor,
  chatSystemPrompt,
} from '../core/chat-setup.js';
import { listProfiles, CLI_PROVIDERS } from '../core/models.js';
import { createProvider } from '../providers/index.js';
import { createChatSession } from '../core/chat.js';
import { createDefaultTools } from '../core/tools.js';
import {
  discoverSkills,
  skillSearchPaths,
  renderSkillBriefing,
  BUILTIN_SKILL_DIR,
} from '../core/skills.js';
import {
  KnowledgeStore,
  briefingForQuery,
  composeKnowledgeTurn,
  knowledgeAutoRetrieveEnabled,
  publicKnowledgeReceipt,
  retrieveForTurn,
} from '../core/knowledge/index.js';
import { HttpError } from './http.js';
import { composeAndroidTurnMessage, loadAndroidEvidence } from './android-api.js';
import { composeDesignTurnMessage, listDesignCaptures, normalizeDesignCapture } from './design.js';
import { formatPatchReviewMessage } from './patch-view.js';

const MAX_MESSAGE_CHARS = 8_000;
const MAX_HISTORY = 40;
const MAX_TURN_CHARS = 40_000;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    if (item.role !== 'user' && item.role !== 'assistant') return [];
    if (typeof item.content !== 'string') return [];
    return [{ role: item.role, content: item.content.slice(0, MAX_MESSAGE_CHARS) }];
  });
}

export async function inspectAgentRuntime({ home, cwd, loadConfigFn = loadConfig } = {}) {
  const tui = 'toris';
  const gui = studioAgentUrl();
  let catalogue;
  let agentsError = null;
  try {
    catalogue = await loadAgentCatalogue({ home, projectPath: cwd });
  } catch (error) {
    agentsError = error.message;
    catalogue = undefined;
  }
  const agents = listSurfaceAgents(undefined, catalogue);
  const agent = catalogue?.surface ?? SURFACE_AGENT;
  try {
    const { config, exists } = await loadConfigFn(home);
    if (!exists || listProfiles(config).length === 0) {
      return {
        ready: false,
        reason: '모델 프로필이 없습니다. 터미널에서 `toris connect`를 실행하세요.',
        tui: 'toris connect',
        gui,
        agent,
        agents,
        catalogue,
        agentsError,
        config,
      };
    }
    return {
      ready: true,
      reason: null,
      tui,
      gui,
      agent,
      agents,
      catalogue,
      agentsError,
      config,
    };
  } catch (error) {
    return {
      ready: false,
      reason: error.message,
      tui: 'toris doctor',
      gui,
      agent,
      agents,
      catalogue,
      agentsError,
      config: null,
    };
  }
}

export function publicAgentStatus(status, agentId) {
  let agent = status.agent || SURFACE_AGENT;
  try {
    agent = resolveSurfaceAgent(agentId, status.catalogue);
  } catch {
    agent = status.agent || SURFACE_AGENT;
  }
  return {
    ready: status.ready,
    reason: status.reason,
    tui: tuiAgentHint(agent.id),
    gui: status.gui,
    agent,
    agents: status.agents,
    ...(status.agentsError ? { agentsError: status.agentsError } : {}),
  };
}

/**
 * One chat turn for the Studio GUI. Tools auto-approve: sending from the
 * local page is already an explicit action, matching a TUI `/yes` click.
 */
async function resolveDesignCaptures(options) {
  const captures = [];
  const seen = new Set();
  const remember = (record) => {
    if (!record) return;
    const key = record.id || `${record.url}|${record.selector}|${captures.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    captures.push(record);
  };

  if (options.tray) {
    if (!options.loadTray) throw new HttpError(400, 'design tray is not available');
    const tray = await options.loadTray();
    for (const item of tray?.items || []) remember(item);
  }

  const ids = [
    ...(options.designId ? [options.designId] : []),
    ...(Array.isArray(options.designIds) ? options.designIds : []),
  ];
  for (const id of ids) {
    if (!options.loadDesign) throw new HttpError(400, 'designId is not available');
    const capture = await options.loadDesign(id);
    if (!capture) throw new HttpError(404, 'design capture not found');
    remember(capture);
  }

  const payloads = [
    ...(options.design ? [options.design] : []),
    ...(Array.isArray(options.designs) ? options.designs : []),
  ];
  for (const payload of payloads) {
    let capture;
    try {
      capture = normalizeDesignCapture(payload);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    if (options.saveDesign) capture = await options.saveDesign(capture);
    remember(capture);
  }
  return listDesignCaptures(captures);
}

async function resolveAndroidEvidence(options) {
  if (Array.isArray(options.androidEvidence) && options.androidEvidence.length > 0) {
    return options.androidEvidence.filter((item) => item && typeof item === 'object');
  }
  const rels = [
    ...(Array.isArray(options.android?.artifacts) ? options.android.artifacts : []),
    ...(Array.isArray(options.androidArtifacts) ? options.androidArtifacts : []),
  ];
  if (rels.length === 0) return [];
  const load = options.loadAndroidEvidence || ((paths) => loadAndroidEvidence(options.home, paths));
  return load(rels);
}

export async function runAgentTurn(options) {
  const message = String(options.message ?? '').trim();
  const hasDesign = Boolean(options.design || options.designId || options.tray || options.designIds?.length || options.designs?.length);
  const hasPatchReview = Boolean(options.patchReview);
  const androidEvidence = await resolveAndroidEvidence(options);
  const hasAndroid = androidEvidence.length > 0;
  if (!message && !hasDesign && !hasPatchReview && !hasAndroid) throw new HttpError(400, 'message is required');
  if (message.length > MAX_MESSAGE_CHARS) throw new HttpError(400, 'message is too long');

  let catalogue = options.catalogue;
  if (!catalogue) {
    try {
      catalogue = await loadAgentCatalogue({ home: options.home, projectPath: options.cwd });
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  }
  let agent;
  try {
    agent = resolveSurfaceAgent(options.agent, catalogue);
  } catch (error) {
    throw new HttpError(400, error.message);
  }

  const status = options.status || (await inspectAgentRuntime({ home: options.home }));
  if (!status.ready || !status.config) throw new HttpError(409, status.reason);

  const captures = await resolveDesignCaptures(options);
  const fallback = hasAndroid && captures.length === 0
    ? 'Inspect the attached Android device evidence.'
    : captures.length > 1
      ? 'Inspect and fix the selected UI elements.'
      : 'Inspect and fix the selected UI element.';
  let composed = hasPatchReview
    ? formatPatchReviewMessage({
        patch: options.patchReview.patch,
        diff: options.patchReview.diff,
        note: message,
        hunk: options.patchReview.hunk,
      })
    : composeDesignTurnMessage(message || fallback, captures);
  if (hasAndroid) composed = composeAndroidTurnMessage(composed, androidEvidence);
  if (composed.length > MAX_TURN_CHARS) throw new HttpError(400, 'attachment is too large');

  const config = status.config;
  const resolved = pickChatModel(config, options.profile);
  assertChatUsable(resolved, config);
  const cliBacked = CLI_PROVIDERS.includes(resolved.provider);
  const cwd = options.cwd || process.cwd();
  const knowledgeSession = { activeDomains: [] };
  const knowledgeStore = new KnowledgeStore({ home: options.home, projectPath: cwd });
  const autoRetrieve = knowledgeAutoRetrieveEnabled(config);
  const tools = cliBacked
    ? []
    : createDefaultTools({ cwd, home: options.home, knowledge: knowledgeSession });
  const { skills } = cliBacked
    ? { skills: [] }
    : await discoverSkills(
        skillSearchPaths({ builtinDir: BUILTIN_SKILL_DIR, home: options.home, projectPath: cwd }),
      );
  const knowledgeBriefing =
    cliBacked || !autoRetrieve
      ? ''
      : await briefingForQuery(knowledgeStore, '', knowledgeSession, { includeProfile: true });
  const retrieved = autoRetrieve
    ? await retrieveForTurn(knowledgeStore, {
        query: composed,
        history: options.history,
        session: knowledgeSession,
        includeProfile: cliBacked,
      })
    : { enabled: false, retrieved: [], briefing: '' };
  const userMessage = retrieved.briefing ? composeKnowledgeTurn(composed, retrieved.briefing) : composed;
  const events = [];
  const onEvent = (evt) => {
    events.push(evt);
    options.onEvent?.(evt);
  };
  const provider = createProvider(resolved, {
    bins: {
      'claude-cli': cliBinFor('claude-cli', config),
      'codex-cli': cliBinFor('codex-cli', config),
    },
    timeoutMs: config.providerTimeoutMs,
    cwd,
    warm: false,
  });
  try {
    const session = createChatSession({
      provider,
      model: resolved.model,
      system: chatSystemPrompt({
        agent,
        briefing: renderSkillBriefing(skills),
        knowledgeBriefing,
        cliBacked,
      }),
      tools,
      maxTokens: resolved.maxTokens ?? undefined,
      approve: async () => true,
      onEvent,
    });
    session.reset(sanitizeHistory(options.history));
    const result = await session.send(userMessage, { signal: options.signal });
    return {
      ok: true,
      agent,
      profile: resolved.profile,
      provider: resolved.provider,
      model: resolved.model,
      text: result.text,
      usage: result.usage,
      events,
      knowledge: publicKnowledgeReceipt(retrieved),
      tui: tuiAgentHint(agent.id),
      design: captures[0]
        ? { id: captures[0].id || null, url: captures[0].url, selector: captures[0].selector }
        : null,
      designs: captures.map((item) => ({
        id: item.id || null,
        url: item.url,
        selector: item.selector,
        note: item.note || '',
      })),
      android: androidEvidence.map((item) => ({
        rel: item.rel || null,
        path: item.path || null,
        image: Boolean(item.image),
      })),
    };
  } finally {
    provider.dispose?.();
  }
}
