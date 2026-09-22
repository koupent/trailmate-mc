import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChestItemTransfer } from '../src/companion/utils/ChestItemTransfer.js';
import {
    classifyDepositError,
    containerHasRoom,
    countTypeInWindowInventory,
    readOpenContainerInventory
} from '../src/companion/utils/containerWindow.js';
import { listChestDepositStacks } from '../src/companion/utils/itemRetention.js';
import {
    CHEST_SLOT_COUNTS,
    FakeContainerWindow,
    putSelectedItemRange
} from './helpers/containerWindow.js';

const FOODS_BY_NAME = {
    cooked_beef: { foodPoints: 8, saturation: 12.8 },
    bread: { foodPoints: 5, saturation: 6 }
};

let nextType = 100;
function item(slot, name, count = 1, extras = {}) {
    return {
        slot,
        name,
        count,
        type: extras.type ?? (nextType += 1),
        metadata: extras.metadata ?? 0,
        nbt: extras.nbt ?? null,
        stackSize: extras.stackSize ?? 64,
        attackDamage: extras.attackDamage ?? 0
    };
}

function chestAt(x, y, z) {
    return { name: 'chest', position: { x, y, z } };
}

/**
 * A companion world whose chests are real container windows.
 * @param {{ items?: object[], chestContents?: Record<number, object>, containerSlotCount?: number }} [options]
 */
function makeWorld(options = {}) {
    const bot = new EventEmitter();
    const owner = { id: 2, position: { x: 0, y: 64, z: -2 } };
    const slots = [];
    const stacks = options.items || [
        item(36, 'iron_sword', 1, { attackDamage: 6 }),
        item(9, 'cobblestone', 64),
        item(10, 'dirt', 64),
        item(44, 'chest', 3)
    ];
    for (const stack of stacks) slots[stack.slot] = stack;
    for (let slot = 0; slot < 46; slot += 1) {
        if (slots[slot] === undefined) slots[slot] = null;
    }

    const events = [];
    const chest = chestAt(0, 64, -2);
    /** @type {FakeContainerWindow[]} */
    const windows = [];
    /** Mutable so a test can change what happens mid-deposit. */
    const hooks = {
        onDeposit: options.onDeposit || null,
        onClose: options.onClose || null
    };

    bot.entity = { id: 1, yaw: 0, position: { x: 0.5, y: 64, z: 0.5 } };
    bot.players = { Owner: { entity: owner } };
    bot.inventory = { slots, inventoryStart: 9, inventoryEnd: 45 };
    bot.registry = { foodsByName: FOODS_BY_NAME };
    bot.currentWindow = null;
    Object.defineProperty(bot, 'heldItem', {
        get() {
            return bot.inventory.slots[36] || null;
        }
    });
    bot.pvp = { target: null, stop() { events.push('pvp-stop'); } };
    bot.getEquipmentDestSlot = (destination) => ({
        head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45
    })[destination];
    bot.lookAt = async () => events.push('look');
    bot.blockAt = () => chest;
    /**
     * Mineflayer's `unequip`: move the worn item into the inventory proper.
     * Calling it on an empty slot blocks for ~4s in the real client, so the
     * fake records every call and refuses one.
     */
    bot.unequip = async (destination) => {
        events.push(`unequip:${destination}`);
        const slot = bot.getEquipmentDestSlot(destination);
        const worn = bot.inventory.slots[slot];
        if (!worn) throw new Error(`unequip on empty slot ${slot}`);
        const free = bot.inventory.slots.findIndex(
            (stack, index) => index >= 9 && index < 45 && !stack
        );
        if (free === -1) throw new Error('inventory is full');
        bot.inventory.slots[slot] = null;
        bot.inventory.slots[free] = { ...worn, slot: free };
    };
    bot.putSelectedItemRange = async (start, end, window, slot) => {
        putSelectedItemRange(start, end, window, slot);
        events.push('restore');
    };
    bot.openContainer = async () => {
        const window = new FakeContainerWindow(bot, {
            id: windows.length + 1,
            containerSlotCount: options.containerSlotCount ?? CHEST_SLOT_COUNTS.single,
            contents: options.chestContents,
            events,
            onDeposit: (win, order) => hooks.onDeposit?.(win, order, windows.length),
            onClose: (win) => hooks.onClose?.(win, windows.length)
        });
        windows.push(window);
        bot.currentWindow = window;
        return window;
    };

    const manager = {
        paused: false,
        getCurrentModeId: () => 'follow',
        getActiveFsmId: () => 'follow',
        pause() { this.paused = true; },
        resume() { this.paused = false; }
    };
    const spoken = [];
    const dialogue = {
        isActionBusy: false,
        async speakNotice(key) {
            spoken.push(key);
            return true;
        }
    };
    const ctx = {
        ownerName: 'Owner',
        get ownerEntity() { return bot.players.Owner.entity; },
        bot,
        agent: {
            companion: { manager },
            reflexes: { wantsCombat: false, isControllingMovement: false }
        },
        worldState: { visiblePlayers: [{ name: 'Owner' }] },
        config: { owner_near_radius: 12, nearby_loot: { give_suppress_ms: 1000 } },
        movement: { stop() { events.push('stop'); } },
        deathRecovery: { active: false },
        graveLoot: { active: false },
        nearbyLoot: { active: false, suppressUntil: 0 },
        itemTransfer: { active: false }
    };
    return { bot, owner, chest, slots, events, manager, dialogue, spoken, windows, hooks, ctx };
}

