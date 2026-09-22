import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentToolRuntime } from './runtime.js';
import { OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, OPENCHAMBER_CONTROL_ACTION_DEFINITIONS } from '../openchamber-control/actions.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createRuntime = async (overrides = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agent-tool-'));
  temporaryDirectories.push(dataDir);
  const executeAction = vi.fn(async () => ({ projects: [] }));
  const runtime = createAgentToolRuntime({
    crypto,
    fsPromises: fs,
    path,
    dataDir,
    getActivePort: () => 3901,
    executeAction,
    ...overrides,
  });
  return { runtime, dataDir, executeAction };
};

const pluginDirectoryFor = (dataDir) => path.join(dataDir, 'agent-tool', 'openchamber-agent-tool');

const loadTools = async (dataDir, tag) => {
  const entrypoint = path.join(pluginDirectoryFor(dataDir), 'index.js');
  const pluginModule = await import(`${pathToFileURL(entrypoint).href}?${tag}=${Date.now()}`);
  const registered = {};
  await pluginModule.default.setup({
    tool: {
      transform: async (transform) => transform({
        add: (tool) => { registered[tool.name] = tool; },
      }),
    },
  });
  return registered;
};

describe('agent tool action allowlist', () => {
  it('defines a short title and agent description for every action', () => {
    expect(OPENCHAMBER_CONTROL_ACTION_DEFINITIONS.every(({ action, title, description }) => action && title && description)).toBe(true);
  });

  it.each([
    'projects.list', 'models.list', 'session.list', 'session.create', 'session.send',
    'session.fork', 'session.status', 'session.messages', 'schedule.list',
    'schedule.create', 'schedule.run', 'schedule.delete', 'schedule.toggle', 'file.open',
  ])('delegates %s to the shared control service', async (action) => {
    const { runtime, executeAction } = await createRuntime();
    const input = { action, projectId: 'project-1' };
    await runtime.execute({ input, contextDirectory: '/work/project' });
    expect(executeAction).toHaveBeenCalledWith(action, input, '/work/project', {});
  });

  it.each(['session.delete', 'schedule.status'])('rejects %s outside the agent allowlist without invoking the service', async (action) => {
    const { runtime, executeAction } = await createRuntime();
    await expect(runtime.execute({ input: { action } })).resolves.toEqual(expect.objectContaining({
      ok: false,
      action,
      error: expect.objectContaining({ kind: 'usage' }),
    }));
    expect(executeAction).not.toHaveBeenCalled();
  });
});

