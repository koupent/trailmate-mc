import {
  spanDegrees,
  threatBearingRad,
  type XZ
} from '../combat/threatArc.js';
import {
  describeAttackFan,
  umbraAnchor,
  type AttackFanDebug
} from '../combat/attackFanSafeZone.js';
import { idleRangedDodgeLatch, type CombatIntent, type RangedDodgeLatch } from '../combat/CombatIntent.js';
import {
  decideCombatStep,
  pickMixedMeleeCoverPoint,
  type CombatScene,
  type SceneThreat
} from '../combat/CombatStep.js';
import {
  combatDistance,
  ENTITY_OVERLAP_RANGE,
  GUARD_RANGED_THREAT_THRESHOLD,
  MELEE_HEIGHT_SLACK,
  MELEE_HOLD_RANGE,
  MELEE_STOP_RANGE,
  RANGED_PRESSURE_RANGE
} from '../combat/CombatParams.js';
import {
  baselinePresetId,
  classifyEncounterEnemyClass,
  classifyEnemy,
  getPresetParams,
  isRangedEntity,
  type CombatPresetParams
} from '../combat/CombatProfiles.js';
import {
  type EncounterSituation
} from '../combat/EncounterSituation.js';
import {
  decideCombatPhase,
  mergeUtilityWeights,
  scoreUtilityCandidate,
  UTILITY_EQUATION,
  PHASE_META,
  type CombatPhase,
  type UtilityScore,
  type UtilityWeights
} from '../combat/CombatUtility.js';
import { selectControlOwner } from '../companion/ControlPriority.js';
import {
  createDeathRecoveryState,
  observeRecoveryItemCollection,
  requestRecoveryItemCollection,
  trackRecoveryItem
} from '../companion/deathRecovery.js';
import {
  createBlockSet,
  createFlatFloor,
  distance3,
  EYE_HEIGHT,
  hasBlock,
  hasVoxelLineOfSight,
  horizontalDistance,
  isOverVoid,
  isPathBlocked3D,
  standingY,
  stepEntity,
  VOID_DEATH_Y,
  type Vec3,
  type Voxel
} from './voxel.js';
import {
  applyKnockback,
  hurtBot,
  isSimCreeperIgnited,
  isStunned,
  MELEE_KNOCKBACK,
  RANGED_KNOCKBACK,
  RANGED_STUN_MS,
  strikeEnemy,
  tickCreeperFuses
} from './combatPhysics.js';

export type SimPoint = Vec3;
export type SimEnemy = SimPoint & {
  id: number;
  kind: string;
  hp: number;
  lastShotTick?: number;
  /** ノックバック硬直の終了時刻。 */
  stunUntil?: number;
  /** クリーパー着火開始時刻。未着火は null。 */
  fuseStartedAt?: number | null;
};
export type SimDrop = SimPoint & { id: number; item: string; graveOwned?: boolean };
/** @deprecated 平面AABB。3Dでは blocks を使う。互換のため残す。 */
export type SimObstacle = { id: number; x: number; z: number; size: number; y?: number };
export type EnemyBehavior = 'chase' | 'retreat' | 'strafe' | 'hold';
export type EnemyMotion = {
  id: number;
  behavior: EnemyBehavior;
  speed: number;
  from: SimPoint;
  to: SimPoint;
  fired: boolean;
  /** 射撃が当たった対象。味方撃ち込み時は他敵の id。 */
  hitEntityId?: number | null;
  hitKind?: 'bot' | 'enemy' | 'block' | null;
};

/** 飛行中の矢（JE: フルチャージおよそ 3 block / MC tick）。 */
export type SimProjectile = {
  id: number;
  shooterId: number;
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  /** 発射からの飛行距離（despawn 用）。 */
  traveled: number;
};
export type EnemyAiConfig = { enabled: boolean; speedScale: number };

export type SimExpectation = {
  owner?: string;
  intent?: string;
  maxSpanDeg?: number;
  recoveryActive?: boolean;
  equipped?: string;
};

export type SimulationState = {
  name: string;
  now: number;
  tickMs: number;
  tick: number;
  bot: SimPoint & { yaw: number; hp: number };
  owner: SimPoint | null;
  enemies: SimEnemy[];
  /** 固体ボクセル。未指定時は平坦な床を自動生成する。 */
  blocks: Voxel[];
  /** 旧2D障害物。読み込み時に壁へ変換する。 */
  obstacles: SimObstacle[];
  grave: (SimPoint & { contents: string[] }) | null;
  drops: SimDrop[];
  inventory: string[];
  equipped: string | null;
  recovery: any;
  dodgeLatch: RangedDodgeLatch;
  nextId: number;
  attacks: number;
  shots: number;
  /** 飛行中の遠距離弾。 */
  projectiles?: SimProjectile[];
  damageTaken: number;
  /** 箱庭内で最後に被弾した時刻（遠距離回避ラッチ用）。 */
  lastDamageAt: number;
  /** 被弾ノックバック硬直の終了時刻。 */
  botStunUntil?: number;
  /** 相棒が戦闘不能になったら true。以降の戦闘tickは進まない。 */
  botDead: boolean;
  /** エピソード決着。 */
  ended: boolean;
  outcome: 'ongoing' | 'win' | 'lose' | 'draw';
  enemyAi: EnemyAiConfig;
  transitions: string[];
  lastOwner: string;
  expectations?: SimExpectation;
  seed?: number;
  arenaKind?: string;
  activePresetId?: string;
  presetParams?: CombatPresetParams;
  /** 壁迂回の左右固定（+1 / -1）。 */
  approachFlankSign?: 1 | -1;
  /** 前進がほぼ止まった連続tick。 */
  approachStuckTicks?: number;
  /** CORE: 扇狭窄位置取りのヒステリシス（Reflexes.arcNarrowLatched 相当）。 */
  arcNarrowLatched?: boolean;
  /** 位置取りコミット中の目標（途中で moved が消えても寄せ切る）。 */
  positioningGoal?: { x: number; z: number } | null;
  /**
   * 肉壁／壁影の錨。カバー中は live umbra へ追従し、
   * 一瞬のLOS切れではヒステリシスで保持する。
   */
  coverAnchor?: { x: number; z: number } | null;
  /** カバー喪失の連続tick（ヒステリシス）。 */
  coverBreakTicks?: number;
  /** 扇重ねのオービット対象（最寄り sticky）。 */
  orbitEnemyId?: number | null;
  /** 遠距離フォーカス固定（撃ち分け防止）。 */
  focusEnemyId?: number | null;
  focusUntil?: number;
  /** 型別効用重み（Gym が注入）。未設定時は型デフォルト。 */
  utilityWeights?: UtilityWeights | null;
  /** エピソード開始時の遭遇型（学習キー）。 */
  situationId?: string;
};

export type SimulationDecision = {
  controlOwner: string;
  primaryId: number | null;
  spanDeg: number | null;
  selectedSpanDeg: number | null;
  destination: SimPoint | null;
  movement: 'stay' | 'positioning' | 'dodge' | 'advance' | 'attack' | 'recovery' | 'survival' | 'dead';
  intent: CombatIntent | null;
  enemyMotions: EnemyMotion[];
  rangedPressureCount: number;
  ended: boolean;
  outcome: 'ongoing' | 'win' | 'lose' | 'draw';
  recovery: {
    phase: string;
    ownedIds: number[];
    remainingIds: number[];
    captureRemainingMs: number;
    deadlineRemainingMs: number;
  } | null;
  validation: Array<{ field: string; expected: unknown; actual: unknown; pass: boolean }>;
  /** 状況型・フェーズ・効用スコア（UI可視化用）。 */
  situation?: EncounterSituation | null;
  phase?: CombatPhase | null;
  utility?: {
    equation: string;
    weights: UtilityWeights;
    evaluation: UtilityScore | null;
  } | null;
  /** 目標への直線プレビュー（3D可視化）。 */
  routePreview?: {
    mode: 'straight';
    center: SimPoint;
    goal: SimPoint | null;
    points: SimPoint[];
  } | null;
  /** 攻撃扇ベースの安全地帯（3Dデバッグ）。 */
  safeZoneDebug?: {
    safeZone: SimPoint | null;
    coverPoint?: SimPoint | null;
    fans: AttackFanDebug[];
  } | null;
};

/** 扇が十分狭まった判定（カバー解除・コミット用）。チューニング対象外の固定値。 */
/** 闘技場の端とみなす座標（|x| か |z| がこれ以上）。 */
const ARENA_EDGE = 9.2;
const MOVE_PER_TICK = 0.55;
/** 接近移動（直線・旋回）のダッシュ相当倍率。 */
const APPROACH_DASH_MULT = 2.4;
/** 肉壁カバー中の近接KB。通常KBだと遮蔽が射手側へ飛び肉壁が壊れる。 */
const COVER_MELEE_KNOCKBACK = 0.28;
/** これ未満は「めり込み」。押し出して近接はLOS無しでも通す。 */
/** 接近移動の目標間合い（敵中心に飲み込まない）。 */
/** 盾ガード中の遠距離被弾倍率（CORE: ranged-with-shield）。 */
const SHIELD_RANGED_DAMAGE_FACTOR = 0.25;
const RANGED_MIN_RANGE = 5.5;
const RANGED_MAX_RANGE = 8.5;
const RANGED_SHOT_INTERVAL_TICKS = 4;
const RANGED_SHOT_DAMAGE = 2;
/** JE フルチャージ弓のおおよそ速度（block / MC tick）。 */
const ARROW_SPEED_PER_MC_TICK = 3.0;
const MC_TICK_MS = 50;
const ARROW_HIT_RADIUS = 0.65;
const ARROW_MAX_FLIGHT = RANGED_PRESSURE_RANGE + 4;

