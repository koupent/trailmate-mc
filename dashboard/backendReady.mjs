/**
 * Trailmate / ViaProxy readiness helpers for the dashboard.
 */

export const BACKEND_STARTING_MESSAGE =
  'ボット側の準備中です。コンテナ起動が終わるまでスポーンできません。';

export const PROXY_STARTING_MESSAGE =
  '接続用プロキシ（ViaProxy）の起動中です。しばらく待ってからスポーンしてください。';

/**
 * @param {string} [detail]
 */
export function backendUnavailableStatus(detail = BACKEND_STARTING_MESSAGE) {
  return {
    backendReady: false,
    spawnReady: false,
    spawned: false,
    spawning: false,
    botName: null,
    lastError: null,
    backendMessage: detail
  };
}

/**
 * @param {unknown} status
 * @param {{ backendReady?: boolean, spawnReady?: boolean, backendMessage?: string|null }} flags
 */
export function withReadiness(status, flags = {}) {
  const base = status && typeof status === 'object' ? status : {};
  const backendReady = flags.backendReady !== false;
  const spawnReady = flags.spawnReady !== false && backendReady;
  return {
    ...base,
    backendReady,
    spawnReady,
    backendMessage: flags.backendMessage ?? null
  };
}

/** @deprecated use withReadiness */
export function withBackendReady(status, ready) {
  return withReadiness(status, { backendReady: ready, spawnReady: ready });
}

/**
 * @param {string} message
 */
export function humanizeSpawnError(message) {
  const raw = String(message || '').trim();
  if (!raw) return BACKEND_STARTING_MESSAGE;
  if (
    /bot ended before spawn:\s*socketClosed/i.test(raw) ||
    /socketClosed/i.test(raw) ||
    /ECONNREFUSED/i.test(raw) ||
    /connect ETIMEDOUT/i.test(raw)
  ) {
    return PROXY_STARTING_MESSAGE;
  }
  return raw;
}

/**
 * @param {string} controlBaseUrl
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function probeTrailmateBackend(controlBaseUrl, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const base = String(controlBaseUrl || '').replace(/\/$/, '');
  if (!base) {
    return { ok: false, error: BACKEND_STARTING_MESSAGE };
  }

  try {
    const response = await fetchFn(`${base}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return { ok: false, error: BACKEND_STARTING_MESSAGE };
    }
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: BACKEND_STARTING_MESSAGE };
  }
}

/**
 * @param {{
 *   ok: boolean,
 *   status?: string,
 *   error?: string|null
 * }} health
 */
export function messageForProxyHealth(health) {
  if (health?.ok) return null;
  return PROXY_STARTING_MESSAGE;
}

/**
 * Spawn needs trailmate control API + ViaProxy healthy.
 * @param {{
 *   controlUrl: string,
 *   fetch?: typeof fetch,
 *   timeoutMs?: number,
 *   getProxyHealth?: () => Promise<{ ok: boolean, status?: string }>
 * }} options
 */
export async function probeSpawnReady(options) {
  const trailmate = await probeTrailmateBackend(options.controlUrl, options);
  if (!trailmate.ok) {
    return {
      ok: false,
      backendReady: false,
      spawnReady: false,
      error: trailmate.error || BACKEND_STARTING_MESSAGE
    };
  }

  if (typeof options.getProxyHealth === 'function') {
    let proxy;
    try {
      proxy = await options.getProxyHealth();
    } catch {
      proxy = { ok: false, status: 'error' };
    }
    if (!proxy?.ok) {
      return {
        ok: false,
        backendReady: true,
        spawnReady: false,
        error: messageForProxyHealth(proxy) || PROXY_STARTING_MESSAGE
      };
    }
  }

  return {
    ok: true,
    backendReady: true,
    spawnReady: true,
    error: null
  };
}
