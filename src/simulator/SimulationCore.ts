import {
  chooseBestThreatPosition,
  computeThreatArc,
  generateStrategicThreatPositionCandidates,
  perpendicularDodgeBearing,
  spanDegrees,
  threatBearingRad,
  type XZ
} from '../combat/threatArc.js';
import {
  decideCombatIntent,
  decideRangedDodgeBurst,
  idleRangedDodgeLatch,
  type RangedDodgeLatch
} from '../combat/CombatIntent.js';
import {
  baselinePresetId,
  classifyEnemy,
  getPresetParams,
  isRangedEntity
} from '../combat/CombatProfiles.js';
import { selectControlOwner } from '../companion/ControlPriority.js';
import {
  createDeathRecoveryState,
  observeRecoveryItemCollection,
  requestRecoveryItemCollection,
  trackRecoveryItem
} from '../companion/deathRecovery.js';

export type SimPoint = { x: number; z: number };
export type SimEnemy = SimPoint & { id: number; kind: string; hp: number; lastShotTick?: number };
export type SimDrop = SimPoint & { id: number; item: string; graveOwned?: boolean };
export type SimObstacle = SimPoint & { id: number; size: number };
export type EnemyBehavior = 'chase' | 'retreat' | 'strafe' | 'hold';
export type EnemyMotion = {
  id: number;
  behavior: EnemyBehavior;
  speed: number;
  from: SimPoint;
  to: SimPoint;
  fired: boolean;
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
  enemyAi: EnemyAiConfig;
  transitions: string[];
  lastOwner: string;
  expectations?: SimExpectation;
};

export type SimulationDecision = {
  controlOwner: string;
  primaryId: number | null;
  spanDeg: number | null;
  selectedSpanDeg: number | null;
  destination: SimPoint | null;
  movement: 'stay' | 'positioning' | 'dodge' | 'advance' | 'attack' | 'recovery' | 'survival';
  intent: ReturnType<typeof decideCombatIntent> | null;
  enemyMotions: EnemyMotion[];
  rangedPressureCount: number;
  recovery: {
    phase: string;
    ownedIds: number[];
    remainingIds: number[];
    captureRemainingMs: number;
    deadlineRemainingMs: number;
  } | null;
  validation: Array<{ field: string; expected: unknown; actual: unknown; pass: boolean }>;
};

const MOVE_PER_TICK = 0.55;
const MELEE_RANGE = 3.5;
const MELEE_STOP_RANGE = 1.25;
const RANGED_MIN_RANGE = 5.5;
const RANGED_MAX_RANGE = 8.5;
const RANGED_PRESSURE_RANGE = 12;
const RANGED_SHOT_INTERVAL_TICKS = 4;

export function createScenario(id: string): SimulationState {
  const base: SimulationState = {
    name: id,
    now: 0,
    tickMs: 250,
    tick: 0,
    bot: { x: 0, z: 0, yaw: 0, hp: 20 },
    owner: { x: -5, z: 0 },
    enemies: [],
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
    enemyAi: { enabled: false, speedScale: 1 },
    transitions: [],
    lastOwner: 'follow'
  };

  if (id === 'single-ranged') {
    base.enemies = [{ id: 1, kind: 'skeleton', x: 7, z: 0, hp: 20 }];
    base.expectations = { owner: 'combat' };
  } else if (id === 'multi-positioning') {
    base.enemies = [
      { id: 1, kind: 'zombie', x: 0, z: 4, hp: 20 },
      { id: 2, kind: 'skeleton', x: 0, z: -4, hp: 20 }
    ];
    base.expectations = { owner: 'combat', maxSpanDeg: 35 };
  } else if (id === 'recovery') {
    base.bot = { x: -7, z: 0, yaw: 0, hp: 16 };
    base.owner = { x: -8, z: -3 };
    base.enemies = [{ id: 1, kind: 'zombie', x: 4, z: 0, hp: 20 }];
    base.grave = { x: 0, z: 0, contents: ['iron_sword', 'iron_boots'] };
    base.inventory = [];
    base.equipped = null;
    base.recovery = {
      ...createDeathRecoveryState(),
      active: true,
      phase: 'travel',
      startedAt: 0,
      deathPos: { x: 0, y: 0, z: 0 }
    };
    base.expectations = { equipped: 'iron_sword' };
  } else if (id === 'dynamic-melee-pincer') {
    base.enemies = [
      { id: 1, kind: 'zombie', x: -7, z: -1, hp: 20 },
      { id: 2, kind: 'spider', x: 7, z: 1, hp: 20 }
    ];
    base.enemyAi.enabled = true;
    base.expectations = { owner: 'combat', maxSpanDeg: 150 };
  } else if (id === 'dynamic-ranged-pressure') {
    base.enemies = [
      { id: 1, kind: 'skeleton', x: -6, z: -5, hp: 20 },
      { id: 2, kind: 'skeleton', x: 6, z: 5, hp: 20 }
    ];
    base.enemyAi.enabled = true;
    base.expectations = { owner: 'combat', intent: 'dodge', maxSpanDeg: 150 };
  } else if (id === 'dynamic-mixed') {
    base.enemies = [
      { id: 1, kind: 'zombie', x: -6.5, z: 0, hp: 24 },
      { id: 2, kind: 'skeleton', x: 6.5, z: 4.5, hp: 20 }
    ];
    base.enemyAi.enabled = true;
    base.expectations = { owner: 'combat', maxSpanDeg: 150 };
  }
  return base;
}

