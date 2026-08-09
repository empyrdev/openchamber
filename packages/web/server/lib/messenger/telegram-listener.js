import {
  telegramApi,
  sendTelegramMessage,
  editTelegramMessageText,
  answerTelegramCallbackQuery,
  friendlyTelegramError,
} from './telegram-api.js';
import {
  evaluateTelegramAccess,
  normalizeTelegramAccessSettings,
} from './telegram-access.js';

/**
 * Telegram Bot API long-polling listener registry, keyed by bot token.
 *
 * Mirrors the Discord listener registry (createDiscordListenerRegistry) so the
 * messenger router, the Settings UI, and the boot auto-start can drive both
 * platforms through the same { start, stop, status, recent, inspect,
 * updateConfig } surface. Telegram needs no gateway websocket: getUpdates
 * long polling delivers messages and callback_query button clicks over plain
 * HTTPS, which fits the local-first OpenChamber server (no public webhook
 * URL required).
 *
 * Inbound messages are normalized into the SAME shape the Discord listener
 * emits ({ updateId, chatId, chatType, threadId, from, text, receivedAt, … })
 * so the UI renders one 'recent messages' list for both platforms.
 *
 * State is in-memory only; UI re-starts the listener after reload.
 */

const RECENT_BUFFER_SIZE = 25;
const POLL_TIMEOUT_SECONDS = 25;
const POLL_REQUEST_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 10) * 1000;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const listeners = new Map();

function tokenKey(token) {
  return String(token);
}

/** Static replies used when the bridge is unavailable (mirrors Discord's). */
function buildAutoReply(text, fromName) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (t.startsWith('/start')) {
    return [
      `Hi ${fromName || 'there'} — this chat is now linked to OpenChamber.`,
      'Send a message to talk to the agent, or /help for commands.',
    ].join('\n');
  }
  if (t.toLowerCase().startsWith('/ping')) {
    return `pong — OpenChamber agent is listening (last update at ${new Date().toISOString()})`;
  }
  if (t.toLowerCase().startsWith('/help')) {
    return [
      'OpenChamber agent commands:',
      '`/ping` — health check',
      '`/status` — session status',
      '`/help` — this message',
    ].join('\n');
  }
  if (t.toLowerCase().startsWith('/status')) {
    return `OpenChamber agent listener is online. Reply received from ${fromName || 'there'}.`;
  }
  return null;
}

function inboundFromUpdate(update) {
  const message = update.message;
  const chat = message?.chat ?? {};
  const from = message?.from ?? {};
  return {
    updateId: update.update_id,
    chatId: chat.id != null ? String(chat.id) : null,
    chatTitle: chat.title ?? null,
    chatType: chat.type === 'private' ? 'dm' : chat.type ?? null,
    threadId: message?.message_thread_id ?? null,
    from: {
      id: from.id ?? null,
      username: from.username ?? null,
      firstName: [from.first_name, from.last_name].filter(Boolean).join(' ') || null,
      isBot: Boolean(from.is_bot),
    },
    text: message?.text ?? message?.caption ?? null,
    receivedAt: new Date().toISOString(),
    // Extra telegram-only fields:
    telegram: {
      chatId: chat.id != null ? String(chat.id) : null,
      messageId: message?.message_id ?? null,
      messageThreadId: message?.message_thread_id ?? null,
      chatType: chat.type ?? null,
    },
  };
}

/**
 * Normalize Telegram's group command form `/cmd@BotName args` into the plain
 * `/cmd args` the bridge command pipeline parses. Returns null when the text
 * is not a command, and { addressedElsewhere: true } when the command targets
 * a different bot (must be ignored entirely in shared groups).
 */
function parseTelegramCommand(text, botUsername) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?/.exec(trimmed);
  if (!match) return null;
  const [, name, addressed] = match;
  if (addressed) {
    if (!botUsername || addressed.toLowerCase() !== botUsername.toLowerCase()) {
      return { addressedElsewhere: true };
    }
  }
  const args = trimmed.slice(match[0].length).trim();
  return { name: name.toLowerCase(), args, normalized: `/${name.toLowerCase()}${args ? ` ${args}` : ''}` };
}