function atGround(x: number, z: number, extras: Partial<SimPoint> = {}): SimPoint {
  return { x, y: 1, z, ...extras };
}

export function createScenario(id: string): SimulationState {
  const floor = createFlatFloor();
  const base: SimulationState = {
    name: id,
    now: 0,
    tickMs: 250,
    tick: 0,
    bot: { ...atGround(0, 0), yaw: 0, hp: 20 },
    owner: atGround(-5, 0),
    enemies: [],
    blocks: floor,
    obstacles: [],
    grave: null,
    drops: [],
    inventory: ['stone_sword'],
    equipped: 'stone_sword',
    recovery: createDeathRecoveryState(),
    dodgeLatch: idleRangedDodgeLatch(),
    nextId: 100,
    attacks: 0,
    shots: 0,
    projectiles: [],
    damageTaken: 0,
    lastDamageAt: 0,
    botStunUntil: 0,
    botDead: false,
    ended: false,
    outcome: 'ongoing',
    enemyAi: { enabled: false, speedScale: 1 },
    transitions: [],
    lastOwner: 'follow'
  };

  if (id === 'single-ranged') {
    base.enemies = [{ id: 1, kind: 'skeleton', ...atGround(7, 0), hp: 20 }];
    base.expectations = { owner: 'combat' };
  } else if (id === 'multi-positioning') {
    base.enemies = [
      { id: 1, kind: 'zombie', ...atGround(0, 4), hp: 20 },
      { id: 2, kind: 'skeleton', ...atGround(0, -4), hp: 20 }
    ];
    base.expectations = { owner: 'combat', maxSpanDeg: 35 };
  } else if (id === 'recovery') {
    base.bot = { ...atGround(-7, 0), yaw: 0, hp: 16 };
    base.owner = atGround(-8, -3);
    base.enemies = [{ id: 1, kind: 'zombie', ...atGround(4, 0), hp: 20 }];
    base.grave = { ...atGround(0, 0), contents: ['iron_sword', 'iron_boots'] };
    base.inventory = [];
    base.equipped = null;
    base.recovery = {
      ...createDeathRecoveryState(),
      active: true,
      phase: 'travel',
      startedAt: 0,
      deathPos: { x: 0, y: 1, z: 0 }
    };
    base.expectations = { equipped: 'iron_sword' };
  } else if (id === 'dynamic-melee-pincer') {
    base.enemies = [
      { id: 1, kind: 'zombie', ...atGround(-7, -1), hp: 20 },
      { id: 2, kind: 'spider', ...atGround(7, 1), hp: 20 }
    ];
    base.enemyAi.enabled = true;
    base.expectations = { owner: 'combat', maxSpanDeg: 150 };
  } else if (id === 'dynamic-ranged-pressure') {
    base.enemies = [
      { id: 1, kind: 'skeleton', ...atGround(-6, -5), hp: 20 },
      { id: 2, kind: 'skeleton', ...atGround(6, 5), hp: 20 }
    ];
    base.enemyAi.enabled = true;
    base.expectations = { owner: 'combat', intent: 'dodge', maxSpanDeg: 150 };
  } else if (id === 'dynamic-mixed') {
    base.enemies = [
      { id: 1, kind: 'zombie', ...atGround(-6.5, 0), hp: 24 },
      { id: 2, kind: 'skeleton', ...atGround(6.5, 4.5), hp: 20 }
    ];
    base.enemyAi.enabled = true;
    base.expectations = { owner: 'combat', maxSpanDeg: 150 };
  } else if (id === 'elevated-ranged') {
    // 1段上のスケルトン（2Dでは無意味だった高低差）
    base.blocks = [
      ...floor,
      { x: 6, y: 1, z: 0 },
      { x: 7, y: 1, z: 0 },
      { x: 8, y: 1, z: 0 },
      { x: 6, y: 1, z: 1 },
      { x: 7, y: 1, z: 1 },
      { x: 8, y: 1, z: 1 }
    ];
    base.enemies = [{ id: 1, kind: 'skeleton', x: 7, y: 2, z: 0, hp: 20 }];
    base.enemyAi.enabled = true;
    base.expectations = { owner: 'combat' };
  } else if (id === 'wall-los-block') {
    // 壁越しゾンビ — LOS が無いと射撃・接近圧が変わる
    const wall: Voxel[] = [];
    for (let y = 1; y <= 3; y += 1) {
      for (let z = -2; z <= 2; z += 1) {
        wall.push({ x: 3, y, z });
      }
    }
    base.blocks = [...floor, ...wall];
    base.enemies = [{ id: 1, kind: 'zombie', ...atGround(7, 0), hp: 20 }];
    base.enemyAi.enabled = true;
    base.expectations = { owner: 'combat' };
  } else if (id === 'attack-fan-cover') {
    // 肉壁＋壁影: 手前ゾンビがスケルトン射線を遮る。攻撃扇安全地帯の確認用。
    const wall: Voxel[] = [];
    for (let y = 1; y <= 3; y += 1) {
      for (let z = 3; z <= 5; z += 1) {
        wall.push({ x: -4, y, z });
      }
    }
    base.blocks = [...floor, ...wall];
    base.bot = { ...atGround(3, 0), yaw: 0, hp: 24 };
    base.owner = atGround(0, -6);
    base.enemies = [
      { id: 1, kind: 'zombie', ...atGround(0, 4), hp: 28 },
      { id: 2, kind: 'skeleton', ...atGround(0, 10), hp: 20 }
    ];
    base.enemyAi.enabled = false;
    base.expectations = { owner: 'combat' };
  }
  return normalizeState(base);
}

export function listScenarioIds(): string[] {
  return [
    'single-ranged',
    'multi-positioning',
    'recovery',
    'dynamic-melee-pincer',
    'dynamic-ranged-pressure',
    'dynamic-mixed',
    'elevated-ranged',
    'wall-los-block',
    'attack-fan-cover'
  ];
}

export function normalizeState(input: SimulationState): SimulationState {
  const state = structuredClone(input) as SimulationState;
  state.enemyAi ||= { enabled: false, speedScale: 1 };
  state.shots ||= 0;
  state.projectiles = Array.isArray(state.projectiles) ? state.projectiles : [];
  state.damageTaken ||= 0;
  state.lastDamageAt ||= 0;
  state.botStunUntil ||= 0;
  state.botDead = Boolean(state.botDead) || (state.bot?.hp ?? 0) <= 0;
  state.enemies = (state.enemies || []).map((enemy) => ({
    ...enemy,
    stunUntil: enemy.stunUntil || 0,
    fuseStartedAt: enemy.fuseStartedAt ?? null
  }));
  state.ended = Boolean(state.ended);
  state.outcome = state.outcome || 'ongoing';
  state.approachStuckTicks ||= 0;
  state.arcNarrowLatched = Boolean(state.arcNarrowLatched);
  if (!state.positioningGoal || !Number.isFinite(state.positioningGoal.x)) {
    state.positioningGoal = null;
  }
  if (!state.coverAnchor || !Number.isFinite(state.coverAnchor.x)) {
    state.coverAnchor = null;
  }
  state.coverBreakTicks = Math.max(0, state.coverBreakTicks || 0);
  if (state.approachFlankSign !== 1 && state.approachFlankSign !== -1) {
    state.approachFlankSign = undefined;
  }
  state.obstacles ||= [];
  if (!state.blocks || state.blocks.length === 0) {
    state.blocks = createFlatFloor();
    for (const obstacle of state.obstacles) {
      const half = Math.max(0.5, (obstacle.size || 1) / 2);
      for (let x = Math.floor(obstacle.x - half); x <= Math.floor(obstacle.x + half); x += 1) {
        for (let z = Math.floor(obstacle.z - half); z <= Math.floor(obstacle.z + half); z += 1) {
          state.blocks.push({ x, y: 1, z });
          state.blocks.push({ x, y: 2, z });
        }
      }
    }
  }
  const blocks = createBlockSet(state.blocks);
  const snap = <T extends SimPoint>(entity: T): T => {
    if (entity.y != null && Number.isFinite(entity.y) && entity.y < VOID_DEATH_Y) {
      return { ...entity, y: entity.y };
    }
    const floorY = standingY(blocks, entity.x, entity.z);
    if (floorY < -1) {
      // 虚空。無限に下げず、現在高さを維持して上位で死亡判定する。
      const y = entity.y == null || !Number.isFinite(entity.y) ? -1 : entity.y;
      return { ...entity, y };
    }
    const y = entity.y == null || !Number.isFinite(entity.y) ? floorY : entity.y;
    return { ...entity, y };
  };
  state.bot = snap(state.bot);
  if (state.bot.hp <= 0) {
    state.bot.hp = 0;
    state.botDead = true;
  }
  if (state.owner) state.owner = snap(state.owner);
  state.enemies = state.enemies.map(snap).filter((enemy) => enemy.hp > 0);
  state.drops = state.drops.map(snap);
  if (state.grave) state.grave = snap(state.grave);
  return state;
}

