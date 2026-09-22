export const createOpenCodeNetworkRuntime = (deps) => {
  const {
    state,
    getOpenCodeAuthHeaders,
    configuredOpenCodeHostname = '127.0.0.1',
  } = deps;

  const resolveConnectHostname = () => {
    const raw = typeof configuredOpenCodeHostname === 'string' ? configuredOpenCodeHostname.trim() : '';
    const hostname = raw || '127.0.0.1';
    if (hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') {
      return '127.0.0.1';
    }
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname;
    }
    return hostname.includes(':') ? `[${hostname}]` : hostname;
  };

  const normalizeApiPrefix = (prefix) => {
    if (!prefix) {
      return '';
    }

    if (prefix.includes('://')) {
      try {
        const parsed = new URL(prefix);
        return normalizeApiPrefix(parsed.pathname);
      } catch {
        return '';
      }
    }

    const trimmed = prefix.trim();
    if (!trimmed || trimmed === '/') {
      return '';
    }
    const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
  };

  const waitForReady = async (url, timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let timeout = null;
      try {
        const controller = new AbortController();
        const remainingMs = timeoutMs - (Date.now() - start);
        timeout = setTimeout(() => controller.abort(), Math.min(3000, remainingMs));
        const response = await fetch(`${url.replace(/\/+$/, '')}/api/info`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...getOpenCodeAuthHeaders(),
          },
          signal: controller.signal,
        });

        if (response.status === 401) {
          return {
            ready: false,
            retryable: false,
            failure: {
              class: 'authentication',
              detail: 'OpenCode readiness authentication failed (HTTP 401). Check the managed server password.',
            },
          };
        }
        if (response.status === 404) {
          return {
            ready: false,
            retryable: false,
            failure: {
              class: 'incompatible_endpoint',
              detail: 'OpenCode readiness endpoint /api/info is unavailable (HTTP 404). Update OpenCode to a compatible version.',
            },
          };
        }
        if (response.status !== 200) {
          return {
            ready: false,
            retryable: false,
            failure: {
              class: 'invalid_response',
              detail: `OpenCode readiness endpoint returned HTTP ${response.status ?? 'unknown'}.`,
            },
          };
        }

        let body;
        try {
          body = await response.json();
        } catch (error) {
          if (controller.signal.aborted) {
            throw error;
          }
          return {
            ready: false,
            retryable: false,
            failure: {
              class: 'invalid_response',
              detail: 'OpenCode readiness endpoint returned invalid JSON.',
            },
          };
        }
        const version = typeof body?.version === 'string' ? body.version.trim() : '';
        const pid = body?.pid;
        if (!version || !Number.isFinite(pid) || pid <= 0) {
          return {
            ready: false,
            retryable: false,
            failure: {
              class: 'invalid_response',
              detail: 'OpenCode readiness endpoint must return a non-empty version and positive finite pid.',
            },
          };
        }
        return { ready: true, version, pid };
      } catch {
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
      const remainingMs = timeoutMs - (Date.now() - start);
      if (remainingMs <= 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingMs)));
    }
    return {
      ready: false,
      retryable: true,
      failure: {
        class: 'unreachable',
        detail: 'OpenCode readiness endpoint did not become reachable before the startup deadline.',
      },
    };
  };

  const setDetectedOpenCodeApiPrefix = () => {
    state.openCodeApiPrefix = '';
    state.openCodeApiPrefixDetected = true;
    if (state.openCodeApiDetectionTimer) {
      clearTimeout(state.openCodeApiDetectionTimer);
      state.openCodeApiDetectionTimer = null;
    }
  };

  const buildOpenCodeUrl = (path, prefixOverride) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const prefix = normalizeApiPrefix(prefixOverride !== undefined ? prefixOverride : '');
    const fullPath = `${prefix}${normalizedPath}`;
    const base = state.openCodeBaseUrl ?? `http://${resolveConnectHostname()}:${state.openCodePort}`;
    return `${base}${fullPath}`;
  };

  const detectOpenCodeApiPrefix = () => {
    state.openCodeApiPrefixDetected = true;
    state.openCodeApiPrefix = '';
    return true;
  };

  const ensureOpenCodeApiPrefix = () => detectOpenCodeApiPrefix();

  const scheduleOpenCodeApiDetection = () => {
    return;
  };

  return {
    waitForReady,
    normalizeApiPrefix,
    setDetectedOpenCodeApiPrefix,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    scheduleOpenCodeApiDetection,
  };
};