/** Is this message explicitly addressed to our bot in a group? */
function detectAddressing(state, message, text) {
  const botUsername = (state.botUsername ?? '').toLowerCase();
  const entities = [
    ...(Array.isArray(message?.entities) ? message.entities : []),
    ...(Array.isArray(message?.caption_entities) ? message.caption_entities : []),
  ];
  for (const entity of entities) {
    if (entity?.type === 'mention' && botUsername) {
      const mentioned = text.substr(entity.offset ?? 0, entity.length ?? 0).toLowerCase();
      if (mentioned === `@${botUsername}`) return true;
    }
    if (entity?.type === 'text_mention' && state.botId) {
      if (String(entity.user?.id ?? '') === state.botId) return true;
    }
  }
  // A reply to one of the bot's own messages is addressed to it.
  if (state.botId && String(message?.reply_to_message?.from?.id ?? '') === state.botId) {
    return true;
  }
  return false;
}

async function dispatchMessage(state, update, broadcastEvent, bridge) {
  const message = update.message;
  const chat = message?.chat ?? {};
  const from = message?.from ?? {};
  state.totalRawMessages += 1;
  state.lastRawMessageAt = Date.now();

  if (state.botId && String(from.id ?? '') === state.botId) return;

  const chatType = chat.type ?? null;
  const access = evaluateTelegramAccess({
    userId: from.id ?? null,
    chatId: chat.id ?? null,
    chatType,
    isBot: Boolean(from.is_bot),
    ownerUserId: state.ownerUserId,
    allowedChatIds: state.allowedChatIds,
  });
  if (!access.allowed) {
    state.accessDeniedCount = (state.accessDeniedCount || 0) + 1;
    state.lastAccessDeniedReason = access.reason;
    return;
  }

  const inbound = inboundFromUpdate(update);
  state.recent.push(inbound);
  if (state.recent.length > RECENT_BUFFER_SIZE) {
    state.recent.splice(0, state.recent.length - RECENT_BUFFER_SIZE);
  }
  state.totalReceived += 1;
  state.lastUpdateAt = Date.now();

  try {
    broadcastEvent?.('messenger.telegram.message_received', inbound);
  } catch {
    // ignore
  }

  let text = typeof message.text === 'string' && message.text.length > 0
    ? message.text.trim()
    : typeof message.caption === 'string'
      ? message.caption.trim()
      : '';

  // Reply-mode gating. DMs always reach the bot. Groups reach it when the
  // message addresses the bot (@mention, reply, /command) or the chat already
  // has a session binding — mirroring Discord's mention-mode semantics.
  // `defaultReplyMode: 'mention'` additionally confines groups to addressed
  // messages even when the chat is unbound.
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const command = parseTelegramCommand(text, state.botUsername);
  if (command?.addressedElsewhere) return;
  const addressed = Boolean(command) || detectAddressing(state, message, text);
  if (isGroup && !addressed) {
    const hasBinding = bridge?.hasSurfaceBinding?.({
      type: 'telegram',
      token: state.token,
      channelId: String(chat.id),
      threadId: message.message_thread_id ?? null,
    });
    const mentionOnly = state.defaultReplyMode === 'mention';
    if (mentionOnly || !hasBinding) {
      state.filteredOutCount += 1;
      return;
    }
  }
  // Strip the @bot mention so the prompt doesn't carry it. Collapse the
  // whitespace a mid-text removal leaves behind ("hey @Bot x" → "hey x").
  if (state.botUsername && text.includes('@')) {
    text = text
      .replace(new RegExp(`@${state.botUsername}(?![A-Za-z0-9_])`, 'gi'), '')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  // `/start` always answers locally — it carries no prompt and users hit it
  // first on Telegram, so the welcome must work even with no bridge wired.
  if (command?.name === 'start') {
    const reply = buildAutoReply('/start', inbound.from.firstName ?? inbound.from.username);
    const r = await sendTelegramMessage({
      token: state.token,
      chatId: chat.id,
      text: reply,
      replyToMessageId: message.message_id,
    });
    if (r.ok) state.totalReplied += 1;
    else state.lastError = r.error ?? 'start reply failed';
    return;
  }

  // Forward to the OpenCode bridge. Commands are normalized (`/status@Bot` →
  // `/status`) so the shared pipeline sees the same text as Discord's `!cmd`.
  const bridgeText = command?.normalized ?? text;
  const isBridgeable = bridge && bridgeText.length > 0;
  if (isBridgeable) {
    try {
      const project = state.resolveProject?.({
        chatId: String(chat.id),
        channelId: String(chat.id),
        threadId: message.message_thread_id ?? null,
      });
      const bridged = await bridge.routeInbound({
        type: 'telegram',
        token: state.token,
        channelId: String(chat.id),
        threadId: message.message_thread_id ?? null,
        sourceMessageId: message.message_id,
        text: bridgeText,
        projectPath: project?.path ?? null,
        projectLabel: project?.label ?? null,
        from: {
          id: from.id != null ? String(from.id) : null,
          username: from.username ?? null,
          firstName: inbound.from.firstName,
        },
      });
      if (bridged?.ok) {
        state.totalReplied += 1;
        state.lastError = null;
        return;
      }
      state.lastError = bridged?.error ?? 'bridge failed';
    } catch (err) {
      state.lastError = err?.message ?? 'bridge failed';
    }
    // Bridge attempted — never fall through to the static auto-reply, the
    // bridge may still respond via the event stream (mirrors Discord).
    return;
  }

  // Auto-reply fallback for known static commands when no bridge is wired.
  if (!state.autoReply) return;
  const replyText = command ? buildAutoReply(command.normalized, inbound.from.firstName) : null;
  if (!replyText) return;
  const r = await sendTelegramMessage({
    token: state.token,
    chatId: chat.id,
    text: replyText,
    replyToMessageId: message.message_id,
  });
  if (r.ok) {
    state.totalReplied += 1;
    broadcastEvent?.('messenger.telegram.auto_reply', {
      chatId: String(chat.id),
      text: replyText,
      messageId: r.messageId,
    });
  } else {
    state.lastError = r.error ?? 'auto-reply failed';
  }
}

/**
 * Inline-button clicks for approvals and questions. The callback_data scheme
 * matches the Discord component custom_ids so both listeners feed the same
 * bridge decision handlers:
 *   openchamber-agent-approve:<id> / -approve-always:<id> / -deny:<id>
 *   openchamber-agent-question:<questionId>:<questionIndex>:<optionIndex>
 */
async function dispatchCallbackQuery(state, callbackQuery, broadcastEvent, bridge) {
  const data = typeof callbackQuery?.data === 'string' ? callbackQuery.data : '';
  const from = callbackQuery?.from ?? {};
  const message = callbackQuery?.message ?? null;
  const chatId = message?.chat?.id ?? null;
  const messageId = message?.message_id ?? null;
  const fromName = from.first_name ?? from.username ?? 'user';

  const access = evaluateTelegramAccess({
    userId: from.id ?? null,
    chatId,
    chatType: message?.chat?.type ?? null,
    isBot: Boolean(from.is_bot),
    ownerUserId: state.ownerUserId,
    allowedChatIds: state.allowedChatIds,
  });
  if (!access.allowed) {
    state.accessDeniedCount = (state.accessDeniedCount || 0) + 1;
    state.lastAccessDeniedReason = access.reason;
    await answerTelegramCallbackQuery({
      token: state.token,
      callbackQueryId: callbackQuery.id,
      text: 'Access denied.',
      showAlert: true,
    }).catch(() => {});
    return;
  }

  const annotate = async (note) => {
    if (chatId == null || messageId == null) return;
    const original = typeof message.text === 'string' ? message.text : '';
    const next = original ? `${original}\n\n${note}` : note;
    await editTelegramMessageText({
      token: state.token,
      chatId,
      messageId,
      text: next,
    }).catch(() => {});
  };

  let decision = null;
  let approvalId = null;
  if (data.startsWith('openchamber-agent-approve-always:')) {
    decision = 'approve-always';
    approvalId = data.slice('openchamber-agent-approve-always:'.length);
  } else if (data.startsWith('openchamber-agent-approve:')) {
    decision = 'approve';
    approvalId = data.slice('openchamber-agent-approve:'.length);
  } else if (data.startsWith('openchamber-agent-deny:')) {
    decision = 'deny';
    approvalId = data.slice('openchamber-agent-deny:'.length);
  }

  if (approvalId) {
    const known = Boolean(bridge?.approvalContexts?.has?.(approvalId));
    bridge?.handleApprovalDecision?.(approvalId, decision);
    const label =
      decision === 'approve' ? '✅ Allowed once' : decision === 'approve-always' ? '♻️ Always allowed' : '❌ Denied';
    await answerTelegramCallbackQuery({
      token: state.token,
      callbackQueryId: callbackQuery.id,
      text: known ? label : 'This request expired',
      showAlert: !known,
    }).catch(() => {});
    await annotate(
      known ? `${label} — by ${fromName}` : '⚠ This approval expired — wait for a new request.',
    );
    // Same event contract as the Discord listener's messenger.discord.approval
    // broadcast — the bridge's hub fallback and UI clients consume it.
    broadcastEvent?.('messenger.telegram.approval', {
      approvalId,
      decision,
      by: { id: from.id ?? null, username: from.username ?? null, displayName: fromName },
      messageId,
      channelId: chatId != null ? String(chatId) : null,
      decidedAt: new Date().toISOString(),
    });
    return;
  }

  if (data.startsWith('openchamber-agent-question:')) {
    const segments = data.split(':');
    const questionId = segments[1] ?? '';
    const questionIndex = Number(segments[2] ?? '0');
    const optionIndex = segments[3];
    let result = { ok: false };
    try {
      result = bridge?.handleQuestionDecision?.(questionId, questionIndex, [optionIndex]) ?? result;
    } catch (err) {
      result = { ok: false, error: err?.message };
    }
    await answerTelegramCallbackQuery({
      token: state.token,
      callbackQueryId: callbackQuery.id,
      text: result.ok ? (result.labels ?? []).join(', ') : 'This question expired',
      showAlert: !result.ok,
    }).catch(() => {});
    await annotate(
      result.ok
        ? `✅ ${(result.labels ?? []).join(', ')} — by ${fromName}`
        : '⚠ This question expired — reply with a text message instead.',
    );
    return;
  }

  // Unknown payload — still ACK so the button stops spinning.
  await answerTelegramCallbackQuery({ token: state.token, callbackQueryId: callbackQuery.id }).catch(() => {});
}

async function dispatchUpdate(state, update, broadcastEvent, bridge) {
  if (update?.message) {
    await dispatchMessage(state, update, broadcastEvent, bridge);
    return;
  }
  if (update?.callback_query) {
    await dispatchCallbackQuery(state, update.callback_query, broadcastEvent, bridge);
  }
}

function scheduleRetry(state, broadcastEvent, bridge) {
  if (state.stopRequested) {
    state.running = false;
    state.connected = false;
    return;
  }
  const exponential = RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(state.consecutiveErrors, 10));
  const clamped = Math.min(exponential, RECONNECT_MAX_DELAY_MS);
  const delay = Math.round(clamped * (0.75 + Math.random() * 0.5));
  state.totalReconnects += 1;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    void pollLoop(state, broadcastEvent, bridge);
  }, delay);
}

