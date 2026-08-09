import { describe, expect, it } from 'vitest';
import {
  evaluateTelegramAccess,
  effectiveTelegramChatReplyMode,
  isTelegramChatDisabled,
  normalizeTelegramAccessSettings,
  normalizeTelegramChatIds,
  normalizeTelegramUserIds,
} from './telegram-access.js';

describe('telegram access control', () => {
  it('always allows any configured owner, in DMs and groups', () => {
    expect(
      evaluateTelegramAccess({
        userId: '42',
        chatId: '42',
        chatType: 'private',
        ownerUserIds: ['42', '99'],
      }),
    ).toMatchObject({ allowed: true, reason: 'owner' });
    expect(
      evaluateTelegramAccess({
        userId: '99',
        chatId: '-100999',
        chatType: 'supergroup',
        ownerUserIds: ['42', '99'],
      }),
    ).toMatchObject({ allowed: true, reason: 'owner' });
  });

  it('accepts singular ownerUserId and merges it into the owner list', () => {
    expect(
      evaluateTelegramAccess({
        userId: '7',
        chatId: '7',
        chatType: 'private',
        ownerUserId: '7',
      }),
    ).toMatchObject({ allowed: true, reason: 'owner' });
    expect(
      evaluateTelegramAccess({
        userId: '7',
        chatId: '7',
        chatType: 'private',
        ownerUserId: '7',
        ownerUserIds: ['42'],
      }),
    ).toMatchObject({ allowed: true, reason: 'owner' });
  });

  it('denies bot senders even when they match an owner id', () => {
    expect(
      evaluateTelegramAccess({
        userId: '42',
        chatId: '42',
        chatType: 'private',
        isBot: true,
        ownerUserIds: ['42'],
      }),
    ).toMatchObject({ allowed: false, reason: 'bot-sender' });
  });

  it('fails closed when no owners are configured', () => {
    expect(
      evaluateTelegramAccess({ userId: '1', chatId: '-5', chatType: 'group' }),
    ).toMatchObject({ allowed: false, reason: 'no-owner-configured' });
    expect(
      evaluateTelegramAccess({
        userId: '1',
        chatId: '1',
        chatType: 'private',
        ownerUserIds: [],
        allowedChatIds: ['1'],
      }),
    ).toMatchObject({ allowed: false, reason: 'no-owner-configured' });
    expect(
      evaluateTelegramAccess({
        userId: '1',
        chatId: '1',
        chatType: 'private',
        ownerUserId: '0',
        ownerUserIds: ['0', ''],
      }),
    ).toMatchObject({ allowed: false, reason: 'no-owner-configured' });
  });

  it('with an allow-list, permits listed chats and denies everything else', () => {
    const allowedChatIds = ['-100123'];
    const ownerUserIds = ['42'];
    expect(
      evaluateTelegramAccess({
        userId: '7',
        chatId: '-100123',
        chatType: 'supergroup',
        ownerUserIds,
        allowedChatIds,
      }),
    ).toMatchObject({ allowed: true, reason: 'allowed-chat' });
    expect(
      evaluateTelegramAccess({
        userId: '7',
        chatId: '-100999',
        chatType: 'supergroup',
        ownerUserIds,
        allowedChatIds,
      }),
    ).toMatchObject({ allowed: false, reason: 'chat-not-allowed' });
  });

  it('matches a DM when the user id is listed (private chat id equals user id)', () => {
    const ownerUserIds = ['42'];
    expect(
      evaluateTelegramAccess({
        userId: '55',
        chatId: '55',
        chatType: 'private',
        ownerUserIds,
        allowedChatIds: ['55'],
      }),
    ).toMatchObject({ allowed: true, reason: 'allowed-chat' });
    expect(
      evaluateTelegramAccess({
        userId: '56',
        chatId: '56',
        chatType: 'private',
        ownerUserIds,
        allowedChatIds: ['55'],
      }),
    ).toMatchObject({ allowed: false, reason: 'chat-not-allowed' });
  });

  it('with owners but no allow-list, keeps DMs open and confines groups to owners', () => {
    expect(
      evaluateTelegramAccess({
        userId: '99',
        chatId: '99',
        chatType: 'private',
        ownerUserIds: ['42'],
      }),
    ).toMatchObject({ allowed: true, reason: 'open-dm' });
    expect(
      evaluateTelegramAccess({
        userId: '99',
        chatId: '-100999',
        chatType: 'group',
        ownerUserIds: ['42'],
      }),
    ).toMatchObject({ allowed: false, reason: 'not-owner' });
  });

  it('normalizes chat id lists from text or arrays', () => {
    expect(normalizeTelegramChatIds('1, -2\n3 -2')).toEqual(['1', '-2', '3']);
    expect(normalizeTelegramChatIds(['4', '', '4', -5])).toEqual(['4', '-5']);
    expect(normalizeTelegramChatIds(null)).toEqual([]);
  });

  it('normalizes user ids and rejects literal 0', () => {
    expect(normalizeTelegramUserIds('1, 0\n2 0')).toEqual(['1', '2']);
    expect(normalizeTelegramUserIds(['4', '', '0', 0, '4', -5])).toEqual(['4', '-5']);
    expect(normalizeTelegramUserIds(null)).toEqual([]);
    expect(normalizeTelegramUserIds(0)).toEqual([]);
    expect(normalizeTelegramUserIds('0')).toEqual([]);
    expect(normalizeTelegramUserIds(' 0 ')).toEqual([]);
  });

  it('normalizes settings to ownerUserIds, accepting defaultUserId as first/compat', () => {
    expect(
      normalizeTelegramAccessSettings({ defaultUserId: ' 42 ', allowedChatIds: '1 2' }),
    ).toEqual({ ownerUserIds: ['42'], ownerUserId: '42', allowedChatIds: ['1', '2'] });
    expect(
      normalizeTelegramAccessSettings({
        defaultUserId: '42',
        ownerUserIds: ['99', '42', '0'],
        allowedChatIds: [],
      }),
    ).toEqual({ ownerUserIds: ['42', '99'], ownerUserId: '42', allowedChatIds: [] });
    expect(
      normalizeTelegramAccessSettings({ ownerUserId: '7', ownerUserIds: ['8'] }),
    ).toEqual({ ownerUserIds: ['7', '8'], ownerUserId: '7', allowedChatIds: [] });
    expect(normalizeTelegramAccessSettings({})).toEqual({
      ownerUserIds: [],
      ownerUserId: '',
      allowedChatIds: [],
    });
    expect(
      normalizeTelegramAccessSettings({ defaultUserId: '0', ownerUserIds: ['0'] }),
    ).toEqual({ ownerUserIds: [], ownerUserId: '', allowedChatIds: [] });
  });

  it('denies muted chats via chatPolicies[*].enabled === false (Discord mute parity)', () => {
    expect(
      evaluateTelegramAccess({
        userId: '42',
        chatId: '-100999',
        chatType: 'supergroup',
        ownerUserIds: ['42'],
        chatPolicies: { '-100999': { enabled: false } },
      }),
    ).toMatchObject({ allowed: false, reason: 'chat-disabled' });
    // Mute wins even when the sender is an owner.
    expect(
      evaluateTelegramAccess({
        userId: '42',
        chatId: '-100999',
        chatType: 'supergroup',
        ownerUserIds: ['42'],
        allowedChatIds: ['-100999'],
        chatPolicies: { '-100999': { enabled: false } },
      }),
    ).toMatchObject({ allowed: false, reason: 'chat-disabled' });
    // Absent / true policies still allow owners.
    expect(
      evaluateTelegramAccess({
        userId: '42',
        chatId: '-100999',
        chatType: 'supergroup',
        ownerUserIds: ['42'],
        chatPolicies: { '-100999': { enabled: true, replyMode: 'mention' } },
      }),
    ).toMatchObject({ allowed: true, reason: 'owner' });
  });

  it('resolves per-chat reply mode with inherit → default', () => {
    expect(effectiveTelegramChatReplyMode('always', { '-1': { replyMode: 'mention' } }, '-1')).toBe(
      'mention',
    );
    expect(effectiveTelegramChatReplyMode('mention', { '-1': { replyMode: 'inherit' } }, '-1')).toBe(
      'mention',
    );
    expect(effectiveTelegramChatReplyMode('always', {}, '-1')).toBe('always');
    expect(isTelegramChatDisabled({ '-1': { enabled: false } }, '-1')).toBe(true);
    expect(isTelegramChatDisabled({ '-1': { enabled: true } }, '-1')).toBe(false);
  });
});