export function stepSimulation(input: SimulationState): {
  state: SimulationState;
  decision: SimulationDecision;
} {
  const state = normalizeState(input);
  if (state.ended) {
    return {
      state,
      decision: terminalDecision(state)
    };
  }

  state.now += state.tickMs;
  state.tick += 1;
  state.transitions = [...(state.transitions || [])].slice(-11);
  const blockSet = createBlockSet(state.blocks);

  // すでに死亡している場合は戦闘しない
  if (state.botDead || state.bot.hp <= 0) {
    markBotDead(state);
    const decision = terminalDecision(state);
    decision.validation = validateExpectations(state, decision);
    return { state, decision };
  }

  const enemyMotions = advanceEnemyAi(state, blockSet);
  applyVoidAndSupport(state, blockSet);

  // 敵の近接等で死亡した場合はここで打ち切り（矢は未解決でも可）
  if (state.botDead || state.bot.hp <= 0) {
    markBotDead(state);
    const decision = terminalDecision(state);
    decision.enemyMotions = enemyMotions;
    decision.validation = validateExpectations(state, decision);
    return { state, decision };
  }

  const decision = state.recovery?.active
    ? stepRecovery(state, blockSet)
    : stepCombat(state, blockSet);
  applyVoidAndSupport(state, blockSet);

  // 相棒が動いたあとに矢を進める → 旋回で射線から外れるとかわせる
  const arrowHits = advanceProjectiles(state, blockSet);
  mergeProjectileHitsIntoMotions(enemyMotions, arrowHits);
  applyVoidAndSupport(state, blockSet);

  if (state.botDead || state.bot.hp <= 0) {
    markBotDead(state);
    decision.ended = true;
    decision.outcome = 'lose';
    decision.movement = 'dead';
  }

  // 戦闘後に着火進行。同tickで殴って止められる。
  if (!state.recovery?.active) {
    tickCreeperFuses(state, blockSet);
    applyVoidAndSupport(state, blockSet);
  }
  decision.enemyMotions = enemyMotions;
  decision.rangedPressureCount = countRangedPressure(state, blockSet);

  // 戦闘後に敵全滅で勝利 / 虚空死
  finalizeOutcome(state, decision);

  if (decision.controlOwner !== state.lastOwner) {
    state.transitions.push(`${state.tick}: ${controlOwnerLabel(state.lastOwner)} → ${controlOwnerLabel(decision.controlOwner)}`);
    state.lastOwner = decision.controlOwner;
  }
  decision.validation = validateExpectations(state, decision);
  return { state, decision };
}

function markBotDead(state: SimulationState, reason = '相棒死亡'): void {
  state.bot.hp = 0;
  state.botDead = true;
  state.ended = true;
  state.outcome = 'lose';
  if (!state.transitions.some((line) => line.includes(reason) || line.includes('相棒死亡'))) {
    state.transitions.push(`${state.tick}: ${reason}`);
  }
}

/** 虚空落下・床無しを即死亡扱いにし、無限落下ループを止める。 */
function applyVoidAndSupport(state: SimulationState, blocks: Set<string>): void {
  const supportBot = resolveSupportedFeet(blocks, state.bot);
  state.bot = { ...state.bot, ...supportBot };
  if (state.bot.y < VOID_DEATH_Y || isOverVoid(blocks, state.bot.x, state.bot.z, state.bot.y + 2)) {
    markBotDead(state, '虚空落下');
    return;
  }
  if (state.owner) {
    state.owner = { ...state.owner, ...resolveSupportedFeet(blocks, state.owner) };
  }
  state.enemies = state.enemies
    .map((enemy) => ({ ...enemy, ...resolveSupportedFeet(blocks, enemy) }))
    .filter((enemy) => enemy.y >= VOID_DEATH_Y && !isOverVoid(blocks, enemy.x, enemy.z, enemy.y + 2));
}

function resolveSupportedFeet(blocks: Set<string>, entity: SimPoint): SimPoint {
  const floorY = standingY(blocks, entity.x, entity.z, (entity.y ?? 1) + 2);
  if (floorY < -1) {
    return { ...entity, y: (entity.y ?? 0) - 1 };
  }
  if ((entity.y ?? floorY) - floorY > 1.05) {
    return { ...entity, y: Math.max(floorY, (entity.y ?? floorY) - 1) };
  }
  return { ...entity, y: floorY };
}

function finalizeOutcome(state: SimulationState, decision: SimulationDecision): void {
  const liveEnemies = state.enemies.filter((enemy) => enemy.hp > 0);
  state.enemies = liveEnemies;
  if (state.bot.hp <= 0) {
    markBotDead(state);
    decision.ended = true;
    decision.outcome = 'lose';
    decision.movement = 'dead';
    return;
  }
  if (!state.recovery?.active && liveEnemies.length === 0) {
    state.ended = true;
    state.outcome = 'win';
    decision.ended = true;
    decision.outcome = 'win';
    if (!state.transitions.some((line) => line.includes('戦闘勝利'))) {
      state.transitions.push(`${state.tick}: 戦闘勝利`);
    }
  }
}

function terminalDecision(state: SimulationState): SimulationDecision {
  return {
    controlOwner: state.botDead ? 'follow' : selectControlOwner({
      combatActive: false,
      upperMode: 'follow'
    }),
    primaryId: null,
    spanDeg: null,
    selectedSpanDeg: null,
    destination: null,
    movement: state.botDead ? 'dead' : 'stay',
    intent: null,
    enemyMotions: [],
    rangedPressureCount: 0,
    ended: true,
    outcome: state.outcome,
    recovery: null,
    validation: []
  };
}

