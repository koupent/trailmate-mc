import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    attachOwnerThreatTracker,
    getActiveOwnerThreat,
    resolveThreatEntity
} from '../src/companion/ownerThreatTracker.js';

describe('ownerThreatTracker', () => {
    it('records owner attackers from entityHurt', () => {
        const listeners = {};
        const owner = { id: 7, position: { x: 0, y: 64, z: 0 } };
        const attacker = { id: 9, name: 'zombie', type: 'hostile', position: { x: 2, y: 64, z: 0 } };
        const bot = {
            entity: { id: 1 },
            on(event, handler) {
                listeners[event] = handler;
            },
            entities: { 9: attacker }
        };
        const ctx = {
            bot,
            ownerEntity: owner,
            get ownerEntity() {
                return owner;
            }
        };

        attachOwnerThreatTracker(ctx);
        listeners.entityHurt(owner, attacker);

        const threat = getActiveOwnerThreat(ctx);
        assert.equal(threat?.attackerId, 9);
        assert.equal(resolveThreatEntity(bot, threat?.attackerId), attacker);
    });

    it('expires owner threat after TTL when attacker is gone', () => {
        const ctx = {
            bot: { entities: {} },
            ownerThreat: { attackerId: 9, seenAt: Date.now() - 5000 }
        };
        assert.equal(getActiveOwnerThreat(ctx), null);
        assert.equal(ctx.ownerThreat, null);
    });

    it('keeps owner threat while the attacker entity is still alive', () => {
        const attacker = { id: 9, name: 'pillager', type: 'hostile', position: { x: 0, y: 64, z: 0 } };
        const ctx = {
            bot: { entities: { 9: attacker } },
            ownerThreat: { attackerId: 9, seenAt: Date.now() - 5000 }
        };
        const threat = getActiveOwnerThreat(ctx);
        assert.equal(threat?.attackerId, 9);
        assert.ok(ctx.ownerThreat.seenAt > Date.now() - 1000);
    });
});
