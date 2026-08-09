import React, { useEffect } from 'react';
import {
  MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MAX_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MIN_MS,
  useMessengerStore,
  type MessengerType,
  type MessengerConnection,
  type MessengerVerbosity,
  type MessengerPermissionMode,
} from '@/stores/useMessengerStore';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';

/**
 * Presentational building blocks shared by the Discord and Telegram cards in
 * the Integrations settings section. Platform copy is injected per card —
 * every user-facing string arrives already localized (see the call sites in
 * MessengerSection.tsx / TelegramCard.tsx).
 */

/** Official Telegram Web deep link for @userinfobot (user-requested URL). */
const TELEGRAM_USERINFOBOT_URL = 'https://web.telegram.org/k/#@userinfobot';

/** Clickable @userinfobot link — visible handle is the product username. */
export function TelegramUserInfoBotLink({ className }: { className?: string }) {
  return (
    <a
      href={TELEGRAM_USERINFOBOT_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('text-primary hover:underline', className)}
    >
      @userinfobot
    </a>
  );
}

/** Localized copy with an embedded @userinfobot link (before + after keys). */
export function TelegramUserInfoBotHint({
  beforeKey,
  afterKey,
  className,
}: {
  beforeKey: I18nKey;
  afterKey: I18nKey;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <span className={className}>
      {t(beforeKey)}
      <TelegramUserInfoBotLink />
      {t(afterKey)}
    </span>
  );
}

/** Parse comma/whitespace/newline-separated messenger ids into a unique list. */
// eslint-disable-next-line react-refresh/only-export-components
export function parseMessengerIdList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  );
}

export type MessengerStatusLabels = Record<
  MessengerConnection['status'],
  string
>;

export function StatusBadge({
  status,
  labels,
}: {
  status: MessengerConnection['status'];
  labels: MessengerStatusLabels;
}) {
  const styles: Record<string, string> = {
    connected:
      'bg-[var(--status-success)]/15 text-[var(--status-success)]',
    connecting:
      'bg-[var(--status-warning)]/15 text-[var(--status-warning)]',
    error: 'bg-[var(--status-error)]/15 text-[var(--status-error)]',
    disconnected: 'bg-muted text-muted-foreground',
  };
  const label = labels[status];
  // Connected: checkmark only (label stays for accessibility). Other states keep text.
  if (status === 'connected') {
    return (
      <span
        className={cn(
          'inline-flex size-5 items-center justify-center rounded-full',
          styles.connected,
        )}
        title={label}
        aria-label={label}
      >
        <Icon name="check" className="size-3" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
        styles[status],
      )}
      aria-label={label}
    >
      {status === 'connecting' ? (
        <Icon name="loader-4" className="size-3 animate-spin" />
      ) : null}
      {label}
    </span>
  );
}

type TranslateFn = (key: I18nKey, params?: Record<string, string | number | boolean | null | undefined>) => string;

// eslint-disable-next-line react-refresh/only-export-components
export function formatRelative(ts: number | null | undefined, t: TranslateFn, neverLabel: string): string {
  if (!ts) return neverLabel;
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('common.relative.justNow');
  if (diff < 3_600_000) {
    return t('common.relative.minutesAgoShort', { count: Math.floor(diff / 60_000) });
  }
  if (diff < 86_400_000) {
    return t('common.relative.hoursAgoShort', { count: Math.floor(diff / 3_600_000) });
  }
  return new Date(ts).toLocaleString();
}

