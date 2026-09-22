import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    listGiveableStacks,
    listUnequipTargets,
    equipmentGroup,
    equipmentScore,
    isTorch,
    isKeepableFood
} from '../src/companion/utils/itemRetention.js';
import {
    DEFAULT_RETENTION_POLICY,
    resolveRetentionPolicy
} from '../src/companion/utils/retentionPolicy.js';
import {
    shouldTransferNow,
    PeriodicItemTransfer
} from '../src/companion/utils/PeriodicItemTransfer.js';

const FOODS_BY_NAME = {
    cooked_beef: { foodPoints: 8, saturation: 12.8 },
    bread: { foodPoints: 5, saturation: 6 },
    apple: { foodPoints: 4, saturation: 2.4 },
    cookie: { foodPoints: 2, saturation: 0.4 }
};

function makeItem(slot, name, count = 1, extras = {}) {
    return {
        slot,
        type: extras.type ?? slot + 100,
        count,
        name,
        attackDamage: extras.attackDamage || 0
    };
}

function makeBot(items, heldSlot = null) {
    const slots = [];
    for (const item of items) {
        slots[item.slot] = item;
    }
    return {
        inventory: { slots },
        registry: { foodsByName: FOODS_BY_NAME },
        heldItem: heldSlot == null ? null : slots[heldSlot],
        getEquipmentDestSlot(destination) {
            return { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }[destination];
        }
    };
}

describe('itemRetention helpers', () => {
    it('defaults every retention category to two, with no per-item rules', () => {
        assert.deepEqual(Object.keys(DEFAULT_RETENTION_POLICY), [
            'helmet',
            'chestplate',
            'leggings',
            'boots',
            'shield',
            'weapon',
            'food',
            'torch'
        ]);
        for (const [id, entry] of Object.entries(DEFAULT_RETENTION_POLICY)) {
            assert.deepEqual(entry, { limit: 2, items: {} }, id);
        }
    });

    it('classifies torches and keepable food', () => {
        assert.equal(isTorch('torch'), true);
        assert.equal(isTorch('soul_torch'), true);
        assert.equal(isTorch('redstone_torch'), false);
        // Kept alongside the torches, but not something the reflex can place.
        assert.equal(isTorch('lantern'), false);
        assert.equal(isKeepableFood('bread', FOODS_BY_NAME, new Set()), true);
        assert.equal(isKeepableFood('rotten_flesh', FOODS_BY_NAME, new Set(['rotten_flesh'])), false);
    });

    it('groups equipment by slot type', () => {
        assert.equal(equipmentGroup('diamond_helmet'), 'helmet');
        assert.equal(equipmentGroup('iron_chestplate'), 'chestplate');
        assert.equal(equipmentGroup('netherite_leggings'), 'leggings');
        assert.equal(equipmentGroup('golden_boots'), 'boots');
        assert.equal(equipmentGroup('shield'), 'shield');
        assert.equal(equipmentGroup('diamond_sword'), 'weapon');
        assert.equal(equipmentGroup('iron_axe'), 'weapon');
        assert.equal(equipmentGroup('iron_pickaxe'), null);
        assert.equal(equipmentGroup('bow'), null);
        assert.equal(equipmentGroup('crossbow'), null);
        assert.equal(equipmentGroup('cobblestone'), null);
    });

    it('scores better weapons higher', () => {
        assert.ok(
            equipmentScore({ name: 'netherite_sword', attackDamage: 8 })
            > equipmentScore({ name: 'wooden_sword', attackDamage: 4 })
        );
    });
});

