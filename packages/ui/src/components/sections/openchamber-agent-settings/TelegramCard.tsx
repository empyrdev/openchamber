import React, { useEffect, useState } from 'react';
import {
  deriveTelegramDisplayStatus,
  useMessengerStore,
  type MessengerConnection,
  type MessengerInboundMessage,
  type MessengerVerbosity,
  type MessengerPermissionMode,
} from '@/stores/useMessengerStore';
import { useOpenChamberAgentEventsStore, type OpenChamberAgentUiRealtimeEvent } from '@/stores/useOpenChamberAgentEventsStore';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { IntegrationCard } from '../integrations/IntegrationCard';
import {
  AdvancedSectionCard,
  BehaviorPanel,
  DangerZoneRow,
  MessengerSegmentedControl,
  SessionBindingsPanel,
  StatusBadge,
  formatRelative,
  isMessengerIntegrationEnabled,
  type MessengerBehaviorStrings,
} from './messenger-shared';
import { TelegramOnboardingWizard } from './TelegramOnboardingWizard';

/** Telegram brand mark — intentional product color, not a theme token. */
const TELEGRAM_BRAND_CLASS = 'text-[#2AABEE]';

function useTelegramStatusLabels(): Record<MessengerConnection['status'], string> {
  const { t } = useI18n();
  return {
    connected: t('settings.integrations.telegram.status.connected'),
    connecting: t('settings.integrations.telegram.status.connecting'),
    error: t('settings.integrations.telegram.status.error'),
    disconnected: t('settings.integrations.telegram.status.disconnected'),
  };
}

const TELEGRAM_VERBOSITY_OPTIONS: {
  id: MessengerVerbosity;
  labelKey: I18nKey;
  descKey: I18nKey;
}[] = [
  {
    id: 'quiet',
    labelKey: 'settings.integrations.telegram.bridge.verbosity.quiet.label',
    descKey: 'settings.integrations.telegram.bridge.verbosity.quiet.desc',
  },
  {
    id: 'normal',
    labelKey: 'settings.integrations.telegram.bridge.verbosity.normal.label',
    descKey: 'settings.integrations.telegram.bridge.verbosity.normal.desc',
  },
  {
    id: 'verbose',
    labelKey: 'settings.integrations.telegram.bridge.verbosity.verbose.label',
    descKey: 'settings.integrations.telegram.bridge.verbosity.verbose.desc',
  },
];

const TELEGRAM_PERMISSION_MODE_OPTIONS: {
  id: MessengerPermissionMode;
  labelKey: I18nKey;
  descKey: I18nKey;
}[] = [
  {
    id: 'ask',
    labelKey: 'settings.integrations.telegram.bridge.permissionMode.ask.label',
    descKey: 'settings.integrations.telegram.bridge.permissionMode.ask.desc',
  },
  {
    id: 'yolo',
    labelKey: 'settings.integrations.telegram.bridge.permissionMode.yolo.label',
    descKey: 'settings.integrations.telegram.bridge.permissionMode.yolo.desc',
  },
  {
    id: 'agent',
    labelKey: 'settings.integrations.telegram.bridge.permissionMode.agent.label',
    descKey: 'settings.integrations.telegram.bridge.permissionMode.agent.desc',
  },
];

function useTelegramBehaviorStrings(): MessengerBehaviorStrings {
  const { t } = useI18n();
  return {
    unavailable: t('settings.integrations.telegram.bridge.unavailable'),
    verbosityTitle: t('settings.integrations.telegram.bridge.verbosity.title'),
    verbosityOptions: TELEGRAM_VERBOSITY_OPTIONS.map((opt) => ({
      id: opt.id,
      label: t(opt.labelKey),
      desc: t(opt.descKey),
    })),
    permissionTitle: t('settings.integrations.telegram.bridge.permissionMode.title'),
    permissionOptions: TELEGRAM_PERMISSION_MODE_OPTIONS.map((opt) => ({
      id: opt.id,
      label: t(opt.labelKey),
      desc: t(opt.descKey),
    })),
    notifyTitle: t('settings.integrations.telegram.bridge.notifyOnComplete.title'),
    notifyDescription: t('settings.integrations.telegram.bridge.notifyOnComplete.description'),
    critiqueTitle: t('settings.integrations.telegram.bridge.critique.title'),
    critiqueDescription: t('settings.integrations.telegram.bridge.critique.description'),
    interruptTitle: t('settings.integrations.telegram.bridge.interruptTimeout.title'),
    interruptUnit: t('settings.integrations.telegram.bridge.interruptTimeout.unit'),
    interruptDescription: t('settings.integrations.telegram.bridge.interruptTimeout.description'),
    activeLabel: (count) =>
      count === 1
        ? t('settings.integrations.telegram.bridge.activeOne')
        : t('settings.integrations.telegram.bridge.activeMany', { count }),
  };
}

