/**
 * Spawn / kick error classification shared by control server and tests.
 */

export const DUPLICATE_LOGIN_RETRY_MESSAGE =
  '同じアカウントのセッションがサーバーに残っていました。解除を待って再接続しています…';

export const DUPLICATE_LOGIN_MESSAGE =
  '同じアカウントがサーバー上で既にログイン中です。別のクライアントで入っている場合は退出してください。残セッションなら数十秒待ってから再スポーンしてください。';

export const CONNECTION_FAILED_MESSAGE =
  'サーバー／プロキシへの接続に失敗しました。診断チェックを確認し、問題が続く場合は ViaProxy の再起動を試してください。';

/**
 * @param {unknown} reason
 */
export function extractKickReason(reason: unknown): string {
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  if (reason && typeof reason === 'object') {
    const value = reason as {
      text?: unknown;
      translate?: unknown;
      extra?: unknown;
    };
    if (typeof value.translate === 'string' && value.translate.trim()) {
      return value.translate.trim();
    }
    if (typeof value.text === 'string' && value.text.trim()) {
      return value.text.trim();
    }
    try {
      return JSON.stringify(reason);
    } catch {
      /* ignore */
    }
  }
  return String(reason || 'kicked');
}

/**
 * @param {string} message
 */
export function isDuplicateLoginError(message: string): boolean {
  return /duplicate_login/i.test(String(message || ''));
}

/**
 * @param {string} message
 * @param {{ retriesExhausted?: boolean }} [opts]
 */
export function humanizeSpawnFailure(
  message: string,
  opts: { retriesExhausted?: boolean } = {}
): string {
  const raw = String(message || '').trim();
  if (!raw) return 'スポーンに失敗しました';

  if (isDuplicateLoginError(raw)) {
    return opts.retriesExhausted ? DUPLICATE_LOGIN_MESSAGE : DUPLICATE_LOGIN_RETRY_MESSAGE;
  }

  if (
    /bot ended before spawn:\s*socketClosed/i.test(raw) ||
    /socketClosed/i.test(raw) ||
    /ECONNREFUSED/i.test(raw) ||
    /connect ETIMEDOUT/i.test(raw)
  ) {
    return CONNECTION_FAILED_MESSAGE;
  }

  return raw;
}
