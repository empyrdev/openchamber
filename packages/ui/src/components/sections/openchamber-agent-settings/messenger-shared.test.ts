import { describe, expect, test } from 'bun:test';
import * as messengerShared from './messenger-shared';

type MessengerIntegrationState = {
  type: 'discord' | 'telegram';
  discordListenerEnabled?: boolean;
  telegramListenerEnabled?: boolean;
};

type IsMessengerIntegrationEnabled = (connection: MessengerIntegrationState) => boolean;

const isMessengerIntegrationEnabled = (
  messengerShared as unknown as {
    isMessengerIntegrationEnabled?: IsMessengerIntegrationEnabled;
  }
).isMessengerIntegrationEnabled;

describe('isMessengerIntegrationEnabled', () => {
  test('uses each messenger’s authoritative listener-enabled flag and preserves the default-on contract', () => {
    expect(typeof isMessengerIntegrationEnabled).toBe('function');
    if (!isMessengerIntegrationEnabled) return;

    expect(isMessengerIntegrationEnabled({ type: 'discord' })).toBe(true);
    expect(isMessengerIntegrationEnabled({ type: 'telegram' })).toBe(true);
    expect(isMessengerIntegrationEnabled({ type: 'discord', discordListenerEnabled: false })).toBe(false);
    expect(isMessengerIntegrationEnabled({ type: 'telegram', telegramListenerEnabled: false })).toBe(false);
    expect(isMessengerIntegrationEnabled({
      type: 'discord',
      discordListenerEnabled: true,
      telegramListenerEnabled: false,
    })).toBe(true);
    expect(isMessengerIntegrationEnabled({
      type: 'telegram',
      discordListenerEnabled: false,
      telegramListenerEnabled: true,
    })).toBe(true);
  });
});
