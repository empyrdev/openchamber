import { expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { MessagePage } from '@/lib/opencode/client';
import { loadFusionOutputs, type FusionSource } from './fusion';
import { getMultiRunIdentity, withMultiRunMembership } from './identity';

const session: Session = {
  id: 'run', projectID: 'project', directory: '/repo', title: 'renamed freely', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  metadata: withMultiRunMembership({}, {
    version: 1, sessionID: 'run', group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
    groupSlug: 'bench', role: 'run', providerID: 'openrouter', modelID: 'vendor/model',
  }),
};
const identity = getMultiRunIdentity(session);
if (!identity) throw new Error('Fixture must have membership');
const source: FusionSource = { session, identity, directory: '/repo', projectDirectory: '/repo' };

function page(text: string): MessagePage {
  return {
    items: [
      { info: { id: 'assistant', sessionID: 'run', role: 'assistant', agent: 'build', providerID: 'openrouter', modelID: 'vendor/model', time: { created: 3 } }, parts: [{ id: 'text', sessionID: 'run', messageID: 'assistant', type: 'text', text }] },
      { info: { id: 'user', sessionID: 'run', role: 'user', time: { created: 2 } }, parts: [] },
    ],
    cursor: {},
  };
}

test('fusion revalidates the selected session and uses its current last assistant output', async () => {
  const calls: string[] = [];
  const result = await loadFusionOutputs([source], source.identity, () => {}, {
    getSession: async (id, directory) => {
      calls.push(`get:${id}:${directory}`);
      return { ...session, title: 'renamed again' };
    },
    getSessionMessages: async (id, options, directory) => {
      calls.push(`messages:${id}:${options?.limit}:${directory}`);
      return page('latest result');
    },
  });
  expect(result.map((item) => item.text)).toEqual(['latest result']);
  expect(result[0].source.session.title).toBe('renamed again');
  expect(calls).toEqual(['get:run:/repo', 'messages:run:50:/repo']);
});

test('fusion stops before fetching output when a selected ID no longer owns membership', async () => {
  const calls: string[] = [];
  await expect(loadFusionOutputs([source], source.identity, () => {}, {
    getSession: async () => {
      calls.push('get');
      return { ...session, id: 'fork' };
    },
    getSessionMessages: async () => {
      calls.push('messages');
      return page('unexpected');
    },
  })).rejects.toThrow('membership changed');
  expect(calls).toEqual(['get']);
});

test('fusion read failure is not silently treated as an empty source', async () => {
  await expect(loadFusionOutputs([source], source.identity, () => {}, {
    getSession: async () => session,
    getSessionMessages: async () => { throw new Error('unavailable'); },
  })).rejects.toThrow('unavailable');
});

test('a runtime switch during source lookup stops the next request', async () => {
  let switched = false;
  let requests = 0;
  await expect(loadFusionOutputs([source], source.identity, () => {
    if (switched) throw new Error('Runtime changed');
  }, {
    getSession: async () => {
      requests += 1;
      switched = true;
      return session;
    },
    getSessionMessages: async () => page('unexpected'),
  })).rejects.toThrow('Runtime changed');
  expect(requests).toBe(1);
});
