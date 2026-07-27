import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    extractGraveOwnerName,
    findOwnGravesNear,
    isGraveCandidateBlock,
    isOwnGraveLabel,
    readEntityDisplayText,
    stripFormatting
} from '../src/world/graves.ts';
import { isGroundItem, getNearestGroundItem } from '../src/world/entities.ts';
import {
    allowDigAt,
    canBreakBlockUnderProtection,
    canBreakUnderProtection,
    clearAllowedDig,
    disableCompanionBlockProtection,
    enableCompanionBlockProtection
} from '../src/companion/blockProtection.js';
import {
    beginDeathReturnAfterSpawn,
    captureDeathState,
    clearDeathReturn,
    createDeathRecoveryState
} from '../src/companion/deathRecovery.js';
import { DeathReturnInterrupt } from '../src/companion/interrupts/DeathReturnInterrupt.js';
import { OwnGraveInterrupt } from '../src/companion/interrupts/OwnGraveInterrupt.js';
import { NearbyLootInterrupt } from '../src/companion/interrupts/NearbyLootInterrupt.js';
import { pickupNearbyItems } from '../src/companion/utils/pickupItems.js';

describe('grave label parsing', () => {
    it('strips formatting codes', () => {
        assert.equal(stripFormatting('&7Trailmate&r\'s Grave &c☠'), "Trailmate's Grave ☠");
        assert.equal(stripFormatting('§aBob§r'), 'Bob');
    });

    it('extracts owner from GravesX-style labels and bare names', () => {
        assert.equal(extractGraveOwnerName("&7Trailmate&r's Grave &c☠"), 'Trailmate');
        assert.equal(extractGraveOwnerName('Trailmate'), 'Trailmate');
        assert.equal(extractGraveOwnerName("OtherPlayer's Grave"), 'OtherPlayer');
        assert.equal(extractGraveOwnerName('random floating text'), null);
    });

    it('accepts only exact owner username matches', () => {
        assert.equal(isOwnGraveLabel("Trailmate's Grave", 'Trailmate'), true);
        assert.equal(isOwnGraveLabel('Trailmate', 'Trailmate'), true);
        assert.equal(isOwnGraveLabel("TrailmateX's Grave", 'Trailmate'), false);
        assert.equal(isOwnGraveLabel("Other's Grave", 'Trailmate'), false);
        assert.equal(isOwnGraveLabel('???', 'Trailmate'), false);
    });
});

describe('text_display hologram reading', () => {
    it('ignores generic "Text Display" type label', () => {
        const entity = {
            name: 'text_display',
            displayName: 'Text Display',
            metadata: {}
        };
        assert.equal(readEntityDisplayText(entity), null);
    });

    it('reads owner text from typed NBT compound metadata', () => {
        const registry = {
            entitiesByName: {
                text_display: {
                    metadataKeys: Array.from({ length: 24 }, (_, i) => (i === 23 ? 'text' : `k${i}`))
                }
            }
        };
        const entity = {
            name: 'text_display',
            displayName: 'Text Display',
            metadata: {
                23: {
                    type: 'compound',
                    value: {
                        extra: {
                            type: 'list',
                            value: {
                                type: 'compound',
                                value: [
                                    {
                                        text: { type: 'string', value: "MameCollie's Grave" },
                                        italic: { type: 'byte', value: 0 }
                                    }
                                ]
                            }
                        },
                        text: { type: 'string', value: '' }
                    }
                }
            }
        };
        const label = readEntityDisplayText(entity, registry);
        assert.equal(label, "MameCollie's Grave");
        assert.equal(isOwnGraveLabel(label, 'MameCollie'), true);
    });

    it('does not treat bare numbers as hologram owner labels', () => {
        assert.equal(extractGraveOwnerName('3'), null);
        assert.equal(isOwnGraveLabel('3', 'MameCollie'), false);
    });

    it('finds own grave when text_display metadata has the owner label', () => {
        const registry = {
            entitiesByName: {
                text_display: {
                    metadataKeys: Array.from({ length: 24 }, (_, i) => (i === 23 ? 'text' : `k${i}`))
                }
            }
        };
        const bot = {
            username: 'MameCollie',
            registry,
            entity: { position: new Vec3(0, 64, 0) },
            entities: {
                1: {
                    name: 'text_display',
                    displayName: 'Text Display',
                    position: new Vec3(2, 65, 0),
                    metadata: { 23: "MameCollie's Grave" }
                }
            },
            blockAt(pos) {
                if (Math.floor(pos.x) === 2 && Math.floor(pos.y) === 64) {
                    return { name: 'player_head', position: { x: 2, y: 64, z: 0 } };
                }
                return { name: 'air', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } };
            }
        };
        const found = findOwnGravesNear(bot, 'MameCollie', 10);
        assert.equal(found.length, 1);
        assert.equal(found[0].block.name, 'player_head');
    });
});

