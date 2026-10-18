/**
 * 本番（Mineflayer）の世界を、共通の戦闘判断（CombatStep）の観測に変換する。
 *
 * 箱庭はボクセルで地形を問い合わせるが、本番は raycast で問い合わせる。
 * 経路の迂回は pathfinder が行うので、接近点・退避点は「どちらへ行くか」だけ決める。
 */

import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { isCreeperIgnited } from '../combat/creeperTactics.js';
import {
  pickMixedMeleeCoverPoint,
  type CombatScene,
  type ScenePoint,
  type SceneThreat
} from '../combat/CombatStep.js';
import { combatDistance, MELEE_HOLD_RANGE } from '../combat/CombatParams.js';
import { threatBearingRad, type XZ } from '../combat/threatArc.js';

const EYE_HEIGHT = 1.62;
/** 視線を通す先（敵の胴）。背の低い敵や低い天井でも当たるよう目線より下。 */
const TARGET_HEIGHT = 1.0;
/** 矢を放つ高さ（スケルトンの手元）。1段の壁は越えて飛んでくる。 */
const ARROW_LAUNCH_HEIGHT = 1.5;
/** 矢が当たる高さ（相棒の胴）。 */
const ARROW_HIT_HEIGHT = 1.2;
/** 矢が他の敵に吸われるとみなす距離（箱庭と同じ）。 */
const ARROW_HIT_RADIUS = 0.65;
/** 1段は跳んで越えられるので、それより上で直線に歩けるかを raycast で見る。 */
const STEP_CLEAR_HEIGHT = 1.1;
/** 1tickで進める距離の目安（歩き 4.3m/s × 0.25s）。 */
const STEP_PER_TICK = 1.0;

type LiveEntity = {
  id?: number;
  name?: string;
  position: { x: number; y: number; z: number };
  health?: number;
  metadata?: unknown;
};

export type LiveSceneInput = {
  bot: Bot;
  now: number;
  tick: number;
  tickMs: number;
  threats: LiveEntity[];
  owner: XZ | null;
  hasShield: boolean;
  lastDamageAt: number;
  priorityThreatId: number | null;
  params: CombatScene['params'];
};

function pointAt(origin: XZ, bearing: number, amount: number): XZ {
  return { x: origin.x + Math.sin(bearing) * amount, z: origin.z + Math.cos(bearing) * amount };
}

/** from→to の raycast が地形に当たる。 */
function rayBlocked(bot: Bot, from: ScenePoint, to: ScenePoint): boolean {
  try {
    const start = new Vec3(from.x, from.y, from.z);
    const delta = new Vec3(to.x, to.y, to.z).minus(start);
    const dist = delta.norm();
    if (dist < 0.15) return false;
    return bot.world.raycast(start, delta.scaled(1 / dist), dist) !== null;
  } catch {
    return false;
  }
}

function segmentDistance(p: XZ, a: XZ, b: XZ): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

/** 着地先が溶岩、または2段以上の落下になる。 */
function unsafeLanding(bot: Bot, to: XZ, y: number): boolean {
  try {
    const at = (dy: number) => bot.blockAt(new Vec3(to.x, Math.floor(y) + dy, to.z));
    const feet = at(0);
    if (String(feet?.name ?? '').includes('lava')) return true;
    const below = at(-1);
    if (String(below?.name ?? '').includes('lava')) return true;
    return below?.boundingBox === 'empty' && at(-2)?.boundingBox === 'empty';
  } catch {
    return false;
  }
}