describe('listGiveableStacks', () => {
    it('keeps 3 torch stacks and gives the rest', () => {
        const bot = makeBot([
            makeItem(9, 'torch', 64),
            makeItem(10, 'torch', 64),
            makeItem(11, 'torch', 64),
            makeItem(12, 'torch', 32),
            makeItem(13, 'cobblestone', 64)
        ]);
        const giveable = listGiveableStacks(bot, {
            keep_torch_stacks: 3,
            keep_food_stacks: 3,
            keep_equipment_sets: 3
        });
        const torchGiven = giveable.filter((s) => s.name === 'torch');
        assert.equal(torchGiven.length, 1);
        assert.equal(torchGiven[0].count, 32);
        assert.ok(giveable.some((s) => s.name === 'cobblestone'));
    });

    it('keeps the two best food stacks', () => {
        const bot = makeBot([
            makeItem(9, 'cooked_beef', 16),
            makeItem(10, 'bread', 16),
            makeItem(11, 'apple', 16),
            makeItem(12, 'cookie', 16),
            makeItem(13, 'dirt', 64)
        ]);
        const giveable = listGiveableStacks(bot);
        const foodGiven = giveable.filter((s) => FOODS_BY_NAME[s.name]);
        assert.deepEqual(foodGiven.map((s) => s.name), ['apple', 'cookie']);
        assert.ok(giveable.some((s) => s.name === 'dirt'));
    });

    it('keeps equipped items and only the best spare in each equipment category', () => {
        const bot = makeBot([
            makeItem(5, 'leather_helmet'),
            makeItem(9, 'netherite_helmet'),
            makeItem(10, 'diamond_helmet'),
            makeItem(45, 'shield', 1),
            makeItem(11, 'shield', 1),
            makeItem(12, 'shield', 1),
            makeItem(36, 'wooden_sword', 1, { attackDamage: 4 }),
            makeItem(13, 'netherite_sword', 1, { attackDamage: 8 }),
            makeItem(14, 'diamond_sword', 1, { attackDamage: 7 })
        ], 36);
        const giveable = listGiveableStacks(bot);
        const slots = giveable.map((s) => s.slot);

        assert.equal(slots.includes(5), false, 'equipped helmet is always retained');
        assert.equal(slots.includes(45), false, 'equipped shield is always retained');
        assert.equal(slots.includes(36), false, 'held weapon is always retained');
        assert.equal(slots.includes(9), false, 'best spare helmet is retained');
        assert.equal(slots.includes(11), false, 'one spare shield is retained');
        assert.equal(slots.includes(13), false, 'best spare weapon is retained');
        assert.deepEqual([10, 12, 14].filter((slot) => slots.includes(slot)), [10, 12, 14]);
    });

    it('gives banned / special foods away as surplus', () => {
        const bot = makeBot([
            makeItem(9, 'bread', 16),
            makeItem(10, 'golden_apple', 1)
        ]);
        const giveable = listGiveableStacks(bot, {}, {
            foodsByName: { ...FOODS_BY_NAME, golden_apple: { foodPoints: 4, saturation: 9.6 } },
            bannedFood: ['golden_apple']
        });
        assert.ok(giveable.some((s) => s.name === 'golden_apple'));
        assert.equal(giveable.some((s) => s.name === 'bread'), false);
    });

    it('hands back everything outside the keep categories, full kit or not', () => {
        // A full keep set leaves no room for anything else, and nothing here
        // belongs to a keep category in the first place. Both readings have to
        // agree, because the keep list is an allow-list now.
        const junk = [
            'chest',
            'bucket',
            'redstone',
            'gold_ingot',
            'wolf_armor',
            'leather_horse_armor',
            'carved_pumpkin',
            'elytra'
        ];
        const fullKit = [
            makeItem(9, 'netherite_helmet'),
            makeItem(10, 'diamond_helmet'),
            makeItem(11, 'netherite_chestplate'),
            makeItem(12, 'diamond_chestplate'),
            makeItem(13, 'netherite_leggings'),
            makeItem(14, 'diamond_leggings'),
            makeItem(15, 'netherite_boots'),
            makeItem(16, 'diamond_boots'),
            makeItem(17, 'shield'),
            makeItem(18, 'shield'),
            makeItem(19, 'netherite_sword'),
            makeItem(20, 'diamond_sword'),
            makeItem(21, 'cooked_beef', 16),
            makeItem(22, 'bread', 16),
            makeItem(23, 'torch', 64),
            makeItem(24, 'torch', 32)
        ];
        const bot = makeBot([
            ...fullKit,
            ...junk.map((name, index) => makeItem(25 + index, name))
        ]);

        assert.deepEqual(listGiveableStacks(bot).map((stack) => stack.name), junk);
    });

    it('does not retain ranged weapons or ammunition', () => {
        const bot = makeBot([
            makeItem(9, 'bow'),
            makeItem(10, 'crossbow'),
            makeItem(11, 'arrow', 64),
            makeItem(12, 'spectral_arrow', 16)
        ]);

        assert.deepEqual(
            listGiveableStacks(bot).map((stack) => stack.name),
            ['bow', 'crossbow', 'arrow', 'spectral_arrow']
        );
    });
});

