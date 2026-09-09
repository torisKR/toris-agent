/**
 * toris desktop bridge — a long-lived NDJSON sidecar.
 *
 * The Tauri (Rust) backend spawns this script with `node` and talks to it over
 * stdio: one JSON object per line in, one JSON event per line out. It reuses the
 * REAL toris chat engine (`createChatSession`), providers and tools rather than
 * reimplementing model calls, and adds a key-free Demo provider so the whole UI
 * works with no API key.
 *
 * PROTOCOL
 * --------
 * stdin  (one JSON object per line):
 *   { "type":"send", "conversationId":string, "messageId":string, "text":string,
 *     "profileId":string, "presetId":string, "autonomy":"L1".."L5" }
 *   { "type":"approval", "callId":string, "allow":boolean }
 *   { "type":"abort", "conversationId":string }
 *   { "type":"reset", "conversationId":string }
 *
 * stdout (one JSON event per line):
 *   { "type":"ready", "presets":[...], "profiles":[...], "keys":{...}, "defaultAutonomy":"L3" }
 *   { "type":"text", "conversationId", "messageId", "delta":string }
 *   { "type":"tool-approval-request", "conversationId", "messageId", "callId", "name", "input" }
 *   { "type":"tool-start" | "tool-end" | "tool-error" | "tool-denied", ... }
 *   { "type":"turn-end", "conversationId", "messageId", "text", "usage", "provider", "model" }
 *   { "type":"error", "conversationId", "messageId", "message", "code" }
 */

import { createInterface } from 'node:readline';
import { stdin, stdout, stderr } from 'node:process';

import { createChatSession } from '../core/chat.js';
import { createDefaultTools } from '../core/tools.js';
import { resolveHome, loadConfig } from '../core/config.js';
import { listProfiles, resolveProfile, whichApiKey, apiKeyEnvVar } from '../core/models.js';
import { API_PROVIDERS, CLI_PROVIDERS } from '../core/models.js';
import { createProvider } from '../providers/index.js';
import { detectBinary } from '../core/providers.js';
import { autoApprovesTools, resolveAutonomy } from '../core/autonomy.js';
import { getPreset, listPresetsForUi, DEFAULT_PRESET_ID } from './presets.js';
import { createDemoProvider } from './demo-provider.js';

const DEMO_PROFILE_ID = 'demo';

/** Write one NDJSON event to stdout. stdout is reserved for the protocol. */
function emit(obj) {
  stdout.write(`${JSON.stringify(obj)}\n`);
}

/** Human-readable diagnostics go to stderr so they never corrupt the protocol. */
function logErr(...args) {
  stderr.write(`[toris-bridge] ${args.join(' ')}\n`);
}

let idCounter = 0;
const nextId = (p) => `${p}_${Date.now().toString(36)}_${(idCounter += 1)}`;

/**
 * Per-conversation state. Sessions are rebuilt (never mutated) when the profile,
 * preset or autonomy changes, replaying the provider-neutral transcript so
 * switching a mode mid-thread never rewrites history.
 * @type {Map<string, {session:object, signature:string, provider:object, resolved:object, generation:AbortController|null}>}
 */
const conversations = new Map();

/** callId -> resolve(boolean), for tool approvals awaiting the UI's decision. */
const pendingApprovals = new Map();

let CONFIG = null;
let HOME = null;

/**
 * Runtime overrides supplied by the Settings UI. Kept in memory only (never
 * written to disk): API keys entered at runtime and ad-hoc profiles the user
 * defines (provider + a model id they type — so no model IDs are pinned in
 * product code, matching the toris config ethos).
 */
const overrides = { keys: /** @type {Record<string,string>} */ ({}), profiles: {} };

/** process.env plus any keys the user entered at runtime. */
function effectiveEnv() {
  return { ...process.env, ...overrides.keys };
}

/** CONFIG with runtime profiles merged into models.profiles. */
function effectiveConfig() {
  if (Object.keys(overrides.profiles).length === 0) return CONFIG;
  return {
    ...CONFIG,
    models: {
      ...CONFIG.models,
      profiles: { ...CONFIG.models.profiles, ...overrides.profiles },
    },
  };
}

/** Which providers currently have a usable key/binary, for the settings UI. */
function providerAvailability(config) {
  const env = effectiveEnv();
  const keys = {};
  for (const provider of API_PROVIDERS) keys[provider] = Boolean(whichApiKey(provider, env));
  const clis = {};
  for (const provider of CLI_PROVIDERS) {
    const bin = provider === 'claude-cli' ? 'claude' : 'codex';
    clis[provider] = Boolean(detectBinary(config?.providers?.[bin]?.bin ?? bin));
  }
  return { api: keys, cli: clis };
}

