/**
 * 1tick分の戦闘判断。箱庭（SimulationCore）と本番（Reflexes）が同じ関数を呼ぶ。
 *
 * ここは「何をするか」だけを決める純粋な判断で、地形・射線・経路の問い合わせは
 * CombatScene のコールバック経由で行う。実際の移動・打撃・物理は呼び出し側
 * （箱庭は voxel 物理、本番は Mineflayer）が担う。
 *
 * 判断の順序（ビヘイビアツリーの節と対応）:
 * 1. 主対象を選ぶ（sticky / 着火クリーパー・オーナー襲撃者は強制）
 * 2. 状況を見る（脅威弧・位置取り候補・遮蔽・遠距離圧）
 * 3. 着火したクリーパーから逃げるか
 * 4. 危険扇から抜ける位置取りをするか
 * 5. 遠距離を避けるか・詰めるか
 * 6. 殴るか・近づくか
 * 7. 移動先と打撃対象を決める
 */

import {
  chooseStackThreatPosition,
  computeThreatArc,
  generateStrategicThreatPositionCandidates,
  perpendicularDodgeBearing,
  spanDegrees,
  threatBearingRad,
  updateArcNarrowLatchByImprovement,
  type XZ
} from './threatArc.js';
import {
  chooseAttackFanSafePoint,
  chooseRangedSkirtPoint,
  umbraAnchor
} from './attackFanSafeZone.js';
import {
  decideMixedCombatPlan,
  isDangerFanPressure,
  type MixedCombatPlan
} from './MixedCombatPlan.js';
import { extendFocusLatch, selectCommittedFocus } from './CombatFocus.js';
import {
  decideCombatIntent,
  decideCombatMoveKind,
  decideRangedDodgeBurst,
  idleRangedDodgeLatch,
  type CombatIntent,
  type CombatMoveKind,
  type RangedDodgeLatch,
  type RangedDodgePhase
} from './CombatIntent.js';
import { classifyEnemy, type CombatPresetParams } from './CombatProfiles.js';
import {
  classifyEncounterSituation,
  type EncounterSituation
} from './EncounterSituation.js';
import { CREEPER_FLEE_DISTANCE, creeperMustFlee } from './creeperTactics.js';
import {
  ARC_NARROW_ENOUGH_SPAN_DEG,
  combatDistance,
  ENTITY_OVERLAP_RANGE,
  FOCUS_STICKY_MS,
  GUARD_RANGED_THREAT_THRESHOLD,
  MELEE_CONTACT_INTERRUPT_RANGE,
  MELEE_HEIGHT_SLACK,
  MELEE_HOLD_RANGE,
  MELEE_RANGE,
  POSITIONING_MAX_OWNER_DISTANCE,
  POSITIONING_STEP,
  RANGED_PRESSURE_RANGE
} from './CombatParams.js';

export type ScenePoint = { x: number; y: number; z: number };

export type SceneThreat = ScenePoint & {
  id: number;
  kind: string;
  hp: number;
  /** 着火中のクリーパー。 */
  ignited: boolean;
};

/** 判断に必要な観測と、地形への問い合わせ。 */
export type CombatScene = {
  now: number;
  /** 1tickの長さ（被弾が「このtick」かの判定に使う）。 */
  tickMs: number;
  /** tick番号（左右の初期値・被弾時の横揺れの向きに使う）。 */
  tick: number;
  bot: ScenePoint & { hp: number };
  threats: SceneThreat[];
  owner: XZ | null;
  hasShield: boolean;
  /** 被弾直後で殴れない。 */
  stunned: boolean;
  lastDamageAt: number;
  /** 端に追い詰められている（箱庭: 闘技場の端。本番: 判定なし）。 */
  cornered: boolean;
  /** 優先して狙う敵（本番: オーナーを襲った敵）。 */
  priorityThreatId?: number | null;
  params: Pick<CombatPresetParams, 'creeperSoftEvadeRange' | 'rangedDodgeBurstMs' | 'rangedDodgeReassessMs'>;
  /** 目線の視線が通る。 */
  hasLineOfSight(from: ScenePoint, to: ScenePoint): boolean;
  /** 遠距離敵の矢がいま相棒に当たる（地形・他の敵で遮られない）。 */
  rangedHitsBot(shooter: SceneThreat): boolean;
  /** 地形だけで射線が遮られる。 */
  terrainBlocked(from: Partial<ScenePoint> & XZ, to: Partial<ScenePoint> & XZ): boolean;
  /** 直線では歩いて行けない。 */
  pathBlocked(from: ScenePoint, to: XZ): boolean;
  /** 対象へ近づく点。 */
  approachPoint(target: SceneThreat, flank: 1 | -1): XZ;
  /** クリーパーから離れる点。 */
  creeperFleePoint(creeper: SceneThreat, amount: number): XZ;
  /** クリーパーとの間合いを保ったまま主対象へ近づく点。 */
  approachKeepingCreeperDistance(primary: SceneThreat, creeper: SceneThreat, soft: number, flank: 1 | -1): XZ;
  /** 遠距離敵から見て近接敵の陰になる点。 */
  meleeCoverPoint(meleeAlly: SceneThreat, ranged: SceneThreat): XZ | null;
};

/** tickをまたいで保つ判断の状態。 */
export type CombatMemory = {
  focusEnemyId?: number | null;
  focusUntil?: number;
  orbitEnemyId?: number | null;
  arcNarrowLatched?: boolean;
  positioningGoal?: XZ | null;
  approachFlankSign?: 1 | -1 | null;
  dodgeLatch?: RangedDodgeLatch;
  coverAnchor?: XZ | null;
  coverBreakTicks?: number;
  /** 呼び出し側が移動の進み具合から更新する。 */
  approachStuckTicks?: number;
};

export type CombatMovementKind = 'attack' | 'positioning' | 'dodge' | 'advance' | 'stay';