describe('per-item retention rules', () => {
    /** @param {Record<string, unknown>} retention */
    function policy(retention) {
        return { retention };
    }

    it('spends a category budget on the items the owner named', () => {
        // "two melee weapons" and "one iron sword plus one golden sword" are
        // the same budget said two different ways; both have to work.
        const bot = makeBot([
            makeItem(9, 'netherite_sword', 1, { attackDamage: 8 }),
            makeItem(10, 'iron_sword', 1, { attackDamage: 6 }),
            makeItem(11, 'iron_sword', 1, { attackDamage: 6 }),
            makeItem(12, 'golden_sword', 1, { attackDamage: 4 })
        ]);

        const given = listGiveableStacks(bot, policy({
            weapon: { limit: 2, items: { netherite_sword: 0, iron_sword: 1, golden_sword: 1 } }
        }));

        assert.deepEqual(given.map((stack) => stack.slot), [9, 11]);
    });

    it('never keeps an item struck off the list, however good it is', () => {
        const bot = makeBot([
            makeItem(9, 'netherite_helmet'),
            makeItem(10, 'iron_helmet')
        ]);

        assert.deepEqual(
            listGiveableStacks(bot, policy({ helmet: { limit: 2, items: { netherite_helmet: 0 } } }))
                .map((stack) => stack.name),
            ['netherite_helmet']
        );
    });

    it('caps one item without capping the category', () => {
        const bot = makeBot([
            makeItem(9, 'torch', 64),
            makeItem(10, 'torch', 32),
            makeItem(11, 'lantern', 16),
            makeItem(12, 'lantern', 8)
        ]);

        const given = listGiveableStacks(bot, policy({
            torch: { limit: 3, items: { lantern: 1 } }
        }));

        // Both torch stacks fit, the third slot goes to one lantern, and the
        // per-item cap sends the second lantern back.
        assert.deepEqual(given.map((stack) => stack.slot), [12]);
    });

    it('keeps what the companion is wearing even at the smallest legal total', () => {
        const bot = makeBot([
            makeItem(5, 'iron_helmet'),
            makeItem(9, 'netherite_helmet'),
            makeItem(45, 'shield'),
            makeItem(10, 'shield'),
            makeItem(36, 'iron_sword', 1, { attackDamage: 6 }),
            makeItem(11, 'netherite_sword', 1, { attackDamage: 8 })
        ], 36);

        const slots = listGiveableStacks(bot, policy({
            helmet: { limit: 1, items: {} },
            shield: { limit: 1, items: {} },
            weapon: { limit: 1, items: {} }
        })).map((stack) => stack.slot);

        assert.equal(slots.includes(5), false, 'worn helmet stays');
        assert.equal(slots.includes(45), false, 'worn shield stays');
        assert.equal(slots.includes(36), false, 'held weapon stays');
        // The worn pieces fill the budget, so every spare goes back.
        assert.deepEqual(slots, [9, 10, 11]);
    });

    it('unequips a worn piece the owner has struck off, so the box actually does something', () => {
        const bot = makeBot([
            makeItem(5, 'leather_helmet'),
            makeItem(45, 'shield')
        ]);

        const retention = policy({ helmet: { limit: 2, items: { leather_helmet: 0 } } });
        assert.deepEqual(listUnequipTargets(bot, retention), [
            { slot: 5, destination: 'head', name: 'leather_helmet' }
        ]);
        // Still equipment as far as the classifier is concerned; it is the
        // owner's policy that took it off the list.
        assert.deepEqual(listUnequipTargets(bot), []);
    });

    it('reads the four category limits an older config still carries', () => {
        const bot = makeBot([
            makeItem(9, 'torch', 64),
            makeItem(10, 'torch', 32),
            makeItem(11, 'torch', 16)
        ]);

        assert.deepEqual(
            listGiveableStacks(bot, { keep_torch_stacks: 3 }).map((stack) => stack.slot),
            []
        );
        assert.deepEqual(
            listGiveableStacks(bot, { keep_torch_stacks: 1 }).map((stack) => stack.slot),
            [10, 11]
        );
        // A retention block wins over the legacy key it replaces.
        assert.deepEqual(
            listGiveableStacks(bot, {
                keep_torch_stacks: 1,
                retention: { torch: { limit: 3, items: {} } }
            }).map((stack) => stack.slot),
            []
        );
    });
});