function stepCombat(state: SimulationState, blocks: Set<string>): SimulationDecision {
  const threats = state.enemies.filter((enemy) => enemy.hp > 0);
  state.enemies = threats;
  const context = {
    enemyClass: classifyEncounterEnemyClass(threats),
    hasShield: state.inventory.includes('shield')
  };
  const params = state.presetParams || getPresetParams(
    state.activePresetId || baselinePresetId(context)
  );
  // 判断は本番 Reflexes と共通（CombatStep）。ここは観測の用意と、結果の物理反映だけ。
  const step = decideCombatStep(simCombatScene(state, blocks, threats, params), state);
  const byId = (enemy: SceneThreat | null) => (
    enemy ? threats.find((item) => item.id === enemy.id) ?? null : null
  );
  const primary = byId(step.primary);
  if (!primary || !step.detail || !step.situation) {
    return makeDecision('follow', null, null, null, null, 'stay', null);
  }
  const {
    arc,
    selection,
    rangedMoveGoal,
    creeperDist,
    creeperSoft
  } = step.detail;
  const meleeAlly = byId(step.detail.meleeAlly);
  const rangedThreat = byId(step.detail.rangedThreat);
  const creeper = threats.find((enemy) => enemy.kind === 'creeper') ?? null;
  const situation = step.situation;
  const mixedPlan = step.mixedPlan;
  const intent = step.intent;
  const movement = step.movement;
  const forceCommit = step.forceCommit;
  const soleCreeper = step.soleCreeper;
  const preciseStep = step.preciseStep;
  const directFlee = step.directFlee;
  const meleeAllyDistance = meleeAlly ? combatDistance(state.bot, meleeAlly) : Infinity;
  const utilityWeights = state.utilityWeights
    || mergeUtilityWeights(situation.id, null);
  // 決定論位置取りが主経路。効用は現在地スコアのみUI用に残す。
  const utilityEval: UtilityScore | null = threats.length >= 2
    ? scoreUtilityCandidate({
      bot: state.bot,
      candidate: { x: state.bot.x, z: state.bot.z },
      threats: threats.map((enemy) => ({ x: enemy.x, z: enemy.z, kind: enemy.kind })),
      focus: meleeAlly || primary,
      weights: utilityWeights
    })
    : null;

  let destination = null as SimPoint | null;
  let routePreview: SimulationDecision['routePreview'] = null;
  let safeZoneDebug: SimulationDecision['safeZoneDebug'] = null;
  if (step.destination) {
    destination = {
      x: step.destination.x,
      y: standingY(blocks, step.destination.x, step.destination.z, state.bot.y + 2),
      z: step.destination.z
    };
    routePreview = {
      mode: 'straight',
      center: { x: state.bot.x, y: state.bot.y, z: state.bot.z },
      goal: { ...destination },
      points: [
        { x: state.bot.x, y: state.bot.y + 0.18, z: state.bot.z },
        { x: destination.x, y: state.bot.y + 0.18, z: destination.z }
      ]
    };
  }
  const strikeTarget = byId(step.strikeTarget);
  if (strikeTarget) {
    const strikeDamage = (step.rangedPressure > 0 || step.underMixedRanged || soleCreeper) ? 8 : 4;
    const strikeKnockback = step.holdingCover ? COVER_MELEE_KNOCKBACK : MELEE_KNOCKBACK;
    strikeEnemy(state, blocks, strikeTarget, strikeDamage, strikeKnockback);
  }
  if (destination) {
    const approaching = !directFlee && (
      movement === 'advance'
      || movement === 'positioning'
      || movement === 'dodge'
    );
    const stepSpeed = directFlee
      ? MOVE_PER_TICK * 1.85
      : approaching
        ? MOVE_PER_TICK * APPROACH_DASH_MULT
      : forceCommit
        ? MOVE_PER_TICK * 2.35
      : soleCreeper
        ? MOVE_PER_TICK * 2.1
      : MOVE_PER_TICK;
    const before = { x: state.bot.x, z: state.bot.z };
    const flank = state.approachFlankSign
      ?? ((primary.id + state.tick) % 2 === 0 ? 1 : -1);
    const needsNav = !directFlee && !preciseStep && (
      movement === 'advance'
      || movement === 'positioning'
      || movement === 'dodge'
      || (movement === 'attack' && destination != null)
    );
    const moved = needsNav
      ? navigateToward(blocks, state.bot, destination, stepSpeed, flank)
      : stepEntity(blocks, state.bot, destination, stepSpeed);
    state.bot = { ...state.bot, ...moved };
    const progress = horizontalDistance(before, state.bot);
    // 直進退避が壁で止まったら別方位を再試行
    if (directFlee && progress < 0.12 && creeper) {
      const alt = pickCreeperFleePoint(blocks, state.bot, creeper, 3.2);
      const retry = stepEntity(blocks, state.bot, alt, stepSpeed);
      if (horizontalDistance(state.bot, retry) >= 0.12) {
        state.bot = { ...state.bot, ...retry };
        state.approachStuckTicks = 0;
      } else {
        state.approachStuckTicks = (state.approachStuckTicks || 0) + 1;
      }
    } else if (progress < 0.1 && (needsNav || preciseStep)) {
      state.approachStuckTicks = (state.approachStuckTicks || 0) + 1;
      // 壁に吸い付いたら左右を反転して迂回を試す
      state.approachFlankSign = flank === 1 ? -1 : 1;
      if (state.approachStuckTicks >= 2) {
        // 目的地を優先。primary（遠距離）へ迂回すると肉壁を突き抜ける。
        const detour = findDetourWaypoint(blocks, state.bot, destination, state.approachFlankSign);
        if (detour) {
          const slide = stepEntity(
            blocks,
            state.bot,
            { x: detour.x, z: detour.z },
            stepSpeed
          );
          state.bot = { ...state.bot, ...slide };
        } else {
          const slide = navigateToward(
            blocks,
            state.bot,
            destination,
            stepSpeed,
            state.approachFlankSign
          );
          state.bot = { ...state.bot, ...slide };
        }
      }
    } else if (progress >= 0.1) {
      state.approachStuckTicks = 0;
      state.approachFlankSign = flank;
    }
  }
  separateOverlappingEntities(state, blocks);
  const phase = mixedPlan
    ? { id: mixedPlan.uiPhaseId, ...PHASE_META[mixedPlan.uiPhaseId] }
    : decideCombatPhase({
      situation,
      spanDeg: arc ? spanDegrees(arc.spanRad) : null,
      arcLatched: Boolean(state.arcNarrowLatched),
      creeperDist,
      creeperSoft,
      meleeDist: meleeAllyDistance,
      rangedDist: rangedThreat ? combatDistance(state.bot, rangedThreat) : Infinity,
      canStrikeFocus: Boolean(step.detail.inRangeStrikeTarget) || step.detail.canMeleeAttack,
      explosiveDanger: step.explosiveImmediateDanger
    });
  const decision = makeDecision(
    'combat',
    primary.id,
    arc ? spanDegrees(arc.spanRad) : null,
    threats.length >= 2 ? spanDegrees(selection.chosen.spanRad) : null,
    destination,
    movement,
    intent
  );
  decision.situation = situation;
  decision.phase = phase;
  decision.utility = {
    equation: UTILITY_EQUATION,
    weights: utilityWeights,
    evaluation: utilityEval
  };
  decision.routePreview = routePreview;
  // 緑箱は移動目標と一致させる（あさっての別点を出さない）
  {
    const liveThreats = state.enemies.filter((enemy) => enemy.hp > 0);
    if (liveThreats.length >= 1) {
      const liveMelee = liveThreats.find((enemy) => classifyEnemy(enemy.kind) !== 'ranged'
        && classifyEnemy(enemy.kind) !== 'explosive') ?? null;
      const liveRanged = liveThreats.find((enemy) => classifyEnemy(enemy.kind) === 'ranged') ?? null;
      const liveUmbra = (liveMelee && liveRanged)
        ? umbraAnchor(liveRanged, liveMelee, 1.55)
        : null;
      const fans = liveThreats.map((enemy) => {
        const others = liveThreats.filter((item) => item.id !== enemy.id);
        const terrainBlocked = resolveRangedImpact(
          enemy,
          state.bot,
          [],
          blocks
        ).hitKind === 'block';
        return describeAttackFan(enemy, state.bot, {
          others,
          point: state.bot,
          terrainBlocked
        });
      });
      const coverFromFan = fans.find((fan) => fan.coverPoint)?.coverPoint ?? null;
      const cover = selection.coverPoint || coverFromFan;
      const marker = destination
        || rangedMoveGoal
        || liveUmbra
        || selection.safePoint
        || null;
      safeZoneDebug = {
        safeZone: marker
          ? {
            x: marker.x,
            y: state.bot.y + 0.2,
            z: marker.z
          }
          : null,
        coverPoint: cover
          ? {
            x: cover.x,
            y: (cover.y ?? state.bot.y) + 0.2,
            z: cover.z
          }
          : null,
        fans
      };
    }
  }
  decision.safeZoneDebug = safeZoneDebug;
  return decision;
}

/** 箱庭の状態を共通判断（CombatStep）の観測に変換する。 */
function simCombatScene(
  state: SimulationState,
  blocks: Set<string>,
  threats: SimEnemy[],
  params: CombatPresetParams
): CombatScene {
  return {
    now: state.now,
    tickMs: state.tickMs,
    tick: state.tick,
    bot: state.bot,
    threats: threats.map((enemy) => ({
      id: enemy.id,
      x: enemy.x,
      y: enemy.y,
      z: enemy.z,
      kind: enemy.kind,
      hp: enemy.hp,
      ignited: isSimCreeperIgnited(enemy)
    })),
    owner: state.owner,
    hasShield: state.inventory.includes('shield'),
    stunned: isStunned(state.now, state.botStunUntil),
    lastDamageAt: state.lastDamageAt,
    cornered: Math.max(Math.abs(state.bot.x), Math.abs(state.bot.z)) >= ARENA_EDGE,
    params,
    hasLineOfSight: (from, to) => hasVoxelLineOfSight(blocks, from, to),
    rangedHitsBot: (shooter) => resolveRangedImpact(shooter, state.bot, state.enemies, blocks).hitKind === 'bot',
    // 地形のみ（他敵遮蔽は attackFan 側）。矢の着弾と同じボクセル感覚。
    terrainBlocked: (from, to) => resolveRangedImpact(
      { x: from.x, y: from.y ?? 1, z: from.z, id: (from as { id?: number }).id ?? -999 },
      { x: to.x, y: to.y ?? state.bot.y, z: to.z },
      [],
      blocks
    ).hitKind === 'block',
    pathBlocked: (from, to) => isPathBlocked3D(blocks, from, to),
    approachPoint: (target, flank) => pickCombatApproachPoint(blocks, state.bot, target, flank),
    creeperFleePoint: (creeper, amount) => pickCreeperFleePoint(blocks, state.bot, creeper, amount),
    approachKeepingCreeperDistance: (primary, creeper, soft, flank) => (
      pickApproachKeepingCreeperDistance(blocks, state.bot, primary, creeper, soft, flank)
    ),
    meleeCoverPoint: (meleeAlly, ranged) => pickMixedMeleeCoverPoint(
      state.bot,
      meleeAlly,
      ranged,
      (from, to) => isPathBlocked3D(blocks, from, to)
    )
  };
}

