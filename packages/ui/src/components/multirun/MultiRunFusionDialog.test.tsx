import { expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { createMultiRunSession } from '@/lib/multirun/createSession';
import { getMultiRunIdentity, isFusionSource, withMultiRunMembership } from '@/lib/multirun/identity';
import type { FusionSource } from '@/lib/multirun/fusion';
import { startMultiRunFusion } from '@/lib/multirun/fusion-start';

const sourceSession: Session = {
  id: 'run-source', projectID: 'project', directory: '/repo', title: 'benchmark/run', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  metadata: withMultiRunMembership({}, {
    version: 1, sessionID: 'run-source', group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
    groupSlug: 'benchmark', runGroup: 'g1', providerID: 'source-provider', modelID: 'source-model', role: 'run',
  }),
};

const anchor = getMultiRunIdentity(sourceSession);
if (!anchor) throw new Error('Fixture must have native multi-run membership');
const source: FusionSource = { session: sourceSession, directory: '/repo', projectDirectory: '/repo', identity: anchor };

test('fusion caller atomically retains native group membership and can rediscover its source group after reload', async () => {
  let created: Session | undefined;
  const calls: string[] = [];
  const started = await startMultiRunFusion({
    sources: [source], anchor, providerID: 'target-provider', modelID: 'target-model', variant: 'high', agent: 'review', runtimeKey: 'runtime-a',
    onOpenChange: () => calls.push('close'), assertCurrent: () => {},
  }, {
    loadFusionOutputs: async () => [{ source, text: 'source output' }],
    renderMagicPrompt: async (key) => key,
    createMultiRunSession: async (input, assertCurrent) => createMultiRunSession(input, assertCurrent, {
      createSession: async (request) => {
        const id = request?.id ?? 'missing';
        return {
          ...sourceSession, id, title: request?.title ?? '', metadata: request?.metadata,
        };
      },
      deleteSession: async () => true,
    }),
    registerMultiRunSession: (session) => {
      calls.push('register');
      created = session;
      return session;
    },
    setCurrentSession: () => calls.push('select'),
    sendMessage: async (request) => {
      calls.push(`send:${request.agent}:${request.model?.id ?? 'missing'}`);
      return 'message';
    },
  });

  expect(started).toBe(true);
  expect(created?.id.startsWith('ses_')).toBe(true);
  const fusionIdentity = created ? getMultiRunIdentity(created) : null;
  expect(fusionIdentity).toMatchObject({ key: anchor.key, group: anchor.group, runGroup: 'g1', role: 'fusion', providerID: 'target-provider', modelID: 'target-model' });
  if (!fusionIdentity) throw new Error('Fusion result must retain membership');
  // A reload derives the same anchor from the fusion result and finds the native run again.
  expect(isFusionSource(fusionIdentity, getMultiRunIdentity(sourceSession))).toBe(true);
  expect(calls).toEqual(['register', 'select', 'close', 'send:review:target-model']);
});

test('a runtime switch while both prompt templates load creates and publishes no fusion session', async () => {
  let current = true;
  let resolvePrompts!: () => void;
  const prompts = new Promise<string>((resolve) => { resolvePrompts = () => resolve('prompt'); });
  const calls: string[] = [];
  const pending = startMultiRunFusion({
    sources: [source], anchor, providerID: 'target-provider', modelID: 'target-model', variant: '', agent: '', runtimeKey: 'runtime-a',
    onOpenChange: () => calls.push('close'), assertCurrent: () => { if (!current) throw new Error('Runtime changed'); },
  }, {
    loadFusionOutputs: async () => [{ source, text: 'source output' }],
    renderMagicPrompt: async () => prompts,
    createMultiRunSession: async () => { calls.push('create'); return sourceSession; },
    registerMultiRunSession: (session) => { calls.push('register'); return session; },
    setCurrentSession: () => calls.push('select'),
    sendMessage: async () => { calls.push('send'); return 'message'; },
  });
  await Promise.resolve();
  current = false;
  resolvePrompts();

  await expect(pending).rejects.toThrow('Runtime changed');
  expect(calls).toEqual([]);
});