export function buildLiveCombatScene(input: LiveSceneInput): CombatScene {
  const { bot } = input;
  const pos = bot.entity.position;
  const botPoint = { x: pos.x, y: pos.y, z: pos.z, hp: Number.isFinite(bot.health) ? bot.health : 20 };
  const threats: SceneThreat[] = input.threats
    .filter((entity) => entity?.id != null && entity.position)
    .map((entity) => ({
      id: Number(entity.id),
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      kind: String(entity.name || 'unknown'),
      hp: Number.isFinite(Number(entity.health)) ? Number(entity.health) : 20,
      ignited: isCreeperIgnited(entity as { name?: string; metadata?: unknown })
    }));
  const pathBlocked = (from: ScenePoint, to: XZ) => rayBlocked(
    bot,
    { x: from.x, y: from.y + STEP_CLEAR_HEIGHT, z: from.z },
    { x: to.x, y: from.y + STEP_CLEAR_HEIGHT, z: to.z }
  ) || unsafeLanding(bot, to, from.y);
  const eye = (p: Partial<ScenePoint> & XZ, fallbackY: number): ScenePoint => ({
    x: p.x,
    y: (p.y ?? fallbackY) + EYE_HEIGHT,
    z: p.z
  });

  return {
    now: input.now,
    tickMs: input.tickMs,
    tick: input.tick,
    bot: botPoint,
    threats,
    owner: input.owner,
    hasShield: input.hasShield,
    // 本番ではノックバック硬直を観測できない。
    stunned: false,
    lastDamageAt: input.lastDamageAt,
    // 本番に闘技場の端はない。詰まりは approachStuckTicks で扱う。
    cornered: false,
    priorityThreatId: input.priorityThreatId,
    params: input.params,
    hasLineOfSight: (from, to) => !rayBlocked(
      bot,
      eye(from, from.y),
      { x: to.x, y: to.y + TARGET_HEIGHT, z: to.z }
    ),
    rangedHitsBot: (shooter) => {
      const from = { x: shooter.x, y: shooter.y + ARROW_LAUNCH_HEIGHT, z: shooter.z };
      const to = { x: botPoint.x, y: botPoint.y + ARROW_HIT_HEIGHT, z: botPoint.z };
      if (rayBlocked(bot, from, to)) return false;
      // 間に別の敵がいれば矢はそちらに当たる（肉壁）。
      return !threats.some((other) => other.id !== shooter.id
        && segmentDistance(other, shooter, botPoint) < ARROW_HIT_RADIUS
        && combatDistance(other, botPoint) < combatDistance(shooter, botPoint));
    },
    terrainBlocked: (from, to) => rayBlocked(bot, eye(from, 1), eye(to, botPoint.y)),
    pathBlocked,
    approachPoint: (target) => {
      const bearing = threatBearingRad(botPoint, target);
      return pointAt(botPoint, bearing, Math.max(0.6, combatDistance(botPoint, target) - MELEE_HOLD_RANGE));
    },
    creeperFleePoint: (creeper, amount) => {
      const base = threatBearingRad(creeper, botPoint);
      for (const offset of [0, 0.55, -0.55, 1.1, -1.1, Math.PI / 2, -Math.PI / 2]) {
        const point = pointAt(botPoint, base + offset, amount);
        if (!pathBlocked(botPoint, point)) return point;
      }
      return pointAt(botPoint, base, amount);
    },
    approachKeepingCreeperDistance: (primary, creeper, soft, flank) => {
      // 箱庭と同じ採点。1tick分進んだ位置で、クリーパー間合いを崩さず主対象へ近づく方向を選ぶ。
      const toPrimary = threatBearingRad(botPoint, primary);
      const awayCreeper = threatBearingRad(creeper, botPoint);
      const startPrimary = combatDistance(botPoint, primary);
      const startCreeper = combatDistance(botPoint, creeper);
      let best: XZ | null = null;
      let bestScore = -Infinity;
      const consider = (bearing: number, amount: number, penalty: number) => {
        const target = pointAt(botPoint, bearing, amount);
        if (pathBlocked(botPoint, target)) return;
        const stepped = pointAt(botPoint, bearing, Math.min(amount, STEP_PER_TICK));
        const nextPrimary = Math.hypot(stepped.x - primary.x, stepped.z - primary.z);
        const nextCreeper = Math.hypot(stepped.x - creeper.x, stepped.z - creeper.z);
        // 間合いを切り崩す前進は採用しない（振動死の主因）
        if (nextCreeper < soft - 0.05) return;
        if (nextCreeper < startCreeper - 0.12 && nextCreeper < soft + 0.6) return;
        const score = (startPrimary - nextPrimary) * 3.2
          + (nextCreeper - Math.min(startCreeper, soft + 0.4)) * 3.0
          + Math.min(amount, STEP_PER_TICK)
          - penalty;
        if (score > bestScore) {
          bestScore = score;
          best = target;
        }
      };
      consider(toPrimary, Math.max(0.6, startPrimary - MELEE_HOLD_RANGE), 0);
      for (const offset of [0.45, -0.45, 0.9, -0.9, Math.PI / 2, -Math.PI / 2, 1.8, -1.8]) {
        consider(toPrimary + flank * offset, 2.6, Math.abs(offset) * 0.15);
      }
      for (const offset of [Math.PI / 2, -Math.PI / 2, 1.2, -1.2, 2.2, -2.2]) {
        consider(awayCreeper + flank * offset, 2.8, 0.05);
      }
      // どうしても間合いを保てないときはクリーパーから離れて次tickに回る
      return best ?? pointAt(botPoint, awayCreeper, 2.4);
    },
    meleeCoverPoint: (meleeAlly, ranged) => pickMixedMeleeCoverPoint(botPoint, meleeAlly, ranged, pathBlocked)
  };
}
