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
      .send({ defaultUserId: '42', allowedChatIds: `${CHAT} -1009`, defaultReplyMode: 'mention' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const saved = persistSettings.mock.calls.at(-1)[0].telegram;
    expect(saved.botToken).toBe(SETTINGS_TOKEN);
    expect(saved.defaultChatId).toBe(CHAT);
    expect(saved.defaultUserId).toBe('42');
    expect(saved.allowedChatIds).toEqual([CHAT, '-1009']);
    expect(saved.defaultReplyMode).toBe('mention');
    expect(saved.bridgeEnabled).toBe(true);
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