describe('listUnequipTargets', () => {
    it('reports worn slots holding something the companion does not keep', () => {
        const bot = makeBot([
            makeItem(5, 'diamond_helmet'),
            makeItem(6, 'chest'),
            makeItem(8, 'diamond_boots'),
            makeItem(45, 'bucket')
        ]);

        assert.deepEqual(listUnequipTargets(bot), [
            { slot: 6, destination: 'torso', name: 'chest' },
            { slot: 45, destination: 'off-hand', name: 'bucket' }
        ]);
    });

    it('never asks for an empty slot, because an empty unequip hangs', () => {
        assert.deepEqual(listUnequipTargets(makeBot([])), []);
    });

    it('leaves worn gear alone', () => {
        const bot = makeBot([
            makeItem(5, 'diamond_helmet'),
            makeItem(6, 'diamond_chestplate'),
            makeItem(7, 'diamond_leggings'),
            makeItem(8, 'diamond_boots'),
            makeItem(45, 'shield')
        ]);

        assert.deepEqual(listUnequipTargets(bot), []);
    });

    it('stops treating a worn non-keepable item as equipped', () => {
        const bot = makeBot([
            makeItem(6, 'chest'),
            makeItem(45, 'bucket'),
            makeItem(9, 'cobblestone', 64)
        ]);

        assert.deepEqual(
            listGiveableStacks(bot).map((stack) => stack.name).sort(),
            ['bucket', 'chest', 'cobblestone']
        );
    });
});

describe('shouldTransferNow', () => {
    function makeCtx(overrides = {}) {
        const ownerPos = { x: 0, y: 64, z: 0 };
        const botPos = { x: 2, y: 64, z: 0 };
        return {
            ownerName: 'Owner',
            bot: {
                entity: {
                    position: {
                        distanceTo(other) {
                            const dx = botPos.x - other.x;
                            const dy = botPos.y - other.y;
                            const dz = botPos.z - other.z;
                            return Math.sqrt(dx * dx + dy * dy + dz * dz);
                        }
                    }
                },
                players: {
                    Owner: {
                        entity: { position: ownerPos }
                    }
                },
                pvp: { target: null },
                ...(overrides.bot || {})
            },
            worldState: { visiblePlayers: [] },
            config: { owner_near_radius: 12 },
            deathRecovery: { active: false },
            graveLoot: { active: false },
            nearbyLoot: { active: false },
            itemTransfer: { active: false },
            ...overrides
        };
    }

    it('returns true when owner is near and interval elapsed', () => {
        assert.equal(shouldTransferNow(makeCtx(), {
            now: 100_000,
            lastRunAt: 0,
            intervalMs: 60_000
        }), true);
    });

    it('returns false when interval has not elapsed', () => {
        assert.equal(shouldTransferNow(makeCtx(), {
            now: 30_000,
            lastRunAt: 0,
            intervalMs: 60_000
        }), false);
    });

    it('returns false without locked owner', () => {
        assert.equal(shouldTransferNow(makeCtx({ ownerName: null }), {
            now: 100_000,
            lastRunAt: 0
        }), false);
    });

    it('returns false during death / grave / loot / dialogue / combat', () => {
        assert.equal(shouldTransferNow(makeCtx({ deathRecovery: { active: true } }), {
            now: 100_000, lastRunAt: 0
        }), false);
        assert.equal(shouldTransferNow(makeCtx({ graveLoot: { active: true } }), {
            now: 100_000, lastRunAt: 0
        }), false);
        assert.equal(shouldTransferNow(makeCtx({ nearbyLoot: { active: true } }), {
            now: 100_000, lastRunAt: 0
        }), false);
        assert.equal(shouldTransferNow(makeCtx(), {
            now: 100_000, lastRunAt: 0, dialogueBusy: true
        }), false);
        const combatCtx = makeCtx();
        combatCtx.bot.pvp = { target: { id: 1 } };
        assert.equal(shouldTransferNow(combatCtx, {
            now: 100_000, lastRunAt: 0
        }), false);

        const tacticalCtx = makeCtx({
            agent: {
                reflexes: {
                    isControllingMovement: true,
                    wantsCombat: true
                }
            }
        });
        assert.equal(shouldTransferNow(tacticalCtx, {
            now: 100_000, lastRunAt: 0
        }), false);
    });

    it('returns false when disabled', () => {
        assert.equal(shouldTransferNow(makeCtx(), {
            enabled: false,
            now: 100_000,
            lastRunAt: 0
        }), false);
    });
});

