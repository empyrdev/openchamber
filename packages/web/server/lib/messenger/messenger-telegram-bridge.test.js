import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createMessengerOpencodeBridge,
  questionContexts,
  approvalContexts,
} from './messenger-opencode-bridge.js';

/**
 * Telegram outbound coverage: permission and question events must reach the
 * chat as inline-keyboard messages whose callback_data matches the scheme the
 * Telegram listener decodes, and typed-answer contexts must strip keyboards.
 */

function makeFakeStore({ boundSessionId = null } = {}) {
  return {
    lookup: () =>
      boundSessionId
        ? { sessionId: boundSessionId, projectPath: '/binding/project', projectLabel: 'binding' }
        : null,
    bind: () => {},
    touch: () => {},
    setOverrides: () => {},
    getVerbosityDefault: () => null,
    getProjectDefaults: () => null,
    lookupBySessionId: () => [],
  };
}

const TELEGRAM_TARGET = {
  type: 'telegram',
  token: 'tg-token',
  targetKey: '424242',
  threadId: null,
  projectPath: '/binding/project',
};

function makeBridge(overrides = {}) {
  const { boundSessionId, ...rest } = overrides;
  return createMessengerOpencodeBridge({
    globalEventHub: { subscribeEvent: () => () => {} },
    buildOpenCodeUrl: (p) => `http://opencode${p}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastEvent: () => {},
    store: makeFakeStore({ boundSessionId }),
    listProjects: async () => [],
    lookupMessengerTarget: () => TELEGRAM_TARGET,
    ...rest,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let fetchCalls = [];
let originalFetch;

function stubTelegramFetch() {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const href = String(url);
    // Only Telegram Bot API calls get Bot-API envelopes; OpenCode upstream
    // calls keep generic JSON shapes so the bridge adapter parses them.
    if (!href.includes('api.telegram.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'ses-mock', result: null }),
        text: async () => '',
      };
    }
    const method = href.split('/').pop();
    fetchCalls.push({ method, body, url: href });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 9000 + fetchCalls.length } }),
      text: async () => '',
    };
  });
}

beforeEach(() => {
  questionContexts.clear();
  approvalContexts.clear();
  stubTelegramFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('telegram approval surface', () => {
  it('posts permission.asked as an inline-keyboard message with matching callback_data', async () => {
    const bridge = makeBridge();
    bridge._handleGlobalEvent({
      directory: '/binding/project',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'req-1',
          sessionID: 'ses-1',
          permission: 'bash',
          patterns: [],
          always: [],
          metadata: {},
        },
      },
    });
    await flush();

    const sent = fetchCalls.find((c) => c.method === 'sendMessage');
    expect(sent).toBeTruthy();
    expect(sent.url).toContain('bottg-token/sendMessage');
    expect(sent.body.chat_id).toBe('424242');
    expect(sent.body.text).toContain('Permission Required');

    const keyboard = sent.body.reply_markup?.inline_keyboard;
    expect(Array.isArray(keyboard)).toBe(true);
    const datas = keyboard.flat().map((b) => b.callback_data);
    const approvalId = [...bridge.approvalContexts.keys()][0];
    expect(approvalId).toBeTruthy();
    expect(datas).toContain(`openchamber-agent-approve:${approvalId}`);
    expect(datas).toContain(`openchamber-agent-approve-always:${approvalId}`);
    expect(datas).toContain(`openchamber-agent-deny:${approvalId}`);
    for (const data of datas) {
      expect(data.length).toBeLessThanOrEqual(64);
    }

    // The stored surface lets the auto-reject path strip the keyboard later.
    const ctx = bridge.approvalContexts.get(approvalId);
    expect(ctx.surface).toMatchObject({ type: 'telegram', channelId: '424242' });
    expect(ctx.surface.messageId).toBeTruthy();
  });

  it('a new inbound prompt auto-rejects the pending approval and strips the keyboard', async () => {
    // The chat surface is already bound to ses-1 so the inbound message
    // supersedes THAT session's pending approval (instead of a new session's).
    const bridge = makeBridge({ boundSessionId: 'ses-1' });
    bridge._handleGlobalEvent({
      directory: '/binding/project',
      payload: {
        type: 'permission.asked',
        properties: { id: 'req-2', sessionID: 'ses-1', permission: 'edit', patterns: [], always: [], metadata: {} },
      },
    });
    await flush();
    expect(bridge.approvalContexts.size).toBe(1);

    // A follow-up message on the same session supersedes the pending request.
    await bridge.routeInbound({
      type: 'telegram',
      token: 'tg-token',
      channelId: '424242',
      threadId: null,
      text: 'never mind, stop',
      from: { id: '42' },
    });
    await flush();

    expect(bridge.approvalContexts.size).toBe(0);
    const strip = fetchCalls.find((c) => c.method === 'editMessageReplyMarkup');
    expect(strip).toBeTruthy();
    expect(strip.body.chat_id).toBe('424242');
    expect(strip.body.reply_markup).toEqual({ inline_keyboard: [] });
  });
});

describe('telegram question surface', () => {
  it('posts single-select questions with one button row per option', async () => {
    const bridge = makeBridge();
    bridge._handleGlobalEvent({
      directory: '/binding/project',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'q-1',
          sessionID: 'ses-1',
          questions: [
            {
              question: 'Which framework?',
              options: [
                { label: 'React' },
                { label: 'Vue' },
                { label: 'Svelte' },
              ],
            },
          ],
        },
      },
    });
    await flush();

    const sent = fetchCalls.find((c) => c.method === 'sendMessage');
    expect(sent).toBeTruthy();
    const keyboard = sent.body.reply_markup?.inline_keyboard;
    expect(keyboard).toHaveLength(3);
    const questionId = [...bridge.questionContexts.keys()][0];
    expect(keyboard[0][0].callback_data).toBe(`openchamber-agent-question:${questionId}:0:0`);
    expect(keyboard[2][0].callback_data).toBe(`openchamber-agent-question:${questionId}:0:2`);
    expect(sent.body.text).not.toContain('Reply with your answer');
  });

  it('multi-select questions fall back to a typed answer (no keyboard, explicit hint)', async () => {
    const bridge = makeBridge();
    bridge._handleGlobalEvent({
      directory: '/binding/project',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'q-2',
          sessionID: 'ses-1',
          questions: [
            {
              question: 'Pick all that apply',
              multiple: true,
              options: [{ label: 'A' }, { label: 'B' }],
            },
          ],
        },
      },
    });
    await flush();

    const sent = fetchCalls.find((c) => c.method === 'sendMessage');
    expect(sent).toBeTruthy();
    expect(sent.body.reply_markup).toBeUndefined();
    expect(sent.body.text).toContain('Reply with your answer as a text message.');
  });

  it('a typed answer strips the keyboard from the question message', async () => {
    const bridge = makeBridge({ boundSessionId: 'ses-1' });
    bridge._handleGlobalEvent({
      directory: '/binding/project',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'q-3',
          sessionID: 'ses-1',
          questions: [{ question: 'One?', options: [{ label: 'A' }, { label: 'B' }] }],
        },
      },
    });
    await flush();
    expect(bridge.questionContexts.size).toBe(1);

    await bridge.routeInbound({
      type: 'telegram',
      token: 'tg-token',
      channelId: '424242',
      threadId: null,
      text: 'my custom answer',
      from: { id: '42' },
    });
    await flush();

    // The question was consumed as an answer and its keyboard stripped.
    expect(bridge.questionContexts.size).toBe(0);
    const strip = fetchCalls.find((c) => c.method === 'editMessageReplyMarkup');
    expect(strip).toBeTruthy();
    expect(strip.body.reply_markup).toEqual({ inline_keyboard: [] });
  });
});