async function pollLoop(state, broadcastEvent, bridge) {
  if (state.stopRequested) {
    state.running = false;
    state.connected = false;
    return;
  }

  // Identity (once per process): getMe doubles as the token check.
  if (!state.botId) {
    const me = await telegramApi(state.token, 'getMe', undefined, { signal: state.abort.signal });
    if (state.stopRequested) {
      state.running = false;
      state.connected = false;
      return;
    }
    if (!me.ok) {
      state.consecutiveErrors += 1;
      state.lastError = friendlyTelegramError(me.status, me.body, me.error);
      if (me.status === 401) {
        // Bad token never recovers — stop instead of retrying forever.
        state.running = false;
        state.connected = false;
        state.stopRequested = true;
        return;
      }
      scheduleRetry(state, broadcastEvent, bridge);
      return;
    }
    const bot = me.body?.result ?? {};
    state.botId = bot.id != null ? String(bot.id) : null;
    state.botUsername = bot.username ?? null;

    // Drop a configured webhook (best-effort): getUpdates 409s while one is
    // set. drop_pending_updates stays false so nothing is silently lost.
    await telegramApi(state.token, 'deleteWebhook', { drop_pending_updates: false }).catch(() => {});

    // Skip the queued backlog: Discord only ever sees live traffic, and
    // replaying stale prompts after a server restart would re-run turns.
    const latest = await telegramApi(
      state.token,
      'getUpdates',
      { offset: -1, timeout: 0, allowed_updates: ['message', 'callback_query'] },
      { signal: state.abort.signal },
    );
    if (latest.ok && Array.isArray(latest.body?.result) && latest.body.result.length > 0) {
      state.offset = latest.body.result[latest.body.result.length - 1].update_id + 1;
    }
  }

  state.connected = true;
  state.lastError = null;
  if (!state.readyBroadcasted) {
    state.readyBroadcasted = true;
    broadcastEvent?.('messenger.telegram.listener_ready', {
      botId: state.botId,
      botUsername: state.botUsername,
    });
  }

  const r = await telegramApi(
    state.token,
    'getUpdates',
    {
      offset: state.offset,
      timeout: POLL_TIMEOUT_SECONDS,
      allowed_updates: ['message', 'callback_query'],
    },
    { timeoutMs: POLL_REQUEST_TIMEOUT_MS, signal: state.abort.signal },
  );

  if (state.stopRequested) {
    state.running = false;
    state.connected = false;
    return;
  }

  if (!r.ok) {
    state.consecutiveErrors += 1;
    state.connected = false;
    state.lastError = friendlyTelegramError(r.status, r.body, r.error);
    if (r.status === 401) {
      state.running = false;
      state.stopRequested = true;
      return;
    }
    // 409 = another poller grabbed the session (or a webhook re-appeared).
    // Back off like any network error; the next iteration retries.
    scheduleRetry(state, broadcastEvent, bridge);
    return;
  }

  state.consecutiveErrors = 0;
  state.connected = true;
  const updates = Array.isArray(r.body?.result) ? r.body.result : [];
  for (const update of updates) {
    if (typeof update?.update_id === 'number') {
      // Advance the offset BEFORE dispatch so one failing update cannot block
      // the queue forever (logged and skipped, matching Discord's per-event
      // error isolation).
      state.offset = update.update_id + 1;
    }
    try {
      await dispatchUpdate(state, update, broadcastEvent, bridge);
    } catch (err) {
      state.lastError = err?.message ?? 'update dispatch failed';
    }
    if (state.stopRequested) break;
  }

  // Immediate next iteration (the long poll itself is the pacing mechanism).
  void pollLoop(state, broadcastEvent, bridge);
}