export function listScenarioIds(): string[] {
  return [
    'single-ranged',
    'multi-positioning',
    'recovery',
    'dynamic-melee-pincer',
    'dynamic-ranged-pressure',
    'dynamic-mixed'
  ];
}

export function stepSimulation(input: SimulationState): {
  state: SimulationState;
  decision: SimulationDecision;
} {
  const state = structuredClone(input) as SimulationState;
  state.enemyAi ||= { enabled: false, speedScale: 1 };
  state.shots = state.shots || 0;
  state.now += state.tickMs;
  state.tick += 1;
  state.transitions = [...(state.transitions || [])].slice(-11);
  const enemyMotions = advanceEnemyAi(state);

  const decision = state.recovery?.active
    ? stepRecovery(state)
    : stepCombat(state);
  decision.enemyMotions = enemyMotions;
  decision.rangedPressureCount = countRangedPressure(state);
  if (decision.controlOwner !== state.lastOwner) {
    state.transitions.push(`${state.tick}: ${controlOwnerLabel(state.lastOwner)} → ${controlOwnerLabel(decision.controlOwner)}`);
    state.lastOwner = decision.controlOwner;
  }
  decision.validation = validateExpectations(state, decision);
  return { state, decision };
}

function stepCombat(state: SimulationState): SimulationDecision {
  const threats = state.enemies.filter((enemy) => enemy.hp > 0);
  state.enemies = threats;
  const primary = [...threats].sort((a, b) => distance(state.bot, a) - distance(state.bot, b))[0];
  if (!primary) {
    return makeDecision('follow', null, null, null, null, 'stay', null);
  }

  const threatPositions = threats.map(({ x, z }) => ({ x, z }));
  const arc = computeThreatArc(state.bot, threatPositions);
  const candidates = generateStrategicThreatPositionCandidates(state.bot, threatPositions, 2.25, 1.8)
    .filter((candidate) => !isPathBlocked(state.bot, candidate, state.obstacles));
  const selection = chooseBestThreatPosition(state.bot, threatPositions, {
    candidates,
    minEnemyDistance: 1.8,
    ownerPos: state.owner,
    maxOwnerDistance: 8
  });
  const params = getPresetParams(baselinePresetId({
    enemyClass: classifyEnemy(primary.kind),
    hasShield: state.inventory.includes('shield')
  }));
  const rangedCount = countRangedPressure(state);
  const primaryDistance = distance(state.bot, primary);
  const intent = decideCombatIntent({
    distanceToPrimary: primaryDistance,
    meleeAttackRange: MELEE_RANGE,
    rangedThreatCount: rangedCount,
    hasShield: state.inventory.includes('shield'),
    guardRangedThreatThreshold: params.guardRangedThreatThreshold,
    explosiveImmediateDanger: primary.kind === 'creeper' && primaryDistance < 3
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
    burstMs: params.rangedDodgeBurstMs,
    advanceMs: params.rangedDodgeReassessMs
  });
  state.dodgeLatch = dodge.latch;

  let destination: SimPoint | null = null;
  let movement: SimulationDecision['movement'] = 'stay';
  if (threats.length >= 2 && selection.moved) {
    destination = selection.chosen.position;
    movement = 'positioning';
  } else if (rangedBearing != null && dodge.phase === 'dodge') {
    destination = pointAt(state.bot, perpendicularDodgeBearing(rangedBearing, 1), 2);
    movement = 'dodge';
  } else if (rangedBearing != null && dodge.phase === 'advance') {
    destination = { x: primary.x, z: primary.z };
    movement = 'advance';
  } else if (intent.attack) {
    movement = 'attack';
    primary.hp -= 4;
    state.attacks += 1;
  } else {
    destination = { x: primary.x, z: primary.z };
    movement = 'advance';
  }
  if (destination) state.bot = { ...state.bot, ...moveToward(state.bot, destination, MOVE_PER_TICK) };
  return makeDecision(
    'combat',
    primary.id,
    arc ? spanDegrees(arc.spanRad) : null,
    threats.length >= 2 ? spanDegrees(selection.chosen.spanRad) : null,
    destination,
    movement,
    intent
  );
}

