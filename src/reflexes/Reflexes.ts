import { Vec3 } from 'vec3';
import path from 'node:path';
import type { Bot } from 'mineflayer';
import { chooseCombatTarget, isHostile } from '../world/entities.js';
import { hasLineOfSight } from '../world/lineOfSight.js';
import { projectRoot, type ReflexConfig } from '../config.js';
import {
  baselinePresetId,
  blendCrowdAvoidDirection,
  classifyEnemy,
  countBucket,
  countNearbyHostiles,
  crowdAwayDirection,
  decideSpacing,
  getPresetParams,
  type CombatContext,
  type CombatPresetParams
} from '../combat/CombatProfiles.js';
import { CombatEpisodeTracker } from '../combat/CombatEpisodeTracker.js';
import { CombatOptimizer } from '../combat/CombatOptimizer.js';
import { CombatStateStore } from '../combat/CombatStateStore.js';
import {
  estimateBrightness,
  nearestTorchDistance,
  torchScanRadius,
  TORCH_PLACE_COOLDOWN_MS,
  type LightSample
} from './torchPlacement.js';

type DefendOwner = {
  position: {
    x: number;
    y: number;
    z: number;
    offset: (x: number, y: number, z: number) => any;
    distanceTo?: (other: { x: number; y: number; z: number }) => number;
  };
  height?: number;
} | null | undefined;

type CombatMovement = {
  followEntity: (entity: any, range: number) => boolean;
  goToward: (position: { x: number; y: number; z: number }, range?: number) => boolean;
  setSprintAllowed?: (allowed: boolean) => void;
};

const TARGET_RANGE_BUFFER = 2;
const OWNER_RETREAT_RANGE = 2;
const OWNER_THREAT_TOO_CLOSE = 4;
const RETREAT_GOAL_RANGE = 1.5;
const RETREAT_MODE_STICKY_MS = 1500;
const RETREAT_DEST_REFRESH_MS = 2000;

type RetreatMode = 'owner' | 'away';

/**
 * Lightweight survival reflexes with optional combat-preset learning.
 */
export class Reflexes {
  private lastTorchAt = 0;
  private fighting = false;
  private currentTarget: any | null = null;
  private lastTargetSeenAt = 0;
  private retreating = false;
  private retreatMode: RetreatMode | null = null;
  private retreatModeUntil = 0;
  private retreatDestination: { x: number; y: number; z: number } | null = null;
  private retreatDestinationUntil = 0;
  private lastHealth: number;
  private strafeSign: 1 | -1 = 1;
  private strafeUntil = 0;
  private lastMovement: CombatMovement | undefined;
  private activePresetParams: CombatPresetParams = getPresetParams(baselinePresetId({
    enemyClass: 'melee',
    countBucket: 'solo',
    hasShield: false
  }));
  private activePresetId = baselinePresetId({
    enemyClass: 'melee',
    countBucket: 'solo',
    hasShield: false
  });
  private activeContextKey = '';
  private focusUntil = 0;
  private readonly episodeTracker = new CombatEpisodeTracker();
  private readonly combatOptimizer: CombatOptimizer;
  private readonly combatStore: CombatStateStore;

  constructor(
    private readonly bot: Bot,
    private readonly config: ReflexConfig,
    private readonly torchLightThreshold: number
  ) {
    this.lastHealth = Number.isFinite(bot.health) ? bot.health : 20;
    const learning = config.combat_learning;
    const statePath = path.isAbsolute(learning.state_path)
      ? learning.state_path
      : path.join(projectRoot(), learning.state_path);
    this.combatStore = new CombatStateStore(statePath);
    this.combatOptimizer = new CombatOptimizer(this.combatStore, {
      enabled: learning.enabled,
      exploreRate: learning.explore_rate,
      swarmExploreRate: learning.swarm_explore_rate,
      minTrials: learning.min_trials,
      minHealthToExplore: learning.min_health_to_explore,
      exploreDamageAbort: learning.explore_damage_abort
    });
    (bot as any).on?.('health', () => this.onHealthChanged());
    (bot as any).on?.('attackedTarget', () => {
      this.episodeTracker.recordHit();
    });
    (bot as any).on?.('entityGone', (entity: any) => {
      this.onEntityGone(entity);
    });
    (bot as any).on?.('death', () => {
      this.episodeTracker.markDied();
      this.finishEpisode();
    });
  }