export type CombatStep = {
  /** 主対象がいなければ null（戦闘終了）。 */
  primary: SceneThreat | null;
  intent: CombatIntent | null;
  moveKind: CombatMoveKind | null;
  movement: CombatMovementKind;
  destination: XZ | null;
  /** 経路探索せず直進で逃げる。 */
  directFlee: boolean;
  /** 経路探索せず直進で詰める。 */
  preciseStep: boolean;
  forceCommit: boolean;
  /** このtickに殴る敵。 */
  strikeTarget: SceneThreat | null;
  dodgePhase: RangedDodgePhase;
  situation: EncounterSituation | null;
  mixedPlan: MixedCombatPlan | null;
  explosiveImmediateDanger: boolean;
  holdingCover: boolean;
  soleCreeper: boolean;
  rangedPressure: number;
  underMixedRanged: boolean;
  /** 表示・評価用の途中結果。 */
  detail: {
    arc: ReturnType<typeof computeThreatArc>;
    selection: ReturnType<typeof chooseStackThreatPosition>;
    meleeAlly: SceneThreat | null;
    rangedThreat: SceneThreat | null;
    meatWallHold: XZ | null;
    coverHold: XZ | null;
    rangedMoveGoal: XZ | null;
    creeperDist: number;
    creeperSoft: number;
    canMeleeAttack: boolean;
    inRangeStrikeTarget: SceneThreat | null;
  } | null;
};

function pointAt(origin: XZ, bearing: number, amount: number): XZ {
  return { x: origin.x + Math.sin(bearing) * amount, z: origin.z + Math.cos(bearing) * amount };
}

/** 遠距離敵から見て、相棒が近接敵の裏側にいる。 */
export function isBehindMeleeCover(bot: XZ, meleeAlly: XZ, rangedThreat: XZ): boolean {
  const allyDist = Math.hypot(bot.x - meleeAlly.x, bot.z - meleeAlly.z);
  if (allyDist < 1.05 || allyDist > MELEE_RANGE) return false;
  const fromRangedToBotX = bot.x - rangedThreat.x;
  const fromRangedToBotZ = bot.z - rangedThreat.z;
  const fromRangedToMeleeX = meleeAlly.x - rangedThreat.x;
  const fromRangedToMeleeZ = meleeAlly.z - rangedThreat.z;
  const meleeLen = Math.hypot(fromRangedToMeleeX, fromRangedToMeleeZ) || 1;
  const botLen = Math.hypot(fromRangedToBotX, fromRangedToBotZ) || 1;
  const alignment = (
    fromRangedToBotX * fromRangedToMeleeX + fromRangedToBotZ * fromRangedToMeleeZ
  ) / (meleeLen * botLen);
  // 近接の裏側（遠距離から見て同方向）にいる
  return alignment >= 0.35 && botLen + 0.2 >= meleeLen;
}

/**
 * 近接の影に留まるカバー点。遠ざかり続けてマップ端へ逃げない。
 * 一直線上にいるときは横オフセットを優先し、扇が潰れないようにする。
 */
export function pickMixedMeleeCoverPoint(
  bot: ScenePoint,
  meleeAlly: XZ,
  rangedThreat: XZ,
  pathBlocked: (from: ScenePoint, to: XZ) => boolean
): XZ | null {
  const dx = meleeAlly.x - rangedThreat.x;
  const dz = meleeAlly.z - rangedThreat.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const px = -uz;
  const pz = ux;
  const allyDist = Math.hypot(bot.x - meleeAlly.x, bot.z - meleeAlly.z);
  if (isBehindMeleeCover(bot, meleeAlly, rangedThreat)) {
    // すでに影にいるなら、さらに遠ざからず近接周辺の横位置を保つ
    const side = ((bot.x - meleeAlly.x) * px + (bot.z - meleeAlly.z) * pz) >= 0 ? 1 : -1;
    return {
      x: meleeAlly.x + ux * 1.35 + px * 0.9 * side,
      z: meleeAlly.z + uz * 1.35 + pz * 0.9 * side
    };
  }
  const onThreatLine = Math.abs(
    (bot.x - rangedThreat.x) * uz - (bot.z - rangedThreat.z) * ux
  ) < 1.25;
  const candidates = [
    { x: meleeAlly.x + ux * 1.45 + px * 1.15, z: meleeAlly.z + uz * 1.45 + pz * 1.15 },
    { x: meleeAlly.x + ux * 1.45 - px * 1.15, z: meleeAlly.z + uz * 1.45 - pz * 1.15 },
    { x: meleeAlly.x + ux * 1.55 + px * 0.7, z: meleeAlly.z + uz * 1.55 + pz * 0.7 },
    { x: meleeAlly.x + ux * 1.55 - px * 0.7, z: meleeAlly.z + uz * 1.55 - pz * 0.7 }
  ];
  let best: XZ | null = null;
  let bestScore = -Infinity;
  for (const cover of candidates) {
    if (pathBlocked(bot, cover) && allyDist > 2.8) continue;
    const nextMelee = Math.hypot(cover.x - meleeAlly.x, cover.z - meleeAlly.z);
    if (nextMelee < 1.2 || nextMelee > 2.5) continue;
    const lateral = Math.abs((cover.x - meleeAlly.x) * px + (cover.z - meleeAlly.z) * pz);
    const progress = allyDist - nextMelee;
    const score = progress * 2
      - Math.abs(nextMelee - 1.65)
      + (onThreatLine ? lateral * 2.4 : lateral * 0.4);
    if (score > bestScore) {
      bestScore = score;
      best = cover;
    }
  }
  return best;
}

function idleStep(): CombatStep {
  return {
    primary: null,
    intent: null,
    moveKind: null,
    movement: 'stay',
    destination: null,
    directFlee: false,
    preciseStep: false,
    forceCommit: false,
    strikeTarget: null,
    dodgePhase: 'idle',
    situation: null,
    mixedPlan: null,
    explosiveImmediateDanger: false,
    holdingCover: false,
    soleCreeper: false,
    rangedPressure: 0,
    underMixedRanged: false,
    detail: null
  };
}

/**
 * 1tick分の戦闘判断。`memory` は tick をまたいで保つ状態で、この関数が更新する。
 */
