import { TorisError } from './errors.js';
import { agentRolePrompt, withAgentPrompt } from './agents.js';
import { detectBinary } from './providers.js';
import {
  resolveProfile,
  resolveRole,
  listProfiles,
  apiKeyEnvVar,
  readApiKey,
  AUTO_MODEL,
  API_PROVIDERS,
  CLI_PROVIDERS,
} from './models.js';

export const CHAT_SYSTEM_PROMPT = [
  "You are toris, a coding agent working inside a solo developer's repository.",
  'You have tools for reading, listing, writing files and running shell commands.',
  '',
  'Working rules:',
  '- Read a file before you edit it. Never guess its contents.',
  "- Verify your own work by running the project's tests or build.",
  '- Prefer the smallest change that actually solves the problem.',
  '- If a tool is denied, do not retry it. Explain the alternative.',
  '- Be concrete and brief. The operator is one person, not a committee.',
].join('\n');

/**
 * Pick the model for this chat: explicit profile, then the `chat` role in
 * routing, then a lone configured profile. Anything else is ambiguous.
 * @param {object} config
 * @param {string} [profileName]
 */
export function pickChatModel(config, profileName) {
  if (typeof profileName === 'string') return resolveProfile(profileName, config);

  const profiles = listProfiles(config);
  if (profiles.length === 0) {
    throw new TorisError(
      'No model profiles are configured, so there is nothing to chat with.\n' +
        'Run `toris connect` to pick a backend (installed claude/codex CLI, or an API key),\n' +
        'or add one to your config under models.profiles, for example:\n' +
        '  "models": {\n' +
        '    "profiles": { "main": { "provider": "claude-cli", "model": "auto" } },\n' +
        '    "routing":  { "chat": "main" }\n' +
        '  }\n' +
        `Providers available for chat: ${[...API_PROVIDERS, ...CLI_PROVIDERS].join(', ')}.`,
      'E_UNKNOWN_PROFILE',
    );
  }

  try {
    return resolveRole('chat', config);
  } catch {
    if (profiles.length === 1) return resolveProfile(profiles[0], config);
    throw new TorisError(
      `Several profiles exist (${profiles.join(', ')}) but none is routed to "chat".\n` +
        'Set models.routing.chat, or pass --profile <name>.',
      'E_UNKNOWN_PROFILE',
    );
  }
}

/** Map a CLI provider id onto its configured binary name. */
export function cliBinFor(provider, config) {
  const key = provider === 'claude-cli' ? 'claude' : 'codex';
  return config?.providers?.[key]?.bin ?? key;
}

/** Fail before the first token rather than after a confusing HTTP 401. */
export function assertChatUsable(resolved, config) {
  if (CLI_PROVIDERS.includes(resolved.provider)) {
    const bin = cliBinFor(resolved.provider, config);
    if (!detectBinary(bin)) {
      throw new TorisError(
        `Profile "${resolved.profile}" uses "${resolved.provider}", but the "${bin}" binary ` +
          'is not on PATH. Install it (or fix providers.' +
          `${resolved.provider === 'claude-cli' ? 'claude' : 'codex'}.bin) and log in first.`,
        'E_PROVIDER_CLI',
      );
    }
    return;
  }
  if (!API_PROVIDERS.includes(resolved.provider)) {
    throw new TorisError(
      `Profile "${resolved.profile}" uses provider "${resolved.provider}", which chat does not ` +
        `support. Chat needs one of: ${[...API_PROVIDERS, ...CLI_PROVIDERS].join(', ')}.`,
      'E_UNKNOWN_PROVIDER',
    );
  }
  if (!readApiKey(resolved.provider)) {
    throw new TorisError(
      `${apiKeyEnvVar(resolved.provider)} is not set, so "${resolved.profile}" cannot be used.\n` +
        `  export ${apiKeyEnvVar(resolved.provider)}=...`,
      'E_PROVIDER_AUTH',
    );
  }
  if (resolved.model === AUTO_MODEL) {
    throw new TorisError(
      `Profile "${resolved.profile}" has no model id ("auto" only works for CLI adapters).\n` +
        `Set models.profiles.${resolved.profile}.model to a concrete model id.`,
      'E_MODEL_REQUIRED',
    );
  }
}

/**
 * System prompt for a chat turn on either surface.
 * CLI-backed providers keep their own agent loop; we only inject a role.
 */
export function chatSystemPrompt({ agent, briefing, cliBacked = false } = {}) {
  if (cliBacked) return agentRolePrompt(agent) || undefined;
  const base = briefing ? `${CHAT_SYSTEM_PROMPT}\n\n${briefing}` : CHAT_SYSTEM_PROMPT;
  return withAgentPrompt(base, agent);
}
