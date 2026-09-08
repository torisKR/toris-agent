const SLACK_API = 'https://slack.com/api';

export function slackEventText(event) {
  if (event?.type === 'app_mention' && typeof event.text === 'string') return event.text;
  if (event?.type === 'message' && typeof event.text === 'string' && !event.bot_id) return event.text;
  return '';
}

export function slackSender(event) {
  return {
    channel: event?.channel,
    userId: event?.user,
    threadTs: event?.thread_ts || event?.ts,
  };
}

export async function slackPostMessage(token, { channel, text, threadTs }, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
  return { ok: response.ok, status: response.status };
}

export async function openSlackSocket(appToken, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${SLACK_API}/apps.connections.open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${appToken}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok || !body.url) {
    throw new Error(body.error || `Slack socket open failed (${response.status})`);
  }
  return body.url;
}

export function slackEnvelopeReply(envelopeId) {
  return JSON.stringify({ envelope_id: envelopeId });
}