function stepRecovery(state: SimulationState, blocks: Set<string>): SimulationDecision {
  const recovery = state.recovery;
  const nearest = [...state.enemies].sort((a, b) => combatDistance(state.bot, a) - combatDistance(state.bot, b))[0];
  if (nearest && combatDistance(state.bot, nearest) <= 2.5 && state.now >= (recovery.emergencyCooldownUntil || 0)) {
    recovery.emergencyUntil = state.now + 500;
    recovery.emergencyCooldownUntil = state.now + 1000;
  }
  if (nearest && state.now < (recovery.emergencyUntil || 0)) {
    const away = threatBearingRad(nearest, state.bot);
    const point = pointAt(state.bot, away, 2);
    state.bot = { ...state.bot, ...stepEntity(blocks, state.bot, point, MOVE_PER_TICK) };
    return recoveryDecision(state, 'survival', 'survival');
  }

  if (recovery.phase === 'travel' && state.grave) {
    state.bot = { ...state.bot, ...stepEntity(blocks, state.bot, state.grave, MOVE_PER_TICK) };
    if (combatDistance(state.bot, state.grave) <= 0.7) {
      recovery.phase = 'grave';
      state.transitions.push(`${state.tick}: 復旧移動 → 墓処理`);
    }
    return recoveryDecision(state, 'recovery', 'recovery', state.grave);
  }

  if (recovery.phase === 'grave' && state.grave) {
    const preexistingItemIds = state.drops.map((drop) => drop.id);
    const origin = { x: state.grave.x, y: state.grave.y, z: state.grave.z };
    const fakeCtx = recoveryContext(state);
    requestRecoveryItemCollection(fakeCtx, origin, state.now, 'grave', { preexistingItemIds });
    const contents = state.grave.contents;
    state.grave = null;
    contents.forEach((item, index) => state.drops.push({
      id: state.nextId++,
      item,
      graveOwned: true,
      x: origin.x + (index === 0 ? 0.6 : -0.6),
      y: origin.y,
      z: origin.z + (index % 2 === 0 ? 0.4 : -0.4)
    }));
    state.transitions.push(`${state.tick}: 墓処理 → アイテム回収`);
    return recoveryDecision(state, 'recovery', 'recovery');
  }

  if (recovery.phase === 'items') {
    const fakeCtx = recoveryContext(state);
    for (const drop of state.drops) {
      trackRecoveryItem(fakeCtx, dropEntity(drop), state.now);
    }
    let status = observeRecoveryItemCollection(fakeCtx, state.now);
    const ownedRemaining = state.drops.filter((drop) => status?.remainingIds.includes(drop.id));
    const target = [...ownedRemaining].sort((a, b) => combatDistance(state.bot, a) - combatDistance(state.bot, b))[0];
    if (target) {
      state.bot = { ...state.bot, ...stepEntity(blocks, state.bot, target, MOVE_PER_TICK) };
      if (combatDistance(state.bot, target) <= 0.8) {
        state.inventory.push(target.item);
        state.drops = state.drops.filter((drop) => drop.id !== target.id);
        status = observeRecoveryItemCollection(recoveryContext(state), state.now);
      }
    }
    const hasWeapon = state.inventory.some((item) => /sword|axe|trident|mace/.test(item));
    const quietReady = Boolean(status?.captureComplete)
      && status!.remainingIds.length === 0
      && status!.quietForMs >= 300;
    if ((quietReady && hasWeapon) || status?.deadlineReached) {
      state.equipped = state.inventory.find((item) => /sword|axe|trident|mace/.test(item)) || null;
      recovery.phase = 'done';
      recovery.active = false;
      state.transitions.push(`${state.tick}: アイテム回収 → 戦闘復帰可能`);
    }
    return recoveryDecision(state, 'recovery', 'recovery', target || null);
  }
  return recoveryDecision(state, 'recovery', 'recovery');
}

function recoveryContext(state: SimulationState): any {
  const entities: Record<number, any> = {};
  for (const drop of state.drops) entities[drop.id] = dropEntity(drop);
  return {
    bot: { entities },
    config: { nearby_loot: { recovery_capture_ms: 500, recovery_deadline_ms: 5000 } },
    deathRecovery: state.recovery,
    holdReflexes: true
  };
}

function dropEntity(drop: SimDrop): any {
  return { id: drop.id, name: 'item', position: { x: drop.x, y: drop.y, z: drop.z } };
}

function recoveryDecision(
  state: SimulationState,
  owner: string,
  movement: SimulationDecision['movement'],
  destination: SimPoint | null = null
): SimulationDecision {
  const entities = Object.fromEntries(state.drops.map((drop) => [drop.id, dropEntity(drop)]));
  const ids = state.recovery.ownedItemIds || [];
  return {
    controlOwner: selectControlOwner({
      recoveryActive: true,
      recoveryEmergency: owner === 'survival',
      combatActive: state.enemies.length > 0,
      upperMode: 'follow'
    }),
    primaryId: null,
    spanDeg: null,
    selectedSpanDeg: null,
    destination,
    movement,
    intent: null,
    enemyMotions: [],
    rangedPressureCount: 0,
    ended: false,
    outcome: 'ongoing',
    recovery: {
      phase: state.recovery.phase,
      ownedIds: ids,
      remainingIds: ids.filter((id: number) => Boolean(entities[id])),
      captureRemainingMs: Math.max(0, (state.recovery.collectionCaptureUntil || 0) - state.now),
      deadlineRemainingMs: Math.max(0, (state.recovery.collectionDeadlineAt || 0) - state.now)
    },
    validation: []
  };
}

function makeDecision(
  owner: string,
  primaryId: number | null,
  spanDegValue: number | null,
  selectedSpanDeg: number | null,
  destination: SimPoint | null,
  movement: SimulationDecision['movement'],
  intent: CombatIntent | null
): SimulationDecision {
  return {
    controlOwner: selectControlOwner({
      combatActive: owner === 'combat',
      upperMode: 'follow'
    }),
    primaryId,
    spanDeg: spanDegValue,
    selectedSpanDeg,
    destination,
    movement,
    intent,
    enemyMotions: [],
    rangedPressureCount: 0,
    ended: false,
    outcome: 'ongoing',
    recovery: null,
    validation: [],
    situation: null,
    phase: null,
    utility: null,
    routePreview: null,
    safeZoneDebug: null
  };
}

function validateExpectations(state: SimulationState, decision: SimulationDecision) {
  const expected = state.expectations || {};
  const checks: Array<{ field: string; expected: unknown; actual: unknown; pass: boolean }> = [];
  const add = (field: string, wanted: unknown, actual: unknown, pass: boolean) => {
    if (wanted !== undefined) checks.push({ field, expected: wanted, actual, pass });
  };
  add('owner', expected.owner, decision.controlOwner, decision.controlOwner === expected.owner);
  add('intent', expected.intent, decision.intent?.priority ?? null, decision.intent?.priority === expected.intent);
  const evaluatedSpan = decision.selectedSpanDeg ?? decision.spanDeg;
  add('maxSpanDeg', expected.maxSpanDeg, evaluatedSpan, evaluatedSpan != null && evaluatedSpan <= expected.maxSpanDeg!);
  add('recoveryActive', expected.recoveryActive, state.recovery.active, state.recovery.active === expected.recoveryActive);
  add('equipped', expected.equipped, state.equipped, state.equipped === expected.equipped);
  return checks;
}

function controlOwnerLabel(value: string): string {
  return ({
    follow: '追従',
    combat: '戦闘',
    recovery: '復旧',
    survival: '緊急生存',
    transfer: '受け渡し',
    wait: '待機'
  } as Record<string, string>)[value] || value;
}

