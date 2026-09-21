import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { Session as OpenCodeSession } from '@opencode/schema';
import { getMultiRunMembership, withMultiRunMembership, type MultiRunIdentity } from './identity';

type MultiRunSessionClient = Pick<typeof opencodeClient, 'createSession' | 'deleteSession'>;

/** Preassign the server's canonical ID so creation atomically persists eligible membership. */
export async function createMultiRunSession(
  input: { title: string; directory: string; identity: Omit<MultiRunIdentity, 'key'> },
  assertCurrent: () => void,
  client: MultiRunSessionClient = opencodeClient,
): Promise<Session> {
  assertCurrent();
  const id = OpenCodeSession.ID.create();
  const membership = { ...input.identity, version: 1 as const, sessionID: id };
  const session = await client.createSession({
    id,
    title: input.title,
    metadata: withMultiRunMembership({}, membership),
  }, input.directory);
  try {
    assertCurrent();
    if (session.id !== id || !getMultiRunMembership(session)) throw new Error('Multi-run membership was not saved');
    return session;
  } catch (error) {
    // Never delete through a switched runtime.
    assertCurrent();
    try {
      await client.deleteSession(session.id, input.directory);
    } catch {
      console.warn('[MultiRun] Could not remove an undispatched session after membership failure');
    }
    throw error;
  }
}