/** Collapsible card used by messenger Advanced settings accordion sections. */
export function AdvancedSectionCard({
  icon,
  title,
  meta,
  badge,
  open,
  onOpenChange,
  children,
}: {
  icon: IconName;
  title: string;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]">
        <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-none px-4 py-3 hover:bg-[var(--interactive-hover)]/50">
          <Icon name={icon} className="size-4 shrink-0 text-primary" />
          <span className="shrink-0 text-sm font-semibold text-foreground">{title}</span>
          {badge}
          {meta ? (
            <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">
              {meta}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <Icon
            name={open ? 'arrow-up-s' : 'arrow-down-s'}
            className="size-4 shrink-0 text-muted-foreground"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-3">
          {children}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** Segmented chip picker shared by the messenger behavior panels. */
export function MessengerSegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <Button
          key={opt.id}
          type="button"
          variant="chip"
          size="xs"
          disabled={disabled}
          aria-pressed={value === opt.id}
          className="!font-normal normal-case"
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

export function DangerZoneRow({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/40"
      >
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Icon
          name={open ? 'arrow-down-s' : 'arrow-right-s'}
          className="size-4 shrink-0 text-muted-foreground"
        />
      </button>
      {open ? <div className="space-y-2 px-4 pb-3">{children}</div> : null}
    </div>
  );
}

/** Fully localized copy for the behavior panel — resolved per platform. */
export interface MessengerBehaviorStrings {
  unavailable: string;
  verbosityTitle: string;
  verbosityOptions: { id: MessengerVerbosity; label: string; desc: string }[];
  permissionTitle: string;
  permissionOptions: { id: MessengerPermissionMode; label: string; desc: string }[];
  notifyTitle: string;
  notifyDescription: string;
  critiqueTitle: string;
  critiqueDescription: string;
  interruptTitle: string;
  interruptUnit: string;
  interruptDescription: string;
  activeLabel: (count: number) => string;
}

export function BehaviorPanel({
  type,
  bridgeStatus,
  refreshBridgeStatus,
  strings,
  settingsItemPrefix,
  worktreesSlot,
  footerNotes,
}: {
  type: MessengerType;
  bridgeStatus: ReturnType<typeof useMessengerStore.getState>['bridgeStatus'];
  refreshBridgeStatus: (t?: MessengerType) => Promise<void>;
  strings: MessengerBehaviorStrings;
  /** data-settings-item anchor prefix, e.g. 'integrations.discord'. */
  settingsItemPrefix: string;
  /** Optional platform-specific extra controls (Discord worktree sync). */
  worktreesSlot?: React.ReactNode;
  footerNotes?: React.ReactNode;
}) {
  const bridgeVerbosity = useMessengerStore((s) => s.bridgeVerbosity);
  const setBridgeVerbosity = useMessengerStore((s) => s.setBridgeVerbosity);
  const bridgePermissionMode = useMessengerStore((s) => s.bridgePermissionMode);
  const setBridgePermissionMode = useMessengerStore((s) => s.setBridgePermissionMode);
  const bridgeNotifyOnComplete = useMessengerStore((s) => s.bridgeNotifyOnComplete);
  const setBridgeNotifyOnComplete = useMessengerStore((s) => s.setBridgeNotifyOnComplete);
  const bridgeCritiqueEnabled = useMessengerStore((s) => s.bridgeCritiqueEnabled);
  const setBridgeCritiqueEnabled = useMessengerStore((s) => s.setBridgeCritiqueEnabled);
  const bridgeInterruptTimeoutMs = useMessengerStore((s) => s.bridgeInterruptTimeoutMs);
  const setBridgeInterruptTimeoutMs = useMessengerStore((s) => s.setBridgeInterruptTimeoutMs);
  useEffect(() => {
    refreshBridgeStatus(type);
    const id = setInterval(() => refreshBridgeStatus(type), 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const active = bridgeStatus.active.filter((a) => a.type === type);
  const currentVerbosity: MessengerVerbosity = bridgeVerbosity[type] ?? 'normal';
  const currentVerbosityOption =
    strings.verbosityOptions.find((o) => o.id === currentVerbosity) ?? strings.verbosityOptions[0];
  const currentPermissionMode: MessengerPermissionMode = bridgePermissionMode[type] ?? 'agent';
  const currentPermissionOption =
    strings.permissionOptions.find((o) => o.id === currentPermissionMode) ??
    strings.permissionOptions[0];
  const notifyOnComplete = bridgeNotifyOnComplete[type] ?? false;
  const critiqueEnabled = bridgeCritiqueEnabled[type] ?? false;
  const interruptTimeoutMs =
    bridgeInterruptTimeoutMs[type] ?? MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS;
  const controlsDisabled = !bridgeStatus.enabled;

  return (
    <div className="space-y-4">
      {!bridgeStatus.enabled ? (
        <p className="text-xs text-[var(--status-warning)] leading-snug">{strings.unavailable}</p>
      ) : null}

      {/* Output verbosity — how much of each OpenCode turn is mirrored back. */}
      <div className="space-y-2">
        <div className="text-sm font-medium text-foreground">{strings.verbosityTitle}</div>
        <MessengerSegmentedControl
          value={currentVerbosity}
          disabled={controlsDisabled}
          ariaLabel={strings.verbosityTitle}
          onChange={(id) => setBridgeVerbosity(type, id)}
          options={strings.verbosityOptions.map((opt) => ({
            id: opt.id,
            label: opt.label,
          }))}
        />
        <div className="text-xs text-muted-foreground leading-snug">
          {currentVerbosityOption.desc}
        </div>
      </div>

      {/* Tool permission mode — same defaults as /yolo and /permissions. */}
      <div className="space-y-2">
        <div className="text-sm font-medium text-foreground">{strings.permissionTitle}</div>
        <MessengerSegmentedControl
          value={currentPermissionMode}
          disabled={controlsDisabled}
          ariaLabel={strings.permissionTitle}
          onChange={(id) => setBridgePermissionMode(type, id)}
          options={strings.permissionOptions.map((opt) => ({
            id: opt.id,
            label: opt.label,
          }))}
        />
        <div className="text-xs text-muted-foreground leading-snug">
          {currentPermissionOption.desc}
        </div>
      </div>

      <div data-settings-item={`${settingsItemPrefix}.notify-on-complete`} className="space-y-1">
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox
            checked={notifyOnComplete}
            onChange={(checked) => setBridgeNotifyOnComplete(type, checked)}
            disabled={controlsDisabled}
            ariaLabel={strings.notifyTitle}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">{strings.notifyTitle}</span>
            <span className="block text-xs text-muted-foreground leading-snug">
              {strings.notifyDescription}
            </span>
          </span>
        </label>
      </div>

      <div data-settings-item={`${settingsItemPrefix}.critique`} className="space-y-1">
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox
            checked={critiqueEnabled}
            onChange={(checked) => setBridgeCritiqueEnabled(type, checked)}
            disabled={controlsDisabled}
            ariaLabel={strings.critiqueTitle}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {strings.critiqueTitle}
            </span>
            <span className="block text-xs text-muted-foreground leading-snug">
              {strings.critiqueDescription}
            </span>
          </span>
        </label>
      </div>

      {worktreesSlot}

      <div data-settings-item={`${settingsItemPrefix}.interrupt-timeout`} className="space-y-2">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor={`${settingsItemPrefix.replace(/\./g, '-')}-interrupt-timeout-ms`}
        >
          {strings.interruptTitle}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={`${settingsItemPrefix.replace(/\./g, '-')}-interrupt-timeout-ms`}
            type="number"
            min={MESSENGER_INTERRUPT_TIMEOUT_MIN_MS}
            max={MESSENGER_INTERRUPT_TIMEOUT_MAX_MS}
            step={500}
            disabled={controlsDisabled}
            value={interruptTimeoutMs}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) {
                setBridgeInterruptTimeoutMs(type, next);
              }
            }}
            className="h-8 w-28 rounded-md border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <span className="text-xs text-muted-foreground">{strings.interruptUnit}</span>
        </div>
        <div className="text-xs text-muted-foreground leading-snug">
          {strings.interruptDescription}
        </div>
      </div>

      {active.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="text-primary">▶</span> {strings.activeLabel(active.length)}
        </div>
      )}

      {footerNotes ? (
        <div className="space-y-1 border-t border-border/60 pt-3 text-xs text-muted-foreground leading-snug">
          {footerNotes}
        </div>
      ) : null}
    </div>
  );
}

export function SessionBindingsPanel({
  type,
  bridgeStatus,
  emptyText,
}: {
  type: MessengerType;
  bridgeStatus: ReturnType<typeof useMessengerStore.getState>['bridgeStatus'];
  emptyText: string;
}) {
  const bindings = bridgeStatus.bindings.filter((b) => b.type === type);
  if (bindings.length === 0) {
    return <div className="text-xs text-muted-foreground">{emptyText}</div>;
  }
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto">
      {bindings.map((b) => (
        <li
          key={`${b.type}:${b.targetKey}:${b.sessionId}`}
          className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground"
        >
          <code className="rounded bg-muted px-1 text-foreground">{b.targetKey}</code>
          {' → '}
          <code className="rounded bg-muted px-1 text-foreground">
            {b.sessionId.slice(0, 16)}…
          </code>
          {b.projectLabel ? ` · ${b.projectLabel}` : ''}
        </li>
      ))}
    </ul>
  );
}