describe('grave candidate blocks', () => {
    it('accepts heads / chests / shulkers only', () => {
        assert.equal(isGraveCandidateBlock('player_head'), true);
        assert.equal(isGraveCandidateBlock('gray_shulker_box'), true);
        assert.equal(isGraveCandidateBlock('chest'), true);
        assert.equal(isGraveCandidateBlock('stone'), false);
        assert.equal(isGraveCandidateBlock('dirt'), false);
        assert.equal(isGraveCandidateBlock(null), false);
    });
});

describe('findOwnGravesNear', () => {
    function makeBot({ username = 'Trailmate', botPos = new Vec3(0, 64, 0), entities = {}, blocks = {} } = {}) {
        return {
            username,
            entity: { position: botPos },
            entities,
            blockAt(pos) {
                const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
                const name = blocks[key];
                if (!name) return { name: 'air', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } };
                return {
                    name,
                    position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
                };
            }
        };
    }

    it('returns own graves within radius and ignores others / unlabeled', () => {
        const bot = makeBot({
            entities: {
                1: {
                    name: 'armor_stand',
                    position: new Vec3(2, 65, 0),
                    username: "Trailmate's Grave"
                },
                2: {
                    name: 'armor_stand',
                    position: new Vec3(3, 65, 0),
                    username: "Steve's Grave"
                },
                3: {
                    name: 'armor_stand',
                    position: new Vec3(4, 65, 0),
                    username: '???'
                },
                4: {
                    name: 'armor_stand',
                    position: new Vec3(20, 65, 0),
                    username: "Trailmate's Grave"
                }
            },
            blocks: {
                '2,64,0': 'player_head',
                '3,64,0': 'player_head',
                '4,64,0': 'player_head',
                '20,64,0': 'player_head'
            }
        });

        const found = findOwnGravesNear(bot, 'Trailmate', 10);
        assert.equal(found.length, 1);
        assert.equal(found[0].block.position.x, 2);
        assert.equal(found[0].ownerName, 'Trailmate');
    });

    it('ignores own label without a grave-like block underneath', () => {
        const bot = makeBot({
            entities: {
                1: {
                    name: 'text_display',
                    position: new Vec3(1, 65, 0),
                    username: 'Trailmate'
                }
            },
            blocks: {
                '1,64,0': 'dirt'
            }
        });
        assert.equal(findOwnGravesNear(bot, 'Trailmate', 10).length, 0);
    });

    it('finds multiple own graves sorted by distance', () => {
        const bot = makeBot({
            entities: {
                1: {
                    name: 'armor_stand',
                    position: new Vec3(5, 65, 0),
                    username: "Trailmate's Grave"
                },
                2: {
                    name: 'armor_stand',
                    position: new Vec3(2, 65, 0),
                    username: 'Trailmate'
                }
            },
            blocks: {
                '5,64,0': 'gray_shulker_box',
                '2,64,0': 'player_head'
            }
        });
        const found = findOwnGravesNear(bot, 'Trailmate', 10);
        assert.equal(found.length, 2);
        assert.equal(found[0].block.position.x, 2);
        assert.equal(found[1].block.position.x, 5);
    });
});

describe('ground items', () => {
    it('detects item entities', () => {
        assert.equal(isGroundItem({ name: 'item' }), true);
        assert.equal(isGroundItem({ name: 'zombie' }), false);
    });

    it('finds nearest ground item around a point', () => {
        const around = new Vec3(10, 64, 10);
        const bot = {
            entity: { position: new Vec3(0, 64, 0) },
            entities: {
                1: { name: 'item', position: new Vec3(11, 64, 10) },
                2: { name: 'item', position: new Vec3(14, 64, 10) },
                3: { name: 'zombie', position: new Vec3(10.5, 64, 10) }
            },
            nearestEntity() {
                return null;
            }
        };
        const nearest = getNearestGroundItem(bot, 5, around);
        assert.equal(nearest.position.x, 11);
    });
});

describe('block protection dig allow-list', () => {
    it('allows only the temporary grave block while protection is on', () => {
        enableCompanionBlockProtection();
        assert.equal(canBreakUnderProtection(), false);
        const block = { position: { x: 3, y: 64, z: 7 } };
        assert.equal(canBreakBlockUnderProtection(block), false);
        allowDigAt(block.position);
        assert.equal(canBreakBlockUnderProtection(block), true);
        assert.equal(canBreakBlockUnderProtection({ position: { x: 4, y: 64, z: 7 } }), false);
        clearAllowedDig();
        assert.equal(canBreakBlockUnderProtection(block), false);
        disableCompanionBlockProtection();
    });
});

