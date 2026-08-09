import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  useMessengerStore,
  type MessengerConnection,
} from '@/stores/useMessengerStore';
import {
  TelegramUserInfoBotHint,
  parseMessengerIdList,
} from './messenger-shared';

const TOTAL_STEPS = 3;
const BOTFATHER_URL = 'https://t.me/BotFather';

type TelegramOnboardingWizardProps = {
  conn: MessengerConnection;
};

export function TelegramOnboardingWizard({ conn }: TelegramOnboardingWizardProps) {
  const { t } = useI18n();
  const step = useMessengerStore((s) => s.onboardingStep) ?? 0;
  const nextOnboardingStep = useMessengerStore((s) => s.nextOnboardingStep);
  const prevOnboardingStep = useMessengerStore((s) => s.prevOnboardingStep);
  const finishOnboarding = useMessengerStore((s) => s.finishOnboarding);
  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const testConnection = useMessengerStore((s) => s.testConnection);
  const saveTelegramConfig = useMessengerStore((s) => s.saveTelegramConfig);
  const sendTestMessage = useMessengerStore((s) => s.sendTestMessage);
  const startTelegramListener = useMessengerStore((s) => s.startTelegramListener);
  const stopTelegramListener = useMessengerStore((s) => s.stopTelegramListener);
  const refreshTelegramListenerStatus = useMessengerStore((s) => s.refreshTelegramListenerStatus);

  const [tokenInput, setTokenInput] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [userInput, setUserInput] = useState('');
  const [startingListener, setStartingListener] = useState(false);
  const [listenerStatusText, setListenerStatusText] = useState<string | null>(null);

  const hasToken = Boolean(conn.botToken);
  const isConnected = conn.status === 'connected';
  const listenerRunning = Boolean(conn.telegramListenerRunning);
  const listenerLive = Boolean(conn.telegramListenerRunning && conn.telegramListenerConnected);
  const listenerStuck = listenerRunning && !listenerLive && !startingListener;
  const ownerUserIds = conn.telegramOwnerUserIds ?? [];
  const hasOwners = ownerUserIds.length > 0;

  const canAdvance = (() => {
    if (step === 0) return hasToken && isConnected;
    if (step === 1) return hasOwners;
    if (step === 2) return listenerRunning;
    return false;
  })();

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  const handleSaveToken = () => {
    if (!tokenInput.trim()) return;
    updateConnection('telegram', { botToken: tokenInput.trim(), enabled: true });
    setTimeout(() => saveTelegramConfig(), 0);
    setTokenInput('');
    setTimeout(() => void testConnection('telegram'), 0);
  };

  const handleFinish = () => {
    finishOnboarding();
  };

  const handleNext = () => {
    if (step >= TOTAL_STEPS - 1) {
      handleFinish();
      return;
    }
    nextOnboardingStep();
  };

  const handleStartListener = async () => {
    setStartingListener(true);
    setListenerStatusText(t('settings.integrations.telegram.wizard.step3.listenerStarting'));
    try {
      if (listenerStuck) {
        await stopTelegramListener();
      }
      const ok = await startTelegramListener();
      if (!ok) {
        const err = useMessengerStore.getState().connections.find((c) => c.type === 'telegram')
          ?.telegramListenerError;
        setListenerStatusText(
          t('settings.integrations.telegram.wizard.step3.listenerError', {
            error: err ?? 'start failed',
          }),
        );
        return;
      }
      if (!useMessengerStore.getState().connections.find((c) => c.type === 'telegram')
        ?.telegramListenerConnected) {
        setListenerStatusText(t('settings.integrations.telegram.wizard.step3.listenerConnecting'));
        await refreshTelegramListenerStatus();
      }
      setListenerStatusText(null);
    } finally {
      setStartingListener(false);
    }
  };

  return (
    <div
      className="rounded-lg border border-[color-mix(in_srgb,var(--primary-base)_20%,transparent)] bg-[color-mix(in_srgb,var(--primary-base)_5%,var(--background))] p-4 space-y-4"
      data-settings-item="integrations.telegram.wizard"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="typography-ui-header font-medium text-foreground">
            {t('settings.integrations.telegram.wizard.title')}
          </h4>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t('settings.integrations.telegram.wizard.stepOf', {
              current: step + 1,
              total: TOTAL_STEPS,
            })}
          </p>
        </div>
        <button
          type="button"
          onClick={handleFinish}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          {t('settings.integrations.telegram.wizard.skipToAdvanced')}
        </button>
      </div>

      {/* Step indicators */}
      <div className="flex gap-1">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors',
              i <= step
                ? 'bg-[var(--primary-base)]'
                : 'bg-[var(--surface-muted)]',
            )}
          />
        ))}
      </div>

      {/* Step 0: Create bot + token */}
      {step === 0 && (
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-foreground">
              {t('settings.integrations.telegram.wizard.step1.title')}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              {t('settings.integrations.telegram.wizard.step1.description')}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => window.open(BOTFATHER_URL, '_blank', 'noopener,noreferrer')}
          >
            <Icon name="external-link" className="size-3.5" />
            {t('settings.integrations.telegram.wizard.step1.openBotFather')}
          </Button>
          <ol className="list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground leading-snug">
            <li>{t('settings.integrations.telegram.wizard.step1.stepNewBot')}</li>
            <li>{t('settings.integrations.telegram.wizard.step1.stepName')}</li>
            <li>{t('settings.integrations.telegram.wizard.step1.stepCopyToken')}</li>
          </ol>
          {!hasToken ? (
            <div className="flex gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={t('settings.integrations.telegram.wizard.step1.tokenLabel')}
                className={inputClass}
              />
              <Button
                type="button"
                size="sm"
                disabled={!tokenInput.trim()}
                onClick={handleSaveToken}
              >
                {t('settings.integrations.telegram.actions.saveToken')}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Icon name="check" className="size-3.5 text-[var(--status-success)]" />
                {isConnected
                  ? t('settings.integrations.telegram.wizard.step1.verified', {
                      username: conn.telegramBotUsername ?? 'bot',
                    })
                  : t('settings.integrations.telegram.wizard.step1.tokenLabel')}
              </div>
              {!isConnected && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="!font-normal"
                  disabled={conn.status === 'connecting'}
                  onClick={() => void testConnection('telegram')}
                >
                  {conn.status === 'connecting'
                    ? t('settings.integrations.telegram.wizard.step1.verifying')
                    : t('settings.integrations.telegram.wizard.step1.verify')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Step 1: Chat (optional) + owner ids (required) */}
      {step === 1 && (
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-foreground">
              {t('settings.integrations.telegram.wizard.step2.title')}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              {t('settings.integrations.telegram.wizard.step2.description')}
            </p>
          </div>
          {!conn.defaultChatId ? (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-foreground">
                {t('settings.integrations.telegram.wizard.step2.chatLabel')}
              </label>
              <p className="text-[10px] text-muted-foreground">
                <TelegramUserInfoBotHint
                  beforeKey="settings.integrations.telegram.wizard.step2.chatHint.before"
                  afterKey="settings.integrations.telegram.wizard.step2.chatHint.after"
                />
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="-1001234567890"
                  className={inputClass}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={!chatInput.trim()}
                  onClick={() => {
                    updateConnection('telegram', { defaultChatId: chatInput.trim() });
                    setChatInput('');
                    setTimeout(() => saveTelegramConfig(), 0);
                  }}
                >
                  {t('settings.integrations.telegram.actions.saveToken')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <Icon name="check" className="size-3.5 text-[var(--status-success)]" />
              <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                {conn.defaultChatId}
              </code>
            </div>
          )}
          {!hasOwners ? (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-foreground">
                {t('settings.integrations.telegram.wizard.step2.userLabel')}
              </label>
              <p className="text-[10px] text-muted-foreground">
                <TelegramUserInfoBotHint
                  beforeKey="settings.integrations.telegram.wizard.step2.userHint.before"
                  afterKey="settings.integrations.telegram.wizard.step2.userHint.after"
                />
              </p>
              <p className="text-[10px] text-[var(--status-warning)] leading-snug">
                {t('settings.integrations.telegram.wizard.step2.userRequired')}
              </p>
              <div className="flex gap-2">
                <textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder={t('settings.integrations.telegram.wizard.step2.userPlaceholder')}
                  className={cn(inputClass, 'min-h-16 resize-y')}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={parseMessengerIdList(userInput).length === 0}
                  onClick={() => {
                    const telegramOwnerUserIds = parseMessengerIdList(userInput);
                    if (telegramOwnerUserIds.length === 0) return;
                    updateConnection('telegram', {
                      telegramOwnerUserIds,
                      defaultUserId: telegramOwnerUserIds[0],
                    });
                    setUserInput('');
                    setTimeout(() => saveTelegramConfig(), 0);
                  }}
                >
                  {t('settings.integrations.telegram.actions.saveToken')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <Icon name="check" className="size-3.5 text-[var(--status-success)]" />
                <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                  {ownerUserIds.join(', ')}
                </code>
              </div>
            </div>
          )}
          {conn.telegramCanReadAllGroupMessages === false && (
            <p className="text-[11px] text-[var(--status-warning)] leading-snug">
              {t('settings.integrations.telegram.wizard.step2.privacyHint')}
            </p>
          )}
          {conn.defaultChatId && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                disabled={conn.lastSyncStatus === 'sending'}
                onClick={() => void sendTestMessage('telegram')}
              >
                {t('settings.integrations.telegram.wizard.step2.sendTest')}
              </Button>
              {conn.lastSyncMessage && (
                <span
                  className={cn(
                    'text-[10px] self-center',
                    conn.lastSyncStatus === 'error'
                      ? 'text-[var(--status-error)]'
                      : 'text-muted-foreground',
                  )}
                >
                  {conn.lastSyncMessage}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Step 2: Start listener */}
      {step === 2 && (
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-foreground">
              {t('settings.integrations.telegram.wizard.step3.title')}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
              {t('settings.integrations.telegram.wizard.step3.description')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              disabled={startingListener || (listenerRunning && listenerLive)}
              onClick={() => void handleStartListener()}
            >
              {startingListener ? (
                <Icon name="loader-4" className="size-3.5 animate-spin" />
              ) : (
                <Icon name="play" className="size-3.5" />
              )}
              {listenerStuck
                ? t('settings.integrations.telegram.wizard.step3.retryListener')
                : t('settings.integrations.telegram.wizard.step3.startListener')}
            </Button>
            <span
              className={cn(
                'text-[10px]',
                listenerLive
                  ? 'text-[var(--status-success)]'
                  : listenerRunning
                    ? 'text-[var(--status-warning)]'
                    : 'text-muted-foreground',
              )}
            >
              {listenerLive
                ? t('settings.integrations.telegram.wizard.step3.listenerLive')
                : listenerRunning
                  ? t('settings.integrations.telegram.wizard.step3.listenerConnecting')
                  : t('settings.integrations.telegram.wizard.step3.listenerStopped')}
            </span>
          </div>
          {conn.telegramListenerError && (
            <p className="text-[11px] text-[var(--status-error)]">{conn.telegramListenerError}</p>
          )}
          {listenerStatusText && (
            <p className="text-[11px] text-muted-foreground">{listenerStatusText}</p>
          )}
          {canAdvance && (
            <p className="text-[11px] text-[var(--status-success)]">
              {t('settings.integrations.telegram.wizard.step3.complete')}
            </p>
          )}
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="!font-normal"
          disabled={step === 0}
          onClick={prevOnboardingStep}
        >
          {t('settings.integrations.telegram.wizard.back')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canAdvance}
          onClick={handleNext}
        >
          {step >= TOTAL_STEPS - 1
            ? t('settings.integrations.telegram.wizard.finish')
            : t('settings.integrations.telegram.wizard.next')}
        </Button>
      </div>
    </div>
  );
}
