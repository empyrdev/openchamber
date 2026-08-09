/**
 * Minimal Telegram Bot API REST helpers — no dependency, plain fetch against
 * https://api.telegram.org/bot<token>/<method>. Shared by the long-polling
 * listener, the OpenCode bridge's outbound surface, and the messenger router
 * (token verify / test send) so all three agree on payload shapes.
 *
 * Bot API responses are JSON envelopes: { ok, result, description?, error_code? }.
 * HTTP status matches error_code for failures (401 bad token, 409 conflicting
 * getUpdates, 429 rate limited with parameters.retry_after).
 */

const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Telegram callback_data is capped at 64 bytes — keep custom ids short. */
const TELEGRAM_CALLBACK_DATA_LIMIT = 64;

export async function telegramApi(token, method, body, { timeoutMs = 15_000, signal } = {}) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? '{}' : JSON.stringify(body),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
    const parsed = await r.json().catch(() => null);
    return { ok: r.ok && parsed?.ok === true, status: r.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err?.message ?? 'telegram request failed' };
  }
}

/** Short human-readable reason for a failed Bot API call (router error fields). */
export function friendlyTelegramError(status, body, fallbackError) {
  const description = typeof body?.description === 'string' ? body.description : null;
  if (description) return description.slice(0, 200);
  if (fallbackError) return String(fallbackError).slice(0, 200);
  if (status === 401) return 'Unauthorized — check the bot token';
  if (status === 409) return 'Conflict — another getUpdates session or webhook is active for this bot';
  return `HTTP ${status || 'network error'}`;
}

/**
 * Send a text message. Returns { ok, messageId, error }.
 * `parseMode` stays unset by default: bridge content is Discord-flavored
 * markdown, which Telegram's legacy Markdown mode would reject or mangle, so
 * messages go out as plain text (markup characters stay readable).
 */
export async function sendTelegramMessage({
  token,
  chatId,
  text,
  messageThreadId = null,
  replyToMessageId = null,
  replyMarkup = null,
  disableNotification = false,
}) {
  const payload = {
    chat_id: chatId,
    text: String(text).slice(0, TELEGRAM_MESSAGE_LIMIT),
    disable_notification: Boolean(disableNotification),
  };
  if (messageThreadId) payload.message_thread_id = messageThreadId;
  if (replyToMessageId) {
    payload.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
  }
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const r = await telegramApi(token, 'sendMessage', payload);
  if (!r.ok) return { ok: false, error: friendlyTelegramError(r.status, r.body, r.error) };
  return { ok: true, messageId: r.body?.result?.message_id ?? null };
}

/** Replace (or clear) the inline keyboard on a previously sent message. */
export async function editTelegramReplyMarkup({ token, chatId, messageId, replyMarkup = null }) {
  const r = await telegramApi(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  });
  // "message is not modified" is a success for strip purposes.
  if (!r.ok && r.status === 400 && /not modified/i.test(r.body?.description ?? '')) {
    return { ok: true };
  }
  if (!r.ok) return { ok: false, error: friendlyTelegramError(r.status, r.body, r.error) };
  return { ok: true };
}

/** Edit message text and (by default) drop its keyboard — decision annotation. */
export async function editTelegramMessageText({ token, chatId, messageId, text, replyMarkup = null }) {
  const r = await telegramApi(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: String(text).slice(0, TELEGRAM_MESSAGE_LIMIT),
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  });
  if (!r.ok && r.status === 400 && /not modified/i.test(r.body?.description ?? '')) {
    return { ok: true };
  }
  if (!r.ok) return { ok: false, error: friendlyTelegramError(r.status, r.body, r.error) };
  return { ok: true };
}

/** "typing…" chat action (Telegram shows it for ~5s; callers re-pulse). */
export async function telegramChatAction({ token, chatId, action = 'typing', messageThreadId = null }) {
  const payload = { chat_id: chatId, action };
  if (messageThreadId) payload.message_thread_id = messageThreadId;
  try {
    await telegramApi(token, 'sendChatAction', payload, { timeoutMs: 5_000 });
  } catch {
    // cosmetic — ignore
  }
}

/** ACK a callback_query — Telegram spins the button until this arrives. */
export async function answerTelegramCallbackQuery({ token, callbackQueryId, text = null, showAlert = false }) {
  const payload = { callback_query_id: callbackQueryId, show_alert: Boolean(showAlert) };
  if (text) payload.text = String(text).slice(0, 200);
  const r = await telegramApi(token, 'answerCallbackQuery', payload, { timeoutMs: 5_000 });
  return { ok: r.ok, error: r.ok ? undefined : friendlyTelegramError(r.status, r.body, r.error) };
}

/** Split long content into ≤ limit chunks, preferring newline breaks. */
export function splitForTelegram(content, maxChunks = 4, limit = TELEGRAM_MESSAGE_LIMIT) {
  const text = String(content);
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > 0 && chunks.length < maxChunks - 1) {
    if (rest.length <= limit) break;
    let cut = rest.lastIndexOf('\n', limit - 1);
    if (cut < limit / 2) cut = limit - 1;
    chunks.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.length > 0) chunks.push(rest.slice(0, limit));
  return chunks;
}

/** Build one inline-keyboard row per option group; skips empty rows. */
export function buildTelegramInlineKeyboard(rows) {
  const keyboard = (Array.isArray(rows) ? rows : [])
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) =>
      row.map((btn) => ({
        text: String(btn.text).slice(0, 64),
        callback_data: String(btn.callbackData).slice(0, TELEGRAM_CALLBACK_DATA_LIMIT),
      })),
    );
  return keyboard.length > 0 ? { inline_keyboard: keyboard } : null;
}
