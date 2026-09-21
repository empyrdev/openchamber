import { describe, expect, test } from 'bun:test';
import { Session as OpenCodeSession } from '@opencode/schema';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { createMultiRunSession } from './createSession';
import { getMultiRunIdentity, type MultiRunIdentity } from './identity';

const identity: Omit<MultiRunIdentity, 'key'> = {
  group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
  groupSlug: 'bench', providerID: 'openrouter', modelID: 'vendor/model', role: 'run',
};

type CreateInput = Parameters<typeof opencodeClient.createSession>[0];

function session(id: string, metadata?: Session['metadata']): Session {
  return {
    id, projectID: 'project', directory: '/repo', title: '', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, metadata,
  };
}

function fixture(options: { responseID?: string; omitSavedMarker?: boolean; switchAfterCreate?: boolean } = {}) {
  const calls: string[] = [];
  let current = true;
  let createInput: CreateInput | undefined;
  const client = {
    createSession: async (input: CreateInput) => {
      calls.push('POST');
      createInput = input;
      if (options.switchAfterCreate) current = false;
      const requestedID = input?.id ?? 'missing';
      return session(options.responseID ?? requestedID, options.omitSavedMarker ? undefined : input?.metadata);
    },
    deleteSession: async () => {
      calls.push('DELETE');
      return true;
    },
  };
  const assertCurrent = () => { if (!current) throw new Error('Runtime changed'); };
  return { client, calls, assertCurrent, createInput: () => createInput };
}

describe('multi-run creation', () => {
  for (const role of ['run', 'fusion'] as const) test(`creates ${role} with its canonical ID-bound membership`, async () => {
    const testApi = fixture();
    const result = await createMultiRunSession(
      { title: 'any title', directory: '/repo', identity: { ...identity, role } }, testApi.assertCurrent, testApi.client,
    );
    const input = testApi.createInput();
    expect(input?.id?.startsWith('ses_')).toBe(true);
    expect(input?.metadata?.openchamber).toMatchObject({ multirun: { sessionID: input?.id, role } });
    expect(result.id).toBe(input?.id);
    expect(getMultiRunIdentity(result)).toMatchObject({ role, modelID: 'vendor/model' });
    expect(testApi.calls).toEqual(['POST']);
  });

  test('rejects and cleans up when the create response does not retain the bound marker', async () => {
    const testApi = fixture({ omitSavedMarker: true });
    await expect(createMultiRunSession(
      { title: 'bench/openrouter/vendor/model', directory: '/repo', identity }, testApi.assertCurrent, testApi.client,
    )).rejects.toThrow('membership was not saved');
    expect(testApi.calls).toEqual(['POST', 'DELETE']);
  });

  test('rejects and cleans up when OpenCode returns a different ID', async () => {
    const testApi = fixture({ responseID: OpenCodeSession.ID.create() });
    await expect(createMultiRunSession(
      { title: 'bench/openrouter/vendor/model', directory: '/repo', identity }, testApi.assertCurrent, testApi.client,
    )).rejects.toThrow('membership was not saved');
    expect(testApi.calls).toEqual(['POST', 'DELETE']);
  });

  test('a runtime switch prevents publication and cleanup through the new runtime', async () => {
    const testApi = fixture({ switchAfterCreate: true });
    await expect(createMultiRunSession(
      { title: 'bench/openrouter/vendor/model', directory: '/repo', identity }, testApi.assertCurrent, testApi.client,
    )).rejects.toThrow('Runtime changed');
    expect(testApi.calls).toEqual(['POST']);
  });
});
