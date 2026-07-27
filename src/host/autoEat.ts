import { setTimeout as delay } from 'node:timers/promises';
import type { Bot } from 'mineflayer';

/** Companion at full health waits until hunger drops to this value. */
const COMPANION_HEALTHY_START_AT = 14;
/**
 * Companion below max health eats earlier so natural regeneration
 * (which requires hunger above 17) can continue.
 */
const COMPANION_INJURED_START_AT = 17;
const MAX_HUNGER = 20;
const DEFAULT_MAX_HEALTH = 20;

export const UNSAFE_OR_SPECIAL_FOODS = [
  'rotten_flesh',
  'spider_eye',
  'poisonous_potato',
  'pufferfish',
  'chicken',
  'chorus_fruit',
  'suspicious_stew',
  'golden_apple',
  'enchanted_golden_apple'
];

type FoodItem = { name: string };
type FoodStats = { foodPoints: number; saturation?: number };

/**
 * Whether a companion should eat given current hunger and health.
 */
export function shouldCompanionEat(
  hunger: number,
  health: number,
  maxHealth = DEFAULT_MAX_HEALTH
): boolean {
  if (hunger >= MAX_HUNGER) return false;
  const startAt = health < maxHealth
    ? COMPANION_INJURED_START_AT
    : COMPANION_HEALTHY_START_AT;
  return hunger <= startAt;
}

function compareFoodCandidates(
  a: { foodPoints: number; saturation: number },
  b: { foodPoints: number; saturation: number },
  maximizeFit: boolean
): number {
  if (a.foodPoints !== b.foodPoints) {
    return maximizeFit
      ? b.foodPoints - a.foodPoints
      : a.foodPoints - b.foodPoints;
  }
  return b.saturation - a.saturation;
}

/**
 * Pick food that matches the current hunger deficit as closely as possible.
 */
export function chooseBestFood(
  items: FoodItem[],
  foodsByName: Record<string, FoodStats>,
  hungerDeficit: number,
  bannedFood: string[] = []
): FoodItem | null {
  const banned = new Set(bannedFood);
  const candidates: Array<{ item: FoodItem; foodPoints: number; saturation: number }> = [];

  for (const item of items) {
    if (banned.has(item.name)) continue;
    const food = foodsByName[item.name];
    if (!food) continue;
    candidates.push({
      item,
      foodPoints: food.foodPoints,
      saturation: food.saturation ?? 0
    });
  }

  if (candidates.length === 0) return null;

  const fitting = candidates.filter((c) => c.foodPoints <= hungerDeficit);
  const pool = fitting.length > 0 ? fitting : candidates;
  const maximizeFit = fitting.length > 0;

  let best = pool[0];
  for (let i = 1; i < pool.length; i++) {
    if (compareFoodCandidates(pool[i], best, maximizeFit) < 0) {
      best = pool[i];
    }
  }
  return best.item;
}

function listHeldItems(bot: Bot, includeOffhand: boolean): FoodItem[] {
  const items = bot.inventory.items() as FoodItem[];
  if (!includeOffhand) return items;

  const offhandItem = bot.inventory.slots[45];
  if (offhandItem) items.push(offhandItem as FoodItem);
  return items;
}

async function consumeChosenFood(bot: Bot, foodItem: FoodItem, offhand: boolean): Promise<void> {
  const usedHand = offhand ? 'off-hand' : 'hand';
  bot.emit('autoeat_started', foodItem as any, offhand);

  const requiresConfirmation = bot.inventory.requiresConfirmation;
  if (bot.autoEat.options.ignoreInventoryCheck) {
    bot.inventory.requiresConfirmation = false;
  }
  const oldItem = bot.inventory.slots[bot.getEquipmentDestSlot(usedHand)];
  await bot.equip(foodItem as any, usedHand);
  bot.inventory.requiresConfirmation = requiresConfirmation;
  bot.deactivateItem();
  bot.activateItem(offhand);

  const time = performance.now();
  while (
    bot.autoEat.isEating
    && performance.now() - time < bot.autoEat.options.eatingTimeout
    && bot.inventory.slots[bot.getEquipmentDestSlot(usedHand)]?.name === foodItem.name
  ) {
    await delay(0);
  }

  if (bot.autoEat.options.equipOldItem && oldItem && oldItem.name !== foodItem.name) {
    await bot.equip(oldItem, usedHand);
  }

  bot.emit('autoeat_finished', foodItem as any, offhand);
}

function installCompanionEat(bot: Bot): void {
  bot.autoEat.eat = async (useOffhand = bot.autoEat.options.offhand) => {
    if (
      bot.autoEat.isEating
      || bot.autoEat.disabled
      || !shouldCompanionEat(bot.food, bot.health)
    ) {
      return false;
    }

    bot.autoEat.isEating = true;

    try {
      const canOffhand = !bot.supportFeature('doesntHaveOffHandSlot');
      const offhand = Boolean(useOffhand && canOffhand);
      const items = listHeldItems(bot, offhand);
      const hungerDeficit = MAX_HUNGER - bot.food;
      const bestFood = chooseBestFood(
        items,
        bot.registry.foodsByName,
        hungerDeficit,
        bot.autoEat.options.bannedFood || []
      );

      if (!bestFood) {
        throw new Error('No food found.');
      }

      await consumeChosenFood(bot, bestFood, offhand);
      return true;
    } finally {
      bot.autoEat.isEating = false;
    }
  };
}

/**
 * Configure mineflayer-auto-eat with deficit-aware selection and health-aware thresholds.
 */
export function setupAutoEat(bot: Bot): void {
  const current = bot.autoEat?.options || {};
  bot.autoEat.options = {
    ...current,
    priority: 'foodPoints',
    startAt: COMPANION_HEALTHY_START_AT,
    bannedFood: [...new Set([
      ...(current.bannedFood || []),
      ...UNSAFE_OR_SPECIAL_FOODS
    ])]
  };

  installCompanionEat(bot);
  void bot.autoEat.eat().catch(() => {});
}