function TelegramListenerPanel({ conn }: { conn: MessengerConnection }) {
  const { t } = useI18n();
  const inbound = useMessengerStore((s) => s.telegramInbound);
  const startTelegramListener = useMessengerStore((s) => s.startTelegramListener);
  const stopTelegramListener = useMessengerStore((s) => s.stopTelegramListener);
  const refreshTelegramListenerStatus = useMessengerStore((s) => s.refreshTelegramListenerStatus);
  const loadRecentTelegramMessages = useMessengerStore((s) => s.loadRecentTelegramMessages);
  const subscribeToEvents = useOpenChamberAgentEventsStore((s) => s.subscribeToEvents);
  const ingestTelegramInbound = useMessengerStore((s) => s.ingestTelegramInbound);

  const running = Boolean(conn.telegramListenerRunning);
  const connected = Boolean(conn.telegramListenerConnected);

  useEffect(() => {
    if (!running) return;
    const handler = (event: OpenChamberAgentUiRealtimeEvent) => {
      if (event.eventType !== 'messenger.telegram.message_received') return;
      const data = event.data as MessengerInboundMessage | undefined;
      if (data && typeof data === 'object' && 'updateId' in data) {
        ingestTelegramInbound(data);
      }
    };
    return subscribeToEvents(handler);
  }, [running, subscribeToEvents, ingestTelegramInbound]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await Promise.all([refreshTelegramListenerStatus(), loadRecentTelegramMessages()]);
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, refreshTelegramListenerStatus, loadRecentTelegramMessages]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          {t('settings.integrations.telegram.listener.title')}
        </div>
        <div className="flex items-center gap-2">
          {!running ? (
            <Button
              type="button"
              variant="default"
              size="xs"
              className="!font-normal normal-case"
              onClick={() => void startTelegramListener()}
            >
              <Icon name="play" className="size-3.5" />
              {t('settings.integrations.telegram.listener.start')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal normal-case text-[var(--status-error)] hover:text-[var(--status-error)]"
              onClick={() => void stopTelegramListener()}
            >
              <Icon name="stop" className="size-3.5" />
              {t('settings.integrations.telegram.listener.stop')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] @xl:grid-cols-4">
        <div className="rounded-lg border border-border bg-background px-2 py-1.5">
          <div className="text-muted-foreground">
            {t('settings.integrations.telegram.listener.stats.seen')}
          </div>
          <div className="text-foreground font-medium">
            {conn.telegramListenerTotalRawMessages ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-background px-2 py-1.5">
          <div className="text-muted-foreground">
            {t('settings.integrations.telegram.listener.stats.forwarded')}
          </div>
          <div className="text-foreground font-medium">
            {conn.telegramListenerTotalReceived ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-background px-2 py-1.5">
          <div className="text-muted-foreground">
            {t('settings.integrations.telegram.listener.stats.replied')}
          </div>
          <div className="text-foreground font-medium">
            {conn.telegramListenerTotalReplied ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-background px-2 py-1.5">
          <div className="text-muted-foreground">
            {t('settings.integrations.telegram.listener.stats.lastUpdate')}
          </div>
          <div className="text-foreground font-medium">
            {formatRelative(
              conn.telegramListenerLastUpdateAt ?? null,
              t,
              t('settings.integrations.telegram.relative.never'),
            )}
          </div>
        </div>
      </div>

      {/* Privacy-mode hint: the poll is live but delivers nothing — usually
          group privacy mode or the message reaching a different bot. */}
      {connected && (conn.telegramListenerTotalRawMessages ?? 0) === 0 && (
        <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground leading-snug">
          {t('settings.integrations.telegram.listener.privacyHint')}
        </div>
      )}

      {conn.telegramListenerError && (
        <div className="text-[11px] text-destructive flex items-start gap-1.5 leading-snug">
          <Icon name="alert" className="size-3.5 shrink-0 mt-0.5" />
          {conn.telegramListenerError}
        </div>
      )}

      {!running ? (
        <div className="text-[11px] text-muted-foreground leading-snug">
          {t('settings.integrations.telegram.listener.startHint')}
        </div>
      ) : inbound.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic">
          {t('settings.integrations.telegram.listener.waiting')}
        </div>
      ) : (
        <ul className="space-y-1.5 max-h-48 overflow-y-auto">
          {inbound.slice(0, 8).map((m) => (
            <li
              key={String(m.updateId)}
              className="rounded bg-background border border-border px-2 py-1.5 text-[11px] space-y-0.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground truncate">
                  {m.from?.firstName ?? m.from?.username ?? t('settings.integrations.telegram.recent.fromUnknown')}
                  {m.from?.username ? (
                    <span className="text-muted-foreground"> @{m.from.username}</span>
                  ) : null}
                </span>
                <span className="text-[9px] text-muted-foreground shrink-0">
                  {new Date(m.receivedAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-muted-foreground break-words">
                {m.text ?? <em>{t('settings.integrations.telegram.recent.nonText')}</em>}
              </div>
              <div className="text-[9px] text-muted-foreground">
                {t('settings.integrations.telegram.recent.chatLabel')} {m.chatId}
                {m.chatTitle ? ` · ${m.chatTitle}` : ''}
                {m.telegram?.messageThreadId
                  ? ` · ${t('settings.integrations.telegram.recent.topicLabel')} ${m.telegram.messageThreadId}`
                  : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type TelegramDangerZoneKey = 'fallback' | 'owner' | 'allowed' | 'replyMode';

function TelegramAdvancedSettings({ conn }: { conn: MessengerConnection }) {
  const { t } = useI18n();
  const behaviorStrings = useTelegramBehaviorStrings();
  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const saveTelegramConfig = useMessengerStore((s) => s.saveTelegramConfig);
  const refreshBridgeStatus = useMessengerStore((s) => s.refreshBridgeStatus);
  const bridgeStatus = useMessengerStore((s) => s.bridgeStatus);

  const [chatInput, setChatInput] = useState('');
  const [sectionOpen, setSectionOpen] = useState({
    behavior: true,
    diagnostics: false,
    bindings: false,
  });
  const [dangerOpen, setDangerOpen] = useState<TelegramDangerZoneKey | null>(null);

  useEffect(() => {
    void refreshBridgeStatus('telegram');
    const id = setInterval(() => void refreshBridgeStatus('telegram'), 8000);
    return () => clearInterval(id);
  }, [refreshBridgeStatus]);

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  const listenerConnected = Boolean(conn.telegramListenerConnected);
  const listenerRunning = Boolean(conn.telegramListenerRunning);
  const seen = conn.telegramListenerTotalRawMessages ?? 0;
  const forwarded = conn.telegramListenerTotalReceived ?? 0;
  const replied = conn.telegramListenerTotalReplied ?? 0;
  const bindingsCount = bridgeStatus.bindings.filter((b) => b.type === 'telegram').length;

  const persist = () => setTimeout(() => saveTelegramConfig(), 0);
  const toggleDanger = (key: TelegramDangerZoneKey) => {
    setDangerOpen((prev) => (prev === key ? null : key));
  };

  const listenerBadge = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
        listenerConnected
          ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
          : listenerRunning
            ? 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]'
            : 'bg-muted text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          listenerConnected
            ? 'bg-[var(--status-success)]'
            : listenerRunning
              ? 'bg-[var(--status-warning)]'
              : 'bg-muted-foreground',
        )}
      />
      {listenerConnected
        ? t('settings.integrations.telegram.listener.status.live')
        : listenerRunning
          ? t('settings.integrations.telegram.listener.status.connecting')
          : t('settings.integrations.telegram.listener.status.off')}
    </span>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1 px-0.5">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">
          {t('settings.integrations.telegram.actions.advancedSettings')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('settings.integrations.telegram.advanced.description')}
        </p>
      </div>

      <div className="space-y-3">
        <AdvancedSectionCard
          icon="settings-3"
          title={t('settings.integrations.telegram.advanced.behavior.title')}
          open={sectionOpen.behavior}
          onOpenChange={(next) => setSectionOpen((s) => ({ ...s, behavior: next }))}
        >
          <BehaviorPanel
            type="telegram"
            bridgeStatus={bridgeStatus}
            refreshBridgeStatus={refreshBridgeStatus}
            strings={behaviorStrings}
            settingsItemPrefix="integrations.telegram"
          />
        </AdvancedSectionCard>

        <AdvancedSectionCard
          icon="pulse"
          title={t('settings.integrations.telegram.advanced.diagnostics.title')}
          badge={listenerBadge}
          meta={t('settings.integrations.telegram.advanced.diagnostics.stats', {
            seen,
            forwarded,
            replied,
          })}
          open={sectionOpen.diagnostics}
          onOpenChange={(next) => setSectionOpen((s) => ({ ...s, diagnostics: next }))}
        >
          <TelegramListenerPanel conn={conn} />
        </AdvancedSectionCard>

        <AdvancedSectionCard
          icon="apps"
          title={t('settings.integrations.telegram.advanced.sessionBindings.title')}
          meta={
            bindingsCount === 1
              ? t('settings.integrations.telegram.advanced.sessionBindings.countOne')
              : t('settings.integrations.telegram.advanced.sessionBindings.count', {
                  count: bindingsCount,
                })
          }
          open={sectionOpen.bindings}
          onOpenChange={(next) => setSectionOpen((s) => ({ ...s, bindings: next }))}
        >
          <SessionBindingsPanel
            type="telegram"
            bridgeStatus={bridgeStatus}
            emptyText={t('settings.integrations.telegram.advanced.sessionBindings.empty')}
          />
        </AdvancedSectionCard>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--status-error)]/30 bg-[color-mix(in_srgb,var(--status-error)_6%,var(--background))]">
        <div className="flex items-center gap-2 px-4 py-3">
          <Icon name="alert" className="size-4 text-[var(--status-error)]" />
          <span className="text-sm font-semibold text-[var(--status-error)]">
            {t('settings.integrations.telegram.advanced.dangerZone.title')}
          </span>
        </div>
        <div className="divide-y divide-border/60 border-t border-[var(--status-error)]/20">
          <DangerZoneRow
            label={t('settings.integrations.telegram.advanced.fallbackChat.title')}
            open={dangerOpen === 'fallback'}
            onToggle={() => toggleDanger('fallback')}
          >
            <div data-settings-item="integrations.telegram.fallback-chat" className="space-y-2">
              <div className="text-xs text-muted-foreground leading-snug">
                {t('settings.integrations.telegram.advanced.fallbackChat.description')}
              </div>
              {conn.defaultChatId ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
                    {conn.defaultChatId}
                  </code>
                  <Icon name="check" className="size-3 text-[var(--status-success)]" />
                  <button
                    type="button"
                    onClick={() => {
                      updateConnection('telegram', { defaultChatId: undefined });
                      persist();
                    }}
                    className="text-primary text-[10px] hover:underline"
                  >
                    {t('settings.integrations.telegram.advanced.fallbackChat.change')}
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={t('settings.integrations.telegram.advanced.fallbackChat.placeholder')}
                    className={inputClass}
                  />
                  <Button
                    type="button"
                    variant="default"
                    size="xs"
                    className="!font-normal normal-case shrink-0"
                    disabled={!chatInput.trim()}
                    onClick={() => {
                      updateConnection('telegram', { defaultChatId: chatInput.trim() });
                      setChatInput('');
                      persist();
                    }}
                  >
                    {t('settings.integrations.telegram.actions.saveToken')}
                  </Button>
                </div>
              )}
            </div>
          </DangerZoneRow>
          <DangerZoneRow
            label={t('settings.integrations.telegram.advanced.ownerUserId.title')}
            open={dangerOpen === 'owner'}
            onToggle={() => toggleDanger('owner')}
          >
            <div data-settings-item="integrations.telegram.owner-user" className="space-y-2">
              <div className="text-xs text-muted-foreground leading-snug">
                {t('settings.integrations.telegram.advanced.ownerUserId.description')}
              </div>
              <input
                type="text"
                value={conn.defaultUserId ?? ''}
                onChange={(e) =>
                  updateConnection('telegram', { defaultUserId: e.target.value.trim() })
                }
                onBlur={persist}
                placeholder={t('settings.integrations.telegram.advanced.ownerUserId.placeholder')}
                className={inputClass}
              />
            </div>
          </DangerZoneRow>
          <DangerZoneRow
            label={t('settings.integrations.telegram.advanced.allowedChats.title')}
            open={dangerOpen === 'allowed'}
            onToggle={() => toggleDanger('allowed')}
          >
            <div data-settings-item="integrations.telegram.allowed-chats" className="space-y-2">
              <div className="text-xs text-muted-foreground leading-snug">
                {t('settings.integrations.telegram.advanced.allowedChats.description')}
              </div>
              <textarea
                value={(conn.telegramAllowedChatIds ?? []).join('\n')}
                onChange={(e) => {
                  const telegramAllowedChatIds = e.target.value
                    .split(/[\s,]+/)
                    .map((id) => id.trim())
                    .filter(Boolean);
                  updateConnection('telegram', { telegramAllowedChatIds });
                }}
                onBlur={persist}
                placeholder={t('settings.integrations.telegram.advanced.allowedChats.placeholder')}
                className={cn(inputClass, 'min-h-16 resize-y')}
              />
            </div>
          </DangerZoneRow>
          <DangerZoneRow
            label={t('settings.integrations.telegram.advanced.replyMode.title')}
            open={dangerOpen === 'replyMode'}
            onToggle={() => toggleDanger('replyMode')}
          >
            <div data-settings-item="integrations.telegram.reply-mode" className="space-y-2">
              <MessengerSegmentedControl
                value={conn.telegramDefaultReplyMode ?? 'always'}
                ariaLabel={t('settings.integrations.telegram.advanced.replyMode.title')}
                onChange={(mode) => {
                  updateConnection('telegram', { telegramDefaultReplyMode: mode });
                  persist();
                }}
                options={[
                  {
                    id: 'always' as const,
                    label: t('settings.integrations.telegram.advanced.replyMode.always'),
                  },
                  {
                    id: 'mention' as const,
                    label: t('settings.integrations.telegram.advanced.replyMode.mention'),
                  },
                ]}
              />
              <div className="text-xs text-muted-foreground leading-snug">
                {conn.telegramDefaultReplyMode === 'mention'
                  ? t('settings.integrations.telegram.advanced.replyMode.mentionDesc')
                  : t('settings.integrations.telegram.advanced.replyMode.alwaysDesc')}
              </div>
            </div>
          </DangerZoneRow>
        </div>
      </div>
    </div>
  );
}

export function TelegramSectionCard({ conn }: { conn: MessengerConnection }) {
  const { t } = useI18n();
  const statusLabels = useTelegramStatusLabels();
  const updateConnection = useMessengerStore((s) => s.updateConnection);
  const testConnection = useMessengerStore((s) => s.testConnection);
  const disconnectTelegram = useMessengerStore((s) => s.disconnectTelegram);
  const saveTelegramConfig = useMessengerStore((s) => s.saveTelegramConfig);
  const startTelegramListener = useMessengerStore((s) => s.startTelegramListener);
  const stopTelegramListener = useMessengerStore((s) => s.stopTelegramListener);
  const refreshTelegramListenerStatus = useMessengerStore((s) => s.refreshTelegramListenerStatus);
  const onboardingStep = useMessengerStore((s) => s.onboardingStep);
  const onboardingType = useMessengerStore((s) => s.onboardingType);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [integrationTogglePending, setIntegrationTogglePending] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const displayStatus = deriveTelegramDisplayStatus(conn);
  const hasToken = Boolean(conn.botToken);
  const configured = hasToken || Boolean(conn.telegramServerConfigured);
  const showWizard = onboardingStep !== null && onboardingType === 'telegram';
  const integrationEnabled = isMessengerIntegrationEnabled(conn);

  // Reconcile badge + listener with the live server when this card opens.
  useEffect(() => {
    void useMessengerStore.getState().resyncTelegramStatus();
  }, [conn.botToken]);

  const handleSaveToken = () => {
    if (!tokenInput.trim()) return;
    updateConnection('telegram', { botToken: tokenInput.trim(), enabled: true });
    setTimeout(() => saveTelegramConfig(), 0);
    // Re-verify so a bad replacement token flips the badge to error instead
    // of coasting on the previous token's connected status.
    setTimeout(() => void testConnection('telegram'), 0);
    setTokenInput('');
    setShowToken(false);
  };

  const handleIntegrationEnabledChange = async (enabled: boolean) => {
    if (!configured) return;
    setIntegrationTogglePending(true);
    try {
      const succeeded = enabled
        ? await startTelegramListener()
        : await stopTelegramListener();
      if (!succeeded) {
        await refreshTelegramListenerStatus();
      }
    } catch {
      await refreshTelegramListenerStatus();
    } finally {
      setIntegrationTogglePending(false);
    }
  };

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  return (
    <>
      <IntegrationCard
        open={showWizard || cardOpen}
        onOpenChange={setCardOpen}
        settingsItem="integrations.telegram"
        header={(
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-muted)]">
              <Icon name="telegram-fill" className={cn('size-5', TELEGRAM_BRAND_CLASS)} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">Telegram</div>
              {conn.telegramBotUsername ? (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">@{conn.telegramBotUsername}</p>
              ) : null}
            </div>
            {integrationEnabled ? (
              <StatusBadge status={displayStatus} labels={statusLabels} />
            ) : (
              <span className="shrink-0 rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {t('settings.integrations.telegram.listener.status.off')}
              </span>
            )}
          </div>
        )}
        headerAction={
          configured && !showWizard ? (
            <div className="flex items-center gap-2">
              {integrationTogglePending ? <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" /> : null}
              <Switch
                checked={integrationEnabled}
                disabled={integrationTogglePending}
                onCheckedChange={(enabled) => void handleIntegrationEnabledChange(enabled)}
                aria-label={t('settings.integrations.telegram.listener.title')}
              />
            </div>
          ) : undefined
        }
      >
        <div className="space-y-5">
          {conn.error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
              <span>{conn.error}</span>
            </div>
          )}

          {showWizard ? (
            <TelegramOnboardingWizard conn={conn} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="!font-normal whitespace-nowrap"
                  onClick={() => setAdvancedOpen((open) => !open)}
                >
                  <Icon name="settings-3" className="size-3.5" />
                  {t('settings.integrations.telegram.actions.advancedSettings')}
                </Button>
                {configured ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="!font-normal whitespace-nowrap border-[var(--status-error)]/40 text-[var(--status-error)] hover:text-[var(--status-error)]"
                    onClick={() => setDisconnectConfirmOpen(true)}
                  >
                    {t('settings.integrations.telegram.disconnect.button')}
                  </Button>
                ) : null}
              </div>

              {advancedOpen && (
                <div className="space-y-4 border-t border-[var(--interactive-border)] pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="!font-normal"
                      onClick={() => setShowToken((v) => !v)}
                    >
                      {showToken
                        ? t('settings.common.actions.cancel')
                        : t('settings.integrations.telegram.actions.changeToken')}
                    </Button>
                    {displayStatus !== 'connected' && (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="!font-normal"
                        onClick={() => void testConnection('telegram')}
                        disabled={!configured || conn.status === 'connecting'}
                      >
                        {conn.status === 'connecting'
                          ? t('settings.integrations.telegram.wizard.step1.verifying')
                          : t('settings.integrations.telegram.wizard.step1.verify')}
                      </Button>
                    )}
                  </div>

                  {showToken && (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <input
                        type="password"
                        value={tokenInput}
                        onChange={(e) => setTokenInput(e.target.value)}
                        placeholder={t('settings.integrations.telegram.wizard.step1.tokenLabel')}
                        className={cn(inputClass, 'min-w-[12rem] flex-1')}
                      />
                      <Button
                        type="button"
                        variant="default"
                        size="xs"
                        className="!font-normal shrink-0"
                        onClick={handleSaveToken}
                        disabled={!tokenInput.trim()}
                      >
                        {t('settings.integrations.telegram.actions.updateToken')}
                      </Button>
                    </div>
                  )}

                  <TelegramAdvancedSettings conn={conn} />
                </div>
              )}
            </>
          )}
        </div>
      </IntegrationCard>

      <Dialog open={disconnectConfirmOpen} onOpenChange={setDisconnectConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.integrations.telegram.disconnect.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.integrations.telegram.disconnect.dialog.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDisconnectConfirmOpen(false)}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={disconnecting}
              onClick={() => {
                setDisconnecting(true);
                void disconnectTelegram().finally(() => {
                  setDisconnecting(false);
                  setDisconnectConfirmOpen(false);
                });
              }}
            >
              {t('settings.integrations.telegram.disconnect.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Square "Connect Telegram" tile — shown while no bot token is configured. */
export function TelegramConnectTile({ onConnect }: { onConnect: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onConnect}
      data-settings-item="integrations.telegram.connect"
      className="flex size-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-center text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <Icon name="telegram-fill" className={cn('size-9', TELEGRAM_BRAND_CLASS)} />
      <span className="flex items-center gap-1 text-xs font-medium">
        <Icon name="add" className="size-3.5" />
        {t('settings.integrations.telegram.connect')}
      </span>
      <span className="text-[10px] font-normal leading-snug text-muted-foreground/80">
        {t('settings.integrations.telegram.connectHint')}
      </span>
    </button>
  );
}
