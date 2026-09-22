import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeNetworkRuntime } from './network-runtime.js';

const originalFetch = globalThis.fetch;

const createRuntime = (overrides = {}) => createOpenCodeNetworkRuntime({
  state: {
    openCodePort: 4096,
    openCodeBaseUrl: null,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    ...overrides.state,
  },
  getOpenCodeAuthHeaders: overrides.getOpenCodeAuthHeaders ?? (() => ({})),
  configuredOpenCodeHostname: overrides.configuredOpenCodeHostname,
});

describe('OpenCode network runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('classifies an unreachable readiness endpoint as retryable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    });

    const runtime = createRuntime();
    const readyPromise = runtime.waitForReady('http://127.0.0.1:4096', 1);

    await expect(readyPromise).resolves.toMatchObject({
      ready: false,
      retryable: true,
      failure: { class: 'unreachable' },
    });
  });

  it('probes authenticated OpenCode server info and accepts a valid v2 identity', async () => {
    globalThis.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ version: '2.0.12', pid: 12345 }),
    }));

    const runtime = createRuntime({
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
    });

    await expect(runtime.waitForReady('http://127.0.0.1:4096', 100)).resolves.toEqual({
      ready: true,
      version: '2.0.12',
      pid: 12345,
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/api/info',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it.each([
    {
      name: 'authentication failures',
      response: { status: 401, ok: false },
      failureClass: 'authentication',
      detail: 'authentication',
    },
    {
      name: 'incompatible readiness endpoints',
      response: { status: 404, ok: false },
      failureClass: 'incompatible_endpoint',
      detail: '/api/info',
    },
    {
      name: 'malformed readiness JSON',
      response: {
        status: 200,
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected token'); },
      },
      failureClass: 'invalid_response',
      detail: 'invalid JSON',
    },
    {
      name: 'an invalid readiness schema',
      response: { status: 200, ok: true, json: async () => ({ version: { trim: 1 }, pid: 12345 }) },
      failureClass: 'invalid_response',
      detail: 'non-empty version',
    },
  ])('returns $name without retrying', async ({ response, failureClass, detail }) => {
    globalThis.fetch = vi.fn(async () => response);
    const runtime = createRuntime();

    await expect(runtime.waitForReady('http://127.0.0.1:4096', 1000)).resolves.toMatchObject({
      ready: false,
      retryable: false,
      failure: {
        class: failureClass,
        detail: expect.stringContaining(detail),
      },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the readiness deadline active while the response body is stalled', async () => {
    globalThis.fetch = vi.fn(async (_url, options) => ({
      status: 200,
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    }));

    const runtime = createRuntime();

    await expect(runtime.waitForReady('http://127.0.0.1:4096', 20)).resolves.toMatchObject({
      ready: false,
      retryable: true,
      failure: { class: 'unreachable' },
    });
  }, 1000);

  it('builds managed OpenCode URLs against IPv4 loopback by default', () => {
    const runtime = createRuntime();

    expect(runtime.buildOpenCodeUrl('/provider')).toBe('http://127.0.0.1:4096/provider');
  });

  it('keeps external OpenCode base URLs authoritative', () => {
    const runtime = createRuntime({
      state: { openCodeBaseUrl: 'http://remote.example:4096' },
    });

    expect(runtime.buildOpenCodeUrl('/provider')).toBe('http://remote.example:4096/provider');
  });

  it('normalizes wildcard and IPv6 OpenCode bind hosts for local connects', () => {
    expect(createRuntime({ configuredOpenCodeHostname: '0.0.0.0' }).buildOpenCodeUrl('/provider'))
      .toBe('http://127.0.0.1:4096/provider');
    expect(createRuntime({ configuredOpenCodeHostname: '::1' }).buildOpenCodeUrl('/provider'))
      .toBe('http://[::1]:4096/provider');
  });
});
