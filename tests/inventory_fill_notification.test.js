import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CompanionDialogue } from '../src/companion/CompanionDialogue.js';
import { renderCommentary } from '../src/companion/dialogueParse.js';
import {
    InventoryFillTracker,
    slotsForPercent
} from '../src/companion/utils/InventoryFillTracker.js';
import { snapshotInventoryFill } from '../src/companion/utils/inventorySnapshot.js';

function fillSnapshot(usedSlots, overrides = {}) {
    return {
        mode: 'wait',
        controlOwner: 'wait',
        owner: null,
        health: 20,
        hunger: 20,
        foodCount: 3,
        torchCount: 5,
        stuckSeconds: 0,
        stuckAlert: false,
        isNight: false,
        hostile: null,
        combatTarget: null,
        lastDamageAgeMs: null,
        inventoryUsedSlots: usedSlots,
        inventoryTotalSlots: 36,
        inventoryEmptySlots: 36 - usedSlots,
        inventoryFillPercent: Math.round((usedSlots / 36) * 100),
        ...overrides
    };
}

function makeDialogue(snapshot, chat = {}) {
    const messages = [];
    const agent = {
        bot: {},
        language: 'ja',
        shut_up: false,
        async openChat(message) {
            messages.push(message);
        }
    };
    const manager = {
        interrupts: [],
        getModeCatalog: () => [],
        getCurrentModeId: () => 'wait'
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
    dialogue._buildSnapshot = () => snapshot.current;
    return { dialogue, messages };
}

describe('inventory fill snapshot', () => {
    it('counts only the 36 storage and hotbar slots', () => {
        const slots = Array(46).fill(null);
        for (let slot = 9; slot < 36; slot++) slots[slot] = { slot };
        slots[0] = { slot: 0, name: 'crafting_input' };
        slots[5] = { slot: 5, name: 'diamond_helmet' };
        slots[45] = { slot: 45, name: 'shield' };

        const result = snapshotInventoryFill({
            inventory: { slots, inventoryStart: 9, inventoryEnd: 45 }
        });

        assert.deepEqual(result, {
            inventoryUsedSlots: 27,
            inventoryTotalSlots: 36,
            inventoryEmptySlots: 9,
            inventoryFillPercent: 75
        });
    });
});

describe('InventoryFillTracker', () => {
    it('queues the 75%, 90%, and 100% milestones at 27, 33, and 36 slots', () => {
        assert.equal(slotsForPercent(36, 75), 27);
        assert.equal(slotsForPercent(36, 90), 33);
        assert.equal(slotsForPercent(36, 100), 36);

        const tracker = new InventoryFillTracker();
        assert.equal(tracker.observe(fillSnapshot(26)), null);
        assert.equal(tracker.observe(fillSnapshot(27))?.id, 'inventory_fill_high');
        tracker.markDelivered();
        assert.equal(tracker.observe(fillSnapshot(32)), null);
        assert.equal(tracker.observe(fillSnapshot(33))?.id, 'inventory_fill_critical');
        tracker.markDelivered();
        assert.equal(tracker.observe(fillSnapshot(36))?.id, 'inventory_fill_full');
    });

    it('keeps only the highest milestone when several are crossed at once', () => {
        const tracker = new InventoryFillTracker();
        const event = tracker.observe(fillSnapshot(36));
        assert.equal(event?.id, 'inventory_fill_full');
        assert.deepEqual(event?.inventoryFill, {
            id: 'inventory_fill_full',
            rank: 2,
            percent: 100,
            usedSlots: 36,
            totalSlots: 36,
            emptySlots: 0
        });
    });

    it('does not repeat until the milestone falls by two slots', () => {
        const tracker = new InventoryFillTracker();
        tracker.observe(fillSnapshot(36));
        tracker.markDelivered();

        assert.equal(tracker.observe(fillSnapshot(35)), null);
        assert.equal(tracker.observe(fillSnapshot(36)), null);
        assert.equal(tracker.observe(fillSnapshot(34)), null);
        assert.equal(tracker.observe(fillSnapshot(36))?.id, 'inventory_fill_full');
    });

    it('retains a queued milestone and upgrades it before delivery', () => {
        const tracker = new InventoryFillTracker();
        assert.equal(tracker.observe(fillSnapshot(27))?.id, 'inventory_fill_high');
        assert.equal(tracker.observe(fillSnapshot(33))?.id, 'inventory_fill_critical');
        assert.equal(tracker.peek()?.id, 'inventory_fill_critical');
    });

    it('keeps the full milestone at 100% when custom thresholds are invalid', () => {
        const tracker = new InventoryFillTracker({ thresholds: [70, 85, 95] });
        assert.notEqual(tracker.observe(fillSnapshot(35))?.id, 'inventory_fill_full');
        assert.equal(tracker.observe(fillSnapshot(36))?.id, 'inventory_fill_full');
    });
});

describe('inventory fill dialogue', () => {
    it('retains a startup-full notification across the chat interval', async () => {
        const snapshot = { current: fillSnapshot(36) };
        const { dialogue, messages } = makeDialogue(snapshot, {
            priority_min_interval_ms: 60_000
        });
        dialogue.lastChatAt = Date.now();

        await dialogue.maybeSpeak();
        assert.equal(messages.length, 0);

        dialogue.lastChatAt = 0;
        await dialogue.maybeSpeak();
        assert.equal(messages.length, 1);
        assert.match(messages[0], /100%/);
        assert.match(messages[0], /36\/36枠/);
    });

    it('speaks an urgent situation first and the queued fill milestone next', async () => {
        const snapshot = {
            current: fillSnapshot(36, {
                controlOwner: 'combat',
                hostile: { name: 'zombie', distance: 3 },
                combatTarget: 'zombie'
            })
        };
        const { dialogue, messages } = makeDialogue(snapshot);
        dialogue._prev = fillSnapshot(0, { controlOwner: 'follow' });

        await dialogue.maybeSpeak();
        assert.doesNotMatch(messages[0], /36\/36枠/);

        dialogue.lastChatAt = 0;
        await dialogue.maybeSpeak();
        assert.match(messages[1], /100%/);
        assert.match(messages[1], /36\/36枠/);
    });

    it('does not choose the same localized line twice in succession', () => {
        const snapshot = fillSnapshot(33, { inventoryFillPercent: 90 });
        const first = renderCommentary('ja', 'inventory_fill_critical', snapshot);
        const nextSnapshot = fillSnapshot(34, { inventoryFillPercent: 90 });
        const second = renderCommentary('ja', 'inventory_fill_critical', nextSnapshot, {
            excludeMessage: first
        });
        const withoutNumbers = (message) => message.replace(/\d+(?:\.\d+)?/g, '#');
        assert.notEqual(withoutNumbers(second), withoutNumbers(first));
    });

    it('keeps percentage and slot placeholders in every localized variant', () => {
        const locale = JSON.parse(fs.readFileSync(
            new URL('../locales/ja.json', import.meta.url),
            'utf8'
        ));
        for (const id of [
            'inventory_fill_high',
            'inventory_fill_critical',
            'inventory_fill_full'
        ]) {
            assert.equal(locale.events[id].length, 3);
            for (const line of locale.events[id]) {
                assert.match(line, /\{inventoryFillPercent\}%/);
                assert.match(line, /\{inventoryUsedSlots\}\/\{inventoryTotalSlots\}枠/);
            }
        }
    });
});