  /** Persist learning state (call on shutdown). */
  flushLearning(): void {
    this.finishEpisode();
    this.combatOptimizer.flush();
  }

  async tick(opts: {
    movementHeld: boolean;
    isIdleish: boolean;
    owner?: DefendOwner;
    movement?: CombatMovement;
  }): Promise<void> {
    this.lastMovement = opts.movement;
    if (this.config.self_preservation) {
      this.preserve();
    }
    if (this.config.self_defense && !opts.movementHeld) {
      await this.defend(opts.owner, opts.movement);
    } else {
      this.resetCombat();
    }
    if (
      this.config.torch_placing
      && opts.isIdleish
      && !opts.movementHeld
      && !this.isControllingMovement
    ) {
      await this.maybeTorch();
    }
  }

  get isControllingMovement(): boolean {
    return this.retreating || this.currentTarget != null || this.bot.pvp?.target != null;
  }

  /** Cancel sticky combat state when a higher-priority interrupt takes over. */
  resetCombat(): void {
    this.episodeTracker.markInterrupted();
    this.finishEpisode();
    this.endRetreat();
    this.bot.pvp?.forceStop?.();
    this.currentTarget = null;
    this.lastTargetSeenAt = 0;
    this.focusUntil = 0;
    this.activeContextKey = '';
  }

