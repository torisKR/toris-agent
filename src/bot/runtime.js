import {
  slackAppToken,
  slackBotToken,
  telegramToken,
  channelConfig,
} from '../core/channels.js';
import { authorizeSender, dispatchBotText } from './handler.js';
import {
  nextTelegramOffset,
  telegramGetUpdates,
  telegramMessageText,
  telegramSend,
  telegramSender,
} from './telegram.js';
import {
  openSlackSocket,
  slackEnvelopeReply,
  slackEventText,
  slackPostMessage,
  slackSender,
} from './slack.js';

export async function handleTelegramUpdate(update, ctx, { fetchImpl = fetch } = {}) {
  const text = telegramMessageText(update);
  if (!text) return null;
  const sender = telegramSender(update);
  if (
    !authorizeSender(ctx.config, 'telegram', sender.userId) &&
    !authorizeSender(ctx.config, 'telegram', sender.chatId)
  ) {
    return { skipped: true, reason: 'sender not allowed' };
  }
  const reply = await dispatchBotText(text, ctx);
  const token = telegramToken(ctx.config, ctx.env);
  await telegramSend(token, sender.chatId, reply, { fetchImpl });
  return { ok: true, reply };
}

export async function handleSlackEvent(event, ctx, { fetchImpl = fetch } = {}) {
  const text = slackEventText(event);
  if (!text) return null;
  const sender = slackSender(event);
  if (!authorizeSender(ctx.config, 'slack', sender.userId)) {
    return { skipped: true, reason: 'sender not allowed' };
  }
  const reply = await dispatchBotText(text, ctx);
  const token = slackBotToken(ctx.config, ctx.env);
  await slackPostMessage(
    token,
    { channel: sender.channel, text: reply, threadTs: sender.threadTs },
    { fetchImpl },
  );
  return { ok: true, reply };
}

export async function pollTelegramOnce(ctx, offset, { fetchImpl = fetch, timeout = 25 } = {}) {
  const token = telegramToken(ctx.config, ctx.env);
  if (!token) return offset;
  const updates = await telegramGetUpdates(token, { offset, timeout, fetchImpl });
  for (const update of updates) {
    await handleTelegramUpdate(update, ctx, { fetchImpl });
  }
  return nextTelegramOffset(updates, offset);
}

export async function connectSlackSocket(ctx, { fetchImpl = fetch, webSocket = globalThis.WebSocket } = {}) {
  const appToken = slackAppToken(ctx.config, ctx.env);
  if (!appToken) return null;
  if (typeof webSocket !== 'function') {
    throw new Error('WebSocket is not available in this Node build, so Slack Socket Mode cannot start.');
  }
  const url = await openSlackSocket(appToken, { fetchImpl });
  const socket = new webSocket(url);
  socket.addEventListener('message', async (raw) => {
    let payload;
    try {
      payload = JSON.parse(String(raw.data ?? raw));
    } catch {
      return;
    }
    if (payload.envelope_id && socket.readyState === 1) {
      socket.send(slackEnvelopeReply(payload.envelope_id));
    }
    const event = payload.payload?.event || payload.event;
    if (event) await handleSlackEvent(event, ctx, { fetchImpl });
  });
  return socket;
}

export function describeBotBindings(config, env = process.env) {
  const channels = channelConfig(config);
  return {
    telegram: Boolean(telegramToken(config, env) && channels.telegram?.enabled !== false),
    slack: Boolean(
      slackBotToken(config, env) && slackAppToken(config, env) && channels.slack?.enabled !== false,
    ),
    workspace: channels.workspace || null,
  };
}
