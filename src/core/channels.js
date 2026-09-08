const TELEGRAM_API = 'https://api.telegram.org';
const SLACK_API = 'https://slack.com/api';

export function channelConfig(config) {
  return config?.channels ?? {};
}

export function telegramToken(config, env = process.env) {
  const spec = channelConfig(config).telegram ?? {};
  const key = spec.tokenEnv || 'TORIS_TELEGRAM_BOT_TOKEN';
  return env[key] || '';
}

export function slackBotToken(config, env = process.env) {
  const spec = channelConfig(config).slack ?? {};
  const key = spec.botTokenEnv || 'TORIS_SLACK_BOT_TOKEN';
  return env[key] || '';
}

export function slackAppToken(config, env = process.env) {
  const spec = channelConfig(config).slack ?? {};
  const key = spec.appTokenEnv || 'TORIS_SLACK_APP_TOKEN';
  return env[key] || '';
}

export function slackWebhook(config, env = process.env) {
  const spec = channelConfig(config).slack ?? {};
  const key = spec.webhookEnv || 'TORIS_SLACK_WEBHOOK_URL';
  return spec.webhookUrl || env[key] || '';
}

export function formatPatchNotice(patch, extra = '') {
  const files = (patch.files || []).slice(0, 12).join(', ');
  const more = (patch.files || []).length > 12 ? '…' : '';
  return [
    `toris patch ${patch.id} (${patch.status})`,
    patch.originTouched ? 'warning: the original checkout also changed; inspect before applying' : null,
    `${(patch.files || []).length} files${files ? `: ${files}${more}` : ''}`,
    patch.stats || null,
    extra,
    patch.status === 'pending' ? `apply: toris apply ${patch.id}` : null,
    patch.status === 'pending' ? `discard: toris discard ${patch.id}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function postTelegram(config, text, { fetchImpl = fetch, env = process.env, chatId } = {}) {
  const token = telegramToken(config, env);
  const spec = channelConfig(config).telegram ?? {};
  const target = chatId || spec.chatId;
  if (!token || !target) return { ok: false, skipped: true };
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: target, text, disable_web_page_preview: true }),
  });
  return { ok: response.ok, skipped: false, status: response.status };
}

export async function postSlack(config, text, { fetchImpl = fetch, env = process.env, channel } = {}) {
  const spec = channelConfig(config).slack ?? {};
  const webhook = slackWebhook(config, env);
  if (webhook) {
    const response = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { ok: response.ok, skipped: false, status: response.status, via: 'webhook' };
  }
  const token = slackBotToken(config, env);
  const target = channel || spec.channel;
  if (!token || !target) return { ok: false, skipped: true };
  const response = await fetchImpl(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel: target, text }),
  });
  return { ok: response.ok, skipped: false, status: response.status, via: 'api' };
}

export async function notifyChannels(config, text, deps = {}) {
  const spec = channelConfig(config);
  const results = [];
  if (spec.telegram?.enabled !== false) {
    results.push(await postTelegram(config, text, deps).catch((err) => ({ ok: false, error: err.message })));
  }
  if (spec.slack?.enabled !== false) {
    results.push(await postSlack(config, text, deps).catch((err) => ({ ok: false, error: err.message })));
  }
  return results;
}