/** @param {object[]} slots */
function heldCounts(slots) {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const stack of slots) {
        if (!stack?.name) continue;
        counts[stack.name] = (counts[stack.name] || 0) + stack.count;
    }
    return counts;
}

function makeTransfer(world, config = {}) {
    const transfer = new ChestItemTransfer(
        { enabled: true, ...config },
        { manager: world.manager, dialogue: world.dialogue }
    );
    transfer.noteOwnerSwing(world.ctx, world.owner, 1000);
    return transfer;
}

describe('deposit error classification', () => {
    it('separates a full chest, a stale source, and everything else', () => {
        assert.equal(classifyDepositError(new Error('destination full')), 'full');
        assert.equal(
            classifyDepositError(new Error("Can't find chest in slots [27 - 63], (item id: 54)")),
            'stale'
        );
        assert.equal(classifyDepositError(new Error('Event windowOpen did not fire')), 'other');
        assert.equal(classifyDepositError(undefined), 'unknown');
        assert.equal(classifyDepositError(null), 'unknown');
        assert.equal(classifyDepositError(new Error('')), 'unknown');
    });
});

describe('container window reading', () => {
    it('maps window slots back to inventory slots for single and large chests', () => {
        for (const containerSlotCount of [CHEST_SLOT_COUNTS.single, CHEST_SLOT_COUNTS.large]) {
            const world = makeWorld({ containerSlotCount });
            const window = new FakeContainerWindow(world.bot, { containerSlotCount });

            assert.equal(window.inventoryStart, containerSlotCount);
            assert.equal(window.inventoryEnd, containerSlotCount + 36);
            assert.equal(window.toWindowSlot(9), containerSlotCount);
            assert.equal(window.toWindowSlot(44), containerSlotCount + 35);

            const live = readOpenContainerInventory(world.bot, window);
            const bySlot = new Map(live.stacks.map((stack) => [stack.slot, stack.name]));
            assert.equal(bySlot.get(9), 'cobblestone', `single/large slot 9 @ ${containerSlotCount}`);
            assert.equal(bySlot.get(36), 'iron_sword');
            assert.equal(bySlot.get(44), 'chest', 'the last hotbar slot is still reachable');
            assert.deepEqual([...live.depositable].sort((a, b) => a - b), [9, 10, 36, 44]);
        }
    });

    it('counts and reports free space from the window, not from bot.inventory', () => {
        const world = makeWorld();
        const window = new FakeContainerWindow(world.bot, {});
        const cobblestone = world.slots[9].type;

        assert.equal(countTypeInWindowInventory(window, cobblestone), 64);
        assert.equal(containerHasRoom(window), true);

        const contents = {};
        for (let slot = 0; slot < 27; slot += 1) contents[slot] = item(slot, 'stone', 64);
        const full = new FakeContainerWindow(world.bot, { contents });
        assert.equal(containerHasRoom(full), false);
    });

    it('reports nothing readable for a container without window slots', () => {
        const world = makeWorld();
        assert.equal(readOpenContainerInventory(world.bot, { deposit() {}, close() {} }), null);
        assert.equal(countTypeInWindowInventory({ close() {} }, 1), null);
        assert.equal(containerHasRoom({ close() {} }), null);
    });
});