export function advanceEnemyAi(state: SimulationState, blocks = createBlockSet(state.blocks)): EnemyMotion[] {
  if (!state.enemyAi?.enabled) return [];
  const speedScale = clamp(state.enemyAi.speedScale, 0.25, 2);
  const botAtTickStart = { x: state.bot.x, y: state.bot.y, z: state.bot.z };
  const motions: EnemyMotion[] = [];

  for (const enemy of [...state.enemies].sort((a, b) => a.id - b.id)) {
    if (enemy.hp <= 0) continue;
    const from = { x: enemy.x, y: enemy.y, z: enemy.z };
    const stunned = isStunned(state.now, enemy.stunUntil);
    const ranged = isRangedEntity({ name: enemy.kind });
    const currentDistance = combatDistance(enemy, botAtTickStart);
    let behavior: EnemyBehavior = 'hold';
    let bearing = threatBearingRad(enemy, botAtTickStart);
    let baseSpeed = enemy.kind === 'spider' ? 0.38 : 0.3;

    if (stunned) {
      behavior = 'hold';
      baseSpeed = 0;
    } else if (enemy.kind === 'creeper' && isSimCreeperIgnited(enemy)) {
      // JE: 着火中は膨らみで静止（追尾しない）
      behavior = 'hold';
      baseSpeed = 0;
    } else if (ranged) {
      baseSpeed = 0.24;
      if (currentDistance > RANGED_MAX_RANGE) {
        behavior = 'chase';
      } else if (currentDistance < RANGED_MIN_RANGE) {
        behavior = 'retreat';
        bearing += Math.PI;
      } else {
        behavior = 'strafe';
        const phaseSide: 1 | -1 = (Math.floor(state.tick / 16) + enemy.id) % 2 === 0 ? 1 : -1;
        bearing += phaseSide * Math.PI / 2;
      }
    } else if (currentDistance < ENTITY_OVERLAP_RANGE) {
      // 同座標めり込みは押し出してから殴る
      behavior = 'retreat';
      bearing = Number.isFinite(bearing) ? bearing + Math.PI : enemy.id * 1.7;
      baseSpeed = 0.35;
    } else if (currentDistance > MELEE_STOP_RANGE) {
      behavior = 'chase';
    }

    const requestedSpeed = behavior === 'hold' ? 0 : baseSpeed * speedScale;
    const cappedSpeed = ranged
      ? requestedSpeed
      : behavior === 'retreat'
      ? requestedSpeed
      : Math.min(requestedSpeed, Math.max(0, currentDistance - MELEE_STOP_RANGE));
    const requested = pointAt(enemy, bearing, cappedSpeed);
    const to = moveEnemyAroundBlocks(enemy, requested, bearing, cappedSpeed, blocks, enemy.id);
    enemy.x = to.x;
    enemy.y = to.y;
    enemy.z = to.z;

    const pressureDistance = combatDistance(enemy, botAtTickStart);
    const overlapping = pressureDistance < ENTITY_OVERLAP_RANGE;
    const canSee = overlapping || hasVoxelLineOfSight(blocks, enemy, botAtTickStart);
    // 射撃は視線があれば行う（間の他敵・壁への着弾は resolveRangedImpact 側）。
    // 遠距離「圧」は countRangedPressure で実弾が相棒に届くかだけ見る。
    const fired = !stunned
      && ranged
      && canSee
      && pressureDistance >= 3
      && pressureDistance <= RANGED_PRESSURE_RANGE
      && state.tick % RANGED_SHOT_INTERVAL_TICKS === enemy.id % RANGED_SHOT_INTERVAL_TICKS;
    let hitEntityId: number | null = null;
    let hitKind: 'bot' | 'enemy' | 'block' | null = null;
    if (fired) {
      enemy.lastShotTick = state.tick;
      state.shots += 1;
      // 即着弾せず飛行弾を生成。着弾は advanceProjectiles（相棒移動後）。
      spawnRangedProjectile(state, enemy, botAtTickStart);
    }
    // 近接接触ダメージ（壁越しは不可。めり込みは可）
    // クリーパーは着火爆発以外の殴りダメを持たない（JE準拠）。箱庭では接触を障害物扱い。
    if (
      !stunned
      && !ranged
      && enemy.kind !== 'creeper'
      && canSee
      && (
        overlapping
        || (
          pressureDistance <= MELEE_STOP_RANGE + 0.15
          && Math.abs(enemy.y - botAtTickStart.y) <= MELEE_HEIGHT_SLACK
        )
      )
    ) {
      if (state.tick % 4 === enemy.id % 4) {
        hurtBot(state, blocks, enemy, 3);
      }
    }
    motions.push({
      id: enemy.id,
      behavior,
      speed: horizontalDistance(from, to),
      from,
      to,
      fired,
      hitEntityId,
      hitKind
    });
  }
  // 味方撃ちで倒れた敵を除去
  state.enemies = state.enemies.filter((enemy) => enemy.hp > 0);
  separateOverlappingEntities(state, blocks);
  return motions;
}

function spawnRangedProjectile(
  state: SimulationState,
  shooter: SimEnemy,
  aim: SimPoint
): void {
  const origin = {
    x: shooter.x,
    y: shooter.y + EYE_HEIGHT * 0.55,
    z: shooter.z
  };
  const target = {
    x: aim.x,
    y: aim.y + EYE_HEIGHT * 0.55,
    z: aim.z
  };
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 0.2) return;
  state.projectiles = state.projectiles || [];
  state.nextId = (state.nextId || 100) + 1;
  state.projectiles.push({
    id: state.nextId,
    shooterId: shooter.id,
    x: origin.x,
    y: origin.y,
    z: origin.z,
    dirX: dx / length,
    dirY: dy / length,
    dirZ: dz / length,
    traveled: 0
  });
}

type ProjectileHit = {
  shooterId: number;
  hitKind: 'bot' | 'enemy' | 'block';
  hitEntityId: number | null;
};

/**
 * JE 相当速度で矢を進め、壁／敵／相棒に当たったら着弾。
 * 発射時の向きは固定なので、飛行中に相棒が射線から外れればミスになる。
 */
function advanceProjectiles(
  state: SimulationState,
  blocks: Set<string>
): ProjectileHit[] {
  const projectiles = state.projectiles || [];
  if (!projectiles.length) return [];
  const mcSteps = Math.max(1, Math.round(state.tickMs / MC_TICK_MS));
  const hits: ProjectileHit[] = [];
  const remaining: SimProjectile[] = [];

  for (const arrow of projectiles) {
    let alive = true;
    let hit: ProjectileHit | null = null;
    for (let step = 0; step < mcSteps && alive; step += 1) {
      const nx = arrow.x + arrow.dirX * ARROW_SPEED_PER_MC_TICK;
      const ny = arrow.y + arrow.dirY * ARROW_SPEED_PER_MC_TICK;
      const nz = arrow.z + arrow.dirZ * ARROW_SPEED_PER_MC_TICK;
      const segHits = resolveArrowSegmentHit(
        state,
        blocks,
        arrow,
        { x: nx, y: ny, z: nz }
      );
      arrow.traveled += ARROW_SPEED_PER_MC_TICK;
      if (segHits) {
        hit = segHits;
        alive = false;
        applyArrowHit(state, blocks, arrow, segHits);
        break;
      }
      arrow.x = nx;
      arrow.y = ny;
      arrow.z = nz;
      if (arrow.traveled >= ARROW_MAX_FLIGHT) {
        alive = false;
        hit = { shooterId: arrow.shooterId, hitKind: 'block', hitEntityId: null };
      }
    }
    if (hit) hits.push(hit);
    else if (alive) remaining.push(arrow);
  }

  state.projectiles = remaining;
  state.enemies = state.enemies.filter((enemy) => enemy.hp > 0);
  return hits;
}

function resolveArrowSegmentHit(
  state: SimulationState,
  blocks: Set<string>,
  arrow: SimProjectile,
  next: { x: number; y: number; z: number }
): ProjectileHit | null {
  const dx = next.x - arrow.x;
  const dy = next.y - arrow.y;
  const dz = next.z - arrow.z;
  const length = Math.hypot(dx, dy, dz) || 1e-6;
  const steps = Math.max(2, Math.ceil(length / 0.25));

  let bestEnemyT = Infinity;
  let bestEnemy: SimEnemy | null = null;
  for (const other of state.enemies) {
    if (other.id === arrow.shooterId || other.hp <= 0) continue;
    const body = { x: other.x, y: other.y + 0.9, z: other.z };
    const t = projectPointOntoSegmentT(
      { x: arrow.x, y: arrow.y, z: arrow.z },
      next,
      body
    );
    if (t < 0 || t > 1) continue;
    const closest = {
      x: arrow.x + dx * t,
      y: arrow.y + dy * t,
      z: arrow.z + dz * t
    };
    if (distance3(closest, body) > ARROW_HIT_RADIUS) continue;
    if (t < bestEnemyT) {
      bestEnemyT = t;
      bestEnemy = other;
    }
  }

  let botT = Infinity;
  if (!state.botDead && state.bot.hp > 0) {
    const body = { x: state.bot.x, y: state.bot.y + 0.9, z: state.bot.z };
    const t = projectPointOntoSegmentT(
      { x: arrow.x, y: arrow.y, z: arrow.z },
      next,
      body
    );
    if (t >= 0 && t <= 1) {
      const closest = {
        x: arrow.x + dx * t,
        y: arrow.y + dy * t,
        z: arrow.z + dz * t
      };
      if (distance3(closest, body) <= ARROW_HIT_RADIUS) botT = t;
    }
  }

  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const x = arrow.x + dx * t;
    const y = arrow.y + dy * t;
    const z = arrow.z + dz * t;
    if (hasBlock(blocks, Math.floor(x), Math.floor(y), Math.floor(z))) {
      if (bestEnemy && bestEnemyT < t - 1e-6) {
        return { shooterId: arrow.shooterId, hitKind: 'enemy', hitEntityId: bestEnemy.id };
      }
      if (botT < t - 1e-6) {
        return { shooterId: arrow.shooterId, hitKind: 'bot', hitEntityId: null };
      }
      return { shooterId: arrow.shooterId, hitKind: 'block', hitEntityId: null };
    }
  }

  if (bestEnemy && bestEnemyT <= botT) {
    return { shooterId: arrow.shooterId, hitKind: 'enemy', hitEntityId: bestEnemy.id };
  }
  if (botT < Infinity) {
    return { shooterId: arrow.shooterId, hitKind: 'bot', hitEntityId: null };
  }
  return null;
}

