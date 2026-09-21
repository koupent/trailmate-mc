import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    ChestItemTransfer,
    isOwnerHandoffChestPlacement
} from '../src/companion/utils/ChestItemTransfer.js';
import {
    equipmentGroup,
    listChestDepositStacks
} from '../src/companion/utils/itemRetention.js';

const FOODS_BY_NAME = {
    cooked_beef: { foodPoints: 8, saturation: 12.8 },
    bread: { foodPoints: 5, saturation: 6 },
    apple: { foodPoints: 4, saturation: 2.4 },
    cookie: { foodPoints: 2, saturation: 0.4 }
};

function item(slot, name, count = 1, extras = {}) {
    return {
        slot,
        name,
        count,
        type: extras.type ?? slot + 100,
        metadata: extras.metadata ?? 0,
        nbt: extras.nbt ?? null,
        attackDamage: extras.attackDamage ?? 0
    };
}

function chestAt(x, y, z) {
    return {
        name: 'chest',
        position: {
            x,
            y,
            z,
            offset(dx, dy, dz) {
                return { x: this.x + dx, y: this.y + dy, z: this.z + dz };
            }
        }
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function makeRetentionBot(items, heldSlot = null) {
    const slots = [];
    for (const stack of items) slots[stack.slot] = stack;
    return {
        inventory: { slots },
        registry: { foodsByName: FOODS_BY_NAME },
        heldItem: heldSlot == null ? null : slots[heldSlot],
        getEquipmentDestSlot(destination) {
            return { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }[destination];
        }
    };
}

describe('handoff chest retention', () => {
    it('classifies modern melee weapons as equipment', () => {
        assert.equal(equipmentGroup('trident'), 'weapon');
        assert.equal(equipmentGroup('mace'), 'weapon');
        assert.equal(equipmentGroup('bow'), null);
        assert.equal(equipmentGroup('crossbow'), null);
    });

    it('keeps equipped gear plus the best spare, and two food and torch stacks', () => {
        const bot = makeRetentionBot([
            item(5, 'leather_helmet'),
            item(6, 'leather_chestplate'),
            item(7, 'leather_leggings'),
            item(8, 'leather_boots'),
            item(45, 'shield'),
            item(36, 'wooden_sword', 1, { attackDamage: 4 }),
            item(9, 'netherite_helmet'),
            item(10, 'diamond_helmet'),
            item(11, 'netherite_chestplate'),
            item(12, 'iron_chestplate'),
            item(13, 'diamond_leggings'),
            item(14, 'iron_leggings'),
            item(15, 'diamond_boots'),
            item(16, 'golden_boots'),
            item(17, 'shield'),
            item(18, 'shield'),
            item(19, 'netherite_sword', 1, { attackDamage: 8 }),
            item(20, 'diamond_sword', 1, { attackDamage: 7 }),
            item(21, 'cooked_beef', 16),
            item(22, 'bread', 16),
            item(23, 'apple', 16),
            item(24, 'torch', 64),
            item(25, 'soul_torch', 64),
            item(26, 'torch', 16),
            item(27, 'bow'),
            item(28, 'crossbow'),
            item(29, 'arrow', 64),
            item(30, 'cobblestone', 64)
        ], 36);

        const deposit = listChestDepositStacks(bot);
        const slots = deposit.map((stack) => stack.slot);

        for (const slot of [5, 6, 7, 8, 45, 36]) {
            assert.equal(slots.includes(slot), false, `equipped slot ${slot} is retained`);
        }
        for (const slot of [9, 11, 13, 15, 17, 19, 21, 22, 24, 25]) {
            assert.equal(slots.includes(slot), false, `best retained slot ${slot} stays`);
        }
        for (const slot of [10, 12, 14, 16, 18, 20, 23, 26, 27, 28, 29, 30]) {
            assert.equal(slots.includes(slot), true, `surplus slot ${slot} is deposited`);
        }
    });

    it('keeps the best two items when a category is not equipped', () => {
        const bot = makeRetentionBot([
            item(9, 'iron_helmet'),
            item(10, 'netherite_helmet'),
            item(11, 'diamond_helmet'),
            item(12, 'wooden_sword', 1, { attackDamage: 4 }),
            item(13, 'netherite_sword', 1, { attackDamage: 8 }),
            item(14, 'diamond_sword', 1, { attackDamage: 7 }),
            item(15, 'shield'),
            item(16, 'shield'),
            item(17, 'shield')
        ]);

        assert.deepEqual(
            listChestDepositStacks(bot).map((stack) => stack.slot),
            [9, 12, 17]
        );
    });

    it('always keeps equipped items while respecting equipment and weapon limits', () => {
        const expectedDeposits = new Map([
            [0, [9, 10, 11, 12, 13, 14]],
            [1, [9, 10, 11, 12, 13, 14]],
            [3, [11, 14]]
        ]);

        for (const [limit, expected] of expectedDeposits) {
            const bot = makeRetentionBot([
                item(45, 'shield'),
                item(9, 'shield'),
                item(10, 'shield'),
                item(11, 'shield'),
                item(36, 'wooden_sword', 1, { attackDamage: 4 }),
                item(12, 'netherite_sword', 1, { attackDamage: 8 }),
                item(13, 'diamond_sword', 1, { attackDamage: 7 }),
                item(14, 'iron_sword', 1, { attackDamage: 6 })
            ], 36);
            const deposits = listChestDepositStacks(bot, {
                keep_equipment_sets: limit,
                keep_weapon_stacks: limit
            }).map((stack) => stack.slot);

            assert.deepEqual(deposits, expected, `limit=${limit}`);
            assert.equal(deposits.includes(45), false, `equipped shield stays at limit=${limit}`);
            assert.equal(deposits.includes(36), false, `held weapon stays at limit=${limit}`);
        }
    });

    it('deposits a selected bow because ranged gear is not equipment', () => {
        const bot = makeRetentionBot([
            item(36, 'bow'),
            item(9, 'arrow', 64)
        ], 36);

        assert.deepEqual(
            listChestDepositStacks(bot).map((stack) => stack.name),
            ['arrow', 'bow']
        );
    });
});

function makeTransferWorld() {
    const bot = new EventEmitter();
    const owner = { id: 2, position: { x: 0, y: 64, z: -2 } };
    const cobble = item(9, 'cobblestone', 32);
    const sword = item(36, 'iron_sword', 1, { attackDamage: 6 });
    const slots = [];
    slots[9] = cobble;
    slots[36] = sword;
    const events = [];
    const chest = chestAt(0, 64, -2);

    bot.entity = { id: 1, yaw: 0, position: { x: 0.5, y: 64, z: 0.5 } };
    bot.players = { Owner: { entity: owner } };
    bot.inventory = { slots };
    bot.registry = { foodsByName: FOODS_BY_NAME };
    bot.heldItem = sword;
    bot.pvp = { target: null, stop() { events.push('pvp-stop'); } };
    bot.getEquipmentDestSlot = (destination) => ({
        head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45
    })[destination];
    bot.lookAt = async () => events.push('look');
    bot.blockAt = () => chest;
    bot.openContainer = async () => ({
        async deposit(type, metadata, count, nbt) {
            events.push(`deposit:${type}:${metadata}:${count}:${nbt == null}`);
            const live = slots.find((stack) => stack?.type === type);
            slots[live.slot] = null;
        },
        close() { events.push('close'); }
    });

    const manager = {
        paused: false,
        getCurrentModeId: () => 'follow',
        getActiveFsmId: () => 'follow',
        pause() { this.paused = true; events.push('pause'); },
        resume() { this.paused = false; events.push('resume'); }
    };
    const ctx = {
        ownerName: 'Owner',
        get ownerEntity() { return bot.players.Owner.entity; },
        bot,
        agent: { companion: { manager }, reflexes: { wantsCombat: false, isControllingMovement: false } },
        worldState: { visiblePlayers: [{ name: 'Owner' }] },
        config: { owner_near_radius: 12, nearby_loot: { give_suppress_ms: 1000 } },
        movement: { stop() { events.push('stop'); } },
        deathRecovery: { active: false },
        graveLoot: { active: false },
        nearbyLoot: { active: false, suppressUntil: 0 },
        itemTransfer: { active: false }
    };
    return { bot, owner, chest, cobble, sword, slots, events, manager, ctx };
}

describe('ChestItemTransfer', () => {
    it('accepts only a recent owner placement in front while following', () => {
        const { ctx, chest, manager } = makeTransferWorld();
        const oldBlock = { name: 'air' };
        assert.equal(isOwnerHandoffChestPlacement(ctx, oldBlock, chest, {
            now: 1000,
            lastOwnerSwingAt: 900,
            manager
        }), true);
        assert.equal(isOwnerHandoffChestPlacement(ctx, oldBlock, chest, {
            now: 3000,
            lastOwnerSwingAt: 900,
            manager
        }), false);
        assert.equal(isOwnerHandoffChestPlacement(ctx, oldBlock, {
            ...chest,
            position: { x: 0, y: 64, z: 2 }
        }, {
            now: 1000,
            lastOwnerSwingAt: 900,
            manager
        }), false);
        assert.equal(isOwnerHandoffChestPlacement(ctx, oldBlock, chest, {
            now: 1000,
            lastOwnerSwingAt: 900,
            manager: { ...manager, getCurrentModeId: () => 'wait' }
        }), false);
    });

    it('deposits surplus into the placed chest and never tosses it', async () => {
        const { ctx, chest, owner, slots, events, manager } = makeTransferWorld();
        const autoEquip = {
            pause() { events.push('equip-pause'); },
            resume() { events.push('equip-resume'); }
        };
        const transfer = new ChestItemTransfer({ enabled: true }, { manager, autoEquip });
        transfer.noteOwnerSwing(ctx, owner, 1000);

        const result = await transfer.handleBlockUpdate(ctx, { name: 'air' }, chest, 1100);

        assert.equal(result, 'ok');
        assert.equal(slots[9], null);
        assert.ok(slots[36], 'equipped sword is retained');
        assert.ok(events.some((event) => event.startsWith('deposit:')));
        assert.ok(events.includes('close'));
        assert.ok(events.includes('pause'));
        assert.ok(events.includes('resume'));
        assert.equal(ctx.itemTransfer.active, false);
        assert.ok(ctx.nearbyLoot.suppressUntil > Date.now());
    });

    it('also handles a block update broadcast just before the owner swing', async () => {
        const world = makeTransferWorld();
        const transfer = new ChestItemTransfer({ enabled: true }, { manager: world.manager });
        transfer.attach(world.ctx);

        world.bot.emit('blockUpdate', { name: 'air' }, world.chest);
        world.bot.emit('entitySwingArm', world.owner);
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(world.slots[9], null);
        assert.ok(world.events.some((event) => event.startsWith('deposit:')));
        transfer.detach();
    });

    it('closes and resumes when a chest deposit fails', async () => {
        const world = makeTransferWorld();
        world.bot.openContainer = async () => ({
            async deposit() { throw new Error('chest full'); },
            close() { world.events.push('close'); }
        });
        const transfer = new ChestItemTransfer({ enabled: true }, { manager: world.manager });
        transfer.noteOwnerSwing(world.ctx, world.owner, 1000);

        const result = await transfer.handleBlockUpdate(world.ctx, { name: 'air' }, world.chest, 1100);

        assert.equal(result, 'failed');
        assert.ok(world.events.includes('close'));
        assert.ok(world.events.includes('resume'));
        assert.equal(world.ctx.itemTransfer.active, false);
        assert.ok(world.slots[9]);
    });

    it('continues with a second chest placed while the first full chest is still processing', async () => {
        const world = makeTransferWorld();
        world.slots[10] = item(10, 'phantom_membrane', 8);
        world.slots[11] = item(11, 'dirt', 64);
        const secondChest = chestAt(1, 64, -2);
        let openCount = 0;
        const firstDepositStarted = deferred();
        const firstDepositBlocked = deferred();
        world.bot.putSelectedItemRange = async (_start, _end, container, fallbackSlot) => {
            assert.equal(fallbackSlot, 28);
            const selected = container.selectedItem;
            world.events.push(`restore:${selected.name}`);
            world.slots[selected.slot] = selected;
            container.selectedItem = null;
        };
        world.bot.openContainer = async () => {
            openCount += 1;
            const currentOpen = openCount;
            return {
                inventoryStart: 27,
                inventoryEnd: 63,
                selectedItem: null,
                firstEmptySlotRange() { return 28; },
                async deposit(type) {
                    const live = world.slots.find((stack) => stack?.type === type);
                    if (currentOpen === 1) {
                        if (live.name === 'cobblestone') {
                            world.slots[live.slot] = null;
                            return;
                        }
                        this.selectedItem = live;
                        world.slots[live.slot] = null;
                        firstDepositStarted.resolve();
                        await firstDepositBlocked.promise;
                        throw new Error('destination full');
                    }
                    world.slots[live.slot] = null;
                },
                close() { world.events.push(`close:${currentOpen}`); }
            };
        };

        const transfer = new ChestItemTransfer({ enabled: true }, { manager: world.manager });
        transfer.attach(world.ctx);
        transfer.noteOwnerSwing(world.ctx, world.owner, 1000);
        const firstTransfer = transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );
        await firstDepositStarted.promise;

        // Some servers publish the block update before the matching arm swing.
        world.bot.emit('blockUpdate', { name: 'air' }, secondChest);
        world.bot.emit('entitySwingArm', world.owner);
        firstDepositBlocked.resolve();
        const firstResult = await firstTransfer;

        assert.equal(firstResult, 'ok');
        assert.equal(openCount, 2);
        assert.equal(world.slots[9], null);
        assert.equal(world.slots[10], null);
        assert.equal(world.slots[11], null);
        assert.ok(world.events.includes('restore:phantom_membrane'));
        assert.deepEqual(
            world.events.filter((event) => event.startsWith('close:')),
            ['close:1', 'close:2']
        );
        assert.equal(world.ctx.itemTransfer.active, false);
        assert.equal(world.manager.paused, false);
        transfer.detach();
    });

    it('skips an unavailable stale stack and still deposits later surplus', async () => {
        const world = makeTransferWorld();
        world.slots[10] = item(10, 'phantom_membrane', 8);
        world.slots[11] = item(11, 'dirt', 64);
        const attempts = [];
        world.bot.openContainer = async () => ({
            selectedItem: null,
            async deposit(type) {
                const live = world.slots.find((stack) => stack?.type === type);
                attempts.push(live.name);
                if (live.name === 'phantom_membrane') {
                    throw new Error("Can't find phantom_membrane in slots [27 - 63]");
                }
                world.slots[live.slot] = null;
            },
            close() { world.events.push('close'); }
        });
        const transfer = new ChestItemTransfer({ enabled: true }, { manager: world.manager });
        transfer.noteOwnerSwing(world.ctx, world.owner, 1000);

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'partial');
        assert.deepEqual(attempts, ['cobblestone', 'phantom_membrane', 'dirt']);
        assert.equal(world.slots[9], null);
        assert.ok(world.slots[10]);
        assert.equal(world.slots[11], null);
        assert.ok(world.events.includes('close'));
        assert.equal(world.ctx.itemTransfer.active, false);
    });
});