  private preserve(): void {
    const bot = this.bot;
    if (!bot.entity) return;
    const block = bot.blockAt(bot.entity.position) || { name: 'air' };
    const blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0)) || { name: 'air' };

    if (blockAbove.name === 'water' && !bot.pathfinder?.goal) {
      bot.setControlState('jump', true);
      return;
    }

    if (
      block.name === 'lava' || block.name === 'fire'
      || blockAbove.name === 'lava' || blockAbove.name === 'fire'
    ) {
      bot.setControlState('jump', true);
      bot.setControlState('forward', true);
    }
  }

  private async defend(owner?: DefendOwner, movement?: CombatMovement): Promise<void> {
    if (this.fighting) return;

    const now = Date.now();
    if (!this.currentTarget && this.isUsableTarget(this.bot.pvp?.target)) {
      this.currentTarget = this.bot.pvp.target;
      this.lastTargetSeenAt = now;
    }

    if (this.currentTarget) {
      this.currentTarget = this.resolveLiveTarget(this.currentTarget);
      if (!this.isUsableTarget(this.currentTarget)) {
        this.currentTarget = null;
      } else if (hasLineOfSight(this.bot, this.currentTarget)) {
        this.lastTargetSeenAt = now;
      } else if (now - this.lastTargetSeenAt > this.config.combat_lost_grace_ms) {
        this.currentTarget = null;
      }
    }

    const stickyTarget = this.currentTarget;
    const canSwitchTarget = !stickyTarget || now >= this.focusUntil;
    if (!this.currentTarget && !this.retreating) {
      this.currentTarget = chooseCombatTarget(
        this.bot,
        owner,
        this.config.hostile_range,
        (entity) => hasLineOfSight(this.bot, entity)
      );
      if (this.currentTarget) {
        this.syncCombatLearning(this.currentTarget, now);
        this.lastTargetSeenAt = now;
        this.focusUntil = now + this.activePresetParams.focusStickyMs;
      }
    } else if (canSwitchTarget && stickyTarget && !this.retreating) {
      const candidate = chooseCombatTarget(
        this.bot,
        owner,
        this.config.hostile_range,
        (entity) => hasLineOfSight(this.bot, entity)
      );
      if (candidate && candidate.id !== stickyTarget.id) {
        this.currentTarget = candidate;
        this.syncCombatLearning(candidate, now);
        this.lastTargetSeenAt = now;
        this.focusUntil = now + this.activePresetParams.focusStickyMs;
      }
    }

    if (this.shouldStartRetreat()) {
      this.episodeTracker.markRetreated();
      this.beginRetreat(movement);
    } else if (this.retreating && this.bot.health >= this.config.resume_health) {
      this.endRetreat(movement);
    }

    if (this.retreating) {
      this.keepShieldDown();
      this.bot.setControlState('sprint', true);
      const mode = this.pickRetreatMode(owner, this.currentTarget, now);
      this.retreat(owner, this.currentTarget, movement, mode, now);
      return;
    }

    const enemy = this.currentTarget;
    if (!enemy) {
      this.finishEpisode();
      await this.stopCombat();
      return;
    }

    this.syncCombatLearning(enemy, now);

    if (this.shouldEvadeCreeper(enemy) || this.shouldSoftEvadeCreeper(enemy)) {
      this.bot.pvp?.forceStop?.();
      this.applyCombatSpacing(enemy);
      this.moveAwayFrom(enemy, movement);
      return;
    }

    this.configureCombatRange(enemy);
    this.applyCombatSpacing(enemy);
    this.fighting = true;
    try {
      await this.bot.pvp.attack(enemy);
    } catch (err) {
      console.warn('[reflexes] defend failed:', (err as Error).message || err);
    } finally {
      this.fighting = false;
    }
  }

  private async stopCombat(): Promise<void> {
    if (this.fighting) return;
    this.fighting = true;
    try {
      await this.bot.pvp?.stop?.();
    } catch {
      /* ignore */
    } finally {
      this.fighting = false;
      this.currentTarget = null;
      this.lastTargetSeenAt = 0;
    }
  }

  private resolveLiveTarget(target: any): any | null {
    if (!target) return null;
    if (target.id == null || !this.bot.entities) return target;
    return this.bot.entities[target.id] || null;
  }

  private isUsableTarget(target: any): boolean {
    if (!target || !isHostile(target) || !target.position || target.isValid === false) {
      return false;
    }
    return this.bot.entity.position.distanceTo(target.position)
      <= this.config.hostile_range + TARGET_RANGE_BUFFER;
  }

  private shouldStartRetreat(): boolean {
    return !this.retreating
      && this.currentTarget != null
      && this.bot.health <= this.config.retreat_health;
  }

  private beginRetreat(movement?: CombatMovement): void {
    const move = movement || this.lastMovement;
    this.retreating = true;
    this.retreatMode = null;
    this.retreatModeUntil = 0;
    this.retreatDestination = null;
    this.retreatDestinationUntil = 0;
    this.bot.pvp?.forceStop?.();
    this.keepShieldDown();
    move?.setSprintAllowed?.(true);
    this.bot.setControlState('sprint', true);
  }

  private endRetreat(movement?: CombatMovement): void {
    const move = movement || this.lastMovement;
    if (!this.retreating && !this.retreatMode) {
      this.retreating = false;
      return;
    }
    this.retreating = false;
    this.retreatMode = null;
    this.retreatModeUntil = 0;
    this.retreatDestination = null;
    this.retreatDestinationUntil = 0;
    try {
      this.bot.setControlState('sprint', false);
    } catch {
      /* ignore */
    }
    move?.setSprintAllowed?.(false);
  }

  private keepShieldDown(): void {
    try {
      this.bot.deactivateItem();
    } catch {
      /* ignore */
    }
  }

  private pickRetreatMode(owner: DefendOwner, threat: any | null, now: number): RetreatMode {
    if (this.retreatMode && now < this.retreatModeUntil) {
      return this.retreatMode;
    }
    const ownerTooClose = !!(
      owner
      && threat?.position
      && distanceToPos(owner.position, threat.position) <= OWNER_THREAT_TOO_CLOSE
    );
    this.retreatMode = owner && !ownerTooClose ? 'owner' : 'away';
    this.retreatModeUntil = now + RETREAT_MODE_STICKY_MS;
    if (this.retreatMode === 'away') {
      this.retreatDestination = null;
      this.retreatDestinationUntil = 0;
    }
    return this.retreatMode;
  }

  private retreat(
    owner: DefendOwner,
    threat: any | null,
    movement: CombatMovement | undefined,
    mode: RetreatMode,
    now: number
  ): void {
    if (!movement) return;
    if (mode === 'owner' && owner) {
      movement.followEntity(owner, OWNER_RETREAT_RANGE);
      return;
    }
    if (threat) this.moveAwayFrom(threat, movement, now);
  }

  private moveAwayFrom(threat: any, movement?: CombatMovement, now = Date.now()): void {
    if (!movement || !threat?.position) return;
    const botPos = this.bot.entity.position;
    const useStickyDestination = this.retreating;
    let destination = useStickyDestination ? this.retreatDestination : null;
    const needsFreshDestination = !destination
      || now >= this.retreatDestinationUntil
      || distanceToPos(botPos, destination) <= RETREAT_GOAL_RANGE + 0.5;

    if (needsFreshDestination) {
      let dx = botPos.x - threat.position.x;
      let dz = botPos.z - threat.position.z;
      const horizontalDistance = Math.hypot(dx, dz);
      if (horizontalDistance < 0.1) {
        dx = -Math.sin(this.bot.entity.yaw);
        dz = -Math.cos(this.bot.entity.yaw);
      } else {
        dx /= horizontalDistance;
        dz /= horizontalDistance;
      }
      const crowdAway = crowdAwayDirection(
        this.bot.entities,
        botPos,
        this.config.hostile_range + TARGET_RANGE_BUFFER,
        isHostile
      );
      const blended = blendCrowdAvoidDirection({
        awayFromTarget: { x: dx, z: dz },
        awayFromCrowd: crowdAway,
        bias: this.activePresetParams.crowdAvoidBias
      });
      destination = {
        x: botPos.x + blended.x * this.config.retreat_distance,
        y: botPos.y,
        z: botPos.z + blended.z * this.config.retreat_distance
      };
      if (useStickyDestination) {
        this.retreatDestination = destination;
        this.retreatDestinationUntil = now + RETREAT_DEST_REFRESH_MS;
      }
    }

    if (!destination) return;
    movement.goToward(destination, RETREAT_GOAL_RANGE);
  }

  private shouldEvadeCreeper(enemy: any): boolean {
    if (enemy.name !== 'creeper' || enemy.metadata?.[16] !== 1) return false;
    const pvp = this.bot.pvp as any;
    return typeof pvp?.hasShield !== 'function' || !pvp.hasShield();
  }

  private shouldSoftEvadeCreeper(enemy: any): boolean {
    if (enemy.name !== 'creeper' || !enemy.position) return false;
    return distanceToPos(this.bot.entity.position, enemy.position)
      <= this.activePresetParams.creeperSoftEvadeRange;
  }

  private configureCombatRange(enemy: any): void {
    if (!this.bot.pvp) return;
    const enemyClass = classifyEnemy(enemy.name);
    const distance = enemy.position
      ? distanceToPos(this.bot.entity.position, enemy.position)
      : this.activePresetParams.followRange;
    const decision = decideSpacing({
      params: this.activePresetParams,
      enemyClass,
      distance,
      enemyFacingBot: null
    });
    this.bot.pvp.followRange = decision.followRange;
  }

  /** Overlay spacing controls on top of mineflayer-pvp using the active preset. */
  private applyCombatSpacing(enemy: any): void {
    if (!enemy?.position || !this.bot.entity) return;
    const now = Date.now();
    const botPos = this.bot.entity.position;
    const distance = distanceToPos(botPos, enemy.position);
    const dx = enemy.position.x - botPos.x;
    const dz = enemy.position.z - botPos.z;
    const enemyFacingBot = facingDot(enemy.yaw, -dx, -dz);
    const enemyClass = classifyEnemy(enemy.name);
    const decision = decideSpacing({
      params: this.activePresetParams,
      enemyClass,
      distance,
      enemyFacingBot
    });

    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('back', false);

    if (decision.needStrafe) {
      if (now >= this.strafeUntil) {
        this.strafeSign = this.strafeSign === 1 ? -1 : 1;
        this.strafeUntil = now + this.activePresetParams.strafeSwitchMs;
      }
      this.bot.setControlState(this.strafeSign === 1 ? 'left' : 'right', true);
    }
    if (decision.needBackstep) {
      this.bot.setControlState('back', true);
    }
    if (this.bot.pvp) this.bot.pvp.followRange = decision.followRange;
  }

  private hasShieldEquipped(): boolean {
    try {
      const pvp = this.bot.pvp as any;
      if (typeof pvp?.hasShield === 'function') return !!pvp.hasShield();
      const slot = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')];
      return !!slot?.name?.includes('shield');
    } catch {
      return false;
    }
  }

  private buildCombatContext(enemy: any, enemyCount: number): CombatContext {
    return {
      enemyClass: classifyEnemy(enemy?.name),
      countBucket: countBucket(enemyCount),
      hasShield: this.hasShieldEquipped()
    };
  }

  private syncCombatLearning(enemy: any, now: number): void {
    if (!enemy) return;
    const enemyCount = Math.max(
      1,
      countNearbyHostiles(
        this.bot.entities,
        this.bot.entity.position,
        this.config.hostile_range + TARGET_RANGE_BUFFER,
        isHostile
      )
    );
    const context = this.buildCombatContext(enemy, enemyCount);

    if (!this.combatOptimizer.enabled) {
      this.activePresetId = baselinePresetId(context);
      this.activePresetParams = getPresetParams(this.activePresetId);
      return;
    }

    const key = `${context.enemyClass}|${context.countBucket}|${context.hasShield ? 1 : 0}`;
    const split = this.episodeTracker.noteEnemyCount(enemyCount, now);
    if (split) this.combatOptimizer.completeEpisode(split);

    if (key !== this.activeContextKey || !this.episodeTracker.current) {
      if (this.episodeTracker.current) this.finishEpisode();
      const choice = this.combatOptimizer.pickPreset({
        context,
        health: this.bot.health,
        now
      });
      this.activeContextKey = key;
      this.activePresetId = choice.presetId;
      this.activePresetParams = choice.params;
      this.episodeTracker.begin({
        context,
        presetId: choice.presetId,
        exploring: choice.exploring,
        enemyName: enemy.name ?? null,
        enemyId: enemy.id ?? null,
        enemyCount,
        now
      });
      console.log(
        `[combat-learn] pick ${choice.reason} preset=${choice.presetId} `
        + `class=${context.enemyClass} count=${context.countBucket} shield=${context.hasShield}`
      );
    }
  }

  private finishEpisode(): void {
    const episode = this.episodeTracker.end();
    if (!episode) return;
    this.combatOptimizer.completeEpisode(episode);
    this.activeContextKey = '';
  }

  private onEntityGone(entity: any): void {
    if (!entity || !isHostile(entity)) return;
    const current = this.episodeTracker.current;
    if (!current) return;
    if (current.enemyId != null && entity.id === current.enemyId) {
      this.episodeTracker.recordKill();
      this.finishEpisode();
      return;
    }
    if ((current.peakEnemyCount || 0) >= 2) {
      this.episodeTracker.recordKill();
    }
  }

  private onHealthChanged(): void {
    const health = this.bot.health;
    const damage = this.lastHealth - health;
    this.lastHealth = health;
    if (damage > 0) this.episodeTracker.recordDamage(damage);
  }

  private async maybeTorch(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTorchAt < TORCH_PLACE_COOLDOWN_MS) return;

    const pos = this.bot.entity?.position;
    if (!pos) return;

    const torch = this.bot.inventory.items().find((i) => i.name === 'torch');
    if (!torch) return;

    const feet = this.bot.blockAt(pos);
    if (!feet || feet.name !== 'air') return;

    const below = this.bot.blockAt(pos.offset(0, -1, 0));
    if (!below || !below.name || below.name === 'air' || below.name === 'water') return;

    const timeOfDay = this.bot.time?.timeOfDay ?? 0;
    const isNight = timeOfDay >= 13000 && timeOfDay < 23000;
    const brightness = estimateBrightness({
      skyLight: (feet as LightSample).skyLight ?? null,
      isNight,
      torchDistance: nearestTorchDistance(
        (x, y, z) => this.bot.blockAt(new Vec3(x, y, z)),
        pos,
        torchScanRadius(this.torchLightThreshold)
      )
    });
    if (brightness > this.torchLightThreshold) return;

    this.lastTorchAt = now;
    try {
      await this.bot.equip(torch, 'hand');
      await this.bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {
      /* placement often fails in motion; ignore */
    }
  }
}

function distanceToPos(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const withDistance = a as { distanceTo?: (other: any) => number };
  if (typeof withDistance.distanceTo === 'function') return withDistance.distanceTo(b);
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function facingDot(yaw: number | undefined, dx: number, dz: number): number | null {
  if (!Number.isFinite(yaw)) return null;
  const length = Math.hypot(dx, dz);
  if (length === 0) return 1;
  const facingX = -Math.sin(yaw as number);
  const facingZ = -Math.cos(yaw as number);
  return Number(((facingX * dx + facingZ * dz) / length).toFixed(3));
}