describe('PeriodicItemTransfer', () => {
    it('接近中に戦闘が所有権を得たら延期し、その後安全に再試行する', async () => {
        const events = [];
        const cobble = makeItem(9, 'cobblestone', 32);
        const slots = [];
        slots[9] = cobble;
        let ownerDistance = 10;
        const reflexes = {
            isControllingMovement: false,
            wantsCombat: false
        };
        const ownerPos = {
            x: 10, y: 64, z: 0,
            offset(x, y, z) { return { x: this.x + x, y: this.y + y, z: this.z + z }; }
        };
        const movement = {
            hasGoal: false,
            goToward() {
                events.push('owner-goal');
                this.hasGoal = true;
                reflexes.isControllingMovement = true;
                reflexes.wantsCombat = true;
            },
            stop() {
                events.push('owner-goal-stop');
                this.hasGoal = false;
            }
        };
        const ctx = {
            ownerName: 'Owner',
            ownerEntity: { position: ownerPos },
            agent: { reflexes },
            bot: {
                entity: {
                    position: { distanceTo() { return ownerDistance; } }
                },
                entities: {},
                players: { Owner: { entity: { position: ownerPos, height: 1.8 } } },
                inventory: { slots },
                registry: { foodsByName: FOODS_BY_NAME },
                pvp: { target: null, stop() { events.push('pvp-stop'); } },
                interrupt_code: false,
                async lookAt() { events.push('owner-look'); },
                async tossStack(item) {
                    events.push(`toss:${item.name}`);
                    slots[item.slot] = null;
                }
            },
            worldState: { visiblePlayers: [{ name: 'Owner' }] },
            config: { owner_near_radius: 12, nearby_loot: { give_suppress_ms: 1000 } },
            movement,
            deathRecovery: { active: false },
            graveLoot: { active: false },
            nearbyLoot: { active: false, suppressUntil: 0 },
            itemTransfer: { active: false }
        };
        const transfer = new PeriodicItemTransfer({ enabled: true, interval_ms: 0 });

        await transfer.maybeRun(ctx);

        assert.ok(events.includes('owner-goal-stop'));
        assert.equal(events.includes('owner-look'), false);
        assert.equal(events.some((event) => event.startsWith('toss:')), false);
        assert.equal(slots[9], cobble);
        assert.equal(ctx.itemTransfer.active, false);

        reflexes.isControllingMovement = false;
        reflexes.wantsCombat = false;
        ownerDistance = 1;
        await transfer.maybeRun(ctx);

        assert.ok(events.includes('owner-look'));
        assert.ok(events.includes('toss:cobblestone'));
        assert.equal(slots[9], null);
    });

    it('pauses/resumes and sets loot suppress after transfer', async () => {
        const events = [];
        const ownerPos = { x: 0, y: 64, z: 0, offset(x, y, z) { return { x: this.x + x, y: this.y + y, z: this.z + z }; } };
        const cobble = makeItem(9, 'cobblestone', 32);
        const slots = [];
        slots[9] = cobble;

        const ctx = {
            ownerName: 'Owner',
            bot: {
                entity: {
                    position: {
                        x: 1, y: 64, z: 0,
                        distanceTo() { return 1; }
                    }
                },
                players: {
                    Owner: {
                        entity: {
                            position: ownerPos,
                            height: 1.8
                        }
                    }
                },
                inventory: { slots },
                registry: { foodsByName: FOODS_BY_NAME },
                pvp: {
                    target: null,
                    stop() { events.push('pvp-stop'); }
                },
                interrupt_code: false,
                async lookAt() {},
                async tossStack(item) {
                    events.push(`toss:${item.name}`);
                    slots[item.slot] = null;
                }
            },
            worldState: { visiblePlayers: [{ name: 'Owner' }] },
            config: {
                owner_near_radius: 12,
                nearby_loot: { give_suppress_ms: 5000 }
            },
            movement: {
                stop() { events.push('stop'); },
                goToward() {}
            },
            deathRecovery: { active: false },
            graveLoot: { active: false },
            nearbyLoot: { active: false, suppressUntil: 0 },
            itemTransfer: { active: false }
        };

        const manager = {
            pause() { events.push('pause'); },
            resume() { events.push('resume'); }
        };
        const autoEquip = {
            pause() { events.push('equip-pause'); },
            resume() { events.push('equip-resume'); }
        };

        const transfer = new PeriodicItemTransfer({
            enabled: true,
            interval_ms: 0,
            keep_torch_stacks: 3,
            keep_food_stacks: 3,
            keep_equipment_sets: 3
        }, { manager, autoEquip, dialogue: { isActionBusy: false } });

        await transfer.maybeRun(ctx);

        assert.ok(events.includes('pause'));
        assert.ok(events.includes('equip-pause'));
        assert.ok(events.includes('toss:cobblestone'));
        assert.ok(events.includes('equip-resume'));
        assert.ok(events.includes('resume'));
        assert.equal(ctx.itemTransfer.active, false);
        assert.ok(ctx.nearbyLoot.suppressUntil > Date.now());
    });

    it('resumes even when toss throws', async () => {
        const events = [];
        const ownerPos = { x: 0, y: 64, z: 0, offset(x, y, z) { return { x: this.x + x, y: this.y + y, z: this.z + z }; } };
        const dirt = makeItem(9, 'dirt', 16);
        const slots = [];
        slots[9] = dirt;

        const ctx = {
            ownerName: 'Owner',
            bot: {
                entity: {
                    position: {
                        x: 1, y: 64, z: 0,
                        distanceTo() { return 1; }
                    }
                },
                players: {
                    Owner: { entity: { position: ownerPos, height: 1.8 } }
                },
                inventory: { slots },
                registry: { foodsByName: FOODS_BY_NAME },
                pvp: { target: null, stop() {} },
                interrupt_code: false,
                async lookAt() {},
                async tossStack() {
                    throw new Error('toss failed');
                }
            },
            worldState: { visiblePlayers: [{ name: 'Owner' }] },
            config: {
                owner_near_radius: 12,
                nearby_loot: { give_suppress_ms: 1000 }
            },
            movement: { stop() {}, goToward() {} },
            deathRecovery: { active: false },
            graveLoot: { active: false },
            nearbyLoot: { active: false, suppressUntil: 0 },
            itemTransfer: { active: false }
        };

        const manager = {
            pause() { events.push('pause'); },
            resume() { events.push('resume'); }
        };
        const autoEquip = {
            pause() { events.push('equip-pause'); },
            resume() { events.push('equip-resume'); }
        };

        const transfer = new PeriodicItemTransfer({
            enabled: true,
            interval_ms: 0
        }, { manager, autoEquip, dialogue: { isActionBusy: false } });

        await transfer.maybeRun(ctx);
        assert.ok(events.includes('pause'));
        assert.ok(events.includes('resume'));
        assert.ok(events.includes('equip-resume'));
        assert.equal(ctx.itemTransfer.active, false);
        assert.equal(ctx.nearbyLoot.suppressUntil, 0);
    });

    it('skips when there is nothing giveable after interval check', async () => {
        const events = [];
        const torch = makeItem(9, 'torch', 16);
        const slots = [];
        slots[9] = torch;
        const ctx = {
            ownerName: 'Owner',
            bot: {
                entity: {
                    position: {
                        distanceTo() { return 1; }
                    }
                },
                players: {
                    Owner: { entity: { position: { x: 0, y: 64, z: 0 } } }
                },
                inventory: { slots },
                registry: { foodsByName: FOODS_BY_NAME },
                pvp: { target: null }
            },
            worldState: { visiblePlayers: [{ name: 'Owner' }] },
            config: { owner_near_radius: 12 },
            deathRecovery: { active: false },
            graveLoot: { active: false },
            nearbyLoot: { active: false },
            itemTransfer: { active: false }
        };
        const transfer = new PeriodicItemTransfer({
            enabled: true,
            interval_ms: 0,
            keep_torch_stacks: 3
        }, {
            manager: { pause() { events.push('pause'); }, resume() {} },
            autoEquip: { pause() {}, resume() {} },
            dialogue: { isActionBusy: false }
        });
        await transfer.maybeRun(ctx);
        assert.equal(events.includes('pause'), false);
    });
});
