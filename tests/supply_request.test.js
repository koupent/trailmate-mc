import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CompanionDialogue } from '../src/companion/CompanionDialogue.js';
import { renderCommentary } from '../src/companion/dialogueParse.js';
import {
    RETENTION_CATEGORIES,
    listGiveableStacks,
    listRetentionStock
} from '../src/companion/utils/itemRetention.js';
import { SupplyRequestTracker } from '../src/companion/utils/SupplyRequestTracker.js';

const FOODS_BY_NAME = {
    cooked_beef: { foodPoints: 8, saturation: 12.8 },
    bread: { foodPoints: 5, saturation: 6 }
};

const FULL_KIT = [
    [5, 'diamond_helmet'],
    [6, 'diamond_chestplate'],
    [7, 'diamond_leggings'],
    [8, 'diamond_boots'],
    [45, 'shield'],
    [36, 'diamond_sword'],
    [9, 'iron_helmet'],
    [10, 'iron_chestplate'],
    [11, 'iron_leggings'],
    [12, 'iron_boots'],
    [13, 'shield'],
    [14, 'iron_sword'],
    [15, 'bread', 64],
    [16, 'cooked_beef', 3],
    [17, 'torch', 64],
    [18, 'torch', 1]
];

function makeBot(entries) {
    const slots = [];
    for (const [slot, name, count = 1] of entries) {
        slots[slot] = { slot, type: slot + 100, count, name, attackDamage: 0 };
    }
    return {
        inventory: { slots, inventoryStart: 9, inventoryEnd: 45 },
        registry: { foodsByName: FOODS_BY_NAME },
        heldItem: slots[36] || null,
        getEquipmentDestSlot(destination) {
            return { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }[destination];
        }
    };
}

/** Drop the listed inventory slots from a full kit. */
function kitWithout(...slots) {
    const dropped = new Set(slots);
    return FULL_KIT.filter(([slot]) => !dropped.has(slot));
}

function missingIds(stock) {
    return stock.filter((entry) => entry.missing > 0).map((entry) => entry.id);
}

function makeDialogue(entries, { chat = {}, ctx = null, language = 'ja' } = {}) {
    const messages = [];
    const agent = {
        bot: makeBot(entries),
        language,
        shut_up: false,
        companion: ctx ? { ctx } : undefined,
        async openChat(message) {
            messages.push(message);
        }
    };
    const manager = {
        interrupts: [],
        getModeCatalog: () => [],
        getCurrentModeId: () => 'wait',
        pause() {},
        resume() {}
    };
    const dialogue = new CompanionDialogue(agent, manager, {
        chat: {
            min_interval_ms: 0,
            priority_min_interval_ms: 0,
            event_cooldown_ms: 0,
            spontaneous_chance: 1,
            idle_chance: 0,
            ...chat
        }
    });
    dialogue._buildSnapshot = () => ({
        mode: 'wait',
        controlOwner: 'wait',
        owner: null,
        health: 20,
        hunger: 20,
        stuckSeconds: 0,
        stuckAlert: false,
        isNight: false,
        hostile: null,
        combatTarget: null,
        lastDamageAgeMs: null,
        inventoryUsedSlots: 0,
        inventoryTotalSlots: 36,
        inventoryEmptySlots: 36,
        inventoryFillPercent: 0
    });
    return { agent, dialogue, messages };
}

