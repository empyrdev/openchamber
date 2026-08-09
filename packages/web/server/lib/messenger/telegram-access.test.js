import { describe, expect, it } from 'vitest';
import {
  evaluateTelegramAccess,
  normalizeTelegramAccessSettings,
  normalizeTelegramChatIds,
} from './telegram-access.js';

describe('telegram access control', () => {
  it('always allows the configured owner, in DMs and groups', () => {
    expect(
      evaluateTelegramAccess({ userId: '42', chatId: '42', chatType: 'private', ownerUserId: '42' }),
    ).toMatchObject({ allowed: true, reason: 'owner' });
    expect(
      evaluateTelegramAccess({ userId: '42', chatId: '-100999', chatType: 'supergroup', ownerUserId: '42' }),
    ).toMatchObject({ allowed: true, reason: 'owner' });
  });

  it('denies bot senders even when they match the owner id', () => {
    expect(
      evaluateTelegramAccess({ userId: '42', chatId: '42', chatType: 'private', isBot: true, ownerUserId: '42' }),
    ).toMatchObject({ allowed: false, reason: 'bot-sender' });
  });

  it('with an allow-list, permits listed chats and denies everything else', () => {
    const allowedChatIds = ['-100123'];
    expect(
      evaluateTelegramAccess({ userId: '7', chatId: '-100123', chatType: 'supergroup', allowedChatIds }),
    ).toMatchObject({ allowed: true, reason: 'allowed-chat' });
    expect(
      evaluateTelegramAccess({ userId: '7', chatId: '-100999', chatType: 'supergroup', allowedChatIds }),
    ).toMatchObject({ allowed: false, reason: 'chat-not-allowed' });
  });

  it('matches a DM when the user id is listed (private chat id equals user id)', () => {
    expect(
      evaluateTelegramAccess({ userId: '55', chatId: '55', chatType: 'private', allowedChatIds: ['55'] }),
    ).toMatchObject({ allowed: true, reason: 'allowed-chat' });
    expect(
      evaluateTelegramAccess({ userId: '56', chatId: '56', chatType: 'private', allowedChatIds: ['55'] }),
    ).toMatchObject({ allowed: false, reason: 'chat-not-allowed' });
  });

  it('with an owner but no allow-list, keeps DMs open and confines groups to the owner', () => {
    expect(
      evaluateTelegramAccess({ userId: '99', chatId: '99', chatType: 'private', ownerUserId: '42' }),
    ).toMatchObject({ allowed: true, reason: 'open-dm' });
    expect(
      evaluateTelegramAccess({ userId: '99', chatId: '-100999', chatType: 'group', ownerUserId: '42' }),
    ).toMatchObject({ allowed: false, reason: 'not-owner' });
  });

  it('with nothing configured, is open like Discord before any policy', () => {
    expect(
      evaluateTelegramAccess({ userId: '1', chatId: '-5', chatType: 'group' }),
    ).toMatchObject({ allowed: true, reason: 'open' });
  });

  it('normalizes chat id lists from text or arrays', () => {
    expect(normalizeTelegramChatIds('1, -2\n3 -2')).toEqual(['1', '-2', '3']);
    expect(normalizeTelegramChatIds(['4', '', '4', -5])).toEqual(['4', '-5']);
    expect(normalizeTelegramChatIds(null)).toEqual([]);
  });

  it('normalizes settings, accepting defaultUserId as the owner alias', () => {
    expect(
      normalizeTelegramAccessSettings({ defaultUserId: ' 42 ', allowedChatIds: '1 2' }),
    ).toEqual({ ownerUserId: '42', allowedChatIds: ['1', '2'] });
    expect(normalizeTelegramAccessSettings({})).toEqual({ ownerUserId: '', allowedChatIds: [] });
  });
});
