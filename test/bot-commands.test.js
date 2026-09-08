import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBotCommand,
  renderBotHelp,
  senderAllowed,
} from '../src/bot/commands.js';
import { formatPatchNotice } from '../src/core/channels.js';
import { slackEventText } from '../src/bot/slack.js';
import { telegramMessageText, nextTelegramOffset } from '../src/bot/telegram.js';

test('plain bot text is treated as chat, slash commands are parsed', () => {
  assert.equal(parseBotCommand('fix the login').name, 'chat');
  assert.equal(parseBotCommand('/run add health').name, 'run');
  assert.deepEqual(parseBotCommand('/run add health').args, ['add health']);
  assert.equal(parseBotCommand('/approve pat_123').name, 'apply');
  assert.equal(parseBotCommand('/apply@toris_bot pat_123').name, 'apply');
  assert.equal(parseBotCommand('/latest').name, 'last');
  assert.equal(parseBotCommand('/ws /srv/app').name, 'workspace');
  assert.deepEqual(parseBotCommand('/workspace /srv/my app').args, ['/srv/my app']);
});

test('bot help lists the isolated-apply workflow', () => {
  const help = renderBotHelp();
  assert.match(help, /\/run/);
  assert.match(help, /\/apply/);
  assert.match(help, /\/last/);
  assert.match(help, /\/workspace/);
  assert.match(help, /isolated/);
});

test('allowFrom is open until a sender list is set', () => {
  assert.equal(senderAllowed([], '99'), true);
  assert.equal(senderAllowed(['99'], '99'), true);
  assert.equal(senderAllowed(['99'], '1'), false);
});

test('patch notices tell the operator the exact apply command', () => {
  const notice = formatPatchNotice({
    id: 'pat_abc',
    status: 'pending',
    files: ['src/a.js'],
    stats: '1 file changed',
    originTouched: false,
  });
  assert.match(notice, /toris apply pat_abc/);
});

test('telegram and slack extract the operator text without bot echoes', () => {
  assert.equal(telegramMessageText({ message: { text: '/status' } }), '/status');
  assert.equal(slackEventText({ type: 'message', text: '/patches', bot_id: 'B1' }), '');
  assert.equal(slackEventText({ type: 'app_mention', text: '<@U> /status' }), '<@U> /status');
  assert.equal(nextTelegramOffset([{ update_id: 3 }, { update_id: 9 }], 0), 10);
});