describe('listRetentionStock', () => {
    it('lists every retention category in request order', () => {
        assert.deepEqual(
            listRetentionStock(makeBot(FULL_KIT)).map((entry) => entry.id),
            ['helmet', 'chestplate', 'leggings', 'boots', 'shield', 'weapon', 'food', 'torch']
        );
    });

    it('reports no shortage while worn and spare pieces reach the target', () => {
        assert.deepEqual(missingIds(listRetentionStock(makeBot(FULL_KIT))), []);
    });

    it('counts a worn piece plus one spare as two', () => {
        const stock = listRetentionStock(makeBot(kitWithout(9)));
        const helmet = stock.find((entry) => entry.id === 'helmet');
        assert.deepEqual(helmet, { id: 'helmet', current: 1, target: 2, missing: 1 });
    });

    it('counts a partial food or torch stack as a whole stack', () => {
        const stock = listRetentionStock(makeBot(FULL_KIT));
        assert.deepEqual(
            stock.find((entry) => entry.id === 'food'),
            { id: 'food', current: 2, target: 2, missing: 0 }
        );
        assert.deepEqual(
            stock.find((entry) => entry.id === 'torch'),
            { id: 'torch', current: 2, target: 2, missing: 0 }
        );
    });

    it('asks for food and torches once a stack is spent', () => {
        assert.deepEqual(
            missingIds(listRetentionStock(makeBot(kitWithout(16, 18)))),
            ['food', 'torch']
        );
    });

    it('reads targets from the same settings as the keep decision', () => {
        const bot = makeBot(kitWithout(9, 10, 11, 12, 13, 14));
        const policy = {
            keep_equipment_sets: 1,
            keep_weapon_stacks: 1,
            keep_food_stacks: 1,
            keep_torch_stacks: 1
        };
        assert.deepEqual(missingIds(listRetentionStock(bot, policy)), []);
        // keep_equipment_sets covers armor and the shield; the rest keep their own key.
        assert.deepEqual(
            missingIds(listRetentionStock(bot, { keep_equipment_sets: 3 })),
            ['helmet', 'chestplate', 'leggings', 'boots', 'shield', 'weapon']
        );
        assert.deepEqual(
            missingIds(listRetentionStock(makeBot(FULL_KIT), { keep_food_stacks: 3 })),
            ['food']
        );
    });

    it('shares its category ids with the retention rules', () => {
        assert.deepEqual(
            RETENTION_CATEGORIES.map((category) => category.id),
            listRetentionStock(makeBot([])).map((entry) => entry.id)
        );
        // The keep decision still hands over everything outside those categories.
        assert.deepEqual(
            listGiveableStacks(makeBot([...FULL_KIT, [19, 'cobblestone', 64]]))
                .map((stack) => stack.name),
            ['cobblestone']
        );
    });
});

describe('SupplyRequestTracker', () => {
    const stockOf = (missing) => Object.entries(missing)
        .map(([id, value]) => ({ id, missing: value }));

    it('asks once for a shortage that is already there at startup', () => {
        const tracker = new SupplyRequestTracker();
        const event = tracker.observe(stockOf({ shield: 1, food: 2 }));
        assert.equal(event?.id, 'supply_request');
        assert.deepEqual(event.supplyCategories, ['shield', 'food']);
    });

    it('stays quiet while the same shortage lasts and speaks when it worsens', () => {
        const tracker = new SupplyRequestTracker();
        tracker.observe(stockOf({ food: 1 }));
        tracker.markDelivered();

        assert.equal(tracker.observe(stockOf({ food: 1 })), null);
        assert.equal(tracker.observe(stockOf({ food: 2 }))?.id, 'supply_request');
    });

    it('never speaks for a restock on its own', () => {
        const tracker = new SupplyRequestTracker();
        tracker.observe(stockOf({ food: 2 }));
        tracker.markDelivered();

        assert.equal(tracker.observe(stockOf({ food: 1 })), null);
        assert.equal(tracker.observe(stockOf({ food: 0 })), null);
    });

    it('asks again after a restock to target is spent', () => {
        const tracker = new SupplyRequestTracker();
        tracker.observe(stockOf({ food: 1 }));
        tracker.markDelivered();
        tracker.observe(stockOf({ food: 0 }));
        assert.equal(tracker.observe(stockOf({ food: 1 }))?.id, 'supply_request');
    });

    it('asks again when a partial restock is spent back down', () => {
        const tracker = new SupplyRequestTracker();
        tracker.observe(stockOf({ food: 2 }));
        tracker.markDelivered();
        assert.equal(tracker.observe(stockOf({ food: 1 })), null);
        assert.equal(tracker.observe(stockOf({ food: 2 }))?.id, 'supply_request');
    });

    it('merges categories that fall short while a request waits', () => {
        const tracker = new SupplyRequestTracker();
        tracker.observe(stockOf({ shield: 0, weapon: 0, food: 1 }));
        const event = tracker.observe(stockOf({ shield: 1, weapon: 1, food: 1 }));
        assert.deepEqual(event.supplyCategories, ['shield', 'weapon', 'food']);
    });

    it('drops a category restocked before the request is sent', () => {
        const tracker = new SupplyRequestTracker();
        tracker.observe(stockOf({ shield: 1, food: 1 }));
        const event = tracker.observe(stockOf({ shield: 0, food: 1 }));
        assert.deepEqual(event.supplyCategories, ['food']);
    });

    it('lists categories in retention order whenever they were queued', () => {
        const tracker = new SupplyRequestTracker();
        tracker.observe(stockOf({ shield: 0, weapon: 0, food: 1 }));
        const event = tracker.observe(stockOf({ shield: 1, weapon: 0, food: 1 }));
        assert.deepEqual(event.supplyCategories, ['shield', 'food']);
    });

    it('absorbs a shortage the sweep itself created', () => {
        const tracker = new SupplyRequestTracker();
        tracker.observe(stockOf({ shield: 0, food: 0 }));
        tracker.acknowledge(stockOf({ shield: 2, food: 2 }));
        assert.equal(tracker.peek(), null);
        assert.equal(tracker.observe(stockOf({ shield: 2, food: 2 })), null);
    });

    it('absorbs only the categories a partial sweep emptied', () => {
        const tracker = new SupplyRequestTracker();
        assert.ok(tracker.observe(stockOf({ shield: 1, food: 0 })));
        tracker.acknowledge(stockOf({ shield: 1, food: 2 }));
        assert.deepEqual(tracker.peek()?.supplyCategories, ['shield']);
    });

    it('asks again after an acknowledged category is restocked and spent', () => {
        const tracker = new SupplyRequestTracker();
        tracker.acknowledge(stockOf({ food: 2 }));
        assert.equal(tracker.observe(stockOf({ food: 2 })), null);
        tracker.observe(stockOf({ food: 0 }));
        assert.equal(tracker.observe(stockOf({ food: 1 }))?.id, 'supply_request');
    });
});

