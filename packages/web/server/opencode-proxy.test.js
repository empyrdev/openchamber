import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import express from 'express';
import path from 'path';

import { createSseBoundaryTracker, registerOpenCodeProxy, writeSseChunkWithBackpressure } from './lib/opencode/proxy.js';

const originalFetch = globalThis.fetch;

const listen = (app, host = '127.0.0.1') => new Promise((resolve, reject) => {
  const server = app.listen(0, host, () => resolve(server));
  server.once('error', reject);
});

const closeServer = (server) => new Promise((resolve, reject) => {
  if (!server) {
    resolve();
    return;
  }
  server.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

const getJson = (url, timeoutMs = 0) => new Promise((resolve, reject) => {
  const request = http.get(url, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try {
        resolve({ status: response.statusCode, body: JSON.parse(body) });
      } catch (error) {
        reject(error);
      }
    });
  });
  if (timeoutMs > 0) {
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Timed out waiting for proxy response')));
  }
  request.once('error', reject);
});

describe('OpenCode proxy SSE forwarding', () => {
  let upstreamServer;
  let proxyServer;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await closeServer(proxyServer);
    await closeServer(upstreamServer);
    proxyServer = undefined;
    upstreamServer = undefined;
  });

  const registerSessionListProxy = (app, overrides = {}) => {
    registerOpenCodeProxy(app, {
      fs: {},
      OPEN_CODE_READY_GRACE_MS: 0,
      LONG_REQUEST_TIMEOUT_MS: 20,
      getRuntime: () => ({
        openCodePort: 4096,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic managed-password' }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:4096${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      ...overrides,
    });
  };

  it('forwards event streams with nginx-safe headers', async () => {
    let seenAuthorization = null;

    const upstream = express();
    upstream.get('/api/event', (req, res) => {
      seenAuthorization = req.headers.authorization ?? null;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=0');
      res.setHeader('X-Upstream-Test', 'ok');
      res.write('data: {"ok":true}\n\n');
      res.end();
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/global/event`, {
      headers: { Accept: 'text/event-stream' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('x-upstream-test')).toBe('ok');
    expect(await response.text()).toBe('data: {"ok":true}\n\n');
    expect(seenAuthorization).toBe('Bearer test-token');
  });

  it('closes downstream SSE when the OpenCode upstream stalls despite proxy heartbeats', async () => {
    let stallTimeoutReads = 0;
    let releaseUpstreamFrames;
    let upstreamClosed = false;
    let lateWriteAttempted = false;
    const upstreamFrames = new Promise((resolve) => {
      releaseUpstreamFrames = resolve;
    });
    const upstream = express();
    upstream.get('/api/event', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      let lateWriteTimer = null;
      res.once('close', () => {
        upstreamClosed = true;
        clearTimeout(lateWriteTimer);
      });
      upstreamFrames.then(() => {
        res.write(':upstream-alive\n\n');
        setTimeout(() => res.write('data: still-alive\n\n'), 20);
        lateWriteTimer = setTimeout(() => {
          lateWriteAttempted = true;
          res.write('data: too-late\n\n');
        }, 200);
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      SSE_HEARTBEAT_INTERVAL_MS: 10,
      getSseUpstreamStallTimeoutMs: () => {
        stallTimeoutReads += 1;
        return stallTimeoutReads === 1 ? 50 : 100;
      },
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/global/event`, {
      headers: { Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(2000),
    });

    expect(response.status).toBe(200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    const firstChunk = await reader.read();
    body += decoder.decode(firstChunk.value, { stream: true });
    expect(body).toContain(':heartbeat\n\n');

    // The first downstream heartbeat is emitted only after the proxy has set up
    // its upstream reader and stall watchdog. Release upstream data then, rather
    // than racing a 40ms fixture timer against the 50ms initial watchdog.
    releaseUpstreamFrames();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();

    expect(body).toContain(':heartbeat\n\n');
    expect(body).toContain(':upstream-alive\n\n');
    expect(body).toContain('data: still-alive\n\n');
    expect(stallTimeoutReads).toBeGreaterThanOrEqual(3);
    await vi.waitFor(() => expect(upstreamClosed).toBe(true));
    expect(lateWriteAttempted).toBe(false);
  });

  it('holds a request through OpenCode warmup and succeeds once ready (no 503/backoff)', async () => {
    const upstream = express();
    upstream.get('/api/config/providers', (_req, res) => {
      res.json({ ok: true });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const runtime = {
      openCodePort: upstreamPort,
      isOpenCodeReady: false,
      openCodeNotReadySince: 0,
      isRestartingOpenCode: false,
    };
    // OpenCode becomes ready shortly after the request arrives.
    setTimeout(() => { runtime.isOpenCodeReady = true; }, 200);

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 5000,
      getRuntime: () => runtime,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/config/providers`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('returns 503 fast when OpenCode never becomes ready', async () => {
    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      // Zero grace → hold window collapses to nothing → fail fast.
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: 0,
        isOpenCodeReady: false,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:1${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/config/providers`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ restarting: true });
  });

  it('waits for drain when writing to a slow SSE response', async () => {
    const writes = [];
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroyed = false;
    res.write = (value) => {
      writes.push(value);
      return false;
    };
    const controller = new AbortController();

    const write = writeSseChunkWithBackpressure(res, Buffer.from('data: {"ok":true}\n\n'), controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toHaveLength(1);

    res.emit('drain');

    await expect(write).resolves.toBe(true);
  });

  it('tracks whether a raw SSE stream is between event blocks', () => {
    const tracker = createSseBoundaryTracker();

    expect(tracker.isAtBoundary()).toBe(true);
    expect(tracker.observe(Buffer.from('id: evt-1\n'))).toBe(false);
    expect(tracker.observe(Buffer.from('data: {"ok"'))).toBe(false);
    expect(tracker.observe(Buffer.from(':true}\n'))).toBe(false);
    expect(tracker.observe(Buffer.from('\n'))).toBe(true);
    expect(tracker.observe(Buffer.from('data: next\r\n\r\n'))).toBe(true);
  });

  it('routes generic API requests through external OpenCode base URL', async () => {
    const upstream = express();
    upstream.get('/api/config/providers', (_req, res) => {
      res.json({ ok: true, source: 'external-host' });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: 3902,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/config/providers`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, source: 'external-host' });
  });

  it('replays parsed urlencoded bodies to generic API proxy requests', async () => {
    const upstream = express();
    upstream.post('/api/form', express.urlencoded({ extended: true }), (req, res) => {
      res.json({ body: req.body });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    app.use('/api', express.urlencoded({ extended: true }));
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ messageID: 'msg_1' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { messageID: 'msg_1' } });
  });

  it('replays parsed JSON bodies to generic API proxy requests', async () => {
    const upstream = express();
    upstream.post('/api/session/abc/prompt', express.json(), (req, res) => {
      res.json({
        body: req.body,
        authorization: req.headers.authorization,
        contentLength: req.headers['content-length'],
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    app.use('/api', express.json());
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer replay-token' }),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const payload = { messageID: 'msg_1', parts: [{ type: 'text', text: 'hello' }] };
    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/session/abc/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.body).toEqual(payload);
    expect(data.authorization).toBe('Bearer replay-token');
    expect(Number(data.contentLength)).toBeGreaterThan(0);
  });

  it('sanitizes the global session list and forwards query params', async () => {
    let seenQuery = null;
    let seenAuth = null;

    const upstream = express();
    upstream.get('/api/session', (req, res) => {
      seenQuery = req.query;
      seenAuth = req.headers.authorization ?? null;
      res.setHeader('X-Next-Cursor', '123');
      res.json({
        data: [
          {
            id: 'ses_1',
            projectID: 'proj_1',
            location: { directory: '/repo/app', workspaceID: 'ws_1' },
            subpath: 'app',
            parentID: 'ses_parent',
            title: 'Alpha',
            agent: 'build',
            model: { id: 'gpt-5', providerID: 'openai', variant: 'default' },
            time: { created: 1, updated: 2 },
            cost: 7,
            tokens: { input: 10, output: 20 },
            outcome: 'succeeded',
            fork: { sessionID: 'ses_source', boundary: { type: 'through' } },
            metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_original' } },
            permissions: [{ action: 'deny', resources: ['*'] }],
            revert: { messageID: 'msg_1', partID: 'part_1', snapshot: 'abc123', files: ['a.ts'] },
          },
        ],
        cursor: { next: '123' },
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {
        promises: {
          realpath: async (value) => value === '/link/repo' ? '/real/repo' : value,
        },
      },
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer session-token' }),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/session?archived=false&limit=500&cursor=99&roots=true&directory=%2Flink%2Frepo`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-next-cursor')).toBe('123');
    expect(seenAuth).toBe('Bearer session-token');
    expect(seenQuery).toMatchObject({
      archived: 'false',
      limit: '500',
      cursor: '99',
      roots: 'true',
      directory: '/real/repo',
    });

    // The heavy parts of a revert and the per-session permission ruleset are
    // dropped; everything the list view reads survives.
    await expect(response.json()).resolves.toEqual({
      data: [
        {
          id: 'ses_1',
          projectID: 'proj_1',
          location: { directory: '/repo/app', workspaceID: 'ws_1' },
          subpath: 'app',
          parentID: 'ses_parent',
          title: 'Alpha',
          agent: 'build',
          model: { id: 'gpt-5', providerID: 'openai', variant: 'default' },
          time: { created: 1, updated: 2 },
          cost: 7,
          tokens: { input: 10, output: 20 },
          outcome: 'succeeded',
          fork: { sessionID: 'ses_source', boundary: { type: 'through' } },
          metadata: { openchamber: { kind: 'review', originalSessionID: 'ses_original' } },
          revert: { messageID: 'msg_1', partID: 'part_1' },
        },
      ],
      cursor: { next: '123' },
    });
  });

  it('returns a sanitized timeout when authoritative session-list headers stall', async () => {
    globalThis.fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const app = express();
    registerSessionListProxy(app);
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await getJson(`http://127.0.0.1:${proxyPort}/api/session?cursor=opaque-next`, 100);

    expect(response.status).toBe(504);
    expect(response.body).toEqual({ error: 'OpenCode upstream timed out' });
  });

  it('returns a sanitized timeout when authoritative session-list body consumption stalls', async () => {
    globalThis.fetch = vi.fn(async (_url, options) => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    }));
    const app = express();
    registerSessionListProxy(app);
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await getJson(`http://127.0.0.1:${proxyPort}/api/session?cursor=opaque-next`, 100);

    expect(response.status).toBe(504);
    expect(response.body).toEqual({ error: 'OpenCode upstream timed out' });
  });

  it('cancels authoritative session-list work when the downstream disconnects', async () => {
    let signal = null;
    globalThis.fetch = vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const app = express();
    registerSessionListProxy(app, { LONG_REQUEST_TIMEOUT_MS: 1_000 });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const downstream = http.get(`http://127.0.0.1:${proxyPort}/api/session`);
    downstream.on('error', () => {});
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    downstream.destroy();

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('uses one authoritative paginated v2 session list on Windows', async () => {
    const seen = [];
    const upstream = express();
    upstream.get('/api/session', (req, res) => {
      seen.push({ query: req.query, authorization: req.headers.authorization });
      res.json({
        data: [{
          id: 'ses_global',
          title: 'Global session',
          time: { updated: 1 },
          metadata: { shared: 'upstream' },
        }],
        cursor: { next: 'opaque-next-page' },
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {
        readFileSync: () => {
          throw new Error('The retired Windows merge must not read settings');
        },
      },
      platform: 'win32',
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic managed-password' }),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      getArchivedSessions: async () => ({ ses_global: 42 }),
      getStoredSessionMetadata: async () => ({ ses_global: { shared: 'openchamber' } }),
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/session?limit=500&roots=true`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [{
        id: 'ses_global',
        title: 'Global session',
        time: { updated: 1, archived: 42 },
        metadata: { shared: 'openchamber' },
      }],
      cursor: { next: 'opaque-next-page' },
    });
    expect(seen).toEqual([
      {
        query: { limit: '500', roots: 'true' },
        authorization: 'Basic managed-password',
      },
    ]);
  });

  it('sanitizes session list responses without sanitizing session detail responses', async () => {
    let seenListQuery = null;

    const upstream = express();
    upstream.get('/api/session', (req, res) => {
      seenListQuery = req.query;
      res.json({
        data: [
          {
            id: 'ses_1',
            location: { directory: '/repo/app' },
            title: 'Alpha',
            time: { created: 1, updated: 2 },
            metadata: { custom: { value: 'kept' } },
            permissions: [{ action: 'deny', resources: ['*'] }],
            revert: { messageID: 'msg_1', partID: 'part_1', snapshot: 'abc123', files: ['a.ts'] },
          },
        ],
        cursor: {},
      });
    });
    upstream.get('/api/session/abc', (_req, res) => {
      res.json({
        id: 'abc',
        location: { directory: '/repo/app' },
        title: 'Detail',
        revert: { messageID: 'msg_1', snapshot: 'abc123', files: ['a.ts'] },
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {
        promises: {
          realpath: async (value) => value === '/link/repo' ? '/real/repo' : value,
        },
      },
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const listResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/session?directory=%2Flink%2Frepo`);

    expect(listResponse.status).toBe(200);
    expect(seenListQuery).toMatchObject({ directory: '/real/repo' });
    await expect(listResponse.json()).resolves.toEqual({
      data: [
        {
          id: 'ses_1',
          location: { directory: '/repo/app' },
          title: 'Alpha',
          time: { created: 1, updated: 2 },
          metadata: { custom: { value: 'kept' } },
          revert: { messageID: 'msg_1', partID: 'part_1' },
        },
      ],
      cursor: {},
    });

    const detailResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/session/abc`);

    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toEqual({
      id: 'abc',
      location: { directory: '/repo/app' },
      title: 'Detail',
      revert: { messageID: 'msg_1', snapshot: 'abc123', files: ['a.ts'] },
    });
  });

  it('folds OpenChamber-owned archive state and metadata onto sessions it serves', async () => {
    const upstream = express();
    upstream.get('/api/session', (_req, res) => {
      res.json({
        data: [
          { id: 'ses_1', location: { directory: '/repo/app' }, title: 'Alpha', time: { created: 1, updated: 2 }, metadata: { fromOpenCode: true, shared: 'theirs' } },
          { id: 'ses_2', location: { directory: '/repo/app' }, title: 'Beta', time: { created: 1, updated: 3, archived: 999 } },
        ],
        cursor: {},
      });
    });
    upstream.get('/api/session/ses_1', (_req, res) => {
      res.json({ id: 'ses_1', location: { directory: '/repo/app' }, title: 'Alpha', metadata: { fromOpenCode: true, shared: 'theirs' } });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      getArchivedSessions: async () => ({ ses_1: 4242 }),
      getStoredSessionMetadata: async () => ({ ses_1: { openchamber: { goal: { status: 'active' } }, shared: 'ours' } }),
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const list = await (await fetch(`http://127.0.0.1:${proxyPort}/api/session`)).json();
    // Ours wins per key; a session with no stored state loses the archive flag
    // OpenCode still carries, because OpenChamber is the authority for it now.
    expect(list.data[0]).toMatchObject({
      id: 'ses_1',
      time: { created: 1, updated: 2, archived: 4242 },
      metadata: { fromOpenCode: true, shared: 'ours', openchamber: { goal: { status: 'active' } } },
    });
    // The archive file does not mention ses_2, so the stamp OpenCode carries
    // (a session migrated from v1) stays as it is.
    expect(list.data[1].time).toEqual({ created: 1, updated: 3, archived: 999 });

    const detail = await (await fetch(`http://127.0.0.1:${proxyPort}/api/session/ses_1`)).json();
    expect(detail).toMatchObject({
      id: 'ses_1',
      time: { archived: 4242 },
      metadata: { fromOpenCode: true, shared: 'ours', openchamber: { goal: { status: 'active' } } },
    });
  });

  it('forwards unparsed SDK JSON bodies to generic API proxy requests', async () => {
    const upstream = express();
    upstream.post('/api/session/abc/revert', express.json(), (req, res) => {
      res.json({
        body: req.body,
        contentLength: req.headers['content-length'],
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const payload = { messageID: 'msg_1' };
    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/session/abc/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.body).toEqual(payload);
    expect(Number(data.contentLength)).toBeGreaterThan(0);
  });

  it('uses the long proxy timeout budget for slow upstream responses', async () => {
    const upstream = express();
    upstream.get('/api/slow', (_req, _res) => {
      // Leave the response open so the proxy timeout path is exercised.
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      LONG_REQUEST_TIMEOUT_MS: 50,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/slow`, {
      signal: AbortSignal.timeout(2000),
    });

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error: 'OpenCode upstream timed out' });
  });

});
