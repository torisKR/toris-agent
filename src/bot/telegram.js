const TELEGRAM_API = 'https://api.telegram.org';

export function telegramMessageText(update) {
  return update?.message?.text || update?.edited_message?.text || '';
}

export function telegramSender(update) {
  const message = update?.message || update?.edited_message;
  return {
    chatId: message?.chat?.id,
    userId: message?.from?.id,
    username: message?.from?.username,
  };
}

export async function telegramGetUpdates(token, { offset = 0, timeout = 25, fetchImpl = fetch } = {}) {
  const url = `${TELEGRAM_API}/bot${token}/getUpdates?timeout=${timeout}&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Telegram getUpdates failed (${response.status})`);
  }
  const body = await response.json();
  if (!body.ok) throw new Error(body.description || 'Telegram getUpdates rejected');
  return body.result || [];
}

export async function telegramSend(token, chatId, text, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return { ok: response.ok, status: response.status };
}

export function nextTelegramOffset(updates, current = 0) {
  if (!updates.length) return current;
  return Math.max(...updates.map((update) => Number(update.update_id) || 0)) + 1;
}
