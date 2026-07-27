import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { chooseCombatTarget, isHostile } from '../world/entities.js';
import { hasLineOfSight } from '../world/lineOfSight.js';
import type { ReflexConfig } from '../config.js';
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
  };
  height?: number;
} | null | undefined;

type CombatMovement = {
  followEntity: (entity: any, range: number) => boolean;
  goToward: (position: { x: number; y: number; z: number }, range?: number) => boolean;
};

const TARGET_RANGE_BUFFER = 2;
const OWNER_RETREAT_RANGE = 2;
const RETREAT_GOAL_RANGE = 1.5;
const DEFAULT_FOLLOW_RANGE = 2.5;
const RANGED_FOLLOW_RANGE = 1.5;
const CREEPER_FOLLOW_RANGE = 3;
const RANGED_HOSTILES = new Set([
  'skeleton',
  'stray',
  'bogged',
  'pillager',
  'witch',
  'blaze'
]);

/**
 * Lightweight survival reflexes (replaces Mindcraft modes.js subset).
 */
export class Reflexes {
  private lastTorchAt = 0;
  private fighting = false;
  private currentTarget: any | null = null;
  private lastTargetSeenAt = 0;
  private retreating = false;

  constructor(
    private readonly bot: Bot,
    private readonly config: ReflexConfig,
    private readonly torchLightThreshold: number
  ) {}

  async tick(opts: {
    movementHeld: boolean;
    isIdleish: boolean;
    owner?: DefendOwner;
    movement?: CombatMovement;
  }): Promise<void> {
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
    this.bot.pvp?.forceStop?.();
    this.currentTarget = null;
    this.lastTargetSeenAt = 0;
    this.retreating = false;
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
      if (!this.isUsableTarget(this.currentTarget)) {
        this.currentTarget = null;
      } else if (hasLineOfSight(this.bot, this.currentTarget)) {
        this.lastTargetSeenAt = now;
      } else if (now - this.lastTargetSeenAt > this.config.combat_lost_grace_ms) {
        this.currentTarget = null;
      }
    }

    if (!this.currentTarget && !this.retreating) {
      this.currentTarget = chooseCombatTarget(
        this.bot,
        owner,
        this.config.hostile_range,
        (entity) => hasLineOfSight(this.bot, entity)
      );
      if (this.currentTarget) this.lastTargetSeenAt = now;
    }

    if (this.shouldStartRetreat()) {
      this.retreating = true;
      this.bot.pvp?.forceStop?.();
    } else if (this.retreating && this.bot.health >= this.config.resume_health) {
      this.retreating = false;
    }

    if (this.retreating) {
      this.retreat(owner, this.currentTarget, movement);
      return;
    }

    const enemy = this.currentTarget;
    if (!enemy) {
      await this.stopCombat();
      return;
    }

    if (this.shouldEvadeCreeper(enemy)) {
      this.bot.pvp?.forceStop?.();
      this.moveAwayFrom(enemy, movement);
      return;
    }

    this.configureCombatRange(enemy);
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

  private isUsableTarget(target: any): boolean {
    if (!target || !isHostile(target) || !target.position || target.isValid === false) {
      return false;
    }
    if (target.id != null && this.bot.entities && this.bot.entities[target.id] !== target) {
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

  private retreat(
    owner: DefendOwner,
    threat: any | null,
    movement?: CombatMovement
  ): void {
    if (!movement) return;
    if (owner) {
      movement.followEntity(owner, OWNER_RETREAT_RANGE);
      return;
    }
    if (threat) this.moveAwayFrom(threat, movement);
  }

  private moveAwayFrom(threat: any, movement?: CombatMovement): void {
    if (!movement || !threat?.position) return;
    const botPos = this.bot.entity.position;
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
    movement.goToward({
      x: botPos.x + dx * this.config.retreat_distance,
      y: botPos.y,
      z: botPos.z + dz * this.config.retreat_distance
    }, RETREAT_GOAL_RANGE);
  }

  private shouldEvadeCreeper(enemy: any): boolean {
    if (enemy.name !== 'creeper' || enemy.metadata?.[16] !== 1) return false;
    const pvp = this.bot.pvp as any;
    return typeof pvp?.hasShield !== 'function' || !pvp.hasShield();
  }

  private configureCombatRange(enemy: any): void {
    if (!this.bot.pvp) return;
    if (enemy.name === 'creeper') {
      this.bot.pvp.followRange = CREEPER_FOLLOW_RANGE;
    } else if (RANGED_HOSTILES.has(enemy.name)) {
      this.bot.pvp.followRange = RANGED_FOLLOW_RANGE;
    } else {
      this.bot.pvp.followRange = DEFAULT_FOLLOW_RANGE;
    }
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
