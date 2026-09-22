import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import request from 'supertest';

import { registerOpenCodeRoutes } from './routes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const createApp = (overrides = {}) => {
  const app = express();
  const dependencies = {
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic managed-password' }),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return app;
};

const waitForFetch = async () => {
  await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
};

describe('OpenCode health route', () => {
  it('reads authenticated v2 info and only reports healthy for a valid readiness response', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ version: '2.0.12', pid: 1234 }));
    const app = createApp();

    await request(app)
      .get('/api/opencode/health')
      .expect(200, { healthy: true });

    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:4096/api/info', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Basic managed-password' },
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    [{ version: '', pid: 1234 }],
    [{ version: '2.0.12', pid: 0 }],
    [{ version: '2.0.12', pid: Number.POSITIVE_INFINITY }],
    [{ version: '2.0.12' }],
  ])('rejects malformed v2 info responses', async (payload) => {
    globalThis.fetch = vi.fn(async () => jsonResponse(payload));
    const app = createApp();

    await request(app)
      .get('/api/opencode/health')
      .expect(502, { healthy: false, error: 'Invalid OpenCode health response' });
  });

  it.each([401, 404, 500])('maps upstream %i failures without exposing upstream details', async (status) => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'http://secret.example/api/info leaked body' }, status));
    const app = createApp();

    await request(app)
      .get('/api/opencode/health')
      .expect(status, { healthy: false, error: 'OpenCode health check failed' });
  });

  it('maps transport failures to a generic unavailable response', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('request to http://secret.example/api/info failed');
    });
    const app = createApp();

    await request(app)
      .get('/api/opencode/health')
      .expect(503, { healthy: false, error: 'OpenCode health check failed' });
  });

  it('bounds stalled response headers with a server-owned deadline', async () => {
    let signal = null;
    globalThis.fetch = vi.fn((_url, options) => {
      signal = options.signal;
      if (!signal) return Promise.resolve(jsonResponse({ version: '2.0.12', pid: 1234 }));
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const app = createApp({ healthCheckTimeoutMs: 10 });

    await request(app)
      .get('/api/opencode/health')
      .expect(503, { healthy: false, error: 'OpenCode health check failed' });

    expect(signal?.aborted).toBe(true);
  });

  it('keeps the deadline active while consuming a stalled info body', async () => {
    let signal = null;
    globalThis.fetch = vi.fn(async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => {
          if (!signal) return Promise.resolve({ version: '2.0.12', pid: 1234 });
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      };
    });
    const app = createApp({ healthCheckTimeoutMs: 10 });

    await request(app)
      .get('/api/opencode/health')
      .expect(503, { healthy: false, error: 'OpenCode health check failed' });

    expect(signal?.aborted).toBe(true);
  });

  it('cancels an unused non-OK response body without reading it', async () => {
    const cancel = vi.fn(async () => undefined);
    const json = vi.fn(async () => ({ error: 'unused' }));
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, body: { cancel }, json }));
    const app = createApp();

    await request(app)
      .get('/api/opencode/health')
      .expect(401, { healthy: false, error: 'OpenCode health check failed' });

    expect(cancel).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
  });

  it('aborts a pending upstream health request when the downstream disconnects', async () => {
    let signal = null;
    globalThis.fetch = vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const app = createApp({ healthCheckTimeoutMs: 1_000 });
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
      const port = server.address().port;
      const downstream = http.get(`http://127.0.0.1:${port}/api/opencode/health`);
      downstream.on('error', () => {});
      await waitForFetch();
      downstream.destroy();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
