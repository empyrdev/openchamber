import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useAllLiveSessions, useAllSessionStatuses, useDirectorySync, useGlobalSessionStatus } from '@/sync/sync-context';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { formatCost } from './subagentCost';
import { useSubagentCostRollup } from './useSubagentCostRollup';
import type { State } from '@/sync/types';
import type { Session, SessionStatus } from '@/lib/opencode/model';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const SECTION_ID = 'subagents';

const isActiveStatus = (status: SessionStatus | undefined): boolean => (
  status?.type === 'busy' || status?.type === 'retry'
);

type SubagentRowProps = {
  child: Session;
  localStatus: SessionStatus | undefined;
  blocked: boolean;
  asked: boolean;
  childCost: number;
  directory: string | null;
  openChildSession: (childId: string, label: string) => void;
};

const WorkStatusSubagentRow: React.FC<SubagentRowProps> = ({
  child,
  localStatus,
  blocked,
  asked,
  childCost,
  directory,
  openChildSession,
}) => {
  const { t } = useI18n();
  const globalStatus = useGlobalSessionStatus(child.id);
  const active = isActiveStatus(globalStatus) || isActiveStatus(localStatus);
  const label = child.title?.trim() || t('chat.workStatus.subagent.untitled');
  return (
    <WorkStatusRow
      onClick={directory ? () => openChildSession(child.id, label) : undefined}
      ariaLabel={t('chat.workStatus.action.openSubagent', { name: label })}
      label={label}
      value={(
        <>
          {blocked ? (
            <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.needsPermission')}</WorkStatusValue>
          ) : asked ? (
            <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.askedQuestion')}</WorkStatusValue>
          ) : active ? (
            <WorkStatusValue tone="info">{t('chat.workStatus.subagent.working')}</WorkStatusValue>
          ) : (
            <WorkStatusValue tone="muted">{t('chat.workStatus.subagent.done')}</WorkStatusValue>
          )}
          {childCost > 0 ? <WorkStatusValue tone="muted">{formatCost(childCost)}</WorkStatusValue> : null}
        </>
      )}
    />
  );
};

/**
 * Running subagents and, more importantly, their blockers: a permission request
 * raised by a child session has no representation in the transcript, so this
 * panel is the only place it becomes visible.
 */
export const WorkStatusSubagentsSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);

  const liveSessions = useAllLiveSessions();
  const statuses = useAllSessionStatuses();
  const children = React.useMemo(
    () => (sessionId ? liveSessions.filter((candidate) => candidate.parentID === sessionId) : []),
    [liveSessions, sessionId],
  );
  const locallyActiveChildIds = React.useMemo(() => new Set(
    children.filter((child) => isActiveStatus(statuses[child.id])).map((child) => child.id),
  ), [children, statuses]);
  const globallyActiveChildCount = useGlobalSessionStatusStore(React.useCallback((state) => {
    let count = 0;
    for (const child of children) {
      if (!locallyActiveChildIds.has(child.id) && state.activeSessionIds.has(child.id)) count += 1;
    }
    return count;
  }, [children, locallyActiveChildIds]));

  // Each child's own subtree total (its cost plus every descendant of its
  // own), so nested subagent-of-subagent cost rolls up under the immediate
  // child row shown here rather than disappearing.
  const { perChildCost } = useSubagentCostRollup(sessionId);

  // One subscription covers every child: per-session hooks would multiply
  // store subscriptions by the number of subagents.
  const permissions = useDirectorySync(React.useCallback((state: State) => state.permission, []));
  const forms = useDirectorySync(React.useCallback((state: State) => state.form, []));

  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setSectionExpanded = useUIStore((state) => state.setWorkStatusSectionExpanded);

  // Subagents appearing where there were none is the one moment this section
  // has something urgent to say, so it opens itself. Only on the empty→present
  // edge: re-expanding on every count change would fight a user who just
  // collapsed it.
  const hadChildren = React.useRef(children.length > 0);
  React.useEffect(() => {
    const present = children.length > 0;
    if (present && !hadChildren.current) setSectionExpanded(SECTION_ID, true);
    hadChildren.current = present;
  }, [children.length, setSectionExpanded]);

  // Same branch the transcript's Task tool takes: surfaces that cannot host an
  // embedded panel navigate to the child session instead of opening a tab.
  const openChildSession = React.useCallback((childId: string, label: string) => {
    if (!directory) return;
    if (isEmbeddedSessionChat() || isMobile || isVSCodeRuntime()) {
      setCurrentSession(childId, directory);
      return;
    }
    openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: `session:${childId}`,
      label,
      readOnly: true,
    });
  }, [directory, isMobile, openContextPanelTab, setCurrentSession]);

  useReportWorkStatusPresence('subagents', children.length > 0);

  if (children.length === 0) return null;

  const activeChildren = locallyActiveChildIds.size + globallyActiveChildCount;

  return (
    <WorkStatusCollapsibleSection
      id={SECTION_ID}
      title={t('chat.workStatus.section.subagents')}
      icon="ai-agent"
      defaultExpanded
      summary={activeChildren > 0 ? `${activeChildren}/${children.length}` : children.length}
    >
      <div className="max-h-56 overflow-y-auto">
        {children.map((child) => (
          <WorkStatusSubagentRow
            key={child.id}
            child={child}
            localStatus={statuses[child.id]}
            blocked={(permissions[child.id]?.length ?? 0) > 0}
            asked={(forms[child.id]?.length ?? 0) > 0}
            childCost={perChildCost.get(child.id) ?? 0}
            directory={directory}
            openChildSession={openChildSession}
          />
        ))}
      </div>
    </WorkStatusCollapsibleSection>
  );
};