export function decideCombatStep(scene: CombatScene, memory: CombatMemory): CombatStep {
  const bot = scene.bot;
  const threats = scene.threats.filter((enemy) => enemy.hp > 0);
  const multiLive = threats.length > 1;
  const creeper = threats.find((enemy) => enemy.kind === 'creeper') ?? null;
  const ignitedCreeper = creeper && creeper.ignited ? creeper : null;
  const params = scene.params;

  // ── 1. 主対象を選ぶ（sticky + urgency マージン。遠距離専用 sticky は使わない）
  const focusPick = selectCommittedFocus({
    bot,
    threats: threats.map((enemy) => ({
      id: enemy.id,
      x: enemy.x,
      z: enemy.z,
      kind: enemy.kind,
      hp: enemy.hp
    })),
    stickyId: memory.focusEnemyId,
    now: scene.now,
    stickyMs: FOCUS_STICKY_MS,
    hardOverrideId: ignitedCreeper?.id ?? scene.priorityThreatId ?? null
  });
  memory.focusEnemyId = focusPick.focusEnemyId;
  memory.focusUntil = focusPick.focusUntil;
  const primaryFromFocus = focusPick.primary
    ? threats.find((enemy) => enemy.id === focusPick.primary!.id) ?? null
    : null;
  if (!primaryFromFocus) return idleStep();
  let primary: SceneThreat = primaryFromFocus;

  const noteFocus = (enemy: SceneThreat) => {
    const latch = extendFocusLatch(scene.now, FOCUS_STICKY_MS, enemy.id);
    memory.focusEnemyId = latch.focusEnemyId;
    memory.focusUntil = latch.focusUntil;
  };
  const canStrike = (enemy: SceneThreat): boolean => {
    if (scene.stunned) return false;
    const distance = combatDistance(bot, enemy);
    if (distance > MELEE_RANGE) return false;
    if (Math.abs(bot.y - enemy.y) > MELEE_HEIGHT_SLACK) return false;
    if (distance < ENTITY_OVERLAP_RANGE) return true;
    return scene.hasLineOfSight(bot, enemy);
  };

  // ── 2. 状況を見る
  const threatPositions = threats.map((enemy) => ({
    x: enemy.x,
    y: enemy.y,
    z: enemy.z,
    kind: enemy.kind,
    id: enemy.id
  }));
  const arc = computeThreatArc(bot, threatPositions);
  const creeperDist = creeper ? combatDistance(bot, creeper) : Infinity;
  // 爆発クラス探索対象（下限クリップ）。箱庭↔本番の間合い差を吸収する
  const creeperSoft = Math.max(3.2, params.creeperSoftEvadeRange);
  // 危険帯はソフト間合いよりわずかに内側（外側だと前進と退避が振動する）
  const creeperDangerRange = Math.max(2.8, creeperSoft - 0.25);
  // 扇重ねのオービット対象を sticky に固定（ウロウロ切替防止）
  const stickyOrbitIndex = (() => {
    if (memory.orbitEnemyId == null) return null;
    const index = threats.findIndex((enemy) => enemy.id === memory.orbitEnemyId);
    return index >= 0 ? index : null;
  })();
  const positioningMinDist = creeper ? creeperSoft : 1.8;
  const candidates = threats.length >= 2
    ? generateStrategicThreatPositionCandidates(
      bot,
      threatPositions,
      POSITIONING_STEP,
      positioningMinDist
    ).filter((candidate) => !scene.pathBlocked(bot, candidate))
    : [];
  // 決定論: 攻撃扇の非露出＋扇最小化。学習扇角・効用重みには依存しない。
  const skirtSide = memory.approachFlankSign
    ?? ((threats[0]?.id ?? 0) % 2 === 0 ? 1 : -1);
  memory.approachFlankSign = skirtSide;
  const selection = chooseStackThreatPosition(bot, threatPositions, {
    candidates,
    minEnemyDistance: positioningMinDist,
    dangerWeight: creeper ? 1.35 : undefined,
    ownerPos: scene.owner,
    maxOwnerDistance: POSITIONING_MAX_OWNER_DISTANCE,
    stickyNearestIndex: stickyOrbitIndex,
    stickySafePoint: memory.positioningGoal || null,
    skirtSide,
    skirtMode: 'advance',
    // ラッチ中は微小改善でも寄せ続ける（途中で moved=false になって戦闘へ戻さない）
    minimumImprovement: memory.arcNarrowLatched
      ? 0
      : (2 * Math.PI) / 180,
    // 地形のみ（他敵遮蔽は attackFan 側）。
    isTerrainBlocked: (from, to) => scene.terrainBlocked(from, to)
  });
  if (selection.nearestIndex >= 0 && selection.nearestIndex < threats.length) {
    const nextOrbitId = threats[selection.nearestIndex].id;
    const currentOrbit = memory.orbitEnemyId != null
      ? threats.find((enemy) => enemy.id === memory.orbitEnemyId)
      : null;
    // 扇ラッチ中は近接オービットを維持（遠距離側へ吸い寄せて原則を壊さない）
    const keepMeleeOrbit = Boolean(
      memory.arcNarrowLatched
      && currentOrbit
      && classifyEnemy(currentOrbit.kind) !== 'ranged'
    );
    memory.orbitEnemyId = keepMeleeOrbit ? currentOrbit!.id : nextOrbitId;
  } else {
    memory.orbitEnemyId = null;
  }
  const pursuingGoal = Boolean(
    memory.positioningGoal
    && Math.hypot(
      bot.x - memory.positioningGoal.x,
      bot.z - memory.positioningGoal.z
    ) > 0.9
  );
  const stackIncomplete = threats.length >= 2
    && arc != null
    && selection.chosen.spanRad + 0.12 < arc.spanRad;
  memory.arcNarrowLatched = updateArcNarrowLatchByImprovement({
    latched: Boolean(memory.arcNarrowLatched),
    threatCount: threats.length,
    selectionMoved: selection.moved || stackIncomplete,
    pursuingGoal: (Boolean(memory.arcNarrowLatched) && pursuingGoal) || stackIncomplete
  });
  // 扇重ね中はオービット対象を主対象に固定（途中で別敵へ切替えてウロウロしない）
  if (memory.orbitEnemyId != null && threats.length >= 2) {
    const orbitEnemy = threats.find((enemy) => enemy.id === memory.orbitEnemyId);
    if (orbitEnemy) {
      primary = orbitEnemy;
      noteFocus(orbitEnemy);
    }
  }
  // 遠距離圧 = 矢が実際に相棒へ届く脅威のみ。
  const rangedCount = threats.filter((enemy) => (
    classifyEnemy(enemy.kind) === 'ranged'
    && combatDistance(bot, enemy) <= RANGED_PRESSURE_RANGE
    && scene.rangedHitsBot(enemy)
  )).length;
  // 遠距離敵がいなくなったら回避ラッチを捨て、単独クリーパー処理へ戻す
  if (rangedCount === 0 && !threats.some((enemy) => classifyEnemy(enemy.kind) === 'ranged')) {
    memory.dodgeLatch = idleRangedDodgeLatch();
  }
  const primaryDistance = combatDistance(bot, primary);
  const overlapping = primaryDistance < ENTITY_OVERLAP_RANGE;
  const meleeAlly = threats.find((enemy) => classifyEnemy(enemy.kind) !== 'ranged'
    && classifyEnemy(enemy.kind) !== 'explosive') ?? null;
  const rangedThreat = threats.find((enemy) => classifyEnemy(enemy.kind) === 'ranged') ?? null;
  /** 射手→近接遮蔽の影（表示・保持用）。 */
  const meatWallHold = (meleeAlly && rangedThreat)
    ? umbraAnchor(rangedThreat, meleeAlly, 1.55)
    : null;
  /** 矢が他敵／壁に吸われるなら肉壁／壁影中。 */
  const inRangedCover = rangedThreat != null && (
    (selection.rangedExposedCount ?? 0) === 0
    || !scene.rangedHitsBot(rangedThreat)
  );
  // 遮蔽役がいない／遠距離がいないなら錨は即破棄
  if (!meleeAlly || !rangedThreat) {
    memory.coverAnchor = null;
    memory.coverBreakTicks = 0;
  } else if (inRangedCover) {
    memory.coverBreakTicks = 0;
    if (meatWallHold) {
      memory.coverAnchor = { x: meatWallHold.x, z: meatWallHold.z };
    }
  } else if (memory.coverAnchor) {
    memory.coverBreakTicks = (memory.coverBreakTicks || 0) + 1;
    if (memory.coverBreakTicks >= 3) {
      memory.coverAnchor = null;
      memory.coverBreakTicks = 0;
    }
  } else {
    memory.coverBreakTicks = 0;
  }
  const coverHold = memory.coverAnchor || (inRangedCover ? meatWallHold : null);
  const holdingCover = Boolean(meleeAlly && rangedThreat && (memory.coverAnchor || inRangedCover));
  const situation = classifyEncounterSituation(threats);
  const soleCreeper = Boolean(creeper) && !multiLive;
  const creeperStrikeLos = Boolean(
    creeper
    && (
      combatDistance(bot, creeper) < ENTITY_OVERLAP_RANGE
      || scene.hasLineOfSight(bot, creeper)
    )
  );
  const canStrikeCreeper = Boolean(
    creeper
    && combatDistance(bot, creeper) <= MELEE_RANGE
    && Math.abs(bot.y - creeper.y) <= MELEE_HEIGHT_SLACK
    && creeperStrikeLos
    && !scene.stunned
  );

  // ── 3. 着火中かつ殴れないときだけ強制退避。
  // 未着火は「近い敵」として殴りに行く（混成で逃げ回って矢死するのを防ぐ）。
  const explosiveImmediateDanger = creeperMustFlee({
    ignited: Boolean(ignitedCreeper),
    canMeleeStrike: canStrikeCreeper,
    distance: creeperDist,
    fleeDistance: Math.max(CREEPER_FLEE_DISTANCE, creeperDangerRange + 0.4)
  });
  const intent = decideCombatIntent({
    distanceToPrimary: primaryDistance,
    meleeAttackRange: MELEE_RANGE,
    rangedThreatCount: rangedCount,
    hasShield: scene.hasShield,
    guardRangedThreatThreshold: GUARD_RANGED_THREAT_THRESHOLD,
    explosiveImmediateDanger
  });

  // ── 5. 遠距離を避けるか・詰めるか（回避バースト → 明示的な前進）
  const rangedBearing = rangedCount > 0
    ? (arc?.midRad ?? threatBearingRad(bot, primary))
    : null;
  const dodge = decideRangedDodgeBurst({
    now: scene.now,
    underRangedPressure: rangedBearing != null,
    distanceToPrimary: primaryDistance,
    meleeAttackRange: MELEE_RANGE,
    latch: memory.dodgeLatch ?? idleRangedDodgeLatch(),
    lastDamageAt: scene.lastDamageAt,
    hasShield: scene.hasShield,
    // クリーパーが安全距離なら低HPカイトを解除しスケルトンへ詰める
    botHp: (creeper && creeperDist >= creeperSoft)
      ? Math.max(bot.hp, 11)
      : bot.hp,
    burstMs: params.rangedDodgeBurstMs,
    advanceMs: params.rangedDodgeReassessMs
  });
  memory.dodgeLatch = dodge.latch;

  const hasStrikeLos = overlapping || scene.hasLineOfSight(bot, primary);
  const canMeleeAttack = !scene.stunned
    && primaryDistance <= MELEE_RANGE
    && Math.abs(bot.y - primary.y) <= MELEE_HEIGHT_SLACK
    && hasStrikeLos
    && (
      intent.attack
      || Boolean(ignitedCreeper && primary.id === ignitedCreeper.id)
    );
  // CORE(threat-arc-narrowing): 本当の接触近接。
  // ただし扇ラッチ中は位置取りを打ち切らず、移動しながら殴る（下の positioning 分岐）。
  const rawMeleeContact = threats.some((enemy) => {
    if (classifyEnemy(enemy.kind) === 'ranged') return false;
    if (classifyEnemy(enemy.kind) === 'explosive') return false;
    const distance = combatDistance(bot, enemy);
    if (distance < ENTITY_OVERLAP_RANGE) return true;
    return distance <= MELEE_CONTACT_INTERRUPT_RANGE
      && scene.hasLineOfSight(bot, enemy);
  });
  const underMixedRanged = threats.length >= 2 && rangedCount > 0;
  // 端で詰まった／クリーパーが十分離れたら扇を外してスケルトンへ詰める
  const approachStuck = (memory.approachStuckTicks || 0) >= 2;
  const meleeAllyDistance = meleeAlly ? combatDistance(bot, meleeAlly) : Infinity;
  const spanDegNow = arc ? spanDegrees(arc.spanRad) : null;
  const pureRangedMulti = threats.length >= 2
    && !meleeAlly
    && !creeper
    && threats.every((enemy) => classifyEnemy(enemy.kind) === 'ranged');
  const arcNarrowEnough = spanDegNow != null
    && spanDegNow <= ARC_NARROW_ENOUGH_SPAN_DEG + 8;
  const cornered = scene.cornered;
  const releaseArc = () => {
    memory.arcNarrowLatched = false;
    memory.positioningGoal = null;
  };
  // 肉壁に入れたあと（扇が閉じたとき）だけ狭窄を外して近接処理へ。
  if (holdingCover && meleeAlly && arcNarrowEnough) releaseArc();
  // 純遠距離複数: 扇が十分狭い／端詰まり／HP低下なら扇を外して1体へコミット
  if (
    pureRangedMulti
    && (
      approachStuck
      || arcNarrowEnough
      || (cornered && approachStuck)
      || bot.hp <= 16
    )
  ) {
    releaseArc();
  } else if (
    (
      (creeper && creeperDist >= creeperSoft + 0.4 && classifyEnemy(primary.kind) === 'ranged')
      || (!creeper && !meleeAlly && threats.length === 1 && classifyEnemy(primary.kind) === 'ranged')
    )
    && (approachStuck || primaryDistance > MELEE_RANGE * 1.4)
  ) {
    releaseArc();
  } else if (
    // 近接盾なしでクリーパー危険帯にいる扇は捨て、回避／スケルトン処理へ
    creeper
    && !meleeAlly
    && rangedThreat
    && creeperDist < creeperSoft + 0.15
  ) {
    releaseArc();
  } else if (
    // 爆発混成で端へ逃げ切ったら扇を捨てて近接／処理へ戻す
    Boolean(creeper)
    && threats.length >= 2
    && cornered
    && (approachStuck || bot.hp <= 14)
  ) {
    releaseArc();
  }
  // CORE: 扇ラッチ中のみ接触でも位置取り継続。ラッチ外の混成は接触で攻撃へ戻してよい。
  const meleeContactInterrupt = rawMeleeContact
    && !memory.arcNarrowLatched
    && !explosiveImmediateDanger;
  const forceSkeletonCommit = Boolean(creeper)
    && !meleeAlly
    && classifyEnemy(primary.kind) === 'ranged'
    && !explosiveImmediateDanger
    && creeperDist >= creeperDangerRange;
  // 近接撃破後の単独スケルトンは前進を促す。一歩手前なら低HPでも詰め切る。
  const forceRangedFinish = !creeper
    && !meleeAlly
    && threats.length === 1
    && classifyEnemy(primary.kind) === 'ranged'
    && primaryDistance > MELEE_RANGE * 0.85
    && (
      dodge.phase === 'advance'
      || dodge.phase === 'attack'
      || primaryDistance <= MELEE_RANGE * 1.75
    );
  // 純遠距離複数: 扇解除後は1体へ詰める（位置取り膠着死の防止）
  const forceRangedMultiCommit = pureRangedMulti
    && !memory.arcNarrowLatched
    && !explosiveImmediateDanger
    && (
      approachStuck
      || arcNarrowEnough
      || (cornered && approachStuck)
      || bot.hp <= 16
      || primaryDistance <= MELEE_RANGE * 1.75
      || dodge.phase === 'advance'
    );
  // 混成カバーに入ったら扇ラッチ中でも近接を処理（遠ざかり続けない）
  const inMixedMeleeCover = Boolean(
    meleeAlly
    && rangedThreat
    && meleeAllyDistance <= MELEE_RANGE
    && isBehindMeleeCover(bot, meleeAlly, rangedThreat)
  );
  const canStrikeMeleeAlly = Boolean(meleeAlly && canStrike(meleeAlly));
  const skirtPreview = rangedThreat
    ? chooseRangedSkirtPoint(bot, rangedThreat, {
      side: memory.approachFlankSign ?? 1,
      mode: dodge.phase === 'dodge' ? 'dodge' : 'advance'
    })
    : null;
  const rangedLosExposed = rangedThreat != null && scene.rangedHitsBot(rangedThreat);
  const rangedExposedCount = (selection.rangedExposedCount ?? 0)
    + (rangedLosExposed && (selection.rangedExposedCount ?? 0) === 0 ? 1 : 0);

  // ── 4. 混成・囲まれは位相プランで一本化（種別ifの積み上げではない）。
  const mixedPlan = decideMixedCombatPlan({
    situation,
    spanDeg: spanDegNow,
    arcLatched: Boolean(memory.arcNarrowLatched),
    selectionMoved: selection.moved || stackIncomplete,
    explosiveImmediateDanger,
    canStrikeFocus: classifyEnemy(primary.kind) === 'explosive'
      ? canStrikeCreeper
      : canStrike(primary),
    focusIsExplosive: classifyEnemy(primary.kind) === 'explosive',
    holdingCover,
    rangedExposed: rangedExposedCount > 0,
    dangerFanExposed: isDangerFanPressure({
      rangedExposedCount,
      meleeExposedCount: selection.meleeExposedCount ?? 0
    }),
    hasMeleeBlocker: Boolean(meleeAlly),
    hasRanged: Boolean(rangedThreat),
    meleeContactInterrupt,
    dodgePhase: dodge.phase,
    umbraGoal: meatWallHold,
    skirtGoal: skirtPreview,
    approachGoal: {
      x: primary.x - Math.sin(threatBearingRad(bot, primary)) * 1.2,
      z: primary.z - Math.cos(threatBearingRad(bot, primary)) * 1.2
    }
  });
  if (mixedPlan?.releaseArcLatch) releaseArc();
  const forceMixedMeleeFinish = mixedPlan
    ? (mixedPlan.phase === 'finish-cover' && canStrikeMeleeAlly)
    : (
      underMixedRanged
      && Boolean(meleeAlly)
      && !explosiveImmediateDanger
      && !memory.arcNarrowLatched
      && (
        inMixedMeleeCover
        || (approachStuck && meleeAllyDistance <= MELEE_RANGE)
        || meleeAllyDistance <= MELEE_CONTACT_INTERRUPT_RANGE
        || (bot.hp <= 12 && meleeAllyDistance <= MELEE_RANGE * 1.6)
      )
    );
  /** 肉壁カバー中は遮蔽敵を殴り切る。 */
  const forceMeatWallFinish = mixedPlan
    ? mixedPlan.phase === 'finish-cover'
    : (
      underMixedRanged
      && Boolean(meleeAlly)
      && holdingCover
      && !explosiveImmediateDanger
    );
  // 爆発混成: 端逃げ／詰まり／HP低下では扇改善があっても位置取りを打ち切り、
  // 近接→遠距離の順で処理へ戻す（マップ外周を周回して矢死するのを防ぐ）。
  const forceExplosiveCrowdCommit = Boolean(creeper)
    && threats.length >= 2
    && !explosiveImmediateDanger
    && creeperDist >= creeperDangerRange
    && (
      cornered
      || approachStuck
      || bot.hp <= 14
    );
  if (forceExplosiveCrowdCommit) releaseArc();
  const forceCommit = forceSkeletonCommit
    || forceRangedFinish
    || forceMixedMeleeFinish
    || forceMeatWallFinish
    || forceRangedMultiCommit
    || forceExplosiveCrowdCommit;
  const creeperBlocksReposition = Boolean(
    creeper
    && !meleeAlly
    && rangedThreat
    && creeperDist < creeperSoft + 0.15
  );
  // CORE: 扇ラッチ or 改善候補があるときだけ位置取り。肉壁カバー中は除外。
  // 混成プランがあるときは位相 narrow のみが位置取り。
  const multiThreatReposition = mixedPlan
    ? mixedPlan.phase === 'narrow'
    : (
      threats.length >= 2
      && !meleeContactInterrupt
      && !explosiveImmediateDanger
      && !forceCommit
      && !holdingCover
      && !creeperBlocksReposition
      && (Boolean(memory.arcNarrowLatched) || selection.moved)
    );
  if (!multiThreatReposition) {
    memory.positioningGoal = null;
  }

  // ── 6. 殴るか・近づくか
  const moveKindRaw = decideCombatMoveKind({
    intent,
    dodgePhase: dodge.phase,
    canMeleeAttack: multiThreatReposition ? false : canMeleeAttack,
    multiThreatReposition,
    meleeContactInterrupt,
    explosiveImmediateDanger
  });
  // クリーパー安全時のみ回避を前進へ上書き。単独遠距離は dodge を残す。
  let moveKind: CombatMoveKind = (
    forceSkeletonCommit
    && (moveKindRaw === 'dodge' || moveKindRaw === 'positioning' || moveKindRaw === 'hold')
  ) ? 'advance'
    : (
      (forceRangedFinish || forceRangedMultiCommit || forceExplosiveCrowdCommit)
      && (moveKindRaw === 'positioning' || moveKindRaw === 'hold')
    ) ? 'advance'
      : moveKindRaw;
  // 混成プラン: 位相の moveKind を権威にする（CORE narrow は raw 側で既に positioning）
  if (mixedPlan && mixedPlan.phase !== 'narrow') {
    if (mixedPlan.moveKind === 'attack' || mixedPlan.moveKind === 'advance'
      || mixedPlan.moveKind === 'dodge' || mixedPlan.moveKind === 'hold') {
      moveKind = mixedPlan.moveKind;
    }
  }
  // 爆発混成コミット: 近接がいればそちらを優先して攻撃／接近
  if (
    forceExplosiveCrowdCommit
    && (moveKind === 'dodge' || moveKind === 'positioning' || moveKind === 'hold')
  ) {
    const finishTarget = meleeAlly || primary;
    const finishDist = combatDistance(bot, finishTarget);
    moveKind = (
      finishDist <= MELEE_RANGE
      && canStrike(finishTarget)
      && (classifyEnemy(finishTarget.kind) !== 'explosive' || finishTarget.ignited)
    ) ? 'attack' : 'advance';
  }
  // 盾ありの遠距離複数コミットはガード前進を維持（位置取りへ戻さない）
  if (
    forceRangedMultiCommit
    && scene.hasShield
    && (moveKind === 'dodge' || moveKind === 'positioning' || moveKind === 'hold')
  ) {
    moveKind = canMeleeAttack ? 'attack' : 'advance';
  }
  // CORE: 一歩手前まで詰めた遠距離は、盾なしでも回避に戻さず前進／攻撃
  if (
    classifyEnemy(primary.kind) === 'ranged'
    && !explosiveImmediateDanger
    && primaryDistance <= MELEE_RANGE * 1.75
    && (forceRangedMultiCommit || forceRangedFinish || threats.length === 1)
    && (moveKind === 'dodge' || moveKind === 'positioning' || moveKind === 'hold')
  ) {
    moveKind = canMeleeAttack ? 'attack' : 'advance';
  }
  // 着火中で届くなら殴ってノックバック優先（自爆キャンセル）
  if (ignitedCreeper && canStrikeCreeper) {
    moveKind = 'attack';
  }
  // 単独クリーパーは退避し続けず接近して処理する
  if (soleCreeper && !explosiveImmediateDanger && !creeper!.ignited) {
    if (canMeleeAttack) moveKind = 'attack';
    else if (moveKind === 'dodge' || moveKind === 'hold' || moveKind === 'positioning') moveKind = 'advance';
  }

  // ── 7. 移動先と打撃対象
  /** 遠距離の移動目標＝緑箱。混成プランの goal を最優先。 */
  const rangedMoveGoal = (() => {
    if (mixedPlan?.goal) return mixedPlan.goal;
    if (holdingCover && (meatWallHold || coverHold)) {
      return meatWallHold || coverHold;
    }
    if (!rangedThreat) return selection.safePoint || null;
    const side = memory.approachFlankSign ?? 1;
    if (meleeAlly) {
      const live = chooseAttackFanSafePoint(bot, threatPositions, {
        skirtSide: side,
        skirtMode: moveKind === 'dodge' ? 'dodge' : 'advance',
        stickySafePoint: memory.positioningGoal || selection.safePoint || null,
        ownerPos: scene.owner,
        maxOwnerDistance: POSITIONING_MAX_OWNER_DISTANCE,
        isTerrainBlocked: (from, to) => scene.terrainBlocked(from, to)
      });
      return live?.safePoint ?? selection.safePoint ?? null;
    }
    return chooseRangedSkirtPoint(bot, rangedThreat, {
      side,
      mode: moveKind === 'dodge' ? 'dodge' : 'advance'
    });
  })();
  let destination: XZ | null = null;
  let movement: CombatMovementKind = 'stay';
  let directFlee = false;
  let preciseStep = false;
  let strikeTarget: SceneThreat | null = null;
  const mixedCoverPoint = (meleeAlly && rangedThreat)
    ? scene.meleeCoverPoint(meleeAlly, rangedThreat)
    : null;
  /** 安全点／接近点へは常に直線（壁は呼び出し側の移動で迂回）。 */
  const setDestination = (goal: XZ | null | undefined) => {
    if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.z)) return;
    destination = { x: goal.x, z: goal.z };
  };
  const strike = (enemy: SceneThreat, note = true) => {
    strikeTarget = enemy;
    if (note) noteFocus(enemy);
  };
  const flankFor = (enemy: SceneThreat): 1 | -1 => {
    const flank = memory.approachFlankSign
      ?? ((enemy.id + scene.tick) % 2 === 0 ? 1 : -1);
    memory.approachFlankSign = flank;
    return flank;
  };
  const hitThisTick = scene.lastDamageAt >= scene.now - scene.tickMs;
  // 射程内の打撃対象（sticky最寄り→近接カバー→主対象の順）
  const inRangeStrikeTarget = (() => {
    const ordered: SceneThreat[] = [];
    if (memory.orbitEnemyId != null) {
      const orbitEnemy = threats.find((enemy) => enemy.id === memory.orbitEnemyId);
      if (orbitEnemy) ordered.push(orbitEnemy);
    }
    if (meleeAlly) ordered.push(meleeAlly);
    ordered.push(primary);
    for (const enemy of threats) {
      if (!ordered.some((item) => item.id === enemy.id)) ordered.push(enemy);
    }
    for (const enemy of ordered) {
      if (classifyEnemy(enemy.kind) === 'explosive' && !enemy.ignited) continue;
      if (canStrike(enemy)) return enemy;
    }
    return null;
  })();
  const finishMeleeFirst = (forceMixedMeleeFinish || forceExplosiveCrowdCommit) && meleeAlly;

  if (moveKind === 'attack' || (overlapping && canMeleeAttack)) {
    if (!(canMeleeAttack || overlapping)) {
      // 攻撃種別でも射程外なら接近に落とす
      movement = 'advance';
      const approachTarget = finishMeleeFirst ? meleeAlly! : primary;
      setDestination(scene.approachPoint(approachTarget, flankFor(approachTarget)));
    } else {
      movement = 'attack';
      const attackTarget = (finishMeleeFirst && canStrike(meleeAlly!)) ? meleeAlly! : primary;
      strike(attackTarget);
      // めり込み中は攻撃しつつ軽く離す（同座標スタック解消）
      if (overlapping) {
        const away = threatBearingRad(primary, bot);
        setDestination(pointAt(bot, Number.isFinite(away) ? away : scene.tick * 0.7, 0.7));
      }
      // 遠距離がいるだけの「攻撃中横歩き」はしない。矢避けは dodge 位相／被弾時 weave に任せる。
    }
  } else if (moveKind === 'positioning') {
    let chosen: XZ | null | undefined = memory.positioningGoal;
    const spanStillWide = spanDegNow != null && spanDegNow > ARC_NARROW_ENOUGH_SPAN_DEG;
    const orbitPoint = selection.moved ? selection.chosen.position : null;
    // 扇が広い間は umbra 一直線ではなく回り込み点を使う（CORE）。
    const attackFanSafe = !spanStillWide
      && selection.safePoint
      && rangedThreat
      && (selection.moved || (selection.rangedExposedCount ?? 0) > 0)
      ? selection.safePoint
      : null;
    if (spanStillWide && orbitPoint) {
      // 狭窄中は回り込み点へ（浅い接近点への特例は持たない）
      chosen = orbitPoint;
      memory.positioningGoal = { x: orbitPoint.x, z: orbitPoint.z };
    } else if (pursuingGoal && memory.positioningGoal && attackFanSafe) {
      chosen = attackFanSafe;
      // sticky: 目標は大きく変わったときだけ更新
      const jump = Math.hypot(
        memory.positioningGoal.x - attackFanSafe.x,
        memory.positioningGoal.z - attackFanSafe.z
      );
      if (jump > 1.25 || (selection.rangedExposedCount ?? 0) > 0) {
        memory.positioningGoal = { x: attackFanSafe.x, z: attackFanSafe.z };
        chosen = attackFanSafe;
      } else {
        chosen = memory.positioningGoal;
      }
    } else if (attackFanSafe) {
      chosen = attackFanSafe;
      memory.positioningGoal = { x: attackFanSafe.x, z: attackFanSafe.z };
    } else if (orbitPoint) {
      chosen = orbitPoint;
      memory.positioningGoal = { x: orbitPoint.x, z: orbitPoint.z };
    } else if (
      mixedCoverPoint
      && rangedThreat
      && (selection.rangedExposedCount ?? 0) > 0
      && (!memory.arcNarrowLatched || inMixedMeleeCover)
    ) {
      chosen = mixedCoverPoint;
      memory.positioningGoal = mixedCoverPoint;
    } else if (underMixedRanged && creeper && rangedThreat) {
      const away = threatBearingRad(creeper, bot);
      const toRanged = threatBearingRad(bot, rangedThreat);
      const side = perpendicularDodgeBearing(toRanged, 1);
      const blend = Number.isFinite(away) ? (away * 0.7 + side * 0.3) : side;
      const safe = pointAt(bot, blend, 2.4);
      if (!scene.pathBlocked(bot, safe)) {
        chosen = safe;
        memory.positioningGoal = safe;
      }
    }
    if (!chosen && (selection.rangedExposedCount ?? 0) > 0 && arc) {
      chosen = pointAt(bot, arc.openRad, 2.5);
    }
    if (creeper && chosen && explosiveImmediateDanger) {
      const nextDist = Math.hypot(chosen.x - creeper.x, chosen.z - creeper.z);
      if (nextDist + 0.15 < creeperDist || nextDist < creeperSoft) {
        chosen = scene.creeperFleePoint(creeper, 2.6);
        directFlee = true;
      }
    }
    if (attackFanSafe && !directFlee && !spanStillWide) {
      memory.positioningGoal = { x: attackFanSafe.x, z: attackFanSafe.z };
    }
    // すでに非露出／肉壁中なら位置取り目標を捨てて影軸上で殴る
    if (holdingCover && rangedThreat && !directFlee && !spanStillWide) {
      memory.positioningGoal = null;
      chosen = (!canStrike(meleeAlly || primary) && (meatWallHold || coverHold))
        ? (meatWallHold || coverHold)
        : null;
    }
    if (chosen) setDestination(chosen);
    // 被弾時のみ軽く横へ（直線目標は維持）
    if (
      rangedBearing != null
      && hitThisTick
      && destination
      && !directFlee
      && !holdingCover
      && !mixedCoverPoint
    ) {
      const goal: XZ = destination;
      const weave = pointAt(
        bot,
        perpendicularDodgeBearing(rangedBearing, scene.tick % 2 === 0 ? 1 : -1),
        1.4
      );
      setDestination({ x: (goal.x + weave.x) * 0.5, z: (goal.z + weave.z) * 0.5 });
    }
    movement = 'positioning';
    // CORE: 扇ラッチ中も移動を止めず殴る。
    if (inRangeStrikeTarget) strike(inRangeStrikeTarget);
  } else if (moveKind === 'dodge') {
    if (creeper && explosiveImmediateDanger) {
      setDestination(scene.creeperFleePoint(creeper, 2.8));
      directFlee = true;
    } else if (rangedMoveGoal) {
      setDestination(rangedMoveGoal);
    } else if (mixedCoverPoint && meleeAlly) {
      setDestination(mixedCoverPoint);
    } else if (rangedBearing != null) {
      setDestination(pointAt(bot, perpendicularDodgeBearing(rangedBearing, 1), 2));
    }
    movement = 'dodge';
  } else if (overlapping) {
    // 攻撃できないめり込み（例: クリーパー）は押し出しのみ
    const away = threatBearingRad(primary, bot);
    setDestination(pointAt(bot, Number.isFinite(away) ? away : 0, 0.8));
    movement = 'advance';
    if (classifyEnemy(primary.kind) === 'explosive') directFlee = true;
  } else if (primaryDistance <= MELEE_HOLD_RANGE && canMeleeAttack
    && (classifyEnemy(primary.kind) !== 'explosive' || primary.ignited)) {
    movement = 'attack';
    strike(primary);
  } else if (forceMixedMeleeFinish && meleeAlly && canStrike(meleeAlly)) {
    movement = 'attack';
    strike(meleeAlly, false);
  } else if (primaryDistance <= MELEE_HOLD_RANGE) {
    if (holdingCover && meleeAlly) {
      if (canStrike(meleeAlly)) {
        movement = 'attack';
        strike(meleeAlly, false);
      } else if (meatWallHold || coverHold) {
        setDestination(meatWallHold || coverHold);
        movement = 'advance';
      }
    } else {
      const side = perpendicularDodgeBearing(threatBearingRad(bot, primary), 1);
      setDestination(pointAt(bot, side, 0.9));
      movement = 'advance';
    }
    if (creeper && explosiveImmediateDanger && moveKind === 'advance' && !forceCommit) {
      setDestination(scene.creeperFleePoint(creeper, 2.6));
      movement = 'dodge';
      directFlee = true;
    }
  } else {
    // 敵へ直線接近。肉壁カバー中は固定錨へだけ寄せる。
    const approachPrimary = finishMeleeFirst ? meleeAlly! : primary;
    if (holdingCover && meleeAlly && coverHold) {
      if (canStrike(meleeAlly)) {
        movement = 'attack';
        strike(meleeAlly, false);
      } else {
        // 影軸の現在 umbra へ直線。横ずれ候補は使わない。
        setDestination(meatWallHold || coverHold);
        movement = 'advance';
      }
    } else if (rangedThreat && rangedMoveGoal && !forceExplosiveCrowdCommit) {
      // 遠距離: 斜め接近点へ（真正面を禁止）
      setDestination(rangedMoveGoal);
      movement = 'advance';
    } else {
      const flank = flankFor(approachPrimary);
      let approach: XZ = (
        creeper
        && !soleCreeper
        && !forceSkeletonCommit
        && creeperDist < creeperSoft + 1.0
      )
        ? scene.approachKeepingCreeperDistance(approachPrimary, creeper, creeperSoft, flank)
        : scene.approachPoint(approachPrimary, flank);
      if (creeper && explosiveImmediateDanger && !forceCommit && !soleCreeper) {
        const nextDist = Math.hypot(approach.x - creeper.x, approach.z - creeper.z);
        if (nextDist + 0.2 < creeperDist || nextDist < creeperDangerRange) {
          approach = scene.creeperFleePoint(creeper, 2.6);
          directFlee = true;
          movement = 'dodge';
        }
      }
      setDestination(approach);
      if (!directFlee) movement = 'advance';
    }
    if (forceCommit && !directFlee) preciseStep = true;
    if (
      forceCommit
      && !directFlee
      && !holdingCover
      && destination
      && rangedBearing != null
      && hitThisTick
      && bot.hp > 4
    ) {
      const goal: XZ = destination;
      const weave = pointAt(
        bot,
        perpendicularDodgeBearing(rangedBearing, scene.tick % 2 === 0 ? 1 : -1),
        1.1
      );
      setDestination({ x: goal.x * 0.7 + weave.x * 0.3, z: goal.z * 0.7 + weave.z * 0.3 });
    }
    if (soleCreeper && movement === 'advance') preciseStep = true;
  }

  return {
    primary,
    intent,
    moveKind,
    movement,
    destination,
    directFlee,
    preciseStep,
    forceCommit,
    strikeTarget,
    dodgePhase: dodge.phase,
    situation,
    mixedPlan,
    explosiveImmediateDanger,
    holdingCover,
    soleCreeper,
    rangedPressure: rangedCount,
    underMixedRanged,
    detail: {
      arc,
      selection,
      meleeAlly,
      rangedThreat,
      meatWallHold,
      coverHold,
      rangedMoveGoal,
      creeperDist,
      creeperSoft,
      canMeleeAttack,
      inRangeStrikeTarget
    }
  };
}
