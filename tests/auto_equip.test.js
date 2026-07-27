import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { equipShield } from '../src/companion/utils/AutoEquip.js';

describe('equipShield', () => {
    it('equips an available shield in the off-hand', async () => {
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

    it('keeps an already equipped shield', async () => {
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