describe('supply request dialogue', () => {
    it('asks for the missing categories in one chat line', async () => {
        const { dialogue, messages } = makeDialogue(kitWithout(13, 14, 16));

        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);
        assert.match(messages[0], /^盾、近接武器、食料/);
    });

    it('stays silent when the whole kit is stocked', async () => {
        const { dialogue, messages } = makeDialogue(FULL_KIT);

        await dialogue.maybeSpeak();
        await dialogue.maybeSpeak();
        assert.deepEqual(messages, []);
    });

    it('does not repeat an unchanged shortage', async () => {
        const { dialogue, messages } = makeDialogue(kitWithout(16));

        await dialogue.maybeSpeak();
        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);
    });

    it('holds a deferred request until an urgent event has passed', async () => {
        const { dialogue, messages } = makeDialogue(kitWithout(13), {
            chat: { priority_min_interval_ms: 60_000 }
        });
        dialogue.lastChatAt = Date.now();

        await dialogue.maybeSpeak();
        assert.deepEqual(messages, []);

        dialogue.lastChatAt = 0;
        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);
        assert.match(messages[0], /^盾/);
    });

    it('drops a category restocked while the request waited', async () => {
        const { agent, dialogue, messages } = makeDialogue(kitWithout(13, 16), {
            chat: { priority_min_interval_ms: 60_000 }
        });
        dialogue.lastChatAt = Date.now();

        await dialogue.maybeSpeak();
        assert.deepEqual(messages, []);

        agent.bot = makeBot(kitWithout(16));
        dialogue.lastChatAt = 0;
        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);
        assert.match(messages[0], /^食料/);
    });

    it('stays silent while chat is disabled or the companion is hushed', async () => {
        const disabled = makeDialogue(kitWithout(13), { chat: { enabled: false } });
        await disabled.dialogue.maybeSpeak();
        assert.deepEqual(disabled.messages, []);

        const hushed = makeDialogue(kitWithout(13));
        hushed.agent.shut_up = true;
        await hushed.dialogue.maybeSpeak();
        assert.deepEqual(hushed.messages, []);
    });

    it('stays silent while an item handoff is running', async () => {
        const ctx = { itemTransfer: { active: true } };
        const { dialogue, messages } = makeDialogue(kitWithout(13), { ctx });

        await dialogue.maybeSpeak();
        assert.deepEqual(messages, []);

        ctx.itemTransfer.active = false;
        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);
    });

    it('holds the shortage check during death recovery and asks once it ends', async () => {
        const ctx = {
            deathRecovery: { pending: false, active: false },
            graveLoot: { active: false }
        };
        const { agent, dialogue, messages } = makeDialogue(FULL_KIT, { ctx });

        await dialogue.maybeSpeak();
        assert.deepEqual(messages, []);

        ctx.deathRecovery.pending = true;
        agent.bot = makeBot([]);
        await dialogue.maybeSpeak();
        ctx.deathRecovery.pending = false;
        ctx.deathRecovery.active = true;
        await dialogue.maybeSpeak();
        assert.deepEqual(messages, []);

        // Recovery brought back everything but the spare shield.
        ctx.deathRecovery.active = false;
        agent.bot = makeBot(kitWithout(13));
        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);
        assert.match(messages[0], /^盾/);
    });

    it('does not report the shortage a 全回収 sweep created', async () => {
        const ctx = makeGiveAllCtx(FULL_KIT);
        const { agent, dialogue, messages } = makeDialogue(FULL_KIT, { ctx });
        agent.bot = ctx.bot;
        agent.companion.manager = dialogue.manager;

        await dialogue.maybeSpeak();
        assert.deepEqual(messages, []);

        await dialogue.handlePlayerMessage('Owner', '全回収');
        assert.deepEqual(messages, ['全部渡すね']);

        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);
    });

    it('asks again after the swept categories are restocked and spent', async () => {
        const ctx = makeGiveAllCtx(FULL_KIT);
        const { agent, dialogue, messages } = makeDialogue(FULL_KIT, { ctx });
        agent.bot = ctx.bot;

        await dialogue.handlePlayerMessage('Owner', '全回収');
        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);

        agent.bot = makeBot(FULL_KIT);
        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);

        agent.bot = makeBot(kitWithout(16));
        await dialogue.maybeSpeak();
        assert.equal(messages.length, 2);
        assert.match(messages[1], /^食料/);
    });
});

