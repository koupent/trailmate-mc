import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { getNearestEntityWhere, isHostile } from '../world/entities.js';
import { hasLineOfSight } from '../world/lineOfSight.js';
import type { ReflexConfig } from '../config.js';

type DefendOwner = {
  position: { offset: (x: number, y: number, z: number) => any };
  height?: number;
} | null | undefined;

/**
 * Lightweight survival reflexes (replaces Mindcraft modes.js subset).
 */
export class Reflexes {
  private lastTorchAt = 0;
  private fighting = false;

  constructor(
    private readonly bot: Bot,
    private readonly config: ReflexConfig,
    private readonly torchLightThreshold: number
  ) {}

  async tick(opts: {
    movementHeld: boolean;
    isIdleish: boolean;
    owner?: DefendOwner;
  }): Promise<void> {
    if (this.config.self_preservation) {
      this.preserve();
    }
    if (this.config.self_defense && !opts.movementHeld) {
      await this.defend(opts.owner);
    }
    if (this.config.torch_placing && opts.isIdleish && !opts.movementHeld) {
      await this.maybeTorch();
    }
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

  private async defend(owner?: DefendOwner): Promise<void> {
    if (this.fighting) return;

    // Owner is behind a door/wall: drop combat so Follow can reunite first.
    if (owner && !hasLineOfSight(this.bot, owner)) {
      await this.stopCombat();
      return;
    }

    const enemy = getNearestEntityWhere(
      this.bot,
      (e) => isHostile(e) && hasLineOfSight(this.bot, e),
      this.config.hostile_range
    );
    if (!enemy) {
      await this.stopCombat();
      return;
    }

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
    }
  }

  private async maybeTorch(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTorchAt < 5000) return;
    const torch = this.bot.inventory.items().find((i) => i.name === 'torch');
    if (!torch) return;

    const pos = this.bot.entity.position;
    const feet = this.bot.blockAt(pos);
    if (!feet || feet.name !== 'air') return;

    const timeOfDay = this.bot.time?.timeOfDay ?? 0;
    const isNight = timeOfDay >= 13000 && timeOfDay < 23000;
    const light = (feet as { light?: number }).light;
    const darkEnough = typeof light === 'number'
      ? light <= this.torchLightThreshold
      : isNight;
    if (!darkEnough) return;

    const below = this.bot.blockAt(pos.offset(0, -1, 0));
    if (!below || !below.name || below.name === 'air' || below.name === 'water') return;

    this.lastTorchAt = now;
    try {
      await this.bot.equip(torch, 'hand');
      await this.bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {
      /* placement often fails in motion; ignore */
    }
  }
}