/** Profiles the user has configured, plus the always-present Demo option. */
function profilesForUi(config) {
  const configured = listProfiles(config).map((name) => {
    const p = config.models.profiles[name];
    let usable = false;
    try {
      const resolved = resolveProfile(name, config);
      usable = providerUsable(resolved, config);
    } catch {
      usable = false;
    }
    return { id: name, provider: p.provider, model: p.model ?? 'auto', usable, demo: false };
  });
  return [
    { id: DEMO_PROFILE_ID, provider: 'demo', model: 'demo', usable: true, demo: true },
    ...configured,
  ];
}

/** True when a resolved profile could actually be invoked right now. */
function providerUsable(resolved, config) {
  if (CLI_PROVIDERS.includes(resolved.provider)) {
    const bin = resolved.provider === 'claude-cli' ? 'claude' : 'codex';
    return Boolean(detectBinary(config?.providers?.[bin]?.bin ?? bin));
  }
  if (API_PROVIDERS.includes(resolved.provider)) {
    return (
      Boolean(whichApiKey(resolved.provider, effectiveEnv())) &&
      resolved.model &&
      resolved.model !== 'auto'
    );
  }
  return false;
}

/** Build the transport for a requested profile, falling back to Demo. */
function buildProvider(profileId, config) {
  if (!profileId || profileId === DEMO_PROFILE_ID) {
    return { provider: createDemoProvider(), resolved: { profile: DEMO_PROFILE_ID, provider: 'demo', model: 'demo', maxTokens: null }, demo: true };
  }
  let resolved;
  try {
    resolved = resolveProfile(profileId, config);
  } catch (err) {
    logErr(`profile "${profileId}" did not resolve (${err.message}); using Demo.`);
    return { provider: createDemoProvider(), resolved: { profile: DEMO_PROFILE_ID, provider: 'demo', model: 'demo', maxTokens: null }, demo: true, note: err.message };
  }
  if (!providerUsable(resolved, config)) {
    return {
      provider: createDemoProvider(),
      resolved: { profile: DEMO_PROFILE_ID, provider: 'demo', model: 'demo', maxTokens: null },
      demo: true,
      note: `Profile "${profileId}" (${resolved.provider}) is not usable yet — no key/binary. Falling back to Demo.`,
    };
  }
  const provider = createProvider(resolved, {
    env: effectiveEnv(),
    bins: {
      'claude-cli': config?.providers?.claude?.bin ?? 'claude',
      'codex-cli': config?.providers?.codex?.bin ?? 'codex',
    },
    timeoutMs: config?.providerTimeoutMs,
  });
  return { provider, resolved, demo: false };
}

/** Ensure a conversation has a session matching the requested config. */
function ensureSession(req) {
  const { conversationId } = req;
  const presetId = req.presetId ?? DEFAULT_PRESET_ID;
  const profileId = req.profileId ?? DEMO_PROFILE_ID;
  const autonomy = resolveAutonomy(req.autonomy ?? CONFIG.defaultAutonomy ?? 'L2').level;
  const signature = `${profileId}|${presetId}|${autonomy}`;

  const existing = conversations.get(conversationId);
  if (existing && existing.signature === signature) return existing;

  const preset = getPreset(presetId);
  const { provider, resolved, demo, note } = buildProvider(profileId, effectiveConfig());
  if (note) emit({ type: 'notice', conversationId, message: note });

  const tools = preset.tools ? createDefaultTools({ cwd: process.env.TORIS_DESKTOP_CWD || process.cwd() }) : [];
  const autoApprove = autoApprovesTools(autonomy);

  const approve = ({ name, input }) => {
    if (autoApprove) return Promise.resolve(true);
    const callId = nextId('appr');
    const messageId = activeMessage.get(conversationId) ?? null;
    emit({ type: 'tool-approval-request', conversationId, messageId, callId, name, input });
    return new Promise((resolvePromise) => pendingApprovals.set(callId, resolvePromise));
  };

  const onEvent = (evt) => forwardEngineEvent(conversationId, evt);

  const session = createChatSession({
    provider,
    model: resolved.model,
    system: preset.system,
    tools,
    maxTokens: resolved.maxTokens ?? undefined,
    approve,
    onEvent,
  });

  // Preserve the transcript when only the profile/preset/autonomy changed.
  if (existing) session.reset(existing.session.history);

  const record = { session, signature, provider, resolved, demo, generation: null };
  conversations.set(conversationId, record);
  emit({
    type: 'session',
    conversationId,
    profileId,
    presetId,
    autonomy,
    provider: resolved.provider,
    model: resolved.model,
    demo,
  });
  return record;
}

/** The active messageId per conversation, so engine events can be tagged. */
const activeMessage = new Map();

function forwardEngineEvent(conversationId, evt) {
  const messageId = activeMessage.get(conversationId) ?? null;
  if (evt.type === 'text') {
    emit({ type: 'text', conversationId, messageId, delta: evt.delta });
  } else if (evt.type === 'tool-start') {
    emit({ type: 'tool-start', conversationId, messageId, name: evt.name, input: evt.input });
  } else if (evt.type === 'tool-end') {
    emit({ type: 'tool-end', conversationId, messageId, name: evt.name });
  } else if (evt.type === 'tool-error') {
    emit({ type: 'tool-error', conversationId, messageId, name: evt.name, error: evt.error });
  } else if (evt.type === 'tool-denied') {
    emit({ type: 'tool-denied', conversationId, messageId, name: evt.name });
  } else if (evt.type === 'turn-end') {
    // handled by the send() caller, which also has the final text
  }
}

