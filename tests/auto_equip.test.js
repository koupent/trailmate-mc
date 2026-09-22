import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { equipHighestAttack, equipShield } from '../src/companion/utils/AutoEquip.js';

describe('equipShield', () => {
    it('使用可能な盾をオフハンドへ装備する', async () => {
        const shield = { name: 'shield' };
        const equips = [];
        const bot = {
            supportFeature: () => false,
            getEquipmentDestSlot: () => 45,
            inventory: {
                slots: [],
                items: () => [shield]
            },
            async equip(item, destination) {
                equips.push({ item, destination });
            }
        };

        await equipShield(bot);

        assert.deepEqual(equips, [{ item: shield, destination: 'off-hand' }]);
    });

    it('既に装備している盾を維持する', async () => {
        let equipCount = 0;
        const slots = [];
        slots[45] = { name: 'shield' };
        const bot = {
            supportFeature: () => false,
            getEquipmentDestSlot: () => 45,
            inventory: {
                slots,
                items: () => [{ name: 'shield' }]
            },
            async equip() {
                equipCount += 1;
            }
        };

        await equipShield(bot);

        assert.equal(equipCount, 0);
    });
});

describe('equipHighestAttack', () => {
    function makeBot(names, heldName = null) {
        const equips = [];
        const items = names.map((name, index) => ({ name, slot: 9 + index }));
        return {
            equips,
            bot: {
                inventory: { slots: [], items: () => items },
                heldItem: heldName ? { name: heldName } : null,
                async equip(item, destination) {
                    equips.push({ name: item.name, destination });
                }
            }
        };
    }

    it('prefers a melee weapon over a mining tool', async () => {
        const { bot, equips } = makeBot(['iron_pickaxe', 'diamond_sword']);

        await equipHighestAttack(bot);

        assert.deepEqual(equips, [{ name: 'diamond_sword', destination: 'hand' }]);
    });

    it('ranks melee weapons by material when no attack damage is known', async () => {
        // Neither mineflayer nor minecraft-data sets attackDamage, so the
        // material tier is what actually decides this in production.
        const { bot, equips } = makeBot(['wooden_sword', 'netherite_axe', 'iron_sword']);

        await equipHighestAttack(bot);

        assert.deepEqual(equips, [{ name: 'netherite_axe', destination: 'hand' }]);
    });

    it('falls back to a tool only when there is no weapon at all', async () => {
        const { bot, equips } = makeBot(['stone_shovel', 'diamond_pickaxe']);

        await equipHighestAttack(bot);

        assert.deepEqual(equips, [{ name: 'diamond_pickaxe', destination: 'hand' }]);
    });

    it('never equips an ordinary item as a weapon', async () => {
        const { bot, equips } = makeBot(['gold_ingot', 'chest', 'cobblestone']);

        await equipHighestAttack(bot);

        assert.deepEqual(equips, []);
    });

    it('keeps a better weapon already in hand', async () => {
        const { bot, equips } = makeBot(['wooden_sword'], 'netherite_sword');

        await equipHighestAttack(bot);

        assert.deepEqual(equips, []);
    });
});