export function createTelegramListenerRegistry({ broadcastEvent, bridge = null } = {}) {
  function start(token, opts = {}) {
    const key = tokenKey(token);
    const existing = listeners.get(key);
    if (existing && existing.running) {
      applyLiveConfig(existing, opts);
      return { ok: true, alreadyRunning: true, ...statusSnapshot(existing) };
    }
    const access = normalizeTelegramAccessSettings({
      defaultUserId: opts.defaultUserId,
      ownerUserId: opts.ownerUserId,
      allowedChatIds: opts.allowedChatIds,
    });
    const state = {
      token,
      autoReply: opts.autoReply !== false,
      bridgeEnabled: true,
      defaultReplyMode: opts.defaultReplyMode === 'mention' ? 'mention' : 'always',
      ownerUserId: access.ownerUserId,
      allowedChatIds: access.allowedChatIds,
      resolveProject: opts.resolveProject ?? null,
      abort: new AbortController(),
      offset: 0,
      botId: null,
      botUsername: null,
      connected: false,
      running: true,
      stopRequested: false,
      readyBroadcasted: false,
      startedAt: Date.now(),
      lastUpdateAt: null,
      lastError: null,
      consecutiveErrors: 0,
      totalReconnects: 0,
      totalReceived: 0,
      totalReplied: 0,
      totalRawMessages: 0,
      lastRawMessageAt: null,
      filteredOutCount: 0,
      accessDeniedCount: 0,
      lastAccessDeniedReason: null,
      recent: [],
      retryTimer: null,
    };
    listeners.set(key, state);
    void pollLoop(state, broadcastEvent, bridge);
    return { ok: true, alreadyRunning: false, ...statusSnapshot(state) };
  }

  function stop(token) {
    const key = tokenKey(token);
    const state = listeners.get(key);
    if (!state) return { ok: true, running: false };
    state.stopRequested = true;
    state.running = false;
    state.connected = false;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    try {
      state.abort?.abort();
    } catch {
      // ignore
    }
    listeners.delete(key);
    return { ok: true, running: false, stoppedAt: new Date().toISOString() };
  }

  function status(token) {
    const state = listeners.get(tokenKey(token));
    if (!state) return { ok: true, running: false };
    return { ok: true, ...statusSnapshot(state) };
  }

  function recent(token, limit = RECENT_BUFFER_SIZE) {
    const state = listeners.get(tokenKey(token));
    if (!state) return { ok: true, messages: [], running: false };
    const n = Math.max(1, Math.min(RECENT_BUFFER_SIZE, Number(limit) || RECENT_BUFFER_SIZE));
    return {
      ok: true,
      running: state.running,
      connected: state.connected,
      messages: state.recent.slice(-n).reverse(),
    };
  }

  function statusSnapshot(state) {
    return {
      running: state.running,
      connected: state.connected,
      autoReply: state.autoReply,
      bridgeEnabled: state.bridgeEnabled,
      defaultReplyMode: state.defaultReplyMode,
      ownerUserId: state.ownerUserId || undefined,
      allowedChatIds: state.allowedChatIds.length > 0 ? state.allowedChatIds : undefined,
      botId: state.botId,
      botUsername: state.botUsername,
      startedAt: state.startedAt,
      lastUpdateAt: state.lastUpdateAt,
      lastError: state.lastError,
      totalReceived: state.totalReceived,
      totalReplied: state.totalReplied,
      totalRawMessages: state.totalRawMessages,
      lastRawMessageAt: state.lastRawMessageAt,
      filteredOutCount: state.filteredOutCount,
      accessDeniedCount: state.accessDeniedCount || 0,
      lastAccessDeniedReason: state.lastAccessDeniedReason ?? null,
      recentCount: state.recent.length,
    };
  }

  /** Allow other modules (e.g. diagnose) to peek at the live state. */
  function inspect(token) {
    const state = listeners.get(tokenKey(token));
    if (!state) return null;
    return statusSnapshot(state);
  }

  function applyLiveConfig(state, opts = {}) {
    if (!state || !opts || typeof opts !== 'object') return;
    if (typeof opts.autoReply === 'boolean') {
      state.autoReply = opts.autoReply;
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'defaultReplyMode')) {
      state.defaultReplyMode = opts.defaultReplyMode === 'mention' ? 'mention' : 'always';
    }
    if (
      Object.prototype.hasOwnProperty.call(opts, 'defaultUserId') ||
      Object.prototype.hasOwnProperty.call(opts, 'ownerUserId')
    ) {
      state.ownerUserId = normalizeTelegramAccessSettings({
        defaultUserId: opts.defaultUserId,
        ownerUserId: opts.ownerUserId,
      }).ownerUserId;
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'allowedChatIds')) {
      state.allowedChatIds = normalizeTelegramAccessSettings({
        allowedChatIds: opts.allowedChatIds,
      }).allowedChatIds;
    }
    state.bridgeEnabled = true;
  }

  function updateConfig(token, opts = {}) {
    const state = listeners.get(tokenKey(token));
    if (!state || !state.running) {
      return { ok: true, running: false, updated: false };
    }
    applyLiveConfig(state, opts);
    return { ok: true, running: true, updated: true, ...statusSnapshot(state) };
  }

  return { start, stop, status, recent, inspect, updateConfig };
}
