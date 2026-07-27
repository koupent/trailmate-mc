import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupAutoEat,
  shouldCompanionEat,
  chooseBestFood
} from '../src/host/autoEat.js';

const FOODS_BY_NAME = {
  apple: { foodPoints: 4, saturation: 2.4 },
  bread: { foodPoints: 5, saturation: 6 },
  cooked_beef: { foodPoints: 8, saturation: 12.8 },
  melon_slice: { foodPoints: 2, saturation: 1.2 },
  cookie: { foodPoints: 2, saturation: 0.4 },
  golden_apple: { foodPoints: 4, saturation: 9.6 }
};

describe('shouldCompanionEat', () => {
  it('waits until hunger 14 when healthy', () => {
    assert.equal(shouldCompanionEat(15, 20), false);
    assert.equal(shouldCompanionEat(14, 20), true);
    assert.equal(shouldCompanionEat(10, 20), true);
  });

  it('eats earlier at hunger 17 when injured', () => {
    assert.equal(shouldCompanionEat(18, 19), false);
    assert.equal(shouldCompanionEat(17, 19), true);
    assert.equal(shouldCompanionEat(15, 10), true);
  });

  it('never eats at full hunger', () => {
    assert.equal(shouldCompanionEat(20, 20), false);
    assert.equal(shouldCompanionEat(20, 5), false);
  });
});

describe('chooseBestFood', () => {
  it('picks the largest food that still fits the deficit', () => {
    const items = [
      { name: 'cooked_beef' },
      { name: 'bread' },
      { name: 'apple' },
      { name: 'melon_slice' }
    ];

    const chosen = chooseBestFood(items, FOODS_BY_NAME, 5);
    assert.equal(chosen.name, 'bread');
  });

  it('picks the smallest food when every option exceeds the deficit', () => {
    const items = [
      { name: 'cooked_beef' },
      { name: 'bread' },
      { name: 'apple' }
    ];

    const chosen = chooseBestFood(items, FOODS_BY_NAME, 1);
    assert.equal(chosen.name, 'apple');
  });

  it('breaks ties with higher saturation', () => {
    const items = [
      { name: 'cookie' },
      { name: 'melon_slice' }
    ];

    const chosen = chooseBestFood(items, FOODS_BY_NAME, 2);
    assert.equal(chosen.name, 'melon_slice');
  });

  it('skips banned and non-food items', () => {
    const items = [
      { name: 'golden_apple' },
      { name: 'dirt' },
      { name: 'apple' }
    ];

    const chosen = chooseBestFood(
      items,
      FOODS_BY_NAME,
      4,
      ['golden_apple']
    );
    assert.equal(chosen.name, 'apple');
  });

  it('returns null when no edible food remains', () => {
    const chosen = chooseBestFood(
      [{ name: 'golden_apple' }, { name: 'dirt' }],
      FOODS_BY_NAME,
      4,
      ['golden_apple']
    );
    assert.equal(chosen, null);
  });
});

describe('setupAutoEat', () => {
  function makeBot({ food = 20, health = 20 } = {}) {
    const bot = {
      food,
      health,
      supportFeature: () => false,
      registry: { foodsByName: FOODS_BY_NAME },
      inventory: {
        requiresConfirmation: true,
        items: () => [{ name: 'bread' }, { name: 'cooked_beef' }],
        slots: []
      },
      getEquipmentDestSlot: () => 36,
      emit() {},
      equip() { return Promise.resolve(); },
      deactivateItem() {},
      activateItem() {},
      autoEat: {
        isEating: false,
        disabled: false,
        options: {
          priority: 'saturation',
          startAt: 16,
          eatingTimeout: 3000,
          offhand: true,
          equipOldItem: true,
          bannedFood: ['custom_food']
        },
        eat() {
          return Promise.resolve(true);
        }
      }
    };
    return bot;
  }

  it('installs companion eat logic with healthy start threshold', () => {
    const bot = makeBot();
    const pluginEat = bot.autoEat.eat;

    setupAutoEat(bot);

    assert.equal(bot.autoEat.options.startAt, 14);
    assert.equal(bot.autoEat.options.priority, 'foodPoints');
    assert.notEqual(bot.autoEat.eat, pluginEat);
  });

  it('companion eat selects the smallest food when nothing fits the deficit', async () => {
    const bot = makeBot({ food: 20, health: 20 });
    let equipped = null;
    bot.equip = (item) => {
      equipped = item.name;
      bot.autoEat.isEating = false;
      return Promise.resolve();
    };

    setupAutoEat(bot);
    await Promise.resolve();

    bot.food = 16;
    bot.health = 15;
    const ate = await bot.autoEat.eat();

    assert.equal(ate, true);
    assert.equal(equipped, 'bread');
  });

  it('companion eat selects the largest fitting food for the deficit', async () => {
    const bot = makeBot({ food: 20, health: 20 });
    bot.inventory.items = () => [
      { name: 'cooked_beef' },
      { name: 'bread' },
      { name: 'apple' },
      { name: 'melon_slice' }
    ];
    let equipped = null;
    bot.equip = (item) => {
      equipped = item.name;
      bot.autoEat.isEating = false;
      return Promise.resolve();
    };

    setupAutoEat(bot);
    await Promise.resolve();

    bot.food = 15;
    bot.health = 10;
    const ate = await bot.autoEat.eat();

    assert.equal(ate, true);
    assert.equal(equipped, 'bread');
  });

  it('companion eat skips when healthy and only mildly hungry', async () => {
    const bot = makeBot({ food: 20, health: 20 });

    setupAutoEat(bot);
    await Promise.resolve();

    bot.food = 15;
    bot.health = 20;
    const ate = await bot.autoEat.eat();

    assert.equal(ate, false);
  });

  it('companion eat runs when injured and hunger is 17', async () => {
    const bot = makeBot({ food: 20, health: 20 });
    bot.equip = () => {
      bot.autoEat.isEating = false;
      return Promise.resolve();
    };

    setupAutoEat(bot);
    await Promise.resolve();

    bot.food = 17;
    bot.health = 18;
    const ate = await bot.autoEat.eat();

    assert.equal(ate, true);
  });

  it('keeps plugin defaults and excludes unsafe or special food', () => {
    const bot = makeBot();

    setupAutoEat(bot);

    assert.equal(bot.autoEat.options.eatingTimeout, 3000);
    assert.equal(bot.autoEat.options.offhand, true);
    assert.equal(bot.autoEat.options.equipOldItem, true);
    assert.ok(bot.autoEat.options.bannedFood.includes('custom_food'));
    assert.ok(bot.autoEat.options.bannedFood.includes('rotten_flesh'));
    assert.ok(bot.autoEat.options.bannedFood.includes('golden_apple'));
    assert.ok(bot.autoEat.options.bannedFood.includes('enchanted_golden_apple'));
  });
});
