import { opencodeClient } from '@/lib/opencode/client';
import { renderMagicPrompt, type MagicPromptId } from '@/lib/magicPrompts';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { registerMultiRunSession } from '@/stores/useMultiRunStore';
import { createMultiRunSession } from './createSession';
import { type MultiRunIdentity } from './identity';
import { loadFusionOutputs, type FusionSource } from './fusion';
import { getFusionSessionTitle } from './title';

type FusionStartInput = {
  sources: FusionSource[];
  anchor: MultiRunIdentity;
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  runtimeKey: string;
  onOpenChange: (open: boolean) => void;
  assertCurrent: () => void;
};

type FusionStartDependencies = {
  loadFusionOutputs: typeof loadFusionOutputs;
  renderMagicPrompt: (key: MagicPromptId) => Promise<string>;
  createMultiRunSession: typeof createMultiRunSession;
  registerMultiRunSession: typeof registerMultiRunSession;
  setCurrentSession: (sessionId: string, directory: string) => void;
  sendMessage: typeof opencodeClient.sendMessage;
};

const buildSourcePart = (source: FusionSource, text: string, index: number): string => {
  const title = source.session.title?.trim() || source.session.id;
  return `\n\n--- RESULT ${index + 1}: ${title} ---\n${text.trim()}\n--- END RESULT ${index + 1} ---`;
};

const defaultFusionStartDependencies: FusionStartDependencies = {
  loadFusionOutputs,
  renderMagicPrompt,
  createMultiRunSession,
  registerMultiRunSession,
  setCurrentSession: (sessionId, directory) => useSessionUIStore.getState().setCurrentSession(sessionId, directory),
  sendMessage: (input) => opencodeClient.sendMessage(input),
};

/** The dialog's complete fusion side-effect sequence, guarded by its source runtime. */
export const startMultiRunFusion = async (
  input: FusionStartInput,
  dependencies: FusionStartDependencies = defaultFusionStartDependencies,
): Promise<boolean> => {
  const usableSources = await dependencies.loadFusionOutputs(input.sources, input.anchor, input.assertCurrent);
  if (usableSources.length === 0) return false;

  const directory = input.sources[0]?.projectDirectory ?? input.sources[0]?.directory ?? null;
  if (!directory) throw new Error('Fusion requires a session directory');
  const title = getFusionSessionTitle(input.anchor.groupSlug, input.providerID, input.modelID, input.anchor.runGroup);
  const [visiblePrompt, instructionsPrompt] = await Promise.all([
    dependencies.renderMagicPrompt('session.fusion.visible'),
    dependencies.renderMagicPrompt('session.fusion.instructions'),
  ]);
  // Prompt templates are asynchronous. Do not create a session after a host switch.
  input.assertCurrent();
  const fusionSession = await dependencies.createMultiRunSession({
    title,
    directory,
    identity: {
      group: input.anchor.group,
      groupSlug: input.anchor.groupSlug,
      runGroup: input.anchor.runGroup,
      providerID: input.providerID,
      modelID: input.modelID,
      role: 'fusion',
    },
  }, input.assertCurrent);
  input.assertCurrent();
  const registered = dependencies.registerMultiRunSession(fusionSession, directory);
  input.assertCurrent();
  dependencies.setCurrentSession(registered.id, directory);
  input.assertCurrent();
  input.onOpenChange(false);
  input.assertCurrent();
  await dependencies.sendMessage({
    runtimeKey: input.runtimeKey,
    id: registered.id,
    providerID: input.providerID,
    model: { providerID: input.providerID, id: input.modelID, variant: input.variant || undefined },
    agent: input.agent || undefined,
    text: visiblePrompt,
    context: [
      { text: instructionsPrompt },
      ...usableSources.map((item, index) => ({ text: buildSourcePart(item.source, item.text, index) })),
      { text: '\n\n--- FUSION INPUTS END ---\nNow write the final fused answer.' },
    ],
    directory,
  });
  return true;
};
