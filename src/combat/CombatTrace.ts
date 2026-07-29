export const COMBAT_TRACE_HEARTBEAT_MS = 1000;

export type CombatTraceLogger = (line: string) => void;

export function isCombatTraceEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.COMBAT_TRACE === '1';
}

/**
 * Opt-in structured combat trace. Disabled traces return before payload
 * construction at call sites; enabled decision snapshots are emitted only on
 * tactical state changes or a low-rate heartbeat.
 */
export class CombatTrace {
  readonly enabled: boolean;
  readonly heartbeatMs: number;
  private lastDecisionKey = '';
  private lastDecisionAt = -Infinity;
  private lastRecoveryKey = '';
  private lastRecoveryAt = -Infinity;

  constructor(opts: {
    enabled?: boolean;
    heartbeatMs?: number;
    logger?: CombatTraceLogger;
  } = {}) {
    this.enabled = opts.enabled ?? isCombatTraceEnabled();
    this.heartbeatMs = Math.max(250, opts.heartbeatMs ?? COMBAT_TRACE_HEARTBEAT_MS);
    this.logger = opts.logger ?? console.log;
  }

  private readonly logger: CombatTraceLogger;

  decision(
    stateKey: string,
    payload: Record<string, unknown>,
    now = Date.now()
  ): boolean {
    if (!this.enabled) return false;
    const changed = stateKey !== this.lastDecisionKey;
    if (!changed && now - this.lastDecisionAt < this.heartbeatMs) return false;
    this.lastDecisionKey = stateKey;
    this.lastDecisionAt = now;
    this.emit('decision', payload, now);
    return true;
  }

  event(
    event: string,
    payload: Record<string, unknown> = {},
    now = Date.now()
  ): boolean {
    if (!this.enabled) return false;
    this.emit(event, payload, now);
    return true;
  }

  recovery(
    stateKey: string,
    payload: Record<string, unknown>,
    now = Date.now()
  ): boolean {
    if (!this.enabled) return false;
    const changed = stateKey !== this.lastRecoveryKey;
    if (!changed && now - this.lastRecoveryAt < this.heartbeatMs) return false;
    this.lastRecoveryKey = stateKey;
    this.lastRecoveryAt = now;
    this.emit('recovery_heartbeat', payload, now);
    return true;
  }

  private emit(event: string, payload: Record<string, unknown>, now: number): void {
    this.logger(`[combat-trace] ${JSON.stringify({
      ts: new Date(now).toISOString(),
      at: now,
      event,
      ...payload
    })}`);
  }
}
