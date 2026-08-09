/**
 * Telegram access control for the messenger bridge.
 *
 * Telegram has no guild/role model, so the Discord role-based policy does not
 * translate. Access is evaluated from two configured allow-lists:
 *
 *  - ownerUserIds — Telegram user ids of bot owners. Always allowed, in DMs
 *                    and in groups. At least one owner is required; an empty
 *                    list fails closed (never leaves the bot open). Accepts
 *                    legacy settings.telegram.defaultUserId as a singular
 *                    alias that becomes the first owner. Literal "0" / 0 is
 *                    rejected as invalid.
 *  - allowedChatIds — chat ids (user ids for DMs, negative group ids) the bot
 *                    answers in. An EMPTY list means "every chat the owners
 *                    policy permits" — matching Discord's default where the
 *                    bot answers in every server until a guild is muted.
 *                    Once any id is listed, every other chat is denied
 *                    (fail-closed), so an operator can confine the bot by
 *                    listing exactly one chat.
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

/** True for the literal Telegram id "0" / 0 — never a real user id. */
function isInvalidTelegramUserId(id) {
  return id === '0';
}

export function normalizeTelegramChatIds(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  return Array.from(new Set(raw.map(normalizeId).filter(Boolean)));
}

/**
 * Normalize a list of Telegram user ids. Rejects empty strings and the
 * literal "0" / 0 (invalid — never a real Telegram user).
 */
export function normalizeTelegramUserIds(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : value == null
        ? []
        : [value];
  return Array.from(
    new Set(
      raw
        .map(normalizeId)
        .filter((id) => id.length > 0 && !isInvalidTelegramUserId(id)),
    ),
  );
}

export function normalizeTelegramAccessSettings(settings = {}) {
  // defaultUserId first so legacy singular config remains the primary owner;
  // ownerUserId / ownerUserIds follow and dedupe.
  const ownerUserIds = normalizeTelegramUserIds([
    ...(settings.defaultUserId != null && settings.defaultUserId !== ''
      ? [settings.defaultUserId]
      : []),
    ...(settings.ownerUserId != null && settings.ownerUserId !== ''
      ? [settings.ownerUserId]
      : []),
    ...(Array.isArray(settings.ownerUserIds)
      ? settings.ownerUserIds
      : settings.ownerUserIds != null && settings.ownerUserIds !== ''
        ? [settings.ownerUserIds]
        : []),
  ]);
  return {
    ownerUserIds,
    // Singular back-compat: first configured owner (or empty when none).
    ownerUserId: ownerUserIds[0] || '',
    allowedChatIds: normalizeTelegramChatIds(settings.allowedChatIds),
  };
}

/**
 * Per-chat policy map (Discord guildPolicies analogue).
 * @typedef {{ enabled?: boolean, replyMode?: 'always'|'mention'|'inherit', syncProjects?: boolean }} TelegramChatPolicy
 */

/**
 * Whether a chat is muted via chatPolicies[chatId].enabled === false.
 * Absent/true means respond (matches Discord muted-guild semantics).
 */
export function isTelegramChatDisabled(chatPolicies, chatId) {
  const chat = normalizeId(chatId);
  if (!chat || !chatPolicies || typeof chatPolicies !== 'object' || Array.isArray(chatPolicies)) {
    return false;
  }
  const policy = chatPolicies[chat];
  return Boolean(policy && typeof policy === 'object' && policy.enabled === false);
}

/**
 * Resolve effective reply mode for a chat: per-chat always/mention wins;
 * inherit/absent falls back to the default.
 * @param {'always'|'mention'|undefined} defaultReplyMode
 * @param {Record<string, TelegramChatPolicy>|null|undefined} chatPolicies
 * @param {string|number|null|undefined} chatId
 * @returns {'always'|'mention'}
 */
export function effectiveTelegramChatReplyMode(defaultReplyMode, chatPolicies, chatId) {
  const chat = normalizeId(chatId);
  const policy =
    chat && chatPolicies && typeof chatPolicies === 'object' && !Array.isArray(chatPolicies)
      ? chatPolicies[chat]
      : null;
  const mode = policy && typeof policy === 'object' ? policy.replyMode : null;
  if (mode === 'always' || mode === 'mention') return mode;
  return defaultReplyMode === 'mention' ? 'mention' : 'always';
}

/**
 * @param {object} args
 * @param {string|number|null} args.userId   Telegram sender id (from.id)
 * @param {string|number|null} args.chatId   Telegram chat id (negative for groups)
 * @param {string|null}      args.chatType   'private' | 'group' | 'supergroup' | 'channel'
 * @param {boolean}          args.isBot      sender is a bot
 * @param {string}           [args.ownerUserId]  singular owner (merged into ownerUserIds)
 * @param {string[]}         [args.ownerUserIds] owner allow-list (at least one required)
 * @param {string[]}         args.allowedChatIds
 * @param {Record<string, TelegramChatPolicy>} [args.chatPolicies] per-chat mute / reply policy
 * @returns {{ allowed: boolean, reason: string }}
 */
export function evaluateTelegramAccess({
  userId,
  chatId,
  chatType = null,
  isBot = false,
  ownerUserId = '',
  ownerUserIds = [],
  allowedChatIds = [],
  chatPolicies = null,
} = {}) {
  if (isBot) {
    return { allowed: false, reason: 'bot-sender' };
  }

  const user = normalizeId(userId);
  const chat = normalizeId(chatId);

  // Per-chat mute — same role as Discord guildPolicies[*].enabled === false.
  // Checked before owner bypass so an explicit mute always wins.
  if (isTelegramChatDisabled(chatPolicies, chat)) {
    return { allowed: false, reason: 'chat-disabled' };
  }

  const owners = normalizeTelegramUserIds([
    ...(Array.isArray(ownerUserIds) ? ownerUserIds : ownerUserIds != null ? [ownerUserIds] : []),
    ...(ownerUserId != null && ownerUserId !== '' ? [ownerUserId] : []),
  ]);
  const chatIds = normalizeTelegramChatIds(allowedChatIds);

  // Security: never operate with an empty owner list — that would leave the
  // bot open to anyone who can message it.
  if (owners.length === 0) {
    return { allowed: false, reason: 'no-owner-configured' };
  }

  if (user && owners.includes(user)) {
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

  // Owners are configured but no chat allow-list. Deny strangers in groups
  // (a group member list cannot be enumerated cheaply) but keep DMs open so
  // owners can still onboard new chats by talking to the bot.
  if (chatType !== 'private') {
    return { allowed: false, reason: 'not-owner' };
  }

  return { allowed: true, reason: 'open-dm' };
}