function applyArrowHit(
  state: SimulationState,
  blocks: Set<string>,
  arrow: SimProjectile,
  hit: ProjectileHit
): void {
  const shooter = state.enemies.find((enemy) => enemy.id === arrow.shooterId)
    || { x: arrow.x - arrow.dirX, y: arrow.y, z: arrow.z - arrow.dirZ };
  if (hit.hitKind === 'enemy' && hit.hitEntityId != null) {
    const target = state.enemies.find((enemy) => enemy.id === hit.hitEntityId);
    if (!target) return;
    target.hp -= RANGED_SHOT_DAMAGE;
    const pushed = applyKnockback(blocks, target, shooter, RANGED_KNOCKBACK);
    target.x = pushed.x;
    target.y = pushed.y;
    target.z = pushed.z;
    return;
  }
  if (hit.hitKind === 'bot') {
    const guarded = isBotGuardingRanged(state, blocks);
    const raw = RANGED_SHOT_DAMAGE;
    const dealt = guarded
      ? Math.max(0, Math.round(raw * SHIELD_RANGED_DAMAGE_FACTOR))
      : raw;
    if (dealt > 0) {
      hurtBot(state, blocks, shooter, dealt, RANGED_KNOCKBACK, RANGED_STUN_MS);
    }
  }
}

function mergeProjectileHitsIntoMotions(
  motions: EnemyMotion[],
  hits: ProjectileHit[]
): void {
  for (const hit of hits) {
    const motion = motions.find((item) => item.id === hit.shooterId && item.fired);
    if (!motion) continue;
    // 同一tick発射の着弾をモーションへ反映（UIビーム用）
    motion.hitKind = hit.hitKind;
    motion.hitEntityId = hit.hitEntityId;
  }
}

/** 直進できないときは左右に迂回して目標へ近づく。 */
export function navigateToward(
  blocks: Set<string>,
  from: SimPoint,
  goal: { x: number; z: number },
  maxStep: number,
  flankSign: 1 | -1 = 1
): SimPoint {
  const direct = stepEntity(blocks, from, goal, maxStep);
  const directProgress = horizontalDistance(from, direct);
  const blocked = isPathBlocked3D(blocks, from, goal);
  if (!blocked && directProgress > 0.12) return direct;

  const bearing = threatBearingRad(from, goal);
  const startDist = horizontalDistance(from, goal);
  const offsets = [
    flankSign * Math.PI / 2,
    -flankSign * Math.PI / 2,
    flankSign * Math.PI / 3,
    -flankSign * Math.PI / 3,
    flankSign * (2 * Math.PI / 3),
    -flankSign * (2 * Math.PI / 3)
  ];
  let best = direct;
  let bestScore = directProgress > 0.05
    ? directProgress + (startDist - horizontalDistance(direct, goal)) * 2
    : -1e9;

  for (const offset of offsets) {
    const probe = pointAt(from, bearing + offset, Math.max(1.5, maxStep * 2.2));
    const stepped = stepEntity(blocks, from, probe, maxStep);
    const progress = horizontalDistance(from, stepped);
    if (progress < 0.1) continue;
    const closer = startDist - horizontalDistance(stepped, goal);
    // 壁沿い往復を減らすため、flankSign側への移動を優遇する
    const sideDot = Math.sin(bearing + offset) * Math.sin(bearing + flankSign * Math.PI / 2)
      + Math.cos(bearing + offset) * Math.cos(bearing + flankSign * Math.PI / 2);
    const score = progress * 1.2 + closer * 2.8 + sideDot * 0.8;
    if (score > bestScore) {
      bestScore = score;
      best = stepped;
    }
  }
  return best;
}

/**
 * 接近目標。直進が壁で塞がれているときは、from→経由→敵が通る点を選ぶ。
 * （壁の手前で敵のzを追って左右に滑り続けるのを防ぐ）
 */
export function pickCombatApproachPoint(
  blocks: Set<string>,
  from: SimPoint,
  primary: SimPoint,
  flankSign: 1 | -1 = 1
): SimPoint {
  const bearing = threatBearingRad(from, primary);
  const travel = Math.max(0.6, combatDistance(from, primary) - MELEE_HOLD_RANGE);
  const direct = pointAt(from, bearing, travel);
  const directGoal = {
    x: direct.x,
    y: standingY(blocks, direct.x, direct.z, from.y + 2),
    z: direct.z
  };
  if (!isPathBlocked3D(blocks, from, directGoal)) {
    return directGoal;
  }

  const detour = findDetourWaypoint(blocks, from, primary, flankSign);
  if (detour) {
    return {
      x: detour.x,
      y: standingY(blocks, detour.x, detour.z, from.y + 2),
      z: detour.z
    };
  }
  return directGoal;
}

/** from→wp→goal の2区間が歩ける経由点を探す。 */
function findDetourWaypoint(
  blocks: Set<string>,
  from: SimPoint,
  goal: SimPoint,
  flankSign: 1 | -1
): { x: number; z: number } | null {
  const goalXZ = { x: goal.x, z: goal.z };
  const baseBearing = threatBearingRad(from, goal);
  let best: { x: number; z: number } | null = null;
  let bestScore = Infinity;

  const radii = [2.5, 3.5, 4.5, 5.5, 6.5, 8];
  for (const radius of radii) {
    for (let index = 0; index < 20; index += 1) {
      // flankSign 側を先に試し、反対側・前後も順に見る
      const sector = Math.floor(index / 2) + 1;
      const side = index % 2 === 0 ? flankSign : (-flankSign as 1 | -1);
      const ang = baseBearing + side * (sector * Math.PI / 10);
      const wp = {
        x: from.x + Math.sin(ang) * radius,
        z: from.z + Math.cos(ang) * radius
      };
      const feetY = standingY(blocks, wp.x, wp.z, from.y + 2);
      if (feetY < -1) continue;
      const wpPoint = { x: wp.x, y: feetY, z: wp.z };
      if (isPathBlocked3D(blocks, from, wp)) continue;
      if (isPathBlocked3D(blocks, wpPoint, goalXZ)) continue;
      const sidePenalty = side === flankSign ? 0 : 1.2;
      const score = radius
        + horizontalDistance(wp, goalXZ)
        + sidePenalty;
      if (score < bestScore) {
        bestScore = score;
        best = wp;
      }
    }
  }

  // 円弧で見つからなければ、壁の外側っぽい大きな横移動も試す
  if (!best) {
    for (const side of [flankSign, -flankSign] as const) {
      for (const radius of [4, 6, 8, 10]) {
        const wp = pointAt(from, baseBearing + side * Math.PI / 2, radius);
        const feetY = standingY(blocks, wp.x, wp.z, from.y + 2);
        if (feetY < -1) continue;
        const wpPoint = { x: wp.x, y: feetY, z: wp.z };
        if (isPathBlocked3D(blocks, from, wp)) continue;
        if (isPathBlocked3D(blocks, wpPoint, goalXZ)) continue;
        const score = radius + horizontalDistance(wp, goalXZ);
        if (score < bestScore) {
          bestScore = score;
          best = wp;
        }
      }
    }
  }
  return best;
}

/** 相棒と敵が同座標にめり込んだら押し分けてスタックを解消する。 */
function separateOverlappingEntities(state: SimulationState, blocks: Set<string>): void {
  for (const enemy of state.enemies) {
    if (enemy.hp <= 0) continue;
    const dist = horizontalDistance(state.bot, enemy);
    if (dist >= ENTITY_OVERLAP_RANGE) continue;
    const bearing = dist < 1e-4
      ? (enemy.id * 1.7 + state.tick * 0.31)
      : threatBearingRad(state.bot, enemy);
    const push = (ENTITY_OVERLAP_RANGE - dist) * 0.55 + 0.2;
    const botTarget = pointAt(state.bot, bearing + Math.PI, push);
    const enemyTarget = pointAt(enemy, bearing, push);
    const botMoved = stepEntity(blocks, state.bot, botTarget, push);
    const enemyMoved = stepEntity(blocks, enemy, enemyTarget, push);
    state.bot = { ...state.bot, x: botMoved.x, y: botMoved.y, z: botMoved.z };
    enemy.x = enemyMoved.x;
    enemy.y = enemyMoved.y;
    enemy.z = enemyMoved.z;
  }
}

/**
 * 遠距離弾は、射手→相棒の直線上で最初に当たる実体に着弾する。
 * 間に別の敵がいればその敵が被弾し、相棒には届かない（マイクラの矢に近い）。
 * 壁など固体があればそこで止まり、相棒には届かない。
 */