describe('death recovery state', () => {
    function makeCtx(overrides = {}) {
        const position = overrides.position || new Vec3(12, 70, -4);
        return {
            bot: {
                entity: { position },
                game: { dimension: overrides.dimension || 'minecraft:overworld' },
                pvp: { stop() {} }
            },
            movement: {
                stopped: false,
                stop() { this.stopped = true; },
                goToward() { this.went = true; }
            },
            stuck: {
                reset() { this.resetCalled = true; }
            },
            deathRecovery: createDeathRecoveryState(),
            graveLoot: { active: false, targetKey: null },
            holdReflexes: false,
            config: {
                death_return: { enabled: true, arrive_range: 3, timeout_ms: 90000 },
                own_grave: { enabled: true, scan_radius: 10 },
                nearby_loot: { enabled: true, radius: 8, max_ms: 15000, quiet_ms: 1500, grace_ms: 2500 }
            },
            nearbyLoot: { active: false },
            ...overrides
        };
    }

    it('captures death coordinates and starts return after spawn', () => {
        const ctx = makeCtx();
        captureDeathState(ctx);
        assert.equal(ctx.deathRecovery.pending, true);
        assert.equal(ctx.deathRecovery.deathPos.x, 12);
        assert.equal(ctx.deathRecovery.deathDim, 'minecraft:overworld');
        assert.equal(ctx.movement.stopped, true);
        assert.equal(ctx.holdReflexes, true);

        const started = beginDeathReturnAfterSpawn(ctx);
        assert.equal(started, true);
        assert.equal(ctx.deathRecovery.active, true);
        assert.equal(ctx.deathRecovery.phase, 'travel');
    });

    it('DeathReturnInterrupt walks toward death pos then clears on arrive', async () => {
        const ctx = makeCtx();
        captureDeathState(ctx);
        beginDeathReturnAfterSpawn(ctx);

        const interrupt = new DeathReturnInterrupt();
        assert.equal(interrupt.shouldRun(ctx), true);

        // Far from death pos: travel
        ctx.bot.entity.position = new Vec3(0, 70, 0);
        await interrupt.run(ctx);
        assert.equal(ctx.deathRecovery.phase, 'travel');
        assert.equal(ctx.movement.went, true);

        // Arrive — ground loot is NearbyLootInterrupt's job
        ctx.bot.entity.position = new Vec3(12, 70, -4);
        ctx.bot.entities = {};
        ctx.bot.nearestEntity = () => null;
        await interrupt.run(ctx);
        assert.equal(ctx.deathRecovery.active, false);
        assert.equal(ctx.deathRecovery.phase, 'idle');
    });

    it('skips death return in a different dimension', () => {
        const ctx = makeCtx({ dimension: 'minecraft:the_nether' });
        captureDeathState(ctx);
        // deathDim is nether; after spawn bot is overworld
        ctx.bot.game.dimension = 'minecraft:overworld';
        beginDeathReturnAfterSpawn(ctx);
        const interrupt = new DeathReturnInterrupt();
        assert.equal(interrupt.shouldRun(ctx), false);
        clearDeathReturn(ctx);
    });
});

describe('OwnGraveInterrupt gating', () => {
    it('shouldRun is false when no own graves are nearby', () => {
        const interrupt = new OwnGraveInterrupt();
        const ctx = {
            bot: {
                username: 'Trailmate',
                entity: { position: new Vec3(0, 64, 0) },
                entities: {},
                blockAt() { return { name: 'air', position: { x: 0, y: 64, z: 0 } }; }
            },
            config: { own_grave: { enabled: true, scan_radius: 10 } },
            graveLoot: { active: false, targetKey: null }
        };
        assert.equal(interrupt.shouldRun(ctx), false);
    });

    it('shouldRun is true for own named grave within 10 blocks', () => {
        const interrupt = new OwnGraveInterrupt();
        const ctx = {
            bot: {
                username: 'Trailmate',
                entity: { position: new Vec3(0, 64, 0) },
                entities: {
                    1: {
                        name: 'armor_stand',
                        position: new Vec3(4, 65, 0),
                        username: "Trailmate's Grave"
                    }
                },
                blockAt(pos) {
                    if (Math.floor(pos.x) === 4 && Math.floor(pos.y) === 64) {
                        return { name: 'player_head', position: { x: 4, y: 64, z: 0 } };
                    }
                    return { name: 'air', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } };
                }
            },
            config: { own_grave: { enabled: true, scan_radius: 10 } },
            graveLoot: { active: false, targetKey: null }
        };
        assert.equal(interrupt.shouldRun(ctx), true);
    });

    it('announces found grave in chat once per coordinates', async () => {
        const chats = [];
        const interrupt = new OwnGraveInterrupt();
        const headPos = { x: 2, y: 64, z: 0 };
        const headBlock = {
            name: 'player_head',
            position: headPos,
            offset(x, y, z) {
                return new Vec3(headPos.x + x, headPos.y + y, headPos.z + z);
            }
        };
        const ctx = {
            agent: {
                openChat: async (text) => { chats.push(text); }
            },
            bot: {
                username: 'Trailmate',
                entity: { position: new Vec3(2.2, 64, 0.2) },
                entities: {
                    1: {
                        name: 'armor_stand',
                        position: new Vec3(2, 65, 0),
                        username: "Trailmate's Grave"
                    }
                },
                pvp: { stop() {} },
                blockAt(pos) {
                    if (Math.floor(pos.x) === 2 && Math.floor(pos.y) === 64 && Math.floor(pos.z) === 0) {
                        return headBlock;
                    }
                    return { name: 'air', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } };
                },
                async lookAt() {},
                async dig() {}
            },
            movement: {
                stop() {},
                goToward() {}
            },
            config: {
                own_grave: {
                    enabled: true,
                    scan_radius: 10,
                    dig_range: 3.5
                }
            },
            graveLoot: { active: false, targetKey: null },
            nearbyLoot: { active: false },
            deathRecovery: { active: false },
            holdReflexes: false
        };

        await interrupt.run(ctx);
        assert.equal(chats.length, 1);
        assert.equal(chats[0], '自分の墓を見つけたよ (2, 64, 0)');

        await interrupt.run(ctx);
        assert.equal(chats.length, 1);
    });
});

