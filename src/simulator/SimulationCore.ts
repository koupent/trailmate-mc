import {
  chooseBestThreatPosition,
  computeThreatArc,
  generateThreatPositionCandidates,
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
export type SimEnemy = SimPoint & { id: number; kind: string; hp: number };
export type SimDrop = SimPoint & { id: number; item: string; graveOwned?: boolean };
export type SimObstacle = SimPoint & { id: number; size: number };

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
    base.expectations = { owner: 'combat', maxSpanDeg: 130 };
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
  }
  return base;
}

export function listScenarioIds(): string[] {
  return ['single-ranged', 'multi-positioning', 'recovery'];
}

export function stepSimulation(input: SimulationState): {
  state: SimulationState;
  decision: SimulationDecision;
} {
  const state = structuredClone(input) as SimulationState;
  state.now += state.tickMs;
  state.tick += 1;
  state.transitions = [...(state.transitions || [])].slice(-11);

  const decision = state.recovery?.active
    ? stepRecovery(state)
    : stepCombat(state);
  if (decision.controlOwner !== state.lastOwner) {
    state.transitions.push(`${state.tick}: ${state.lastOwner} → ${decision.controlOwner}`);
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
  const candidates = generateThreatPositionCandidates(state.bot, 2.25)
    .filter((candidate) => !isBlocked(candidate, state.obstacles));
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
  const rangedCount = threats.filter((enemy) => isRangedEntity({ name: enemy.kind })).length;
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
      state.transitions.push(`${state.tick}: recovery travel → grave`);
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
    state.transitions.push(`${state.tick}: grave → items`);
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
    const hasWeapon = state.inventory.some((item) => /sword|axe|bow|crossbow|trident|mace/.test(item));
    const quietReady = Boolean(status?.captureComplete)
      && status!.remainingIds.length === 0
      && status!.quietForMs >= 300;
    if ((quietReady && hasWeapon) || status?.deadlineReached) {
      state.equipped = state.inventory.find((item) => /sword|axe|bow|crossbow|trident|mace/.test(item)) || null;
      recovery.phase = 'done';
      recovery.active = false;
      state.transitions.push(`${state.tick}: items → combat-ready`);
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
