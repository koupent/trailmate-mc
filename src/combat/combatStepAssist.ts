import type { ControlState } from 'mineflayer';
import { scanSurroundings } from '../companion/movement/surroundings.js';
import { movementControlsTowardBearing } from './threatArc.js';

export type StepCell = {
  dx: number;
  dz: number;
  rise: number | null;
  center: { x: number; y: number; z: number };
};

type StepAssistBot = {
  entity?: {
    position: { x: number; y: number; z: number };
    yaw: number;
    onGround?: boolean;
  } | null;
  setControlState: (control: ControlState, state: boolean) => void;
};

/** 移動方位の前方に1ブロック段差があるかを返す。 */
export function stepAheadAlongBearing(
  bot: StepAssistBot,
  bearingRad: number
): StepCell | null {
  if (!bot.entity?.position) return null;
  const pos = bot.entity.position;
  const scan = scanSurroundings(bot as Parameters<typeof scanSurroundings>[0], {
    x: pos.x + Math.sin(bearingRad) * 2,
    y: pos.y,
    z: pos.z + Math.cos(bearingRad) * 2
  });
  return scan.stepUps[0] ?? null;
}

/**
 * 戦闘中のキー入力移動で段差に乗れるよう、接地時にジャンプと前進成分を補助する。
 * @returns 段差補助を適用した場合 true
 */
export function applyCombatStepAssist(
  bot: StepAssistBot,
  bearingRad: number
): boolean {
  if (!bot.entity?.onGround) return false;
  const step = stepAheadAlongBearing(bot, bearingRad);
  if (!step) return false;

  bot.setControlState('jump', true);
  const controls = movementControlsTowardBearing(bearingRad, bot.entity.yaw, 0.1);
  bot.setControlState('forward', controls.forward);
  bot.setControlState('back', controls.back);
  bot.setControlState('left', controls.left);
  bot.setControlState('right', controls.right);
  if (!controls.forward && !controls.back && !controls.left && !controls.right) {
    bot.setControlState('forward', true);
  }
  return true;
}