describe('managed OpenCode v2 agent tool plugin', () => {
  it('materializes an importable v2 plugin with a package manifest', async () => {
    const { runtime, dataDir } = await createRuntime();
    const pluginDirectory = await runtime.materializePlugin();
    const manifest = JSON.parse(await fs.readFile(path.join(pluginDirectory, 'package.json'), 'utf8'));
    const source = await fs.readFile(path.join(pluginDirectory, 'index.js'), 'utf8');

    expect(pluginDirectory).toBe(pluginDirectoryFor(dataDir));
    expect(manifest.exports).toEqual({ '.': './index.js' });
    expect(source).not.toMatch(/\bimport\b/);
    expect(Object.keys(await loadTools(dataDir, 'materialized')).sort()).toEqual(['openchamber', 'openchamber_memory', 'openchamber_web']);
  });

  it('exposes path only in the generated control tool schema', async () => {
    const { runtime, dataDir } = await createRuntime();
    await runtime.materializePlugin({ includeMemory: false });
    const tools = await loadTools(dataDir, 'schema');
    const controlParameters = tools.openchamber.input.properties.parameters.properties;
    const webParameters = tools.openchamber_web.input.properties.parameters.properties;

    expect(controlParameters.path).toEqual(expect.objectContaining({ type: 'string' }));
    expect(webParameters.path).toBeUndefined();
    expect(controlParameters.url).toBeUndefined();
    expect(webParameters.url).toEqual(expect.objectContaining({ type: 'string' }));
  });

  it('resolves a v2 plugin callback directory from its session id', async () => {
    const resolveSessionDirectory = vi.fn(async () => '/work/other-worktree');
    const { runtime, executeAction } = await createRuntime({ resolveSessionDirectory });

    await runtime.execute({ input: { action: 'session.messages', sessionId: 'ses_1' }, sessionID: 'ses_1' });

    expect(resolveSessionDirectory).toHaveBeenCalledWith('ses_1');
    expect(executeAction).toHaveBeenCalledWith('session.messages', { action: 'session.messages', sessionId: 'ses_1' }, '/work/other-worktree', {});
  });

  it('requires the per-child token on the callback route', async () => {
    const { runtime } = await createRuntime();
    const env = runtime.createChildEnv();
    const app = express();
    runtime.registerRoutes(app, express);

    await request(app).post('/api/openchamber/agent-tool').send({ input: { action: 'projects.list' } }).expect(401);
    await request(app)
      .post('/api/openchamber/agent-tool')
      .set('authorization', `Bearer ${env.OPENCHAMBER_AGENT_TOOL_TOKEN}`)
      .send({ input: { action: 'projects.list' } })
      .expect(200);
  });

  it('cancels only the in-flight actions for the aborted session', async () => {
    let markStarted;
    let started = 0;
    const bothStarted = new Promise((resolve) => { markStarted = resolve; });
    const executeAction = vi.fn(async (_action, _input, _directory, options) => {
      started += 1;
      if (started === 2) markStarted();
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { statusCode: 499 })), { once: true });
      });
    });
    const { runtime } = await createRuntime({ executeAction });
    const env = runtime.createChildEnv();
    const app = express();
    runtime.registerRoutes(app, express);
    const headers = { authorization: `Bearer ${env.OPENCHAMBER_AGENT_TOOL_TOKEN}` };
    const first = request(app).post('/api/openchamber/agent-tool').set(headers).send({ input: { action: 'projects.list' }, sessionID: 'ses_one' }).then((response) => response);
    const second = request(app).post('/api/openchamber/agent-tool').set(headers).send({ input: { action: 'projects.list' }, sessionID: 'ses_two' }).then((response) => response);

    await bothStarted;
    expect(runtime.abortSession('ses_one')).toBe(1);
    expect((await first).status).toBe(200);
    expect(runtime.abortSession('ses_two')).toBe(1);
    expect((await second).status).toBe(200);
  });

  it('sends file.open path through the generated v2 callback', async () => {
    let activePort = null;
    const executeAction = vi.fn(async () => ({ opened: true }));
    const { runtime, dataDir } = await createRuntime({ executeAction, getActivePort: () => activePort, resolveSessionDirectory: async () => '/repo' });
    const app = express();
    runtime.registerRoutes(app, express);
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    activePort = server.address().port;
    const env = runtime.createChildEnv();
    const previousUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    const previousToken = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
    process.env.OPENCHAMBER_AGENT_TOOL_URL = env.OPENCHAMBER_AGENT_TOOL_URL;
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = env.OPENCHAMBER_AGENT_TOOL_TOKEN;
    try {
      await runtime.materializePlugin({ includeWeb: false, includeMemory: false });
      const tools = await loadTools(dataDir, 'file-open');
      const result = await tools.openchamber.execute(
        { action: 'file.open', parameters: { path: 'artifacts/report.csv' } },
        { sessionID: 'ses_file', progress: async () => {} },
      );

      expect(JSON.parse(result.content)).toEqual(expect.objectContaining({ ok: true, action: 'file.open' }));
      expect(executeAction).toHaveBeenCalledWith('file.open', { action: 'file.open', path: 'artifacts/report.csv' }, '/repo', expect.any(Object));
    } finally {
      if (previousUrl === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
      else process.env.OPENCHAMBER_AGENT_TOOL_URL = previousUrl;
      if (previousToken === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      else process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = previousToken;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