describe('NearbyLootInterrupt', () => {
    /**
     * @param {Partial<{
     *   botPos: import('vec3').Vec3,
     *   itemPos: import('vec3').Vec3,
     *   ownerPos: import('vec3').Vec3 | null,
     *   deathActive: boolean,
     *   graveActive: boolean,
     *   suppressUntil: number
     * }>} [opts]
     */
    function makeLootCtx(opts = {}) {
        const botPos = opts.botPos || new Vec3(0, 64, 0);
        const itemPos = opts.itemPos || new Vec3(3, 64, 0);
        return {
            bot: {
                entity: { position: botPos },
                entities: {
                    1: { name: 'item', position: itemPos }
                }
            },
            ownerEntity: opts.ownerPos ? { position: opts.ownerPos } : undefined,
            config: { nearby_loot: { enabled: true, radius: 8, owner_clearance: 8 } },
            deathRecovery: { active: opts.deathActive === true, phase: 'travel' },
            graveLoot: { active: opts.graveActive === true },
            nearbyLoot: { active: false, suppressUntil: opts.suppressUntil ?? 0 }
        };
    }

    it('shouldRun is true when ground items are within radius', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx()), true);
    });

    it('shouldRun is true while death-return is traveling if ground items are near', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            itemPos: new Vec3(2, 64, 0),
            deathActive: true
        })), true);
    });

    it('shouldRun is false when drops are only within owner clearance', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            botPos: new Vec3(2, 64, 0),
            itemPos: new Vec3(1, 64, 0),
            ownerPos: new Vec3(0, 64, 0)
        })), false);
    });

    it('shouldRun leaves scattered drops within expanded owner clearance', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            botPos: new Vec3(7, 64, 0),
            itemPos: new Vec3(6, 64, 0),
            ownerPos: new Vec3(0, 64, 0)
        })), false);
    });

    it('shouldRun is true when a drop is outside owner clearance', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            botPos: new Vec3(8, 64, 0),
            itemPos: new Vec3(9, 64, 0),
            ownerPos: new Vec3(0, 64, 0)
        })), true);
    });

    it('shouldRun ignores owner clearance while deathRecovery is active', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            botPos: new Vec3(2, 64, 0),
            itemPos: new Vec3(1, 64, 0),
            ownerPos: new Vec3(0, 64, 0),
            deathActive: true
        })), true);
    });

    it('shouldRun is false while give-all suppressUntil is in the future', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            itemPos: new Vec3(6, 64, 0),
            suppressUntil: Date.now() + 60_000
        })), false);
    });

    it('shouldRun returns after suppressUntil expires', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            itemPos: new Vec3(6, 64, 0),
            suppressUntil: Date.now() - 1
        })), true);
    });

    it('pickupNearbyItems untilClear stops after quiet period with no items', async () => {
        const ctx = {
            bot: {
                entity: { position: new Vec3(0, 64, 0) },
                entities: {},
                interrupt_code: false
            },
            movement: { stop() {} },
            holdReflexes: true
        };
        // No items → after grace+quiet should exit well under max duration.
        const started = Date.now();
        const attempts = await pickupNearbyItems(ctx, {
            radius: 5,
            durationMs: 10000,
            untilClear: true,
            quietMs: 80,
            graceMs: 50,
            pollMs: 20
        });
        const elapsed = Date.now() - started;
        assert.equal(attempts, 0);
        assert.ok(elapsed < 2000, `expected early clear, elapsed=${elapsed}`);
    });
});
