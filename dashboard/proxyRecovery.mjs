/**
 * ViaProxy の自動復旧ヘルパー。
 *
 * Windows 起動直後は Docker Desktop が Tailscale より先に立ち上がることがある。
 * その順番で起動した ViaProxy は接続先サーバーの名前解決に一度も成功しないまま
 * 動き続ける。待ち受けポートは開くので healthcheck は healthy のままで、
 * スポーンだけが "Could not connect to the backend server!" で失敗する。
 * 直し方は ViaProxy の再起動だけなので、ダッシュボードが自動でやる。
 */

export const PROXY_BACKEND_UNREACHABLE_MESSAGE =
  'ViaProxy が接続先サーバーにつながりませんでした。ViaProxy を再起動して自動で試し直します。';

export const PROXY_RECYCLING_MESSAGE =
  'ViaProxy をつなぎ直しています（接続先サーバーへの再接続中）…';

export const PROXY_RECYCLED_MESSAGE = 'ViaProxy をつなぎ直しました。';

export const PROXY_STILL_UNREACHABLE_MESSAGE =
  'ViaProxy をつなぎ直しても接続先サーバーにつながりませんでした。サーバーと Tailscale の状態を確認してください。';

export const PROXY_RESTART_FAILED_MESSAGE =
  'ViaProxy のつなぎ直しに失敗しました。restart.bat で再起動してください。';

/**
 * Minecraft の色コード（§c など）を落とす。
 * @param {unknown} text
 */
export function stripMinecraftFormatting(text) {
  return String(text ?? '').replace(/§[0-9a-fk-or]/gi, '');
}

/**
 * ViaProxy が「バックエンド（実サーバー）へ行けない」と言っているか。
 * ViaProxy のキック文言・Java 側の名前解決例外・こちらの和訳文のどれでも拾う。
 * @param {unknown} message
 */
export function isProxyBackendFailure(message) {
  const raw = stripMinecraftFormatting(message).trim();
  if (!raw) return false;
  return (
    /could not connect to the backend server/i.test(raw) ||
    /failed to connect to the backend server/i.test(raw) ||
    /unresolvedaddressexception/i.test(raw) ||
    /unknownhostexception/i.test(raw) ||
    raw.includes(PROXY_BACKEND_UNREACHABLE_MESSAGE)
  );
}

/**
 * 接続先サーバーへの到達性を見張り、「ViaProxy が動いている間に一度でも
 * 届かない時間帯があり、いま届くようになった」ら一度だけ再起動を促す。
 *
 * 起動順が原因の壊れ方はこの形にしかならない。逆に、ViaProxy 起動後ずっと
 * 届いているなら触らない。
 *
 * @param {{ cooldownMs?: number }} [options]
 */
export function createProxyWatch(options = {}) {
  const cooldownMs = Number(options.cooldownMs ?? 60000);

  /** @type {number | null} 見張り中の ViaProxy 起動時刻 */
  let currentRun = null;
  /** この起動中に接続先が落ちている（届かない）のを見たか */
  let sawUnreachable = false;
  /** @type {number | null} */
  let lastRestartAt = null;

  return { observe, state };

  /**
   * @param {{
   *   reachable?: boolean,
   *   proxyRunning?: boolean,
   *   proxyStartedAt?: number | null,
   *   spawned?: boolean,
   *   spawning?: boolean,
   *   busy?: boolean,
   *   now?: number
   * }} sample
   */
  function observe(sample = {}) {
    const now = Number(sample.now ?? Date.now());
    const startedAt = sample.proxyStartedAt ?? null;

    if (!sample.proxyRunning || startedAt == null) {
      currentRun = null;
      sawUnreachable = false;
      return hold('proxy-not-running');
    }

    if (startedAt !== currentRun) {
      // 別の起動（再起動直後）。前の起動で見た不通は引き継がない。
      currentRun = startedAt;
      sawUnreachable = false;
    }

    if (sample.spawned) {
      // 通信できている証拠。疑いは晴れる。
      sawUnreachable = false;
      return hold('session-active');
    }

    if (!sample.reachable) {
      sawUnreachable = true;
      return hold('target-unreachable');
    }

    if (!sawUnreachable) return hold('healthy');
    if (sample.spawning || sample.busy) return hold('busy');
    if (lastRestartAt != null && now - lastRestartAt < cooldownMs) return hold('cooldown');

    sawUnreachable = false;
    lastRestartAt = now;
    return { restart: true, reason: 'target-recovered' };
  }

  function state() {
    return { currentRun, sawUnreachable, lastRestartAt };
  }

  /** @param {string} reason */
  function hold(reason) {
    return { restart: false, reason };
  }
}
