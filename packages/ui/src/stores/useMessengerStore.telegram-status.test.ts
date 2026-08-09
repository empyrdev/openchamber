import { describe, expect, test } from 'bun:test';
import { deriveTelegramDisplayStatus, deriveTelegramViewState } from './useMessengerStore';

describe('deriveTelegramDisplayStatus', () => {
  test('prefers a live listener over persisted disconnected verify status', () => {
    expect(
      deriveTelegramDisplayStatus({
        status: 'disconnected',
        botToken: 'tok',
        telegramListenerRunning: true,
        telegramListenerConnected: true,
      }),
    ).toBe('connected');
  });

  test('shows connecting while the listener is running but not yet polling', () => {
    expect(
      deriveTelegramDisplayStatus({
        status: 'disconnected',
        botToken: 'tok',
        telegramListenerRunning: true,
        telegramListenerConnected: false,
      }),
    ).toBe('connecting');
  });

  test('shows connecting when a token exists but live state is not reconciled yet', () => {
    expect(
      deriveTelegramDisplayStatus({
        status: 'disconnected',
        botToken: 'tok',
        telegramListenerRunning: false,
        telegramListenerConnected: false,
      }),
    ).toBe('connecting');
  });

  test('falls back to the last token-verify result when the listener is off', () => {
    expect(
      deriveTelegramDisplayStatus({
        status: 'connected',
        botToken: 'tok',
        telegramListenerRunning: false,
        telegramListenerConnected: false,
      }),
    ).toBe('connected');
    expect(
      deriveTelegramDisplayStatus({
        status: 'error',
        botToken: 'tok',
        telegramListenerRunning: false,
        telegramListenerConnected: false,
      }),
    ).toBe('error');
    expect(
      deriveTelegramDisplayStatus({
        status: 'disconnected',
        botToken: undefined,
        telegramServerConfigured: false,
        telegramListenerRunning: false,
        telegramListenerConnected: false,
      }),
    ).toBe('disconnected');
  });

  test('server-configured without a local token shows connecting (not disconnected)', () => {
    expect(
      deriveTelegramDisplayStatus({
        status: 'disconnected',
        botToken: undefined,
        telegramServerConfigured: true,
        telegramListenerRunning: false,
        telegramListenerConnected: false,
      }),
    ).toBe('connecting');
  });
});

describe('deriveTelegramViewState', () => {
  test('fresh state (no token, no wizard) shows the square connect card', () => {
    expect(
      deriveTelegramViewState({ hasToken: false, serverConfigured: false, wizardActive: false }),
    ).toBe('connect-card');
  });

  test('active onboarding shows the wizard, with or without a token', () => {
    expect(
      deriveTelegramViewState({ hasToken: false, serverConfigured: false, wizardActive: true }),
    ).toBe('wizard');
    expect(
      deriveTelegramViewState({ hasToken: true, serverConfigured: false, wizardActive: true }),
    ).toBe('wizard');
  });

  test('a saved token without active onboarding shows the configured view', () => {
    expect(
      deriveTelegramViewState({ hasToken: true, serverConfigured: false, wizardActive: false }),
    ).toBe('configured');
  });

  test('server-configured without a local token shows the configured view', () => {
    expect(
      deriveTelegramViewState({ hasToken: false, serverConfigured: true, wizardActive: false }),
    ).toBe('configured');
  });
});
