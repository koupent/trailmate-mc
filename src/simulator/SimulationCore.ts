import {
  chooseStackThreatPosition,
  computeThreatArc,
  generateStrategicThreatPositionCandidates,
  perpendicularDodgeBearing,
  spanDegrees,
  threatBearingRad,
  updateArcNarrowLatchByImprovement,
  type XZ
} from '../combat/threatArc.js';
import {
  describeAttackFan,
  umbraAnchor,
  chooseAttackFanSafePoint,
  chooseRangedSkirtPoint,
  type AttackFanDebug
} from '../combat/attackFanSafeZone.js';
import { decideMixedCombatPlan, isDangerFanPressure } from '../combat/MixedCombatPlan.js';
import {
  extendFocusLatch,
  selectCommittedFocus
} from '../combat/CombatFocus.js';import {
  decideCombatIntent,
  decideCombatMoveKind,
  decideRangedDodgeBurst,
  idleRangedDodgeLatch,
  type RangedDodgeLatch
} from '../combat/CombatIntent.js';
import {
  baselinePresetId,
  classifyEncounterEnemyClass,
  classifyEnemy,
  getPresetParams,
  isRangedEntity,
  type CombatPresetParams
} from '../combat/CombatProfiles.js';
import {
  classifyEncounterSituation,
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
  CREEPER_FLEE_DISTANCE
} from '../combat/creeperTactics.js';
import {
  applyKnockback,
  creeperMustFlee,
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
  intent: ReturnType<typeof decideCombatIntent> | null;
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
const ARC_NARROW_ENOUGH_SPAN_DEG = 55;
const MOVE_PER_TICK = 0.55;
/** 接近移動（直線・旋回）のダッシュ相当倍率。 */
const APPROACH_DASH_MULT = 2.4;
const MELEE_RANGE = 3.5;
/** 肉壁カバー中の近接KB。通常KBだと遮蔽が射手側へ飛び肉壁が壊れる。 */
const COVER_MELEE_KNOCKBACK = 0.28;
const MELEE_STOP_RANGE = 1.25;
/** これ未満は「めり込み」。押し出して近接はLOS無しでも通す。 */
const ENTITY_OVERLAP_RANGE = 0.55;
/**
 * 扇補正を中断してよい接触近接（CORE）。
 * MELEE_RANGE(3.5)や旧2.2は広すぎて、扇が100°超のまま攻撃へ切り替わってしまう。
 */
const MELEE_CONTACT_INTERRUPT_RANGE = MELEE_STOP_RANGE + 0.2;
/** 接近移動の目標間合い（敵中心に飲み込まない）。 */
const MELEE_HOLD_RANGE = 0.95;
const MELEE_HEIGHT_SLACK = 1.5;
/** 盾ガード中の遠距離被弾倍率（CORE: ranged-with-shield）。 */
const SHIELD_RANGED_DAMAGE_FACTOR = 0.25;
const RANGED_MIN_RANGE = 5.5;
const RANGED_MAX_RANGE = 8.5;
const RANGED_PRESSURE_RANGE = 12;
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
  const multiLive = threats.length > 1;
  const creeperEarly = threats.find((enemy) => enemy.kind === 'creeper') ?? null;
  const ignitedCreeper = creeperEarly && isSimCreeperIgnited(creeperEarly) ? creeperEarly : null;
  const contextEarly = {
    enemyClass: classifyEncounterEnemyClass(threats),
    hasShield: state.inventory.includes('shield')
  };
  const params = state.presetParams || getPresetParams(
    state.activePresetId || baselinePresetId(contextEarly)
  );
  // 探索外の固定感触（urgency マージンが主。盾は1体から）。
  const FOCUS_STICKY_MS = 900;
  const GUARD_RANGED_THREAT_THRESHOLD = 1;
  // 主対象コミット: sticky + urgency マージン。遠距離専用 sticky は使わない。
  const focusPick = selectCommittedFocus({
    bot: state.bot,
    threats: threats.map((enemy) => ({
      id: enemy.id,
      x: enemy.x,
      z: enemy.z,
      kind: enemy.kind,
      hp: enemy.hp
    })),
    stickyId: state.focusEnemyId,
    now: state.now,
    stickyMs: FOCUS_STICKY_MS,
    hardOverrideId: ignitedCreeper?.id ?? null
  });
  state.focusEnemyId = focusPick.focusEnemyId;
  state.focusUntil = focusPick.focusUntil;
  const primaryFromFocus = focusPick.primary
    ? threats.find((enemy) => enemy.id === focusPick.primary!.id) ?? null
    : null;
  if (!primaryFromFocus) {
    return makeDecision('follow', null, null, null, null, 'stay', null);
  }
  let primary = primaryFromFocus;

  const threatPositions = threats.map((enemy) => ({
    x: enemy.x,
    y: enemy.y,
    z: enemy.z,
    kind: enemy.kind,
    id: enemy.id
  }));
  const arc = computeThreatArc(state.bot, threatPositions);
  const context = contextEarly;
  const noteFocus = (enemy: SimEnemy) => {
    const latch = extendFocusLatch(state.now, FOCUS_STICKY_MS, enemy.id);
    state.focusEnemyId = latch.focusEnemyId;
    state.focusUntil = latch.focusUntil;
  };
  const creeper = creeperEarly;
  const creeperDist = creeper ? combatDistance(state.bot, creeper) : Infinity;
  // 爆発クラス探索対象（下限クリップ）。箱庭↔本番の間合い差を吸収する
  const creeperSoft = Math.max(3.2, params.creeperSoftEvadeRange);
  // 危険帯はソフト間合いよりわずかに内側（外側だと前進と退避が振動する）
  const creeperDangerRange = Math.max(2.8, creeperSoft - 0.25);
  // 扇重ねは学習用 enter/exit 角に依存しない（決定論ラッチ）
  // 扇重ねのオービット対象を sticky に固定（ウロウロ切替防止）
  const stickyOrbitIndex = (() => {
    if (state.orbitEnemyId == null) return null;
    const index = threats.findIndex((enemy) => enemy.id === state.orbitEnemyId);
    return index >= 0 ? index : null;
  })();
  // ラッチ中は微小改善でも寄せ続ける（途中で moved=false になって戦闘へ戻さない）
  const positioningMinDist = creeper ? creeperSoft : 1.8;
  const candidates = threats.length >= 2
    ? generateStrategicThreatPositionCandidates(
      state.bot,
      threatPositions,
      2.25,
      positioningMinDist
    ).filter((candidate) => !isPathBlocked3D(blocks, state.bot, candidate))
    : [];
  // 決定論: 攻撃扇の非露出＋扇最小化。学習扇角・効用重みには依存しない。
  const skirtSide = state.approachFlankSign
    ?? ((threats[0]?.id ?? 0) % 2 === 0 ? 1 : -1);
  state.approachFlankSign = skirtSide;
  const selection = chooseStackThreatPosition(state.bot, threatPositions, {
    candidates,
    minEnemyDistance: positioningMinDist,
    dangerWeight: creeper ? 1.35 : undefined,
    ownerPos: state.owner,
    maxOwnerDistance: 8,
    stickyNearestIndex: stickyOrbitIndex,
    stickySafePoint: state.positioningGoal || null,
    skirtSide,
    skirtMode: 'advance',
    minimumImprovement: state.arcNarrowLatched
      ? 0
      : (2 * Math.PI) / 180,
    isTerrainBlocked: (from, to) => {
      const shooter = {
        x: from.x,
        y: from.y ?? 1,
        z: from.z,
        id: from.id ?? -999
      };
      const aim = {
        x: to.x,
        y: to.y ?? state.bot.y,
        z: to.z
      };
      // 地形のみ（他敵遮蔽は attackFan 側）。矢の着弾と同じボクセル感覚。
      return resolveRangedImpact(shooter, aim, [], blocks).hitKind === 'block';
    }
  });
  if (selection.nearestIndex >= 0 && selection.nearestIndex < threats.length) {
    const nextOrbitId = threats[selection.nearestIndex].id;
    const currentOrbit = state.orbitEnemyId != null
      ? threats.find((enemy) => enemy.id === state.orbitEnemyId)
      : null;
    // 扇ラッチ中は近接オービットを維持（遠距離側へ吸い寄せて原則を壊さない）
    const keepMeleeOrbit = Boolean(
      state.arcNarrowLatched
      && currentOrbit
      && classifyEnemy(currentOrbit.kind) !== 'ranged'
      && threats.some((enemy) => enemy.id === currentOrbit.id)
    );
    state.orbitEnemyId = keepMeleeOrbit ? currentOrbit!.id : nextOrbitId;
  } else {
    state.orbitEnemyId = null;
  }
  const pursuingGoal = Boolean(
    state.positioningGoal
    && Math.hypot(
      state.bot.x - state.positioningGoal.x,
      state.bot.z - state.positioningGoal.z
    ) > 0.9
  );
  const stackIncomplete = threats.length >= 2
    && Boolean(arc)
    && selection.chosen.spanRad + 0.12 < arc.spanRad;
  state.arcNarrowLatched = updateArcNarrowLatchByImprovement({
    latched: Boolean(state.arcNarrowLatched),
    threatCount: threats.length,
    selectionMoved: selection.moved || stackIncomplete,
    pursuingGoal: (Boolean(state.arcNarrowLatched) && pursuingGoal) || stackIncomplete
  });
  // 扇重ね中はオービット対象を主対象に固定（途中で別敵へ切替えてウロウロしない）
  if (state.orbitEnemyId != null && threats.length >= 2) {
    const orbitEnemy = threats.find((enemy) => enemy.id === state.orbitEnemyId);
    if (orbitEnemy) {
      primary = orbitEnemy;
      const latch = extendFocusLatch(state.now, FOCUS_STICKY_MS, orbitEnemy.id);
      state.focusEnemyId = latch.focusEnemyId;
      state.focusUntil = latch.focusUntil;
    }
  }
  const rangedCount = countRangedPressure(state, blocks);
  // 遠距離敵がいなくなったら回避ラッチを捨て、単独クリーパー処理へ戻す
  if (rangedCount === 0 && !threats.some((enemy) => classifyEnemy(enemy.kind) === 'ranged')) {
    state.dodgeLatch = idleRangedDodgeLatch();
  }
  const primaryDistance = combatDistance(state.bot, primary);
  const overlapping = primaryDistance < ENTITY_OVERLAP_RANGE;
  const meleeAlly = threats.find((enemy) => classifyEnemy(enemy.kind) !== 'ranged'
    && classifyEnemy(enemy.kind) !== 'explosive') ?? null;
  const rangedThreat = threats.find((enemy) => classifyEnemy(enemy.kind) === 'ranged') ?? null;
  /** 射手→近接遮蔽の影（表示・保持用）。 */
  const meatWallHold = (meleeAlly && rangedThreat)
    ? umbraAnchor(rangedThreat, meleeAlly, 1.55)
    : null;
  /** 矢が他敵／壁に吸われるなら肉壁／壁影中。 */
  const inRangedCover = Boolean(rangedThreat) && (
    (selection.rangedExposedCount ?? 0) === 0
    || resolveRangedImpact(rangedThreat, state.bot, state.enemies, blocks).hitKind !== 'bot'
  );
  // 遮蔽役がいない／遠距離がいないなら錨は即破棄（ゾンビ撃破後のあさって緑箱を残さない）
  if (!meleeAlly || !rangedThreat) {
    state.coverAnchor = null;
    state.coverBreakTicks = 0;
  } else if (inRangedCover) {
    state.coverBreakTicks = 0;
    if (meatWallHold) {
      state.coverAnchor = { x: meatWallHold.x, z: meatWallHold.z };
    }
  } else if (state.coverAnchor) {
    state.coverBreakTicks = (state.coverBreakTicks || 0) + 1;
    if (state.coverBreakTicks >= 3) {
      state.coverAnchor = null;
      state.coverBreakTicks = 0;
    }
  } else {
    state.coverBreakTicks = 0;
  }
  const coverHold = state.coverAnchor || (inRangedCover ? meatWallHold : null);
  const holdingCover = Boolean(meleeAlly && rangedThreat && (state.coverAnchor || inRangedCover));
  const situation = classifyEncounterSituation(threats);
  const utilityWeights = state.utilityWeights
    || mergeUtilityWeights(situation.id, null);
  // 決定論位置取りが主経路。効用候補の総当りは毎tick重いので現在地スコアのみUI用に残す。
  let utilityEval: UtilityScore | null = threats.length >= 2
    ? scoreUtilityCandidate({
      bot: state.bot,
      candidate: { x: state.bot.x, z: state.bot.z },
      threats: threats.map((enemy) => ({ x: enemy.x, z: enemy.z, kind: enemy.kind })),
      focus: meleeAlly || primary,
      weights: utilityWeights
    })
    : null;
  const soleCreeper = Boolean(creeper) && !multiLive;
  const creeperStrikeLos = Boolean(
    creeper
    && (
      combatDistance(state.bot, creeper) < ENTITY_OVERLAP_RANGE
      || hasVoxelLineOfSight(blocks, state.bot, creeper)
    )
  );
  const canStrikeCreeper = Boolean(
    creeper
    && combatDistance(state.bot, creeper) <= MELEE_RANGE
    && Math.abs(state.bot.y - creeper.y) <= MELEE_HEIGHT_SLACK
    && creeperStrikeLos
    && !isStunned(state.now, state.botStunUntil)
  );
  // 着火中かつ殴れないときだけ強制退避。
  // 未着火は「近い敵」として殴りに行く（混成で逃げ回って矢死するのを防ぐ）。
  const explosiveImmediateDanger = creeperMustFlee({
    creeper,
    canMeleeStrike: canStrikeCreeper,
    distance: creeperDist,
    fleeDistance: Math.max(CREEPER_FLEE_DISTANCE, creeperDangerRange + 0.4)
  });
  const intent = decideCombatIntent({
    distanceToPrimary: primaryDistance,
    meleeAttackRange: MELEE_RANGE,
    rangedThreatCount: rangedCount,
    hasShield: state.inventory.includes('shield'),
    guardRangedThreatThreshold: GUARD_RANGED_THREAT_THRESHOLD,
    explosiveImmediateDanger
  });
  const rangedBearing = rangedCount > 0
    ? (arc?.midRad ?? threatBearingRad(state.bot, primary))
    : null;
  const dodge = decideRangedDodgeBurst({
    now: state.now,
    underRangedPressure: rangedBearing != null,
    distanceToPrimary: primaryDistance,
    meleeAttackRange: MELEE_RANGE,
    latch: state.dodgeLatch,
    lastDamageAt: state.lastDamageAt,
    hasShield: state.inventory.includes('shield'),
    // クリーパーが安全距離なら低HPカイトを解除しスケルトンへ詰める
    botHp: (creeper && creeperDist >= creeperSoft)
      ? Math.max(state.bot.hp, 11)
      : state.bot.hp,
    burstMs: params.rangedDodgeBurstMs,
    advanceMs: params.rangedDodgeReassessMs
  });
  state.dodgeLatch = dodge.latch;

  const hasStrikeLos = overlapping
    || hasVoxelLineOfSight(blocks, state.bot, primary);
  const botStunned = isStunned(state.now, state.botStunUntil);
  const canMeleeAttack = !botStunned
    && primaryDistance <= MELEE_RANGE
    && Math.abs(state.bot.y - primary.y) <= MELEE_HEIGHT_SLACK
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
    const distance = combatDistance(state.bot, enemy);
    if (distance < ENTITY_OVERLAP_RANGE) return true;
    return distance <= MELEE_CONTACT_INTERRUPT_RANGE
      && hasVoxelLineOfSight(blocks, state.bot, enemy);
  });
  const underMixedRanged = threats.length >= 2 && rangedCount > 0;
  // 端で詰まった／クリーパーが十分離れたら扇を外してスケルトンへ詰める
  const approachStuck = (state.approachStuckTicks || 0) >= 2;
  const meleeAllyDistance = meleeAlly ? combatDistance(state.bot, meleeAlly) : Infinity;
  const spanDegNow = arc ? spanDegrees(arc.spanRad) : null;
  const pureRangedMulti = threats.length >= 2
    && !meleeAlly
    && !creeper
    && threats.every((enemy) => classifyEnemy(enemy.kind) === 'ranged');
  const arcNarrowEnough = spanDegNow != null
    && spanDegNow <= ARC_NARROW_ENOUGH_SPAN_DEG + 8;
  const nearArenaEdge = Math.max(Math.abs(state.bot.x), Math.abs(state.bot.z)) >= 9.2;
  // 肉壁に入れたあと（扇が閉じたとき）だけ狭窄を外して近接処理へ。
  // 扇が広いのにカバー扱いして一直線殴りに戻さない。
  if (holdingCover && meleeAlly && arcNarrowEnough) {
    state.arcNarrowLatched = false;
    state.positioningGoal = null;
  }
  // 純遠距離複数: 扇が十分狭い／端詰まり／HP低下なら扇を外して1体へコミット
  // （逃げ回りで扇が閉じず、一度も殴れずに死ぬのを防ぐ）
  if (
    pureRangedMulti
    && (
      approachStuck
      || arcNarrowEnough
      || (nearArenaEdge && approachStuck)
      || state.bot.hp <= 16
    )
  ) {
    state.arcNarrowLatched = false;
    state.positioningGoal = null;
  } else if (
    (
      (creeper && creeperDist >= creeperSoft + 0.4 && classifyEnemy(primary.kind) === 'ranged')
      || (!creeper && !meleeAlly && threats.length === 1 && classifyEnemy(primary.kind) === 'ranged')
    )
    && (approachStuck || primaryDistance > MELEE_RANGE * 1.4)
  ) {
    state.arcNarrowLatched = false;
    state.positioningGoal = null;
  } else if (
    // 近接盾なしでクリーパー危険帯にいる扇は捨て、回避／スケルトン処理へ
    creeper
    && !meleeAlly
    && rangedThreat
    && creeperDist < creeperSoft + 0.15
  ) {
    state.arcNarrowLatched = false;
    state.positioningGoal = null;
  } else if (
    // 爆発混成で端へ逃げ切ったら扇を捨てて近接／処理へ戻す
    Boolean(creeper)
    && threats.length >= 2
    && nearArenaEdge
    && (approachStuck || state.bot.hp <= 14)
  ) {
    state.arcNarrowLatched = false;
    state.positioningGoal = null;
  }
  // CORE: 扇ラッチ中のみ接触でも位置取り継続。ラッチ外の混成は接触で攻撃へ戻してよい。
  const meleeContactInterrupt = rawMeleeContact
    && !state.arcNarrowLatched
    && !explosiveImmediateDanger;
  const forceSkeletonCommit = Boolean(creeper)
    && !meleeAlly
    && classifyEnemy(primary.kind) === 'ranged'
    && !explosiveImmediateDanger
    && creeperDist >= creeperDangerRange;
  // 近接撃破後の単独スケルトンは前進を促す。一歩手前なら低HPでも詰め切る。
  // ※遠距離全般を常時コミットにしない（壁LOS時の回避判定を壊さない）。
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
    && !state.arcNarrowLatched
    && !explosiveImmediateDanger
    && (
      approachStuck
      || arcNarrowEnough
      || (nearArenaEdge && approachStuck)
      || state.bot.hp <= 16
      || primaryDistance <= MELEE_RANGE * 1.75
      || dodge.phase === 'advance'
    );
  // 混成カバーに入ったら扇ラッチ中でも近接を処理（遠ざかり続けない）
  const inMixedMeleeCover = Boolean(
    meleeAlly
    && rangedThreat
    && meleeAllyDistance <= MELEE_RANGE
    && isBehindMeleeCover(state.bot, meleeAlly, rangedThreat)
  );
  const canStrikeMeleeAlly = Boolean(
    meleeAlly && canStrikeSimEnemy(state, blocks, meleeAlly)
  );
  const skirtPreview = rangedThreat
    ? chooseRangedSkirtPoint(state.bot, rangedThreat, {
      side: state.approachFlankSign ?? 1,
      mode: dodge.phase === 'dodge' ? 'dodge' : 'advance'
    })
    : null;
  const rangedLosExposed = Boolean(rangedThreat)
    && resolveRangedImpact(rangedThreat, state.bot, state.enemies, blocks).hitKind === 'bot';
  const rangedExposedCount = (selection.rangedExposedCount ?? 0)
    + (rangedLosExposed && (selection.rangedExposedCount ?? 0) === 0 ? 1 : 0);
  /** 混成・囲まれは位相プランで一本化（種別ifの積み上げではない）。 */
  const mixedPlan = decideMixedCombatPlan({
    situation,
    spanDeg: spanDegNow,
    arcLatched: Boolean(state.arcNarrowLatched),
    selectionMoved: selection.moved || stackIncomplete,
    explosiveImmediateDanger,
    canStrikeFocus: classifyEnemy(primary.kind) === 'explosive'
      ? canStrikeCreeper
      : canStrikeSimEnemy(state, blocks, primary),
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
    approachGoal: primary
      ? {
        x: primary.x - Math.sin(threatBearingRad(state.bot, primary)) * 1.2,
        z: primary.z - Math.cos(threatBearingRad(state.bot, primary)) * 1.2
      }
      : null
  });
  if (mixedPlan?.releaseArcLatch) {
    state.arcNarrowLatched = false;
    state.positioningGoal = null;
  }
  const forceMixedMeleeFinish = mixedPlan
    ? (mixedPlan.phase === 'finish-cover' && canStrikeMeleeAlly)
    : (
      underMixedRanged
      && Boolean(meleeAlly)
      && !explosiveImmediateDanger
      && !state.arcNarrowLatched
      && (
        inMixedMeleeCover
        || (approachStuck && meleeAllyDistance <= MELEE_RANGE)
        || meleeAllyDistance <= MELEE_CONTACT_INTERRUPT_RANGE
        || (state.bot.hp <= 12 && meleeAllyDistance <= MELEE_RANGE * 1.6)
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
      nearArenaEdge
      || approachStuck
      || state.bot.hp <= 14
    );
  if (forceExplosiveCrowdCommit) {
    state.arcNarrowLatched = false;
    state.positioningGoal = null;
  }
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
      && (Boolean(state.arcNarrowLatched) || selection.moved)
    );
  if (!multiThreatReposition) {
    state.positioningGoal = null;
  }
  const moveKindRaw = decideCombatMoveKind({
    intent,
    dodgePhase: dodge.phase,
    canMeleeAttack: multiThreatReposition ? false : canMeleeAttack,
    multiThreatReposition,
    meleeContactInterrupt,
    explosiveImmediateDanger
  });
  // クリーパー安全時のみ回避を前進へ上書き。単独遠距離は dodge を残す。
  let moveKind = (
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
    const finishDist = combatDistance(state.bot, finishTarget);
    moveKind = (
      finishDist <= MELEE_RANGE
      && canStrikeSimEnemy(state, blocks, finishTarget)
      && (
        classifyEnemy(finishTarget.kind) !== 'explosive'
        || isSimCreeperIgnited(finishTarget)
      )
    ) ? 'attack' : 'advance';
  }
  // 盾ありの遠距離複数コミットはガード前進を維持（位置取りへ戻さない）
  if (
    forceRangedMultiCommit
    && state.inventory.includes('shield')
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
  if (soleCreeper && !explosiveImmediateDanger && !isSimCreeperIgnited(creeper)) {
    if (canMeleeAttack) moveKind = 'attack';
    else if (moveKind === 'dodge' || moveKind === 'hold' || moveKind === 'positioning') moveKind = 'advance';
  }

  const strikeDamage = (rangedCount > 0 || underMixedRanged || soleCreeper) ? 8 : 4;
  const strikeKnockback = holdingCover ? COVER_MELEE_KNOCKBACK : MELEE_KNOCKBACK;
  /** 遠距離の移動目標＝緑箱。混成プランの goal を最優先。 */
  const rangedMoveGoal = (() => {
    if (mixedPlan?.goal) return mixedPlan.goal;
    if (holdingCover && (meatWallHold || coverHold)) {
      return meatWallHold || coverHold;
    }
    if (!rangedThreat) return selection.safePoint || null;
    const side = state.approachFlankSign ?? 1;
    if (meleeAlly) {
      const live = chooseAttackFanSafePoint(state.bot, threatPositions, {
        skirtSide: side,
        skirtMode: moveKind === 'dodge' ? 'dodge' : 'advance',
        stickySafePoint: state.positioningGoal || selection.safePoint || null,
        ownerPos: state.owner,
        maxOwnerDistance: 8,
        isTerrainBlocked: (from, to) => resolveRangedImpact(
          { x: from.x, y: from.y ?? 1, z: from.z, id: from.id ?? -999 },
          { x: to.x, y: to.y ?? state.bot.y, z: to.z },
          [],
          blocks
        ).hitKind === 'block'
      });
      return live?.safePoint ?? selection.safePoint ?? null;
    }
    return chooseRangedSkirtPoint(state.bot, rangedThreat, {
      side,
      mode: moveKind === 'dodge' ? 'dodge' : 'advance'
    });
  })();
  let destination: SimPoint | null = null;
  let movement: SimulationDecision['movement'] = 'stay';
  let directFlee = false;
  let preciseStep = false;
  let routePreview: SimulationDecision['routePreview'] = null;
  let safeZoneDebug: SimulationDecision['safeZoneDebug'] = null;
  const mixedCoverPoint = (meleeAlly && rangedThreat)
    ? pickMixedMeleeCoverPoint(blocks, state.bot, meleeAlly, rangedThreat)
    : null;
  /** 安全点／接近点へは常に直線（壁は navigateToward 側で迂回）。 */
  const setStraightDestination = (goal: { x: number; z: number } | null | undefined) => {
    if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.z)) return;
    destination = {
      x: goal.x,
      y: standingY(blocks, goal.x, goal.z, state.bot.y + 2),
      z: goal.z
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
  };
  // 射程内の打撃対象（sticky最寄り→近接カバー→主対象の順）
  const inRangeStrikeTarget = (() => {
    const candidates: SimEnemy[] = [];
    if (state.orbitEnemyId != null) {
      const orbitEnemy = threats.find((enemy) => enemy.id === state.orbitEnemyId);
      if (orbitEnemy) candidates.push(orbitEnemy);
    }
    if (meleeAlly) candidates.push(meleeAlly);
    candidates.push(primary);
    for (const enemy of threats) {
      if (!candidates.some((item) => item.id === enemy.id)) candidates.push(enemy);
    }
    for (const enemy of candidates) {
      if (
        classifyEnemy(enemy.kind) === 'explosive'
        && !isSimCreeperIgnited(enemy)
      ) {
        continue;
      }
      if (canStrikeSimEnemy(state, blocks, enemy)) return enemy;
    }
    return null;
  })();
  // 位置取り中でも射程内なら殴る（移動と並行。膠着で攻撃頻度が落ちないように毎tick）
  const positioningStrikeTarget = inRangeStrikeTarget;
  if (moveKind === 'attack' || (overlapping && canMeleeAttack)) {
    if (!(canMeleeAttack || overlapping)) {
      // 攻撃種別でも射程外なら接近に落とす
      movement = 'advance';
      const approachTarget = ((forceMixedMeleeFinish || forceExplosiveCrowdCommit) && meleeAlly)
        ? meleeAlly
        : primary;
      const flank = state.approachFlankSign
        ?? ((approachTarget.id + state.tick) % 2 === 0 ? 1 : -1);
      state.approachFlankSign = flank;
      setStraightDestination(pickCombatApproachPoint(blocks, state.bot, approachTarget, flank));
    } else {
    movement = 'attack';
    const attackTarget = ((forceMixedMeleeFinish || forceExplosiveCrowdCommit) && meleeAlly
      && canStrikeSimEnemy(state, blocks, meleeAlly))
      ? meleeAlly
      : primary;
    strikeEnemy(state, blocks, attackTarget, strikeDamage, strikeKnockback);
    noteFocus(attackTarget);
    // めり込み中は攻撃しつつ軽く離す（同座標スタック解消）
    if (overlapping) {
      const away = threatBearingRad(primary, state.bot);
      const push = pointAt(state.bot, Number.isFinite(away) ? away : state.tick * 0.7, 0.7);
      setStraightDestination(push);
    }
    // 遠距離がいるだけの「攻撃中横歩き」はしない。
    // 毎tick 1m 目的地を置くと被弾なしでもノックバックに見える（カメラ固定で顕著）。
    // 矢避けは dodge 位相／被弾時 weave に任せる。
    }
  } else if (moveKind === 'positioning') {
    let chosen = state.positioningGoal;
    const spanStillWide = spanDegNow != null && spanDegNow > 55;
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
      state.positioningGoal = { x: orbitPoint.x, z: orbitPoint.z };
    } else if (pursuingGoal && state.positioningGoal && attackFanSafe) {
      chosen = attackFanSafe;
      // sticky: 目標は大きく変わったときだけ更新
      const jump = Math.hypot(
        state.positioningGoal.x - attackFanSafe.x,
        state.positioningGoal.z - attackFanSafe.z
      );
      if (jump > 1.25 || (selection.rangedExposedCount ?? 0) > 0) {
        state.positioningGoal = { x: attackFanSafe.x, z: attackFanSafe.z };
        chosen = attackFanSafe;
      } else {
        chosen = state.positioningGoal;
      }
    } else if (attackFanSafe) {
      chosen = attackFanSafe;
      state.positioningGoal = { x: attackFanSafe.x, z: attackFanSafe.z };
    } else if (orbitPoint) {
      chosen = orbitPoint;
      state.positioningGoal = { x: orbitPoint.x, z: orbitPoint.z };
    } else if (
      mixedCoverPoint
      && rangedThreat
      && (selection.rangedExposedCount ?? 0) > 0
      && (
        !state.arcNarrowLatched
        || inMixedMeleeCover
      )
    ) {
      chosen = mixedCoverPoint;
      state.positioningGoal = mixedCoverPoint;
    } else if (underMixedRanged && creeper && rangedThreat) {
      const away = threatBearingRad(creeper, state.bot);
      const toRanged = threatBearingRad(state.bot, rangedThreat);
      const side = perpendicularDodgeBearing(toRanged, 1);
      const blend = Number.isFinite(away) ? (away * 0.7 + side * 0.3) : side;
      const safe = pointAt(state.bot, blend, 2.4);
      if (!isPathBlocked3D(blocks, state.bot, safe)) {
        chosen = safe;
        state.positioningGoal = safe;
      }
    }
    if (!chosen && (selection.rangedExposedCount ?? 0) > 0 && arc) {
      const open = pointAt(state.bot, arc.openRad, 2.5);
      chosen = { x: open.x, z: open.z };
    }
    if (creeper && chosen && explosiveImmediateDanger) {
      const nextDist = Math.hypot(chosen.x - creeper.x, chosen.z - creeper.z);
      if (nextDist + 0.15 < creeperDist || nextDist < creeperSoft) {
        chosen = pickCreeperFleePoint(blocks, state.bot, creeper, 2.6);
        directFlee = true;
      }
    }
    if (attackFanSafe && !directFlee && !spanStillWide) {
      state.positioningGoal = { x: attackFanSafe.x, z: attackFanSafe.z };
    }
    // すでに非露出／肉壁中なら位置取り目標を捨てて影軸上で殴る
    if (holdingCover && rangedThreat && !directFlee && !spanStillWide) {
      state.positioningGoal = null;
      chosen = (!canStrikeSimEnemy(state, blocks, meleeAlly || primary) && (meatWallHold || coverHold))
        ? (meatWallHold || coverHold)
        : null;
    }
    if (chosen) {
      setStraightDestination(chosen);
    }
    // 被弾時のみ軽く横へ（直線目標は維持）
    if (
      rangedBearing != null
      && state.lastDamageAt >= state.now - state.tickMs
      && destination
      && !directFlee
      && !holdingCover
      && !mixedCoverPoint
    ) {
      const weave = pointAt(
        state.bot,
        perpendicularDodgeBearing(rangedBearing, state.tick % 2 === 0 ? 1 : -1),
        1.4
      );
      setStraightDestination({
        x: (destination.x + weave.x) * 0.5,
        z: (destination.z + weave.z) * 0.5
      });
    }
    movement = 'positioning';
    // CORE: 扇ラッチ中も移動を止めず殴る。
    if (positioningStrikeTarget) {
      strikeEnemy(state, blocks, positioningStrikeTarget, strikeDamage, strikeKnockback);
      noteFocus(positioningStrikeTarget);
    }
  } else if (moveKind === 'dodge') {
    if (creeper && explosiveImmediateDanger) {
      setStraightDestination(pickCreeperFleePoint(blocks, state.bot, creeper, 2.8));
      directFlee = true;
    } else if (rangedMoveGoal) {
      setStraightDestination(rangedMoveGoal);
    } else if (mixedCoverPoint && meleeAlly) {
      setStraightDestination(mixedCoverPoint);
    } else if (rangedBearing != null) {
      const point = pointAt(state.bot, perpendicularDodgeBearing(rangedBearing, 1), 2);
      setStraightDestination(point);
    }
    movement = 'dodge';
  } else if (overlapping) {
    // 攻撃できないめり込み（例: クリーパー）は押し出しのみ
    const away = threatBearingRad(primary, state.bot);
    const push = pointAt(state.bot, Number.isFinite(away) ? away : 0, 0.8);
    setStraightDestination(push);
    movement = 'advance';
    if (classifyEnemy(primary.kind) === 'explosive') directFlee = true;
  } else if (primaryDistance <= MELEE_HOLD_RANGE && canMeleeAttack
    && (
      classifyEnemy(primary.kind) !== 'explosive'
      || isSimCreeperIgnited(primary)
    )) {
    movement = 'attack';
    strikeEnemy(state, blocks, primary, strikeDamage, strikeKnockback);
    noteFocus(primary);
  } else if (
    forceMixedMeleeFinish
    && meleeAlly
    && canStrikeSimEnemy(state, blocks, meleeAlly)
  ) {
    movement = 'attack';
    strikeEnemy(state, blocks, meleeAlly, strikeDamage, strikeKnockback);
    // 攻撃中の遠距離横歩きは置かない（被弾なしノックバック見た目の原因）
  } else if (primaryDistance <= MELEE_HOLD_RANGE) {
    if (holdingCover && meleeAlly) {
      if (canStrikeSimEnemy(state, blocks, meleeAlly)) {
        movement = 'attack';
        strikeEnemy(state, blocks, meleeAlly, strikeDamage, strikeKnockback);
      } else if (meatWallHold || coverHold) {
        setStraightDestination(meatWallHold || coverHold);
        movement = 'advance';
      }
    } else {
      const side = perpendicularDodgeBearing(threatBearingRad(state.bot, primary), 1);
      const point = pointAt(state.bot, side, 0.9);
      setStraightDestination(point);
      movement = 'advance';
    }
    if (
      creeper
      && explosiveImmediateDanger
      && moveKind === 'advance'
      && !forceCommit
    ) {
      setStraightDestination(pickCreeperFleePoint(blocks, state.bot, creeper, 2.6));
      movement = 'dodge';
      directFlee = true;
    }
  } else {
    // 敵へ直線接近。肉壁カバー中は固定錨へだけ寄せる。
    const approachPrimary = ((forceMixedMeleeFinish || forceExplosiveCrowdCommit) && meleeAlly)
      ? meleeAlly
      : primary;
    if (holdingCover && meleeAlly && coverHold) {
      if (canStrikeSimEnemy(state, blocks, meleeAlly)) {
        movement = 'attack';
        strikeEnemy(state, blocks, meleeAlly, strikeDamage, strikeKnockback);
      } else {
        // 影軸の現在 umbra へ直線。横ずれ候補は使わない。
        setStraightDestination(meatWallHold || coverHold);
        movement = 'advance';
      }
    } else if (rangedThreat && rangedMoveGoal && !forceExplosiveCrowdCommit) {
      // 遠距離: 斜め接近点へ（真正面の destVsEnemy=0 を禁止）
      setStraightDestination(rangedMoveGoal);
      movement = 'advance';
    } else {
      const flank = state.approachFlankSign
        ?? ((approachPrimary.id + state.tick) % 2 === 0 ? 1 : -1);
      state.approachFlankSign = flank;
      let approach = (
        creeper
        && !soleCreeper
        && !forceSkeletonCommit
        && creeperDist < creeperSoft + 1.0
      )
        ? pickApproachKeepingCreeperDistance(
          blocks,
          state.bot,
          approachPrimary,
          creeper,
          forceSkeletonCommit ? creeperSoft + 0.85 : creeperSoft,
          flank
        )
        : pickCombatApproachPoint(blocks, state.bot, approachPrimary, flank);
      if (
        creeper
        && approach
        && explosiveImmediateDanger
        && !forceCommit
        && !soleCreeper
      ) {
        const nextDist = Math.hypot(approach.x - creeper.x, approach.z - creeper.z);
        if (nextDist + 0.2 < creeperDist || nextDist < creeperDangerRange) {
          approach = pickCreeperFleePoint(blocks, state.bot, creeper, 2.6);
          directFlee = true;
          movement = 'dodge';
        }
      }
      setStraightDestination(approach);
      if (!directFlee) {
        movement = moveKind === 'dodge' ? 'dodge' : 'advance';
      }
    }
    if (forceCommit && !directFlee) {
      preciseStep = true;
    }
    if (
      forceCommit
      && !directFlee
      && !holdingCover
      && destination
      && rangedBearing != null
      && state.lastDamageAt >= state.now - state.tickMs
      && state.bot.hp > 4
    ) {
      const weave = pointAt(
        state.bot,
        perpendicularDodgeBearing(rangedBearing, state.tick % 2 === 0 ? 1 : -1),
        1.1
      );
      setStraightDestination({
        x: destination.x * 0.7 + weave.x * 0.3,
        z: destination.z * 0.7 + weave.z * 0.3
      });
    }
    if (soleCreeper && movement === 'advance') {
      preciseStep = true;
    }
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
        const escapeGoal = destination || meatWallHold || (inRangedCover ? meleeAlly : null) || primary;
        const detour = escapeGoal
          ? findDetourWaypoint(blocks, state.bot, escapeGoal, state.approachFlankSign)
          : null;
        if (detour) {
          const slide = stepEntity(
            blocks,
            state.bot,
            { x: detour.x, y: standingY(blocks, detour.x, detour.z, state.bot.y + 2), z: detour.z },
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
      canStrikeFocus: Boolean(positioningStrikeTarget) || canMeleeAttack,
      explosiveDanger: explosiveImmediateDanger
    });
  if (!utilityEval && threats.length >= 2) {
    utilityEval = scoreUtilityCandidate({
      bot: state.bot,
      candidate: { x: state.bot.x, z: state.bot.z },
      threats: threats.map((enemy) => ({ x: enemy.x, z: enemy.z, kind: enemy.kind })),
      focus: meleeAlly || primary,
      weights: utilityWeights
    });
  }
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
  intent: ReturnType<typeof decideCombatIntent> | null
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
  const threshold = state.presetParams?.guardRangedThreatThreshold ?? 1;
  return countRangedPressure(state, blocks) >= Math.max(1, threshold);
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

function isBehindMeleeCover(
  bot: XZ,
  meleeAlly: XZ,
  rangedThreat: XZ
): boolean {
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
function pickMixedMeleeCoverPoint(
  blocks: Set<string>,
  bot: SimPoint,
  meleeAlly: SimPoint,
  rangedThreat: SimPoint
): { x: number; z: number } | null {
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
  let best: { x: number; z: number } | null = null;
  let bestScore = -Infinity;
  for (const cover of candidates) {
    if (isPathBlocked3D(blocks, bot, cover) && allyDist > 2.8) continue;
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

function canStrikeSimEnemy(
  state: SimulationState,
  blocks: Set<string>,
  enemy: SimEnemy
): boolean {
  if (isStunned(state.now, state.botStunUntil)) return false;
  const distance = combatDistance(state.bot, enemy);
  if (distance > MELEE_RANGE) return false;
  if (Math.abs(state.bot.y - enemy.y) > MELEE_HEIGHT_SLACK) return false;
  if (distance < ENTITY_OVERLAP_RANGE) return true;
  return hasVoxelLineOfSight(blocks, state.bot, enemy);
}

function pointAt(origin: XZ, bearing: number, amount: number): { x: number; z: number } {
  return { x: origin.x + Math.sin(bearing) * amount, z: origin.z + Math.cos(bearing) * amount };
}

function combatDistance(a: SimPoint, b: SimPoint): number {
  // 脅威弧・意図は水平距離。高さ差が大きい近接は距離3Dで少し伸ばす。
  const horizontal = horizontalDistance(a, b);
  const dy = Math.abs(a.y - b.y);
  if (dy <= MELEE_HEIGHT_SLACK) return horizontal;
  return distance3(a, b);
}