/** Minimal companion context whose 全回収 sweep empties the inventory. */
function makeGiveAllCtx(entries) {
    const bot = makeBot(entries);
    bot.entity = { position: { distanceTo: () => 1 } };
    bot.players = { Owner: { entity: { position: { offset: () => ({}) }, height: 1.8 } } };
    bot.pvp = { target: null };
    bot.lookAt = async () => {};
    bot.tossStack = async (item) => {
        bot.inventory.slots[item.slot] = null;
    };
    return {
        bot,
        ownerName: 'Owner',
        worldState: { visiblePlayers: [{ name: 'Owner' }] },
        config: { owner_near_radius: 12, nearby_loot: { give_suppress_ms: 1000 } },
        movement: { stop() {}, goToward() {} },
        deathRecovery: { pending: false, active: false },
        graveLoot: { active: false },
        nearbyLoot: { active: false, suppressUntil: 0 },
        itemTransfer: { active: false }
    };
}

describe('supply request wording', () => {
    it('joins localized category names in retention order', () => {
        const message = renderCommentary('ja', 'supply_request', {
            supplyCategories: ['helmet', 'shield', 'weapon', 'food', 'torch']
        });
        assert.match(message, /^ヘルメット、盾、近接武器、食料、松明/);
    });

    it('names every retention category in the locale', () => {
        const locale = JSON.parse(fs.readFileSync(
            new URL('../locales/ja.json', import.meta.url),
            'utf8'
        ));
        for (const { id } of RETENTION_CATEGORIES) {
            assert.equal(typeof locale.supply_categories[id], 'string');
        }
        assert.equal(locale.events.supply_request.length, 3);
        for (const line of locale.events.supply_request) {
            assert.match(line, /\{supplyCategories\}/);
        }
    });

    it('no longer carries the superseded empty food and torch lines', () => {
        const locale = JSON.parse(fs.readFileSync(
            new URL('../locales/ja.json', import.meta.url),
            'utf8'
        ));
        assert.equal(locale.events.no_food, undefined);
        assert.equal(locale.events.no_torch, undefined);
    });
});
