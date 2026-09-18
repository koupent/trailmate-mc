/**
 * Spawn readiness diagnostics for the dashboard.
 */
import net from 'node:net';
import {
  PROXY_BACKEND_UNREACHABLE_MESSAGE,
  isProxyBackendFailure
} from './proxyRecovery.mjs';

export const BACKEND_STARTING_MESSAGE =
  'ボット API の起動中です。コンテナが立ち上がるまでスポーンできません。';

export const PROXY_STARTING_MESSAGE =
  'ViaProxy の起動中です（まだ受け付けていません）。';

export const TARGET_UNREACHABLE_MESSAGE =
  '接続先サーバーに届きません。サーバー起動や Tailscale 接続を確認してください。';

export const TARGET_PLACEHOLDER_MESSAGE =
  '接続先サーバー住所が未設定です。設定タブで住所を保存してください。';

export const ACCOUNT_MISSING_MESSAGE =
  'Microsoft アカウントが未登録です。設定タブでログインしてください。';

export const SESSION_FAILED_MESSAGE =
  '接続は試みましたが途中で切断されました。同一アカウントの重複ログインの可能性があります。数十秒待って再スポーンするか、別クライアントを退出してください。';

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
    backendMessage: detail,
    diagnostics: null
  };
}

/**
 * @param {unknown} status
 * @param {{
 *   backendReady?: boolean,
 *   spawnReady?: boolean,
 *   backendMessage?: string|null,
 *   diagnostics?: object|null
 * }} flags
 */
export function withReadiness(status, flags = {}) {
  const base = status && typeof status === 'object' ? status : {};
  const backendReady = flags.backendReady !== false;
  const spawnReady = Boolean(flags.spawnReady) && backendReady;
  return {
    ...base,
    backendReady,
    spawnReady,
    backendMessage: flags.backendMessage ?? null,
    diagnostics: flags.diagnostics ?? base.diagnostics ?? null
  };
}

/** @deprecated */
export function withBackendReady(status, ready) {
  return withReadiness(status, { backendReady: ready, spawnReady: ready });
}

/**
 * @param {string} address
 */
export function parseHostPort(address, defaultPort = 25565) {
  const raw = String(address || '').trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    const m = raw.match(/^\[([^\]]+)\]:(\d+)$/);
    if (!m) return null;
    return { host: m[1], port: Number(m[2]) };
  }
  const idx = raw.lastIndexOf(':');
  if (idx > 0 && raw.indexOf(':') === idx) {
    const host = raw.slice(0, idx).trim();
    const port = Number(raw.slice(idx + 1));
    if (!host || !Number.isFinite(port)) return null;
    return { host, port };
  }
  return { host: raw, port: defaultPort };
}

/**
 * @param {string} address
 */
export function isPlaceholderAddress(address) {
  const raw = String(address || '').trim();
  if (!raw) return true;
  if (/your-minecraft-host/i.test(raw)) return true;
  const parsed = parseHostPort(raw);
  const host = (parsed?.host || raw).toLowerCase();
  return host === 'example.com';
}

/**
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @param {typeof net.connect} [connectFn]
 */
export function probeTcp(host, port, timeoutMs = 2500, connectFn = net.connect) {
  return new Promise((resolve) => {
    /** @type {import('node:net').Socket | null} */
    let socket = null;
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok, detail });
    };
    try {
      socket = connectFn({ host, port });
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true, `${host}:${port}`));
      socket.once('timeout', () => done(false, `timeout ${host}:${port}`));
      socket.once('error', (err) => done(false, err?.message || String(err)));
    } catch (error) {
      done(false, error instanceof Error ? error.message : String(error));
    }
  });
}

/**
 * @param {string} message
 * @param {{ spawnReady?: boolean, blockerId?: string|null }} [ctx]
 */