async function handleSend(req) {
  const { conversationId, messageId, text } = req;
  if (!conversationId || !messageId || typeof text !== 'string') {
    emit({ type: 'error', conversationId, messageId, message: 'send needs conversationId, messageId and text', code: 'E_BAD_REQUEST' });
    return;
  }
  let record;
  try {
    record = ensureSession(req);
  } catch (err) {
    emit({ type: 'error', conversationId, messageId, message: err.message, code: err.code ?? 'E_SESSION' });
    return;
  }

  activeMessage.set(conversationId, messageId);
  const generation = new AbortController();
  record.generation = generation;
  emit({ type: 'turn-start', conversationId, messageId, provider: record.resolved.provider, model: record.resolved.model, demo: record.demo });

  try {
    const result = await record.session.send(text, { signal: generation.signal });
    emit({
      type: 'turn-end',
      conversationId,
      messageId,
      text: result.text,
      usage: result.usage,
      provider: record.resolved.provider,
      model: record.resolved.model,
      demo: record.demo,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
    emit({
      type: aborted ? 'aborted' : 'error',
      conversationId,
      messageId,
      message: aborted ? 'interrupted' : err.message,
      code: err.code ?? 'E_TURN',
    });
  } finally {
    record.generation = null;
    activeMessage.delete(conversationId);
  }
}

function handleApproval(req) {
  const resolvePromise = pendingApprovals.get(req.callId);
  if (!resolvePromise) {
    logErr(`approval for unknown callId ${req.callId}`);
    return;
  }
  pendingApprovals.delete(req.callId);
  resolvePromise(Boolean(req.allow));
}

function handleAbort(req) {
  const record = conversations.get(req.conversationId);
  record?.generation?.abort();
}

function handleReset(req) {
  const record = conversations.get(req.conversationId);
  record?.session.reset();
}

/** Re-send the profile/key snapshot after a settings change. */
function emitProviders() {
  emit({
    type: 'providers',
    profiles: profilesForUi(effectiveConfig()),
    keys: providerAvailability(effectiveConfig()),
    defaultAutonomy: CONFIG.defaultAutonomy ?? 'L3',
  });
}

/** Store (or clear) a runtime API key for a provider. Never persisted to disk. */
function handleSetKey(req) {
  const varName = apiKeyEnvVar(req.provider);
  if (!varName) {
    logErr(`set-key: unknown provider ${req.provider}`);
    return;
  }
  const key = typeof req.key === 'string' ? req.key.trim() : '';
  if (key) overrides.keys[varName] = key;
  else delete overrides.keys[varName];
  // Force affected sessions to rebuild with the new credentials.
  conversations.clear();
  emitProviders();
}

/** Define a runtime profile (provider + a model id the user typed). */
function handleAddProfile(req) {
  const { id, provider, model } = req;
  if (!id || !provider) {
    logErr('add-profile needs id and provider');
    return;
  }
  overrides.profiles[id] = { provider, model: model || 'auto' };
  conversations.clear();
  emitProviders();
}

async function dispatch(msg) {
  switch (msg.type) {
    case 'send':
      await handleSend(msg);
      break;
    case 'approval':
      handleApproval(msg);
      break;
    case 'abort':
      handleAbort(msg);
      break;
    case 'reset':
      handleReset(msg);
      break;
    case 'set-key':
      handleSetKey(msg);
      break;
    case 'add-profile':
      handleAddProfile(msg);
      break;
    case 'ping':
      emit({ type: 'pong' });
      break;
    default:
      logErr(`unknown message type: ${msg.type}`);
  }
}

async function main() {
  HOME = resolveHome(process.env.TORIS_HOME);
  try {
    const loaded = await loadConfig(HOME);
    CONFIG = loaded.config;
  } catch (err) {
    logErr(`config load failed (${err.message}); using defaults.`);
    const { DEFAULT_CONFIG } = await import('../core/config.js');
    CONFIG = DEFAULT_CONFIG;
  }

  emit({
    type: 'ready',
    home: HOME,
    presets: listPresetsForUi(),
    profiles: profilesForUi(CONFIG),
    keys: providerAvailability(CONFIG),
    defaultAutonomy: CONFIG.defaultAutonomy ?? 'L3',
    demoProfileId: DEMO_PROFILE_ID,
  });

  const rl = createInterface({ input: stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logErr(`could not parse line: ${trimmed.slice(0, 120)}`);
      return;
    }
    // Fire-and-forget; each command manages its own lifecycle and events.
    dispatch(msg).catch((err) => logErr(`dispatch error: ${err.stack || err.message}`));
  });
  rl.on('close', () => process.exit(0));
}

main().catch((err) => {
  logErr(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
