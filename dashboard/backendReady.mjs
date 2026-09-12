/**
 * Trailmate control API readiness helpers for the dashboard.
 */

export const BACKEND_STARTING_MESSAGE =
  'ボット側の準備中です。コンテナ起動が終わるまでスポーンできません。';

/**
 * @param {string} [detail]
 */
export function backendUnavailableStatus(detail = BACKEND_STARTING_MESSAGE) {
  return {
    backendReady: false,
    spawned: false,
    spawning: false,
    botName: null,
    lastError: null,
    backendMessage: detail
  };
}

/**
 * @param {unknown} status
 * @param {boolean} ready
 */
export function withBackendReady(status, ready) {
  const base = status && typeof status === 'object' ? status : {};
  return {
    ...base,
    backendReady: Boolean(ready)
  };
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