describe('chest deposit convergence', () => {
    it('deposits every unclassified item, including a chest, and leaves nothing behind', async () => {
        const world = makeWorld({
            items: [
                item(5, 'iron_helmet'),
                item(6, 'iron_chestplate'),
                item(7, 'iron_leggings'),
                item(8, 'iron_boots'),
                item(45, 'shield'),
                item(36, 'iron_sword', 1, { attackDamage: 6 }),
                item(9, 'cooked_beef', 12),
                item(10, 'bread', 12),
                item(11, 'torch', 64),
                item(12, 'torch', 32),
                item(13, 'chest', 3),
                item(14, 'bucket', 1),
                item(15, 'redstone', 40),
                item(16, 'gold_ingot', 8),
                item(17, 'redstone_torch', 16),
                item(44, 'chest', 1)
            ]
        });
        const transfer = makeTransfer(world);

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'ok');
        assert.deepEqual(world.windows[0].containerContents(), {
            chest: 4,
            bucket: 1,
            redstone: 40,
            gold_ingot: 8,
            redstone_torch: 16
        });
        assert.deepEqual(heldCounts(world.slots), {
            iron_helmet: 1,
            iron_chestplate: 1,
            iron_leggings: 1,
            iron_boots: 1,
            shield: 1,
            iron_sword: 1,
            cooked_beef: 12,
            bread: 12,
            torch: 96
        });
        assert.equal(listChestDepositStacks(world.bot).length, 0);
        assert.deepEqual(world.spoken, ['chest_deposit_done']);
    });

    it('unequips worn surplus so a deposit can reach the armor and off-hand slots', async () => {
        const world = makeWorld({
            items: [
                item(5, 'iron_helmet'),
                // No container window maps these slots, so a deposit alone can
                // never move what sits in them.
                item(6, 'chest', 1),
                item(8, 'iron_boots'),
                item(45, 'bucket', 1),
                item(36, 'iron_sword', 1, { attackDamage: 6 }),
                item(9, 'cobblestone', 64)
            ]
        });
        const transfer = makeTransfer(world);

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'ok');
        assert.deepEqual(world.windows[0].containerContents(), {
            chest: 1,
            bucket: 1,
            cobblestone: 64
        });
        assert.deepEqual(heldCounts(world.slots), {
            iron_helmet: 1,
            iron_boots: 1,
            iron_sword: 1
        });
        assert.deepEqual(
            world.events.filter((event) => event.startsWith('unequip:')),
            ['unequip:torso', 'unequip:off-hand'],
            'worn gear is left alone and no empty slot is unequipped'
        );
        assert.equal(listChestDepositStacks(world.bot).length, 0);
        assert.deepEqual(world.spoken, ['chest_deposit_done']);
    });

    it('re-opens for worn surplus that a full inventory had no room for', async () => {
        // `unequip` moves the item into the inventory, so a full inventory has
        // to be drained first. Four repeated types keep the chest roomy.
        const filler = ['dirt', 'cobblestone', 'flint', 'gravel'];
        const types = new Map(filler.map((name) => [name, (nextType += 1)]));
        const packed = [];
        for (let slot = 9; slot < 45; slot += 1) {
            const name = filler[slot % filler.length];
            packed.push(item(slot, name, 1, { type: types.get(name) }));
        }
        const world = makeWorld({ items: [...packed, item(45, 'bucket', 1)] });
        const transfer = makeTransfer(world);

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'ok');
        assert.equal(world.windows.length, 2, 'the second pass has room to unequip into');
        assert.deepEqual(world.windows[1].containerContents().bucket, 1);
        assert.deepEqual(heldCounts(world.slots), {});
        assert.deepEqual(
            world.events.filter((event) => event.startsWith('unequip:')),
            ['unequip:off-hand', 'unequip:off-hand'],
            'the first attempt fails against a full inventory, the second lands'
        );
    });

    it('opens the chest for worn surplus even when nothing else is deposited', async () => {
        const world = makeWorld({
            items: [
                item(45, 'bucket', 1),
                item(36, 'iron_sword', 1, { attackDamage: 6 })
            ]
        });
        const transfer = makeTransfer(world);

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'ok');
        assert.deepEqual(world.windows[0].containerContents(), { bucket: 1 });
        assert.deepEqual(heldCounts(world.slots), { iron_sword: 1 });
    });

    it('re-plans from the open window instead of replaying the opening snapshot', async () => {
        let injected = false;
        const world = makeWorld({
            onDeposit: (window) => {
                if (injected) return;
                injected = true;
                // A pickup lands in the window while the container is open;
                // bot.inventory stays frozen until close.
                window.setInventorySlot(20, item(20, 'flint', 7));
            }
        });
        const transfer = makeTransfer(world);

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'ok');
        assert.equal(
            world.windows.length,
            1,
            'the live plan picks the new item up without re-opening'
        );
        assert.deepEqual(world.windows[0].containerContents(), {
            cobblestone: 64,
            dirt: 64,
            chest: 3,
            flint: 7
        });
        assert.deepEqual(heldCounts(world.slots), { iron_sword: 1 });
    });

    it('re-opens the chest when surplus only shows up after the window closes', async () => {
        let settled = false;
        const world = makeWorld({
            onClose: (window) => {
                if (settled) return;
                settled = true;
                // The server settles a pickup as the window closes, so it is
                // only visible once bot.inventory is trustworthy again.
                window.bot.inventory.slots[21] = item(21, 'flint', 5);
            }
        });
        const transfer = makeTransfer(world);

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'ok');
        assert.equal(world.windows.length, 2, 'a second pass picks the late arrival up');
        assert.deepEqual(world.windows[1].containerContents(), { flint: 5 });
        assert.deepEqual(heldCounts(world.slots), { iron_sword: 1 });
        assert.deepEqual(world.spoken, ['chest_deposit_done']);
    });

    it('keeps what does not fit and tells the owner the chest is full', async () => {
        const contents = {};
        for (let slot = 0; slot < 26; slot += 1) contents[slot] = item(slot, 'stone', 64);
        const world = makeWorld({ chestContents: contents });
        const transfer = makeTransfer(world);

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'partial');
        assert.equal(world.windows[0].emptyContainerSlots(), 0);
        assert.equal(world.windows[0].containerContents().cobblestone, 64);

        const held = heldCounts(world.slots);
        assert.equal(held.iron_sword, 1);
        assert.equal(held.dirt + (held.chest || 0) > 0, true, 'the rest stays in hand');
        assert.equal(
            (held.dirt || 0) + (held.chest || 0),
            67,
            'nothing that did not fit is dropped'
        );
        assert.deepEqual(world.spoken, ['chest_full']);
    });

    it('closes, remembers, and resumes a deposit that combat interrupted', async () => {
        const world = makeWorld({
            onDeposit: () => {
                // Taking a hit hands control to combat mid-transfer.
                world.ctx.agent.reflexes.wantsCombat = true;
            }
        });
        const transfer = makeTransfer(world, { resume_retry_ms: 1000 });

        const first = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(first, 'partial');
        assert.equal(world.windows[0].closed, true, 'the container is closed before yielding');
        assert.equal(world.ctx.itemTransfer.active, false);
        assert.equal(world.manager.paused, false);
        assert.ok(transfer.pendingResume, 'the chest is remembered');
        assert.deepEqual(transfer.pendingResume.position, world.chest.position);
        assert.deepEqual(world.spoken, ['chest_deposit_later']);
        assert.ok(listChestDepositStacks(world.bot).length > 0, 'surplus is still in hand');

        // Combat ends and the retry window opens.
        world.ctx.agent.reflexes.wantsCombat = false;
        world.hooks.onDeposit = null;
        const resumed = await transfer.maybeResume(world.ctx, Date.now() + 1500);

        assert.equal(resumed, 'ok');
        assert.equal(transfer.pendingResume, null);
        assert.deepEqual(world.spoken, ['chest_deposit_later', 'chest_deposit_resume', 'chest_deposit_done']);
        assert.deepEqual(heldCounts(world.slots), { iron_sword: 1 });
        assert.equal(listChestDepositStacks(world.bot).length, 0);
    });

    it('waits for control and gives up on a chest that is gone', async () => {
        const world = makeWorld({
            onDeposit: () => {
                world.ctx.agent.reflexes.wantsCombat = true;
            }
        });
        const transfer = makeTransfer(world, { resume_retry_ms: 1000 });
        await transfer.handleBlockUpdate(world.ctx, { name: 'air' }, world.chest, 1100);
        assert.ok(transfer.pendingResume);

        const base = Date.now();
        assert.equal(await transfer.maybeResume(world.ctx, base), 'waiting', 'retry interval');
        assert.equal(
            await transfer.maybeResume(world.ctx, base + 1500),
            'waiting',
            'combat still owns control'
        );

        world.ctx.agent.reflexes.wantsCombat = false;
        world.bot.blockAt = () => ({ name: 'air', position: world.chest.position });
        assert.equal(await transfer.maybeResume(world.ctx, base + 4000), 'gone');
        assert.equal(transfer.pendingResume, null);
    });

    it('drops the resume once it expires', async () => {
        const world = makeWorld({
            onDeposit: () => {
                world.ctx.agent.reflexes.wantsCombat = true;
            }
        });
        const transfer = makeTransfer(world, { resume_expire_ms: 5000 });
        await transfer.handleBlockUpdate(world.ctx, { name: 'air' }, world.chest, 1100);
        assert.ok(transfer.pendingResume);

        assert.equal(await transfer.maybeResume(world.ctx, Date.now() + 6000), 'expired');
        assert.equal(transfer.pendingResume, null);
    });

    it('never records a resume when resuming is disabled', async () => {
        const world = makeWorld({
            onDeposit: () => {
                world.ctx.agent.reflexes.wantsCombat = true;
            }
        });
        const transfer = makeTransfer(world, { resume_enabled: false });

        await transfer.handleBlockUpdate(world.ctx, { name: 'air' }, world.chest, 1100);

        assert.equal(transfer.pendingResume, null);
        assert.equal(await transfer.maybeResume(world.ctx), 'disabled');
        assert.deepEqual(world.spoken, ['chest_deposit_partial']);
    });

    it('keeps depositing after one item type fails', async () => {
        const world = makeWorld({
            onDeposit: (window, order) => {
                if (window.slots.some((slot) => slot?.type === order.itemType && slot.name === 'dirt')) {
                    throw new Error('Event windowOpen did not fire');
                }
            }
        });
        const transfer = makeTransfer(world);

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'partial');
        assert.deepEqual(world.windows[0].containerContents(), { cobblestone: 64, chest: 3 });
        assert.deepEqual(heldCounts(world.slots), { iron_sword: 1, dirt: 64 });
        assert.deepEqual(world.spoken, ['chest_deposit_partial']);
    });

    it('does not abort on the damage latch when the bot is told to hold on', async () => {
        const world = makeWorld({
            onDeposit: () => {
                world.ctx.agent.reflexes.wantsCombat = true;
            }
        });
        const transfer = makeTransfer(world, { abort_on_recent_damage: false });

        const result = await transfer.handleBlockUpdate(
            world.ctx,
            { name: 'air' },
            world.chest,
            1100
        );

        assert.equal(result, 'ok');
        assert.equal(transfer.pendingResume, null);
        assert.deepEqual(heldCounts(world.slots), { iron_sword: 1 });

        // Real combat still takes the chest away.
        world.ctx.agent.reflexes.isControllingMovement = true;
        assert.equal(transfer._shouldAbort(world.ctx), true);
    });
});