function stepRecovery(state: SimulationState): SimulationDecision {
  const recovery = state.recovery;
  const nearest = [...state.enemies].sort((a, b) => distance(state.bot, a) - distance(state.bot, b))[0];
  if (nearest && distance(state.bot, nearest) <= 2.5 && state.now >= (recovery.emergencyCooldownUntil || 0)) {
    recovery.emergencyUntil = state.now + 500;
    recovery.emergencyCooldownUntil = state.now + 1000;
  }
  if (nearest && state.now < (recovery.emergencyUntil || 0)) {
    const away = threatBearingRad(nearest, state.bot);
    state.bot = { ...state.bot, ...moveToward(state.bot, pointAt(state.bot, away, 2), MOVE_PER_TICK) };
    return recoveryDecision(state, 'survival', 'survival');
  }

  if (recovery.phase === 'travel' && state.grave) {
    state.bot = { ...state.bot, ...moveToward(state.bot, state.grave, MOVE_PER_TICK) };
    if (distance(state.bot, state.grave) <= 0.7) {
      recovery.phase = 'grave';
      state.transitions.push(`${state.tick}: 復旧移動 → 墓処理`);
    }
    return recoveryDecision(state, 'recovery', 'recovery', state.grave);
  }

  if (recovery.phase === 'grave' && state.grave) {
    const preexistingItemIds = state.drops.map((drop) => drop.id);
    const origin = { x: state.grave.x, y: 0, z: state.grave.z };
    const fakeCtx = recoveryContext(state);
    requestRecoveryItemCollection(fakeCtx, origin, state.now, 'grave', { preexistingItemIds });
    const contents = state.grave.contents;
    state.grave = null;
    contents.forEach((item, index) => state.drops.push({
      id: state.nextId++,
      item,
      graveOwned: true,
      x: origin.x + (index === 0 ? 0.6 : -0.6),
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
    const target = [...ownedRemaining].sort((a, b) => distance(state.bot, a) - distance(state.bot, b))[0];
    if (target) {
      state.bot = { ...state.bot, ...moveToward(state.bot, target, MOVE_PER_TICK) };
      if (distance(state.bot, target) <= 0.8) {
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
  return { id: drop.id, name: 'item', position: { x: drop.x, y: 0, z: drop.z } };
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
    recovery: null,
    validation: []
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

/**
 * 移動する敵エンティティ用の決定論的シミュレータadapter。
 * 位置取りと戦闘意図は引き続き本番戦闘モジュールが決定し、ここでは
 * 各tickでそれらへ渡すワールド観測だけを進める。
 */
export function advanceEnemyAi(state: SimulationState): EnemyMotion[] {
  if (!state.enemyAi?.enabled) return [];
  const speedScale = clamp(state.enemyAi.speedScale, 0.25, 2);
  const botAtTickStart = { x: state.bot.x, z: state.bot.z };
  const motions: EnemyMotion[] = [];

  for (const enemy of [...state.enemies].sort((a, b) => a.id - b.id)) {
    if (enemy.hp <= 0) continue;
    const from = { x: enemy.x, z: enemy.z };
    const ranged = isRangedEntity({ name: enemy.kind });
    const currentDistance = distance(enemy, botAtTickStart);
    let behavior: EnemyBehavior = 'hold';
    let bearing = threatBearingRad(enemy, botAtTickStart);
    let baseSpeed = enemy.kind === 'spider' ? 0.38 : 0.3;

    if (ranged) {
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
    } else if (currentDistance > MELEE_STOP_RANGE) {
      behavior = 'chase';
    }

    const requestedSpeed = behavior === 'hold' ? 0 : baseSpeed * speedScale;
    const cappedSpeed = ranged
      ? requestedSpeed
      : Math.min(requestedSpeed, Math.max(0, currentDistance - MELEE_STOP_RANGE));
    const requested = pointAt(enemy, bearing, cappedSpeed);
    const to = moveEnemyAroundObstacles(enemy, requested, bearing, cappedSpeed, state.obstacles, enemy.id);
    enemy.x = to.x;
    enemy.z = to.z;

    const pressureDistance = distance(enemy, botAtTickStart);
    const fired = ranged
      && pressureDistance >= 3
      && pressureDistance <= RANGED_PRESSURE_RANGE
      && state.tick % RANGED_SHOT_INTERVAL_TICKS === enemy.id % RANGED_SHOT_INTERVAL_TICKS;
    if (fired) {
      enemy.lastShotTick = state.tick;
      state.shots += 1;
    }
    motions.push({ id: enemy.id, behavior, speed: distance(from, to), from, to, fired });
  }
  return motions;
}

function countRangedPressure(state: SimulationState): number {
  return state.enemies.filter((enemy) => (
    enemy.hp > 0
    && isRangedEntity({ name: enemy.kind })
    && distance(state.bot, enemy) <= RANGED_PRESSURE_RANGE
  )).length;
}

function moveEnemyAroundObstacles(
  origin: SimPoint,
  requested: SimPoint,
  bearing: number,
  speed: number,
  obstacles: SimObstacle[],
  enemyId: number
): SimPoint {
  if (speed <= 0 || !isBlocked(requested, obstacles)) return requested;
  const side: 1 | -1 = enemyId % 2 === 0 ? 1 : -1;
  for (const offset of [side * Math.PI / 2, -side * Math.PI / 2]) {
    const alternative = pointAt(origin, bearing + offset, speed);
    if (!isBlocked(alternative, obstacles)) return alternative;
  }
  return { ...origin };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(minimum, Math.min(maximum, value));
}

function pointAt(origin: XZ, bearing: number, amount: number): SimPoint {
  return { x: origin.x + Math.sin(bearing) * amount, z: origin.z + Math.cos(bearing) * amount };
}

function moveToward(from: SimPoint, to: SimPoint, maxDistance: number): SimPoint {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length <= maxDistance || length < 1e-6) return { x: to.x, z: to.z };
  return { x: from.x + (dx / length) * maxDistance, z: from.z + (dz / length) * maxDistance };
}

function distance(a: SimPoint, b: SimPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function isBlocked(point: SimPoint, obstacles: SimObstacle[]): boolean {
  return obstacles.some((obstacle) => (
    Math.abs(point.x - obstacle.x) <= obstacle.size / 2
    && Math.abs(point.z - obstacle.z) <= obstacle.size / 2
  ));
}

function isPathBlocked(from: SimPoint, to: SimPoint, obstacles: SimObstacle[]): boolean {
  const pathLength = distance(from, to);
  const samples = Math.max(1, Math.ceil(pathLength / 0.25));
  for (let index = 1; index <= samples; index += 1) {
    const ratio = index / samples;
    if (isBlocked({
      x: from.x + (to.x - from.x) * ratio,
      z: from.z + (to.z - from.z) * ratio
    }, obstacles)) return true;
  }
  return false;
}
