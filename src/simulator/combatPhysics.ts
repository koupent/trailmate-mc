/**
 * 箱庭用のノックバックとクリーパー着火／爆発。
 * JE の体感に寄せたモデル（厳密再現ではないが、次は守る）:
 * - 約 3 以内＋視線で着火、約 1.5s 後に爆発
 * - 約 7 以上で自然消火
 * - 着火中は移動しない
 * - 殴ってもタイマーは消えない（倒すか離れるか）
 */

import {
  hasVoxelLineOfSight,
  standingY,
  stepEntity,
  type Vec3
} from './voxel.js';

export type PhysicsPoint = Vec3;

export type PhysicsEnemy = PhysicsPoint & {
  id: number;
  kind: string;
  hp: number;
  stunUntil?: number;
  fuseStartedAt?: number | null;
};

export type PhysicsBot = PhysicsPoint & {
  yaw: number;
  hp: number;
};

/** 着火開始距離（JE おおよそ 3）。 */
export const CREEPER_IGNITE_RANGE = 3.0;
/** 距離で自然消火（JE おおよそ 7）。 */
export const CREEPER_DEFUSE_RANGE = 7.0;
/** 着火から爆発までの時間（JE 1.5s）。 */
export const CREEPER_FUSE_MS = 1500;
/** 爆発の有効半径。 */
export const CREEPER_BLAST_RADIUS = 4.5;
/** 爆心の最大ダメージ。 */
export const CREEPER_BLAST_MAX_DAMAGE = 18;

export const MELEE_KNOCKBACK = 1.05;
export const RANGED_KNOCKBACK = 0.45;
export const BLAST_KNOCKBACK = 1.6;
export const MELEE_STUN_MS = 400;
export const RANGED_STUN_MS = 200;

const MELEE_HEIGHT_SLACK = 1.5;

function combatDistance(a: PhysicsPoint, b: PhysicsPoint): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const horizontal = Math.hypot(dx, dz);
  const dy = Math.abs((a.y ?? 0) - (b.y ?? 0));
  if (dy <= MELEE_HEIGHT_SLACK) return horizontal;
  return Math.hypot(horizontal, dy);
}

export function isSimCreeperIgnited(
  enemy: Pick<PhysicsEnemy, 'kind' | 'fuseStartedAt'> | null | undefined
): boolean {
  if (!enemy || enemy.kind !== 'creeper') return false;
  // null/undefined = 未着火。0 以上の開始時刻は着火中。
  return enemy.fuseStartedAt != null;
}

/** 0〜1。着火していなければ 0。 */
export function creeperFuseProgress(
  enemy: Pick<PhysicsEnemy, 'kind' | 'fuseStartedAt'> | null | undefined,
  now: number
): number {
  if (!isSimCreeperIgnited(enemy) || enemy == null) return 0;
  const started = Number(enemy.fuseStartedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.min(1, (now - started) / CREEPER_FUSE_MS));
}

export function isStunned(now: number, stunUntil?: number | null): boolean {
  return Number(stunUntil) > now;
}

/**
 * 攻撃者から離れる方向へ押し出す。壁があれば stepEntity で止まる。
 */
export function applyKnockback(
  blocks: Set<string>,
  target: PhysicsPoint,
  from: PhysicsPoint,
  strength: number
): PhysicsPoint {
  const dx = (target.x - from.x);
  const dz = (target.z - from.z);
  const len = Math.hypot(dx, dz);
  const ux = len > 1e-6 ? dx / len : 0;
  const uz = len > 1e-6 ? dz / len : 1;
  const goal = {
    x: target.x + ux * strength,
    z: target.z + uz * strength
  };
  const stepped = stepEntity(blocks, target, goal, strength);
  return {
    x: stepped.x,
    y: standingY(blocks, stepped.x, stepped.z, (target.y ?? 1) + 2),
    z: stepped.z
  };
}

export type HurtBotState = {
  now: number;
  bot: PhysicsBot;
  botDead: boolean;
  damageTaken: number;
  lastDamageAt: number;
  botStunUntil?: number;
};

export function hurtBot(
  state: HurtBotState,
  blocks: Set<string>,
  from: PhysicsPoint,
  damage: number,
  knockback = MELEE_KNOCKBACK,
  stunMs = MELEE_STUN_MS
): void {
  if (damage <= 0 || state.botDead) return;
  state.bot.hp = Math.max(0, state.bot.hp - damage);
  state.damageTaken += damage;
  state.lastDamageAt = state.now;
  const pushed = applyKnockback(blocks, state.bot, from, knockback);
  state.bot = { ...state.bot, ...pushed };
  state.botStunUntil = Math.max(state.botStunUntil || 0, state.now + stunMs);
}

