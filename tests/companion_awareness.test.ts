import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    findNearestDrop,
    scanCompanionAwareness,
    type CompanionAwarenessSnapshot
} from '../src/world/companionAwareness.js';

describe('scanCompanionAwareness', () => {
    it('collects drop items inside the radius and ignores those outside', () => {
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            entities: {
                1: { name: 'item', position: new Vec3(3, 64, 0) },
                2: { name: 'item', position: new Vec3(20, 64, 0) },
                3: { name: 'zombie', position: new Vec3(2, 64, 0) }
            }
        };
        const snap = scanCompanionAwareness(bot, 10);
        assert.equal(snap.radius, 10);
        assert.equal(snap.dropItems.length, 1);
        assert.equal(snap.dropItems[0], bot.entities[1]);
        assert.ok(snap.entities.length >= 2);
    });

    it('resolves grave blocks from nearby holograms', () => {
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            entities: {
                1: {
                    name: 'armor_stand',
                    position: new Vec3(2, 65, 0),
                    username: "Trailmate's Grave"
                }
            },
            blockAt(pos: { x: number; y: number; z: number }) {
                if (Math.floor(pos.x) === 2 && Math.floor(pos.y) === 64 && Math.floor(pos.z) === 0) {
                    return { name: 'player_head', position: { x: 2, y: 64, z: 0 } };
                }
                return { name: 'air', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } };
            }
        };
        const snap = scanCompanionAwareness(bot, 10);
        assert.equal(snap.displayEntities.length, 1);
        assert.equal(snap.blocks.length, 1);
        assert.equal(snap.blocks[0].name, 'player_head');
        assert.equal(snap.blocks[0].source, 'hologram');
    });
});

describe('findNearestDrop', () => {
    it('returns the closest drop to the given origin', () => {
        const snap = {
            scannedAt: 0,
            origin: { x: 0, y: 64, z: 0 },
            radius: 10,
            dropItems: [
                { name: 'item', position: new Vec3(5, 64, 0) },
                { name: 'item', position: new Vec3(2, 64, 0) }
            ],
            displayEntities: [],
            blocks: [],
            entities: []
        } satisfies CompanionAwarenessSnapshot;
        const nearest = findNearestDrop(snap, new Vec3(0, 64, 0));
        assert.equal(nearest, snap.dropItems[1]);
    });
});
