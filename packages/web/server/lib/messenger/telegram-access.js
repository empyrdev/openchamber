/**
 * Telegram access control for the messenger bridge.
 *
 * Telegram has no guild/role model, so the Discord role-based policy does not
 * translate. Access is evaluated from two configured allow-lists:
 *
 *  - ownerUserId   — the Telegram user id of the bot owner. Always allowed,
 *                    in DMs and in groups. Mirrors settings.telegram.defaultUserId.
 *  - allowedChatIds — chat ids (user ids for DMs, negative group ids) the bot
 *                    answers in. An EMPTY list means "every chat" — matching
 *                    Discord's default where the bot answers in every server
 *                    until a guild is muted. Once any id is listed, every
 *                    other chat is denied (fail-closed), so an operator can
 *                    confine the bot by listing exactly one chat.
 *
 * Bots are always denied: Telegram bots never see other bots' messages in
 * groups (Bot API privacy model), so this only guards the DM edge case and
 * keeps the bridge from reacting to its own or webhook-injected bot traffic.
 */

function normalizeId(value) {
  if (value == null) return '';
  const text = String(value).trim();
  return text;
}

export function normalizeTelegramChatIds(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  return Array.from(new Set(raw.map(normalizeId).filter(Boolean)));
}

export function normalizeTelegramAccessSettings(settings = {}) {
  return {
    ownerUserId: normalizeId(settings.ownerUserId ?? settings.defaultUserId),
    allowedChatIds: normalizeTelegramChatIds(settings.allowedChatIds),
  };
}

/**
 * @param {object} args
 * @param {string|number|null} args.userId   Telegram sender id (from.id)
 * @param {string|number|null} args.chatId   Telegram chat id (negative for groups)
 * @param {string|null}      args.chatType   'private' | 'group' | 'supergroup' | 'channel'
 * @param {boolean}          args.isBot      sender is a bot
 * @param {string}           args.ownerUserId
 * @param {string[]}         args.allowedChatIds
 * @returns {{ allowed: boolean, reason: string }}
 */
export function evaluateTelegramAccess({
  userId,
  chatId,
  chatType = null,
  isBot = false,
  ownerUserId = '',
  allowedChatIds = [],
} = {}) {
  if (isBot) {
    return { allowed: false, reason: 'bot-sender' };
  }

  const user = normalizeId(userId);
  const chat = normalizeId(chatId);
  const owner = normalizeId(ownerUserId);
  const chatIds = normalizeTelegramChatIds(allowedChatIds);

  if (owner && user && user === owner) {
    return { allowed: true, reason: 'owner' };
  }

  if (chatIds.length > 0) {
    // An explicit allow-list confines the bot to the listed chats. A user's
    // private chat id equals their user id on Telegram, so listing a user id
    // also covers their DM without a separate sender-id check.
    if (chat && chatIds.includes(chat)) {
      return { allowed: true, reason: 'allowed-chat' };
    }
    return { allowed: false, reason: 'chat-not-allowed' };
  }

  // No allow-list configured. Without an owner either, the bot is open to
  // anyone who can reach it — same default posture as Discord before any
  // guild policy is set, and the onboarding wizard pushes the user to set an
  // owner id. With an owner configured but a stranger writing in, deny in
  // groups (a group member list cannot be enumerated cheaply) but keep DMs
  // open so the owner can still onboard new chats by talking to the bot.
  if (owner && chatType !== 'private') {
    return { allowed: false, reason: 'not-owner' };
  }

  return { allowed: true, reason: owner ? 'open-dm' : 'open' };
}