export type StrikeEnemyState = {
  now: number;
  bot: PhysicsPoint;
  attacks: number;
};

/**
 * 相棒の近接ヒット。ダメージ・ノックバック・硬直。
 * JE同様、クリーパーの着火は殴っても消えない（倒すか離れる）。
 */
export function strikeEnemy(
  state: StrikeEnemyState,
  blocks: Set<string>,
  enemy: PhysicsEnemy,
  damage: number,
  knockback = MELEE_KNOCKBACK
): void {
  if (damage <= 0 || enemy.hp <= 0) return;
  enemy.hp -= damage;
  state.attacks += 1;
  const pushed = applyKnockback(blocks, enemy, state.bot, knockback);
  enemy.x = pushed.x;
  enemy.y = pushed.y;
  enemy.z = pushed.z;
  enemy.stunUntil = Math.max(enemy.stunUntil || 0, state.now + MELEE_STUN_MS);
}

export type FuseTickState = {
  now: number;
  tick: number;
  bot: PhysicsBot;
  botDead: boolean;
  damageTaken: number;
  lastDamageAt: number;
  botStunUntil?: number;
  enemies: PhysicsEnemy[];
  transitions: string[];
};

/**
 * 着火の開始・距離消火・爆発を進める。
 * 戦闘アクションの後に呼び、同じ tick で倒して爆発を止められるようにする。
 */
export function tickCreeperFuses(
  state: FuseTickState,
  blocks: Set<string>
): { explodedIds: number[] } {
  const explodedIds: number[] = [];
  for (const enemy of state.enemies) {
    if (enemy.kind !== 'creeper' || enemy.hp <= 0) continue;
    const dist = combatDistance(state.bot, enemy);
    const ignited = isSimCreeperIgnited(enemy);
    const hasLos = hasVoxelLineOfSight(blocks, enemy, state.bot);

    if (!ignited) {
      // JE: 近距離かつ視線があるときだけ膨らみ始める
      if (dist <= CREEPER_IGNITE_RANGE && hasLos) {
        enemy.fuseStartedAt = state.now;
      }
      continue;
    }

    if (dist >= CREEPER_DEFUSE_RANGE) {
      enemy.fuseStartedAt = null;
      continue;
    }

    const started = Number(enemy.fuseStartedAt);
    if (state.now - started < CREEPER_FUSE_MS) continue;

    explodedIds.push(enemy.id);
    applyCreeperBlast(state, blocks, enemy);
    enemy.hp = 0;
    state.transitions.push(`${state.tick}: クリーパー爆発`);
  }
  if (explodedIds.length) {
    state.enemies = state.enemies.filter((enemy) => enemy.hp > 0);
  }
  return { explodedIds };
}

function applyCreeperBlast(
  state: FuseTickState,
  blocks: Set<string>,
  creeper: PhysicsEnemy
): void {
  const botDist = combatDistance(state.bot, creeper);
  if (botDist <= CREEPER_BLAST_RADIUS) {
    const falloff = 1 - botDist / CREEPER_BLAST_RADIUS;
    const damage = Math.max(1, Math.round(CREEPER_BLAST_MAX_DAMAGE * falloff * falloff));
    hurtBot(state, blocks, creeper, damage, BLAST_KNOCKBACK, MELEE_STUN_MS);
  }
  for (const other of state.enemies) {
    if (other.id === creeper.id || other.hp <= 0) continue;
    const dist = combatDistance(other, creeper);
    if (dist > CREEPER_BLAST_RADIUS) continue;
    const falloff = 1 - dist / CREEPER_BLAST_RADIUS;
    const damage = Math.max(1, Math.round(CREEPER_BLAST_MAX_DAMAGE * 0.7 * falloff * falloff));
    other.hp -= damage;
    const pushed = applyKnockback(blocks, other, creeper, BLAST_KNOCKBACK * falloff);
    other.x = pushed.x;
    other.y = pushed.y;
    other.z = pushed.z;
    other.stunUntil = Math.max(other.stunUntil || 0, state.now + MELEE_STUN_MS);
  }
}

/** 着火中で殴って止められないときだけ強制退避。 */
export function creeperMustFlee(opts: {
  creeper: PhysicsEnemy | null;
  canMeleeStrike: boolean;
  distance: number;
  fleeDistance: number;
}): boolean {
  if (!opts.creeper || !isSimCreeperIgnited(opts.creeper)) return false;
  if (opts.canMeleeStrike) return false;
  return opts.distance < opts.fleeDistance;
}