export function humanizeSpawnError(message, ctx = {}) {
  const raw = String(message || '').trim();
  if (!raw) return BACKEND_STARTING_MESSAGE;

  if (/duplicate_login/i.test(raw) || /同じアカウント/.test(raw)) {
    return raw.includes('残って') || raw.includes('既にログイン')
      ? raw
      : '同じアカウントがサーバー上で既にログイン中です。別クライアントを退出するか、数十秒待って再スポーンしてください。';
  }

  if (isProxyBackendFailure(raw)) return PROXY_BACKEND_UNREACHABLE_MESSAGE;

  const connectionLike =
    /bot ended before spawn:\s*socketClosed/i.test(raw) ||
    /socketClosed/i.test(raw) ||
    /ECONNREFUSED/i.test(raw) ||
    /connect ETIMEDOUT/i.test(raw);

  if (!connectionLike) return raw;

  if (ctx.blockerId === 'target') return TARGET_UNREACHABLE_MESSAGE;
  if (ctx.blockerId === 'viaproxy') return PROXY_STARTING_MESSAGE;
  if (ctx.blockerId === 'trailmate') return BACKEND_STARTING_MESSAGE;
  if (ctx.spawnReady) return SESSION_FAILED_MESSAGE;
  return PROXY_STARTING_MESSAGE;
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
    return { ok: false, error: BACKEND_STARTING_MESSAGE, status: 'missing' };
  }

  try {
    const response = await fetchFn(`${base}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return { ok: false, error: BACKEND_STARTING_MESSAGE, status: `http-${response.status}` };
    }
    return { ok: true, error: null, status: 'ok' };
  } catch {
    return { ok: false, error: BACKEND_STARTING_MESSAGE, status: 'unreachable' };
  }
}

/**
 * @param {{ ok: boolean, status?: string }} health
 */
export function messageForProxyHealth(health) {
  if (health?.ok) return null;
  if (health?.status === 'starting') return PROXY_STARTING_MESSAGE;
  if (health?.status === 'missing' || health?.status === 'stopped') {
    return 'ViaProxy コンテナが起動していません。';
  }
  if (health?.status === 'unhealthy') return 'ViaProxy が unhealthy です。ログを確認してください。';
  return PROXY_STARTING_MESSAGE;
}

/**
 * Build a checklist users can understand while waiting / debugging.
 * @param {{
 *   controlUrl: string,
 *   targetAddress?: string,
 *   authMethod?: string,
 *   registeredAccount?: { registered?: boolean, name?: string|null },
 *   fetch?: typeof fetch,
 *   timeoutMs?: number,
 *   getProxyHealth?: () => Promise<{ ok: boolean, status?: string }>,
 *   probeTcpFn?: typeof probeTcp
 * }} options
 */
export async function buildSpawnDiagnostics(options) {
  const steps = [];
  const tcpProbe = options.probeTcpFn || probeTcp;

  const trailmate = await probeTrailmateBackend(options.controlUrl, options);
  steps.push({
    id: 'trailmate',
    label: 'ボット API（trailmate）',
    state: trailmate.ok ? 'ok' : trailmate.status === 'unreachable' ? 'starting' : 'error',
    detail: trailmate.ok ? '応答あり' : '起動待ち／未応答'
  });

  let proxy = { ok: true, status: 'skipped' };
  if (typeof options.getProxyHealth === 'function') {
    try {
      proxy = await options.getProxyHealth();
    } catch {
      proxy = { ok: false, status: 'error' };
    }
  }
  steps.push({
    id: 'viaproxy',
    label: 'ViaProxy',
    state: proxy.ok ? 'ok' : proxy.status === 'starting' ? 'starting' : 'error',
    detail: proxy.ok
      ? proxy.status === 'healthy'
        ? 'healthy'
        : '起動済み'
      : messageForProxyHealth(proxy) || String(proxy.status || '未準備')
  });

  const targetAddress = String(options.targetAddress || '').trim();
  const placeholder = isPlaceholderAddress(targetAddress);
  if (!targetAddress || placeholder) {
    steps.push({
      id: 'target',
      label: '接続先サーバー',
      state: 'error',
      detail: TARGET_PLACEHOLDER_MESSAGE
    });
  } else {
    const parsed = parseHostPort(targetAddress);
    if (!parsed) {
      steps.push({
        id: 'target',
        label: '接続先サーバー',
        state: 'error',
        detail: `住所を解釈できません: ${targetAddress}`
      });
    } else {
      const probe = await tcpProbe(parsed.host, parsed.port);
      steps.push({
        id: 'target',
        label: '接続先サーバー',
        state: probe.ok ? 'ok' : 'error',
        detail: probe.ok
          ? `${parsed.host}:${parsed.port} に到達`
          : `${parsed.host}:${parsed.port} に届かない（${probe.detail}）`
      });
    }
  }

  const authMethod = options.authMethod === 'NONE' ? 'NONE' : 'ACCOUNT';
  if (authMethod === 'NONE') {
    steps.push({
      id: 'account',
      label: '認証',
      state: 'ok',
      detail: 'オフライン認証'
    });
  } else if (options.registeredAccount?.registered) {
    steps.push({
      id: 'account',
      label: 'Microsoft アカウント',
      state: 'ok',
      detail: options.registeredAccount.name
        ? `登録済み: ${options.registeredAccount.name}`
        : '登録済み'
    });
  } else {
    steps.push({
      id: 'account',
      label: 'Microsoft アカウント',
      state: 'error',
      detail: ACCOUNT_MISSING_MESSAGE
    });
  }

  const blocker = steps.find((step) => step.state !== 'ok') || null;
  const backendReady = Boolean(trailmate.ok);
  const spawnReady = !blocker;
  let summary = 'スポーンできる状態です。';
  if (blocker) {
    if (blocker.state === 'starting') {
      summary = `${blocker.label}の準備がまだ終わっていません。自動で再確認します。`;
    } else {
      summary = `${blocker.label}がスポーンを止めています。`;
    }
  }

  return {
    ok: spawnReady,
    backendReady,
    spawnReady,
    blockerId: blocker?.id || null,
    error: blocker
      ? blocker.id === 'trailmate'
        ? BACKEND_STARTING_MESSAGE
        : blocker.id === 'viaproxy'
          ? messageForProxyHealth(proxy) || PROXY_STARTING_MESSAGE
          : blocker.id === 'target'
            ? placeholder || !targetAddress
              ? TARGET_PLACEHOLDER_MESSAGE
              : TARGET_UNREACHABLE_MESSAGE
            : blocker.id === 'account'
              ? ACCOUNT_MISSING_MESSAGE
              : blocker.detail
      : null,
    summary,
    steps,
    checkedAt: new Date().toISOString()
  };
}

/**
 * @param {Parameters<typeof buildSpawnDiagnostics>[0]} options
 */
export async function probeSpawnReady(options) {
  const diagnostics = await buildSpawnDiagnostics(options);
  return {
    ok: diagnostics.spawnReady,
    backendReady: diagnostics.backendReady,
    spawnReady: diagnostics.spawnReady,
    error: diagnostics.error,
    diagnostics
  };
}
