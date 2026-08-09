import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelegramListenerRegistry } from './telegram-listener.js';

const TOKEN = '123456:ABC-DEF';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function dmUpdate(text, { updateId = 1000, userId = 42, messageId = 10 } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1700000000,
      chat: { id: userId, type: 'private', first_name: 'Ada' },
      from: { id: userId, is_bot: false, first_name: 'Ada', username: 'ada' },
      text,
    },
  };
}

function groupUpdate(text, { updateId = 1001, chatId = -100500, userId = 42, messageId = 11, entities, replyTo } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1700000000,
      chat: { id: chatId, type: 'supergroup', title: 'Dev Group' },
      from: { id: userId, is_bot: false, first_name: 'Ada', username: 'ada' },
      text,
      ...(entities ? { entities } : {}),
      ...(replyTo ? { reply_to_message: replyTo } : {}),
    },
  };
}

/**
 * Scripted fetch mock. All scripted updates form one queue; getUpdates honors
 * the offset exactly like the Bot API (already-confirmed updates are never
 * redelivered) and idles for a few ms when nothing is pending, so the
 * listener's poll loop stays paced like real long polling.
 */
function installFetchMock({ updateBatches = [[]], botUsername = 'TestBot' } = {}) {
  const calls = [];
  const queue = updateBatches.flat();
  const mock = vi.fn(async (url, init) => {
    const method = String(url).split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    if (method === 'getMe') {
      return jsonResponse({ ok: true, result: { id: 999001, is_bot: true, username: botUsername } });
    }
    if (method === 'deleteWebhook') return jsonResponse({ ok: true, result: true });
    if (method === 'getUpdates') {
      if (body.offset === -1) return jsonResponse({ ok: true, result: [] });
      const pending = queue.filter((u) => typeof u?.update_id === 'number' && u.update_id >= body.offset);
      if (pending.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return jsonResponse({ ok: true, result: pending });
    }
    if (method === 'sendMessage') return jsonResponse({ ok: true, result: { message_id: 777 } });
    return jsonResponse({ ok: true, result: true });
  });
  globalThis.fetch = mock;
  return { calls, mock };
}

async function waitFor(condition, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function makeBridge(overrides = {}) {
  return {
    routeInbound: vi.fn(async () => ({ ok: true })),
    hasSurfaceBinding: vi.fn(() => false),
    handleApprovalDecision: vi.fn(),
    handleQuestionDecision: vi.fn(() => ({ ok: true, labels: ['Option A'], complete: true })),
    approvalContexts: new Map(),
    ...overrides,
  };
}

describe('telegram listener registry', () => {
  let originalFetch;
  let registry;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    registry?.stop(TOKEN);
    registry = undefined;
    globalThis.fetch = originalFetch;
  });

  it('starts, identifies the bot, skips the backlog, and reports status', async () => {
    const { calls } = installFetchMock();
    const broadcastEvent = vi.fn();
    registry = createTelegramListenerRegistry({ broadcastEvent, bridge: makeBridge() });

    const started = registry.start(TOKEN, {});
    expect(started.ok).toBe(true);
    expect(started.running).toBe(true);

    await waitFor(() => calls.some((c) => c.method === 'getUpdates' && c.body.offset === -1));
    await waitFor(() => broadcastEvent.mock.calls.some(([name]) => name === 'messenger.telegram.listener_ready'));

    const status = registry.status(TOKEN);
    expect(status).toMatchObject({ ok: true, running: true, connected: true, botUsername: 'TestBot' });
    // Webhook dropped so getUpdates does not 409.
    expect(calls.some((c) => c.method === 'deleteWebhook')).toBe(true);
  });

  it('normalizes a DM into the shared inbound shape and routes it to the bridge', async () => {
    installFetchMock({ updateBatches: [[dmUpdate('hello agent')]] });
    const broadcastEvent = vi.fn();
    const bridge = makeBridge();
    registry = createTelegramListenerRegistry({ broadcastEvent, bridge });
    registry.start(TOKEN, {});

    await waitFor(() => bridge.routeInbound.mock.calls.length > 0);

    const [payload] = bridge.routeInbound.mock.calls[0];
    expect(payload).toMatchObject({
      type: 'telegram',
      token: TOKEN,
      channelId: '42',
      threadId: null,
      sourceMessageId: 10,
      text: 'hello agent',
      from: { id: '42', username: 'ada', firstName: 'Ada' },
    });

    await waitFor(() => registry.recent(TOKEN).messages.length > 0);
    const [inbound] = registry.recent(TOKEN).messages;
    expect(inbound).toMatchObject({
      updateId: 1000,
      chatId: '42',
      chatType: 'dm',
      text: 'hello agent',
      from: { id: 42, username: 'ada', firstName: 'Ada', isBot: false },
      telegram: { chatId: '42', messageId: 10, chatType: 'private' },
    });
    expect(
      broadcastEvent.mock.calls.some(([name]) => name === 'messenger.telegram.message_received'),
    ).toBe(true);
  });

  it('answers /start locally with the welcome text and never bridges it', async () => {
    const { calls } = installFetchMock({ updateBatches: [[dmUpdate('/start')]] });
    const bridge = makeBridge();
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge });
    registry.start(TOKEN, {});

    await waitFor(() => calls.some((c) => c.method === 'sendMessage'));
    const sent = calls.find((c) => c.method === 'sendMessage');
    expect(sent.body.chat_id).toBe(42);
    expect(sent.body.text).toContain('OpenChamber');
    expect(bridge.routeInbound).not.toHaveBeenCalled();
  });

  it('ignores group messages not addressing the bot when reply mode is mention', async () => {
    installFetchMock({ updateBatches: [[groupUpdate('just chatter')]] });
    const bridge = makeBridge();
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge });
    registry.start(TOKEN, { defaultReplyMode: 'mention' });

    await waitFor(() => registry.recent(TOKEN).messages.length > 0);
    // Let the dispatch finish (recent push happens before the bridge gate).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.routeInbound).not.toHaveBeenCalled();
    expect(registry.status(TOKEN).filteredOutCount).toBe(1);
  });

  it('forwards group messages that @mention the bot, with the mention stripped', async () => {
    const mention = groupUpdate('hey @TestBot summarize this', {
      entities: [{ type: 'mention', offset: 4, length: 8 }],
    });
    installFetchMock({ updateBatches: [[mention]] });
    const bridge = makeBridge();
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge });
    registry.start(TOKEN, {});

    await waitFor(() => bridge.routeInbound.mock.calls.length > 0);
    expect(bridge.routeInbound.mock.calls[0][0].text).toBe('hey summarize this');
  });

  it('normalizes /cmd@BotName for the bridge and ignores commands for other bots', async () => {
    installFetchMock({
      updateBatches: [[
        groupUpdate('/status@OtherBot'),
        groupUpdate('/status@TestBot', { updateId: 1002, messageId: 12 }),
      ]],
    });
    const bridge = makeBridge();
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge });
    registry.start(TOKEN, {});

    await waitFor(() => bridge.routeInbound.mock.calls.length > 0);
    expect(bridge.routeInbound).toHaveBeenCalledTimes(1);
    expect(bridge.routeInbound.mock.calls[0][0].text).toBe('/status');
  });

  it('routes approval callback queries to the bridge decision handler and annotates', async () => {
    const { calls } = installFetchMock({
      updateBatches: [[{
        update_id: 2000,
        callback_query: {
          id: 'cbq1',
          from: { id: 42, is_bot: false, first_name: 'Ada', username: 'ada' },
          data: 'openchamber-agent-approve:deadbeef12345678',
          message: {
            message_id: 66,
            chat: { id: 42, type: 'private' },
            text: '⚠️ Permission Required — `bash`',
          },
        },
      }]],
    });
    const bridge = makeBridge({ approvalContexts: new Map([['deadbeef12345678', { sessionID: 's1' }]]) });
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge });
    registry.start(TOKEN, {});

    await waitFor(() => bridge.handleApprovalDecision.mock.calls.length > 0);
    expect(bridge.handleApprovalDecision).toHaveBeenCalledWith('deadbeef12345678', 'approve');

    await waitFor(() => calls.some((c) => c.method === 'answerCallbackQuery'));
    const answered = calls.find((c) => c.method === 'answerCallbackQuery');
    expect(answered.body.callback_query_id).toBe('cbq1');

    await waitFor(() => calls.some((c) => c.method === 'editMessageText'));
    const edited = calls.find((c) => c.method === 'editMessageText');
    expect(edited.body.chat_id).toBe(42);
    expect(edited.body.message_id).toBe(66);
    expect(edited.body.text).toContain('✅ Allowed once');
    expect(edited.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('routes question callback queries with the picked option index', async () => {
    installFetchMock({
      updateBatches: [[{
        update_id: 2001,
        callback_query: {
          id: 'cbq2',
          from: { id: 42, is_bot: false, first_name: 'Ada' },
          data: 'openchamber-agent-question:aaaabbbbccccdddd:0:2',
          message: { message_id: 67, chat: { id: 42, type: 'private' }, text: 'Pick one' },
        },
      }]],
    });
    const bridge = makeBridge();
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge });
    registry.start(TOKEN, {});

    await waitFor(() => bridge.handleQuestionDecision.mock.calls.length > 0);
    expect(bridge.handleQuestionDecision).toHaveBeenCalledWith('aaaabbbbccccdddd', 0, ['2']);
  });

  it('denies group messages from strangers when an owner is configured', async () => {
    installFetchMock({ updateBatches: [[
      groupUpdate('@TestBot hi', {
        userId: 77,
        updateId: 1001,
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      }),
      groupUpdate('@TestBot hi', {
        userId: 42,
        updateId: 1002,
        messageId: 12,
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      }),
    ]] });
    const bridge = makeBridge();
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge });
    registry.start(TOKEN, { defaultUserId: '42' });

    await waitFor(() => bridge.routeInbound.mock.calls.length > 0);
    // Only the owner's message (userId 42) was forwarded; the stranger was denied.
    expect(bridge.routeInbound).toHaveBeenCalledTimes(1);
    expect(bridge.routeInbound.mock.calls[0][0].from.id).toBe('42');
    expect(registry.status(TOKEN).accessDeniedCount).toBe(1);
  });

  it('denies bot senders outright', async () => {
    const botMessage = dmUpdate('hello', { userId: 12345 });
    botMessage.message.from.is_bot = true;
    installFetchMock({ updateBatches: [[botMessage]] });
    const bridge = makeBridge();
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge });
    registry.start(TOKEN, {});

    await waitFor(() => registry.status(TOKEN).accessDeniedCount > 0);
    expect(bridge.routeInbound).not.toHaveBeenCalled();
  });

  it('stops cleanly and reports running:false', async () => {
    installFetchMock();
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge: makeBridge() });
    registry.start(TOKEN, {});
    await waitFor(() => registry.status(TOKEN).connected === true);

    const stopped = registry.stop(TOKEN);
    expect(stopped).toMatchObject({ ok: true, running: false });
    expect(registry.status(TOKEN)).toMatchObject({ ok: true, running: false });
    registry = undefined; // already stopped
  });

  it('hot-applies config via updateConfig without a restart', async () => {
    installFetchMock();
    registry = createTelegramListenerRegistry({ broadcastEvent: vi.fn(), bridge: makeBridge() });
    registry.start(TOKEN, {});
    await waitFor(() => registry.status(TOKEN).connected === true);

    const updated = registry.updateConfig(TOKEN, {
      defaultReplyMode: 'mention',
      allowedChatIds: '-100500',
      defaultUserId: '42',
    });
    expect(updated).toMatchObject({
      ok: true,
      updated: true,
      defaultReplyMode: 'mention',
      ownerUserId: '42',
    });
    expect(updated.allowedChatIds).toEqual(['-100500']);
  });
});
