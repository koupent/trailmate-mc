/**
 * 主対象コミット: 一度選んだ敵は、僅差の urgency 逆転では切り替えない。
 * （ノックバック後の混成フォーカスちらつき防止）
 */

import { attackFanRadius } from './attackFanSafeZone.js';
import { classifyEnemy } from './CombatProfiles.js';

export type FocusThreat = {
  id: number;
  x: number;
  z: number;
  kind: string;
  hp: number;
};

export type FocusXZ = { x: number; z: number };

/** urgency 切替マージン（ノックバック1m前後の僅差を吸収） */
export const FOCUS_URGENCY_SWITCH_MARGIN = 0.45;

export function threatUrgency(bot: FocusXZ, enemy: FocusThreat): number {
  const dist = Math.hypot(bot.x - enemy.x, bot.z - enemy.z);
  const radius = Math.max(1.2, attackFanRadius(enemy.kind) * (
    classifyEnemy(enemy.kind) === 'explosive' ? 0.55 : 0.35
  ));
  return dist / radius;
}

export type SelectCommittedFocusInput = {
  bot: FocusXZ;
  threats: FocusThreat[];
  stickyId: number | null | undefined;
  now: number;
  stickyMs: number;
  /** 着火クリーパーなど。あれば最優先で採用 */
  hardOverrideId?: number | null;
  urgencySwitchMargin?: number;
};

export type SelectCommittedFocusResult = {
  primary: FocusThreat | null;
  focusEnemyId: number | null;
  focusUntil: number;
  switched: boolean;
};

function pickFreshFocus(bot: FocusXZ, threats: FocusThreat[]): FocusThreat | null {
  if (threats.length === 0) return null;
  const allRanged = threats.every((enemy) => classifyEnemy(enemy.kind) === 'ranged');
  if (allRanged) {
    return [...threats].sort((a, b) => {
      if (a.hp !== b.hp) return a.hp - b.hp;
      return Math.hypot(bot.x - a.x, bot.z - a.z) - Math.hypot(bot.x - b.x, bot.z - b.z);
    })[0] ?? null;
  }
  return [...threats].sort((a, b) => threatUrgency(bot, a) - threatUrgency(bot, b))[0] ?? null;
}

/**
 * 主対象を選定する。
 * sticky 生存中は urgency マージン内なら維持（タイマー切れでも僅差なら切替えない）。
 */
export function selectCommittedFocus(
  input: SelectCommittedFocusInput
): SelectCommittedFocusResult {
  const threats = input.threats;
  const stickyMs = Math.max(700, input.stickyMs);
  const margin = input.urgencySwitchMargin ?? FOCUS_URGENCY_SWITCH_MARGIN;
  if (threats.length === 0) {
    return { primary: null, focusEnemyId: null, focusUntil: 0, switched: false };
  }

  if (input.hardOverrideId != null) {
    const hard = threats.find((enemy) => enemy.id === input.hardOverrideId) ?? null;
    if (hard) {
      return {
        primary: hard,
        focusEnemyId: hard.id,
        focusUntil: input.now + stickyMs,
        switched: input.stickyId !== hard.id
      };
    }
  }

  const sticky = input.stickyId != null
    ? threats.find((enemy) => enemy.id === input.stickyId) ?? null
    : null;
  const best = pickFreshFocus(input.bot, threats);
  if (!best) {
    return { primary: null, focusEnemyId: null, focusUntil: 0, switched: false };
  }

  if (sticky) {
    const stickyU = threatUrgency(input.bot, sticky);
    const bestU = threatUrgency(input.bot, best);
    if (sticky.id === best.id || stickyU <= bestU + margin) {
      return {
        primary: sticky,
        focusEnemyId: sticky.id,
        focusUntil: input.now + stickyMs,
        switched: false
      };
    }
  }

  return {
    primary: best,
    focusEnemyId: best.id,
    focusUntil: input.now + stickyMs,
    switched: input.stickyId !== best.id
  };
}

/** 打撃などで sticky を延長する（クラス不問） */
export function extendFocusLatch(
  now: number,
  stickyMs: number,
  enemyId: number
): { focusEnemyId: number; focusUntil: number } {
  return {
    focusEnemyId: enemyId,
    focusUntil: now + Math.max(700, stickyMs)
  };
}
