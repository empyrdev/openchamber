import { beforeEach, describe, expect, test } from 'bun:test';
import type { SyncEvent } from '@/lib/opencode/events';
import {
  applyGlobalBlockingRequestEvents,
  captureGlobalBlockingRequestRevisions,
  resetGlobalBlockingRequests,
  seedGlobalBlockingRequests,
  useGlobalBlockingRequestsStore,
} from './global-blocking-requests';
import type { FormRequest, PermissionRequest } from '@/lib/opencode/model';

const permission = (id: string, sessionID: string): PermissionRequest => ({
  id, sessionID, action: 'shell', resources: ['rm *'], metadata: {},
});
const form = (id: string, sessionID: string): FormRequest => ({
  id, sessionID, title: 'Pick', fields: [{ key: 'answer', type: 'boolean' }],
});
const asked = (request: PermissionRequest | FormRequest): SyncEvent => 'action' in request
  ? { id: `e-${request.id}`, type: 'permission.asked', properties: request }
  : { id: `e-${request.id}`, type: 'form.created', properties: { form: request } };
const bySession = () => useGlobalBlockingRequestsStore.getState().bySession;

beforeEach(() => resetGlobalBlockingRequests());

describe('global blocking requests index', () => {
  test('tracks asks per session and settles them by request id', () => {
    applyGlobalBlockingRequestEvents('/far/', [asked(permission('p1', 's1')), asked(form('f1', 's1')), asked(permission('p2', 's2'))]);

    expect(bySession().get('s1')).toEqual({ directory: '/far', permissions: [permission('p1', 's1')], forms: [form('f1', 's1')] });
    expect(bySession().get('s2')?.permissions.map((p) => p.id)).toEqual(['p2']);

    applyGlobalBlockingRequestEvents('/far', [
      { id: 'r1', type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1' } },
      { type: 'form.settled', properties: { sessionID: 's1', formID: 'f1' } },
    ]);
    expect(bySession().has('s1')).toBe(false);
    expect(bySession().has('s2')).toBe(true);
  });

  test('a reply without a request id settles that kind for the session, and deletion clears it', () => {
    applyGlobalBlockingRequestEvents('/far', [asked(permission('p1', 's1')), asked(permission('p2', 's1')), asked(form('f1', 's1'))]);
    // SAFETY: OpenCode may omit requestID on a reply; the SDK type requires it, the reducer contract does not.
    applyGlobalBlockingRequestEvents('/far', [{ type: 'permission.replied', properties: { sessionID: 's1', requestID: '' } }]);
    expect(bySession().get('s1')?.permissions).toEqual([]);
    expect(bySession().get('s1')?.forms.map((entry) => entry.id)).toEqual(['f1']);

    applyGlobalBlockingRequestEvents('/far', [{ type: 'session.deleted', properties: { sessionID: 's1' } }]);
    expect(bySession().has('s1')).toBe(false);
  });

  test('repeated and unrelated events do not publish', () => {
    applyGlobalBlockingRequestEvents('/far', [asked(permission('p1', 's1'))]);
    const before = bySession();
    applyGlobalBlockingRequestEvents('/far', [
      { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
      { type: 'permission.replied', properties: { sessionID: 'other', requestID: 'nope' } },
    ]);
    expect(bySession()).toBe(before);
  });

  test('seeding adds only sessions without live entries and never clears', () => {
    applyGlobalBlockingRequestEvents('/far', [asked(permission('p1', 's1'))]);
    applyGlobalBlockingRequestEvents('/far', [{ type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1' } }]);

    seedGlobalBlockingRequests([
      { sessionId: 's2', directory: '/other', permissions: [permission('p2', 's2')], forms: [] },
      { sessionId: 's3', directory: '/other', permissions: [], forms: [] },
    ]);
    expect([...bySession().keys()]).toEqual(['s2']);

    // A later seed cannot resurrect a settled request or override a live entry.
    seedGlobalBlockingRequests([{ sessionId: 's2', directory: '/elsewhere', permissions: [permission('p9', 's2')], forms: [] }]);
    expect(bySession().get('s2')?.permissions.map((p) => p.id)).toEqual(['p2']);
    seedGlobalBlockingRequests([]);
    expect(bySession().has('s2')).toBe(true);
  });

  test('a seed captured before a reply, form settlement, or deletion cannot resurrect that session while unrelated sessions seed', () => {
    const captured = captureGlobalBlockingRequestRevisions();
    applyGlobalBlockingRequestEvents('/far', [
      { type: 'permission.replied', properties: { sessionID: 'permission-settled', requestID: 'p1' } },
      { type: 'form.settled', properties: { sessionID: 'form-settled', formID: 'f1' } },
      { type: 'session.deleted', properties: { sessionID: 'deleted' } },
    ]);

    seedGlobalBlockingRequests([
      { sessionId: 'permission-settled', directory: '/far', permissions: [permission('p1', 'permission-settled')], forms: [] },
      { sessionId: 'form-settled', directory: '/far', permissions: [], forms: [form('f1', 'form-settled')] },
      { sessionId: 'deleted', directory: '/far', permissions: [permission('p2', 'deleted')], forms: [] },
      { sessionId: 'unrelated', directory: '/far', permissions: [permission('p3', 'unrelated')], forms: [] },
    ], captured);

    expect([...bySession().keys()]).toEqual(['unrelated']);
  });

  test('runtime reset clears reconciliation ownership for the next runtime', () => {
    const captured = captureGlobalBlockingRequestRevisions();
    applyGlobalBlockingRequestEvents('/far', [{ type: 'permission.replied', properties: { sessionID: 'previous-runtime', requestID: 'p1' } }]);
    resetGlobalBlockingRequests();

    seedGlobalBlockingRequests([
      { sessionId: 'previous-runtime', directory: '/far', permissions: [permission('p1', 'previous-runtime')], forms: [] },
    ], captured);
    expect(bySession().get('previous-runtime')?.permissions.map((request) => request.id)).toEqual(['p1']);
  });
});
