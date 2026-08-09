import { describe, expect, it, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createMessengerSyncRouter } from './messenger-sync.js';

// Route coverage for the Telegram half of the messenger surface: token
// verification via getMe, test-send, config persistence, disconnect, and the
// runtime-status probe the Settings UI badge depends on.

const SETTINGS_TOKEN = 'tg-settings-token';
const CHAT = '-1001234567';

function createApp({ readSettings, persistSettings } = {}) {
  const app = express();
  const { router, telegramListener } = createMessengerSyncRouter({ readSettings, persistSettings });
  // The router mounts its own express.json() parser, matching production.
  app.use('/api/messenger', router);
  return { app, telegramListener };
}

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

let fetchCalls = [];
let originalFetch;
function stubFetch(handler) {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    return handler(String(url), init);
  });
}

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn();
  }
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
  vi.restoreAllMocks();
  // Let any in-flight listener abort settle.
  await new Promise((resolve) => setTimeout(resolve, 5));
});

describe('messenger /test telegram', () => {
  it('verifies the bot token via getMe and returns the bot identity', async () => {
    stubFetch((url) => {
      if (url.includes('/getMe')) {
        return jsonResponse({
          ok: true,
          result: { id: 9911, is_bot: true, username: 'OpenChamberBot', first_name: 'OpenChamber' },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp().app)
      .post('/api/messenger/test')
      .send({ type: 'telegram', token: 'tg-body-token' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: '9911', username: 'OpenChamberBot' });
    expect(fetchCalls[0].url).toContain('bottg-body-token/getMe');
  });

  it('falls back to the saved settings token when the body omits it', async () => {
    const readSettings = vi.fn(async () => ({ telegram: { botToken: SETTINGS_TOKEN } }));
    stubFetch((url) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { id: 1, is_bot: true, username: 'SavedBot' } });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp({ readSettings }).app)
      .post('/api/messenger/test')
      .send({ type: 'telegram' });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('SavedBot');
    expect(fetchCalls[0].url).toContain(`bot${SETTINGS_TOKEN}/getMe`);
  });

  it('surfaces an invalid token as a soft error, never an empty success', async () => {
    stubFetch((url) => {
      if (url.includes('/getMe')) {
        return jsonResponse(
          { ok: false, error_code: 401, description: 'Unauthorized' },
          { ok: false, status: 401 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp().app)
      .post('/api/messenger/test')
      .send({ type: 'telegram', token: 'bad-token' });

    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toMatch(/Unauthorized/i);
  });
});

describe('messenger /send telegram', () => {
  it('posts to the target chat with the settings token', async () => {
    const readSettings = vi.fn(async () => ({ telegram: { botToken: SETTINGS_TOKEN } }));
    stubFetch((url) => {
      if (url.includes('/sendMessage')) {
        return jsonResponse({ ok: true, result: { message_id: 321 } });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp({ readSettings }).app)
      .post('/api/messenger/send')
      .send({ type: 'telegram', target: CHAT, text: 'hello chat' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, messageId: 321 });
    const sendCall = fetchCalls.find((c) => c.url.includes('/sendMessage'));
    expect(sendCall.url).toContain(`bot${SETTINGS_TOKEN}/sendMessage`);
    expect(JSON.parse(sendCall.init.body).chat_id).toBe(CHAT);
  });

  it('returns 400 when no chat target is given', async () => {
    const readSettings = vi.fn(async () => ({ telegram: { botToken: SETTINGS_TOKEN } }));
    stubFetch(() => {
      throw new Error('must not hit Telegram without a target');
    });

    const res = await request(createApp({ readSettings }).app)
      .post('/api/messenger/send')
      .send({ type: 'telegram', text: 'hi' });

    expect(res.status).toBe(400);
  });
});

describe('messenger /telegram config persistence', () => {
  it('save-config merges over the previous block and coerces bridgeEnabled', async () => {
    const persistSettings = vi.fn(async () => {});
    const readSettings = vi.fn(async () => ({
      telegram: { botToken: SETTINGS_TOKEN, bridgeEnabled: false, defaultChatId: CHAT },
    }));

    const res = await request(createApp({ readSettings, persistSettings }).app)
      .post('/api/messenger/telegram/save-config')
      .send({
        defaultUserId: '42',
        allowedChatIds: `${CHAT} -1009`,
        defaultReplyMode: 'mention',
        chatPolicies: {
          [CHAT]: { enabled: true, replyMode: 'always', syncProjects: true },
          '-1009': { enabled: false },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const saved = persistSettings.mock.calls.at(-1)[0].telegram;
    expect(saved.botToken).toBe(SETTINGS_TOKEN);
    expect(saved.defaultChatId).toBe(CHAT);
    expect(saved.defaultUserId).toBe('42');
    expect(saved.ownerUserIds).toEqual(['42']);
    expect(saved.allowedChatIds).toEqual([CHAT, '-1009']);
    expect(saved.defaultReplyMode).toBe('mention');
    expect(saved.bridgeEnabled).toBe(true);
    expect(saved.chatPolicies[CHAT]).toEqual({
      enabled: true,
      replyMode: 'always',
      syncProjects: true,
    });
    expect(saved.chatPolicies['-1009']).toEqual({ enabled: false });
  });

  it('load-config omits the bot token but reports hasToken', async () => {
    const readSettings = vi.fn(async () => ({
      telegram: { botToken: SETTINGS_TOKEN, defaultChatId: CHAT, listenerEnabled: false },
    }));

    const res = await request(createApp({ readSettings }).app)
      .get('/api/messenger/telegram/load-config');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.hasToken).toBe(true);
    expect(res.body.config.botToken).toBeUndefined();
    expect(res.body.config.defaultChatId).toBe(CHAT);
    expect(res.body.config.listenerEnabled).toBe(false);
  });

  it('disconnect clears the whole telegram block', async () => {
    const persistSettings = vi.fn(async () => {});
    const readSettings = vi.fn(async () => ({ telegram: { botToken: SETTINGS_TOKEN } }));

    const res = await request(createApp({ readSettings, persistSettings }).app)
      .post('/api/messenger/telegram/disconnect')
      .send({});

    expect(res.status).toBe(200);
    expect(persistSettings).toHaveBeenCalledWith({ telegram: null });
  });

  it('listener/start persists the config with listenerEnabled:true', async () => {
    const persistSettings = vi.fn(async () => {});
    const readSettings = vi.fn(async () => ({}));
    // 401 stops the listener immediately so no poll loop survives the test.
    stubFetch((url) => {
      if (url.includes('/getMe')) {
        return jsonResponse(
          { ok: false, error_code: 401, description: 'Unauthorized' },
          { ok: false, status: 401 },
        );
      }
      return jsonResponse({ ok: true, result: true });
    });

    const { app, telegramListener } = createApp({ readSettings, persistSettings });
    cleanups.push(() => telegramListener.stop('tg-start-token'));

    const res = await request(app)
      .post('/api/messenger/telegram/listener/start')
      .send({ token: 'tg-start-token', defaultUserId: '42' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const saved = persistSettings.mock.calls.at(-1)[0].telegram;
    expect(saved.botToken).toBe('tg-start-token');
    expect(saved.listenerEnabled).toBe(true);
    expect(saved.defaultUserId).toBe('42');
    expect(saved.ownerUserIds).toEqual(['42']);
  });

  it('listener/stop persists the sticky listenerEnabled:false', async () => {
    const persistSettings = vi.fn(async () => {});
    const readSettings = vi.fn(async () => ({ telegram: { botToken: SETTINGS_TOKEN } }));

    const res = await request(createApp({ readSettings, persistSettings }).app)
      .post('/api/messenger/telegram/listener/stop')
      .send({});

    expect(res.status).toBe(200);
    const saved = persistSettings.mock.calls.at(-1)[0].telegram;
    expect(saved.listenerEnabled).toBe(false);
    expect(saved.botToken).toBe(SETTINGS_TOKEN);
  });
});

describe('messenger /telegram/runtime-status', () => {
  it('reports configured:false when no token is saved', async () => {
    const readSettings = vi.fn(async () => ({}));

    const res = await request(createApp({ readSettings }).app)
      .get('/api/messenger/telegram/runtime-status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      configured: false,
      listenerEnabled: false,
      running: false,
      connected: false,
    });
  });

  it('reports the saved config with a non-running listener', async () => {
    const readSettings = vi.fn(async () => ({
      telegram: { botToken: SETTINGS_TOKEN, defaultReplyMode: 'mention', listenerEnabled: true },
    }));

    const res = await request(createApp({ readSettings }).app)
      .get('/api/messenger/telegram/runtime-status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      configured: true,
      listenerEnabled: true,
      running: false,
      defaultReplyMode: 'mention',
    });
  });
});

describe('messenger /telegram/auto-start', () => {
  it('reports not-configured when no telegram block exists', async () => {
    const readSettings = vi.fn(async () => ({}));

    const res = await request(createApp({ readSettings }).app)
      .post('/api/messenger/telegram/auto-start')
      .send({});

    expect(res.body).toMatchObject({ ok: false, reason: 'not-configured' });
  });

  it('reports listener-disabled when the sticky stop flag is set', async () => {
    const readSettings = vi.fn(async () => ({
      telegram: { botToken: SETTINGS_TOKEN, listenerEnabled: false },
    }));

    const res = await request(createApp({ readSettings }).app)
      .post('/api/messenger/telegram/auto-start')
      .send({});

    expect(res.body).toMatchObject({ ok: false, reason: 'listener-disabled' });
  });
});

describe('messenger /config', () => {
  it('lists telegram as a supported messenger', async () => {
    const res = await request(createApp().app).get('/api/messenger/config');

    expect(res.status).toBe(200);
    expect(res.body.supportedMessengers).toEqual(['discord', 'telegram']);
    expect(res.body.telegram.maxMessageLength).toBe(4096);
  });
});

describe('messenger /telegram/sync-projects', () => {
  it('requires token and chatId', async () => {
    const res = await request(createApp().app)
      .post('/api/messenger/telegram/sync-projects')
      .send({ projects: [] });
    expect(res.status).toBe(400);
  });

  it('posts sync status into a non-forum chat, skips topics, and updates projectBindings', async () => {
    const persistSettings = vi.fn(async () => {});
    const readSettings = vi.fn(async () => ({
      telegram: { botToken: SETTINGS_TOKEN },
      projects: [{ id: 'p1', path: '/proj/one', name: 'One' }],
    }));

    stubFetch((url) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { id: 9911, is_bot: true, username: 'Bot' } });
      }
      if (url.includes('/getChat')) {
        return jsonResponse({ ok: true, result: { id: Number(CHAT), type: 'supergroup', is_forum: false } });
      }
      if (url.includes('/sendMessage')) {
        return jsonResponse({ ok: true, result: { message_id: 77 } });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp({ readSettings, persistSettings }).app)
      .post('/api/messenger/telegram/sync-projects')
      .send({
        chatId: CHAT,
        summary: 'sync summary',
        projects: [{ id: 'p1', path: '/proj/one', label: 'One', body: 'status one' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.isForum).toBe(false);
    expect(res.body.canManageTopics).toBe(false);
    expect(res.body.summaryMessageId).toBe(77);
    expect(res.body.restrictions.some((r) => /not a forum/i.test(r))).toBe(true);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0]).toMatchObject({
      projectId: 'p1',
      projectPath: '/proj/one',
      messageId: 77,
      topicCreated: false,
      topicSkippedReason: 'chat is not a forum',
      error: null,
    });

    const sendCalls = fetchCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls.length).toBe(2); // summary + project
    expect(JSON.parse(sendCalls[0].init.body).chat_id).toBe(CHAT);

    const saved = persistSettings.mock.calls.at(-1)[0].telegram;
    expect(saved.projectBindings).toEqual([
      { chatId: CHAT, projectPath: '/proj/one', projectLabel: 'One' },
    ]);
  });

  it('creates forum topics when the chat is a forum and the bot can_manage_topics', async () => {
    const persistSettings = vi.fn(async () => {});
    const readSettings = vi.fn(async () => ({
      telegram: { botToken: SETTINGS_TOKEN },
    }));

    stubFetch((url) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { id: 9911, is_bot: true, username: 'Bot' } });
      }
      if (url.includes('/getChatMember')) {
        return jsonResponse({
          ok: true,
          result: { status: 'administrator', can_manage_topics: true, user: { id: 9911 } },
        });
      }
      if (url.includes('/getChat')) {
        return jsonResponse({
          ok: true,
          result: { id: Number(CHAT), type: 'supergroup', is_forum: true, title: 'Forum' },
        });
      }
      if (url.includes('/createForumTopic')) {
        return jsonResponse({ ok: true, result: { message_thread_id: 555, name: 'Alpha' } });
      }
      if (url.includes('/sendMessage')) {
        return jsonResponse({ ok: true, result: { message_id: 88 } });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp({ readSettings, persistSettings }).app)
      .post('/api/messenger/telegram/sync-projects')
      .send({
        chatId: CHAT,
        projects: [{ id: 'a', path: '/a', label: 'Alpha', body: 'alpha body' }],
      });

    expect(res.body.ok).toBe(true);
    expect(res.body.isForum).toBe(true);
    expect(res.body.canManageTopics).toBe(true);
    expect(res.body.projects[0]).toMatchObject({
      messageThreadId: '555',
      topicCreated: true,
      messageId: 88,
      error: null,
    });
    const topicCall = fetchCalls.find((c) => c.url.includes('/createForumTopic'));
    expect(JSON.parse(topicCall.init.body)).toMatchObject({ chat_id: CHAT, name: 'Alpha' });
    const projectSend = fetchCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(JSON.parse(projectSend.init.body).message_thread_id).toBe(555);

    const saved = persistSettings.mock.calls.at(-1)[0].telegram;
    expect(saved.projectBindings[0]).toMatchObject({
      chatId: CHAT,
      projectPath: '/a',
      messageThreadId: '555',
    });
  });

  it('reports topic restriction when forum bot lacks can_manage_topics', async () => {
    const readSettings = vi.fn(async () => ({ telegram: { botToken: SETTINGS_TOKEN } }));
    stubFetch((url) => {
      if (url.includes('/getMe')) {
        return jsonResponse({ ok: true, result: { id: 1, is_bot: true } });
      }
      if (url.includes('/getChatMember')) {
        return jsonResponse({
          ok: true,
          result: { status: 'administrator', can_manage_topics: false, user: { id: 1 } },
        });
      }
      if (url.includes('/getChat')) {
        return jsonResponse({ ok: true, result: { id: Number(CHAT), is_forum: true } });
      }
      if (url.includes('/sendMessage')) {
        return jsonResponse({ ok: true, result: { message_id: 9 } });
      }
      if (url.includes('/createForumTopic')) {
        throw new Error('must not create topics without permission');
      }
      throw new Error(`unexpected url ${url}`);
    });

    const res = await request(createApp({ readSettings }).app)
      .post('/api/messenger/telegram/sync-projects')
      .send({
        chatId: CHAT,
        projects: [{ id: 'x', path: '/x', label: 'X', body: 'x' }],
      });

    expect(res.body.ok).toBe(true);
    expect(res.body.canManageTopics).toBe(false);
    expect(res.body.restrictions.some((r) => /can_manage_topics/i.test(r))).toBe(true);
    expect(res.body.projects[0].topicSkippedReason).toBe('missing can_manage_topics');
    expect(res.body.projects[0].messageId).toBe(9);
  });
});
