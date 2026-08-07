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

    it('keeps equipped gear, three spare weapons, three foods and three torches', () => {
        const bot = makeRetentionBot([
            item(5, 'diamond_helmet'),
            item(36, 'netherite_sword', 1, { attackDamage: 8 }),
            item(9, 'diamond_sword', 1, { attackDamage: 7 }),
            item(10, 'iron_sword', 1, { attackDamage: 6 }),
            item(11, 'bow'),
            item(12, 'wooden_sword', 1, { attackDamage: 4 }),
            item(13, 'cooked_beef', 16),
            item(14, 'bread', 16),
            item(15, 'apple', 16),
            item(16, 'cookie', 16),
            item(17, 'torch', 64),
            item(18, 'torch', 64),
            item(19, 'soul_torch', 64),
            item(20, 'torch', 16),
            item(21, 'iron_chestplate'),
            item(22, 'cobblestone', 64),
            item(23, 'crossbow'),
            item(24, 'arrow', 64),
            item(25, 'spectral_arrow', 16)
        ], 36);

        const deposit = listChestDepositStacks(bot, {
            keep_weapon_stacks: 3,
            keep_food_stacks: 3,
            keep_torch_stacks: 3
        });
        const slots = deposit.map((stack) => stack.slot);

        assert.equal(slots.includes(5), false, 'worn armor stays equipped');
        assert.equal(slots.includes(36), false, 'held weapon stays equipped');
        assert.deepEqual([9, 10, 12].filter((slot) => slots.includes(slot)), []);
        assert.equal(slots.includes(11), true, 'bow is deposited');
        assert.equal(slots.includes(23), true, 'crossbow is deposited');
        assert.equal(slots.includes(24), true, 'arrows are deposited');
        assert.equal(slots.includes(25), true, 'special arrows are deposited');
        assert.equal(slots.includes(16), true, 'fourth food stack is deposited');
        assert.equal(slots.includes(20), true, 'fourth torch stack is deposited');
        assert.equal(slots.includes(21), true, 'unworn spare armor is deposited');
        assert.equal(slots.includes(22), true, 'ordinary blocks are deposited');
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
    const chest = {
        name: 'chest',
        position: {
            x: 0,
            y: 64,
            z: -2,
            offset(x, y, z) { return { x: this.x + x, y: this.y + y, z: this.z + z }; }
        }
    };

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
});