export function resolveRangedImpact(
  shooter: SimPoint & { id: number },
  bot: SimPoint,
  enemies: Array<SimPoint & { id: number; hp: number; kind?: string }>,
  blocks?: Set<string>
): {
  hitKind: 'bot' | 'enemy' | 'block';
  hitEntityId: number | null;
  target: (SimPoint & { id: number; hp: number; kind?: string }) | null;
} {
  const HIT_RADIUS = 0.65;
  const origin = { x: shooter.x, y: shooter.y + EYE_HEIGHT * 0.55, z: shooter.z };
  const aim = { x: bot.x, y: bot.y + EYE_HEIGHT * 0.55, z: bot.z };
  const dx = aim.x - origin.x;
  const dy = aim.y - origin.y;
  const dz = aim.z - origin.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 0.2) {
    return { hitKind: 'bot', hitEntityId: null, target: null };
  }

  let bestT = 1;
  let best: (SimPoint & { id: number; hp: number; kind?: string }) | null = null;
  for (const other of enemies) {
    if (other.id === shooter.id || other.hp <= 0) continue;
    const body = { x: other.x, y: other.y + 0.9, z: other.z };
    const t = projectPointOntoSegmentT(origin, aim, body);
    // 射手の直後・相棒より先は無視
    if (t < 0.08 || t > 0.98) continue;
    const closest = {
      x: origin.x + dx * t,
      y: origin.y + dy * t,
      z: origin.z + dz * t
    };
    if (distance3(closest, body) > HIT_RADIUS) continue;
    if (t < bestT) {
      bestT = t;
      best = other;
    }
  }

  // 壁が先なら着弾せず無効
  if (blocks) {
    const steps = Math.max(2, Math.ceil(length / 0.25));
    for (let index = 1; index < steps; index += 1) {
      const t = index / steps;
      if (best && t >= bestT) break;
      const x = origin.x + dx * t;
      const y = origin.y + dy * t;
      const z = origin.z + dz * t;
      if (hasBlock(blocks, Math.floor(x), Math.floor(y), Math.floor(z))) {
        return { hitKind: 'block', hitEntityId: null, target: null };
      }
    }
  }

  if (best) {
    return { hitKind: 'enemy', hitEntityId: best.id, target: best };
  }
  return { hitKind: 'bot', hitEntityId: null, target: null };
}

function projectPointOntoSegmentT(
  a: Vec3,
  b: Vec3,
  point: Vec3
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq < 1e-8) return 0;
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy + (point.z - a.z) * dz) / lengthSq;
  return Math.max(0, Math.min(1, t));
}

function countRangedPressure(state: SimulationState, blocks: Set<string>): number {
  // 遠距離圧 = 矢が実際に相棒へ届く脅威のみ。
  // 目線LOSだけ通って胸部の矢が壁に当たるケースでは回避し続けない。
  return state.enemies.filter((enemy) => (
    enemy.hp > 0
    && isRangedEntity({ name: enemy.kind })
    && combatDistance(state.bot, enemy) <= RANGED_PRESSURE_RANGE
    && resolveRangedImpact(enemy, state.bot, state.enemies, blocks).hitKind === 'bot'
  )).length;
}

/** CORE: 盾+遠距離圧ならガード中（箱庭の被弾軽減判定）。 */
function isBotGuardingRanged(state: SimulationState, blocks: Set<string>): boolean {
  if (!state.inventory.includes('shield')) return false;
  return countRangedPressure(state, blocks) >= GUARD_RANGED_THREAT_THRESHOLD;
}

function moveEnemyAroundBlocks(
  origin: SimPoint,
  requested: { x: number; z: number },
  bearing: number,
  speed: number,
  blocks: Set<string>,
  enemyId: number
): SimPoint {
  if (speed <= 0) return { ...origin };
  const direct = stepEntity(blocks, origin, requested, speed);
  if (horizontalDistance(origin, direct) > 1e-4) return direct;
  const side: 1 | -1 = enemyId % 2 === 0 ? 1 : -1;
  for (const offset of [side * Math.PI / 2, -side * Math.PI / 2]) {
    const alternative = pointAt(origin, bearing + offset, speed);
    const moved = stepEntity(blocks, origin, alternative, speed);
    if (horizontalDistance(origin, moved) > 1e-4) return moved;
  }
  return { ...origin, y: standingY(blocks, origin.x, origin.z, origin.y + 1) };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(minimum, Math.min(maximum, value));
}

/** クリーパーから離れる地点。壁・虚空で直進不可なら横へ逃がす。 */
function pickCreeperFleePoint(
  blocks: Set<string>,
  bot: SimPoint,
  creeper: SimPoint,
  amount: number
): SimPoint {
  const base = threatBearingRad(creeper, bot);
  const offsets = [0, 0.55, -0.55, 1.1, -1.1, Math.PI / 2, -Math.PI / 2, 2.1, -2.1, Math.PI];
  let best: SimPoint | null = null;
  let bestScore = -1e9;
  const startDist = combatDistance(bot, creeper);
  for (const offset of offsets) {
    const bearing = Number.isFinite(base) ? base + offset : offset;
    const probe = pointAt(bot, bearing, amount);
    const y = standingY(blocks, probe.x, probe.z, bot.y + 2);
    if (y < -1) continue;
    const target = { x: probe.x, y, z: probe.z };
    if (isOverVoid(blocks, target.x, target.y, target.z)) continue;
    const stepped = stepEntity(blocks, bot, target, MOVE_PER_TICK * 1.85);
    const progress = horizontalDistance(bot, stepped);
    if (progress < 0.08 && Math.abs(offset) < 0.01) continue;
    const nextDist = Math.hypot(stepped.x - creeper.x, stepped.z - creeper.z);
    const score = progress * 2.2 + (nextDist - startDist) * 3.5 - Math.abs(offset) * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  }
  if (best) return best;
  const fallback = pointAt(bot, Number.isFinite(base) ? base : 0, amount);
  return {
    x: fallback.x,
    y: standingY(blocks, fallback.x, fallback.z, bot.y + 2),
    z: fallback.z
  };
}

/**
 * 主対象へ近づきつつクリーパー間合いを落とさない経由点を選ぶ。
 * （スケルトン前進が「クリーパーに寄る」判定で永遠に退避へ落ちるのを防ぐ）
 */
function pickApproachKeepingCreeperDistance(
  blocks: Set<string>,
  bot: SimPoint,
  primary: SimPoint,
  creeper: SimPoint,
  soft: number,
  flankSign: 1 | -1
): SimPoint {
  const toPrimary = threatBearingRad(bot, primary);
  const awayCreeper = threatBearingRad(creeper, bot);
  const startPrimary = combatDistance(bot, primary);
  const startCr = combatDistance(bot, creeper);
  const direct = pickCombatApproachPoint(blocks, bot, primary, flankSign);
  const relativeOffsets = [
    0,
    flankSign * 0.45,
    -flankSign * 0.45,
    flankSign * 0.9,
    -flankSign * 0.9,
    flankSign * Math.PI / 2,
    -flankSign * Math.PI / 2,
    flankSign * 1.8,
    -flankSign * 1.8
  ];
  const absoluteBearings = [
    awayCreeper + flankSign * Math.PI / 2,
    awayCreeper - flankSign * Math.PI / 2,
    awayCreeper + flankSign * 1.2,
    awayCreeper - flankSign * 1.2,
    awayCreeper + flankSign * 2.2,
    awayCreeper - flankSign * 2.2
  ];
  let best: SimPoint | null = null;
  let bestScore = -1e9;
  const consider = (bearing: number, amount: number, penalty: number) => {
    const probe = pointAt(bot, bearing, amount);
    const y = standingY(blocks, probe.x, probe.z, bot.y + 2);
    if (y < -1) return;
    const target = { x: probe.x, y, z: probe.z };
    if (isOverVoid(blocks, target.x, target.y, target.z)) return;
    const stepped = stepEntity(blocks, bot, target, MOVE_PER_TICK * 1.7);
    const progress = horizontalDistance(bot, stepped);
    if (progress < 0.08) return;
    const nextPrimary = Math.hypot(stepped.x - primary.x, stepped.z - primary.z);
    const nextCr = Math.hypot(stepped.x - creeper.x, stepped.z - creeper.z);
    // 間合いを切り崩す前進は採用しない（振動死の主因）
    if (nextCr < soft - 0.05) return;
    if (nextCr < startCr - 0.12 && nextCr < soft + 0.6) return;
    const score = (startPrimary - nextPrimary) * 3.2
      + (nextCr - Math.min(startCr, soft + 0.4)) * 3.0
      + progress
      - penalty;
    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  };
  // 直接接近も「1歩先」の間合いで判定する
  {
    const stepped = stepEntity(blocks, bot, direct, MOVE_PER_TICK * 1.7);
    const progress = horizontalDistance(bot, stepped);
    const nextCr = Math.hypot(stepped.x - creeper.x, stepped.z - creeper.z);
    const nextPrimary = Math.hypot(stepped.x - primary.x, stepped.z - primary.z);
    if (
      progress >= 0.08
      && nextCr >= soft - 0.05
      && !(nextCr < startCr - 0.12 && nextCr < soft + 0.6)
    ) {
      best = direct;
      bestScore = (startPrimary - nextPrimary) * 3.2
        + (nextCr - Math.min(startCr, soft + 0.4)) * 3.0
        + progress;
    }
  }
  for (const offset of relativeOffsets) consider(toPrimary + offset, 2.6, Math.abs(offset) * 0.15);
  for (const bearing of absoluteBearings) consider(bearing, 2.8, 0.05);
  if (best) return best;
  // どうしても間合いを保てないときはクリーパー外周へ逃して次tickに回る
  return pickCreeperFleePoint(blocks, bot, creeper, 2.4);
}




function pointAt(origin: XZ, bearing: number, amount: number): { x: number; z: number } {
  return { x: origin.x + Math.sin(bearing) * amount, z: origin.z + Math.cos(bearing) * amount };
}

