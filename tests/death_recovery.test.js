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
    createDeathRecoveryState,
    requestRecoveryItemCollection,
    completeDeathRecovery
} from '../src/companion/deathRecovery.js';
import { DeathReturnInterrupt } from '../src/companion/interrupts/DeathReturnInterrupt.js';
import { OwnGraveInterrupt } from '../src/companion/interrupts/OwnGraveInterrupt.js';
import { NearbyLootInterrupt } from '../src/companion/interrupts/NearbyLootInterrupt.js';
import { pickupNearbyItems } from '../src/companion/utils/pickupItems.js';
import { isGraveWithinInteractReach } from '../src/companion/utils/graveApproach.js';
import { resolveOwnGraveInteractRange } from '../src/companion/utils/graveInteract.js';
import { scanCompanionAwareness } from '../src/world/companionAwareness.js';
import { OWNER_WORK_PHASES, seedPlayerWorkPhase } from '../src/companion/ownerWorkTracker.js';
import { selectControlOwner } from '../src/companion/ControlPriority.js';

describe('相棒の制御優先順位', () => {
    it('階層型所有権の遷移表を小さく明示的に保つ', () => {
        const cases = [
            [{ upperMode: 'follow' }, 'follow'],
            [{ upperMode: 'wait' }, 'wait'],
            [{ transferActive: true }, 'transfer'],
            [{ combatActive: true, transferActive: true }, 'combat'],
            [{ recoveryActive: true, combatActive: true }, 'recovery'],
            [{ recoveryActive: true, recoveryEmergency: true, combatActive: true }, 'survival']
        ];
        for (const [input, expected] of cases) {
            assert.equal(selectControlOwner(input), expected);
        }
    });
});

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
                own_grave: { enabled: true, interact_range: 3.5 },
                nearby_loot: { enabled: true, max_ms: 15000, quiet_ms: 1500, grace_ms: 2500 },
                awareness_radius: 10
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
        // 死亡処理がholdReflexes経由で戦闘Reflexesを止めてはならない。
        assert.equal(ctx.holdReflexes, false);

        const started = beginDeathReturnAfterSpawn(ctx);
        assert.equal(started, true);
        assert.equal(ctx.deathRecovery.active, true);
        assert.equal(ctx.deathRecovery.phase, 'travel');
        assert.equal(ctx.holdReflexes, true);
    });

    it('DeathReturnInterruptは死亡地点でもRecovery所有権を維持する', async () => {
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
        assert.equal(ctx.deathRecovery.active, true);
        assert.equal(ctx.deathRecovery.phase, 'grave');
        assert.deepEqual(ctx.deathRecovery.collectionOrigin, { x: 12, y: 70, z: -4 });
    });

    it('墓が現れない場合は共通ItemCollectionへ切り替える', async () => {
        const ctx = makeCtx();
        ctx.config.death_return.grave_wait_ms = 0;
        captureDeathState(ctx);
        beginDeathReturnAfterSpawn(ctx);
        ctx.bot.entity.position = new Vec3(12, 70, -4);
        const interrupt = new DeathReturnInterrupt();
        await interrupt.run(ctx);
        await interrupt.run(ctx);
        assert.equal(ctx.deathRecovery.active, true);
        assert.equal(ctx.deathRecovery.phase, 'items');
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
    function withAwareness(ctx) {
        ctx.config = {
            awareness_radius: 10,
            ...(ctx.config || {})
        };
        ctx.getCompanionAwareness = () => scanCompanionAwareness(
            ctx.bot,
            ctx.config.awareness_radius,
            ctx.bot.entity.position
        );
        ctx.invalidateCompanionAwareness = () => {};
        return ctx;
    }

    it('shouldRun is false when no own graves are nearby', () => {
        const interrupt = new OwnGraveInterrupt();
        const ctx = withAwareness({
            bot: {
                username: 'Trailmate',
                entity: { position: new Vec3(0, 64, 0) },
                entities: {},
                blockAt() { return { name: 'air', position: { x: 0, y: 64, z: 0 } }; }
            },
            config: { own_grave: { enabled: true, interact_range: 3.5 } },
            graveLoot: { active: false, targetKey: null }
        });
        assert.equal(interrupt.shouldRun(ctx), false);
    });

    it('10ブロック以内に自分名義の墓があればshouldRunがtrueになる', () => {
        const interrupt = new OwnGraveInterrupt();
        const ctx = withAwareness({
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
            config: { own_grave: { enabled: true, interact_range: 3.5 } },
            graveLoot: { active: false, targetKey: null }
        });
        assert.equal(interrupt.shouldRun(ctx), true);
    });

    it('announces found grave in chat once per coordinates', async () => {
        const chats = [];
        const interrupt = new OwnGraveInterrupt();
        const headPos = new Vec3(2, 64, 0);
        const headBlock = {
            name: 'player_head',
            position: headPos,
            offset(x, y, z) {
                return new Vec3(headPos.x + x, headPos.y + y, headPos.z + z);
            }
        };
        const ctx = withAwareness({
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
                controls: {},
                getControlState(name) { return Boolean(this.controls[name]); },
                setControlState(name, value) { this.controls[name] = value; },
                blockAt(pos) {
                    if (Math.floor(pos.x) === 2 && Math.floor(pos.y) === 64 && Math.floor(pos.z) === 0) {
                        return headBlock;
                    }
                    return { name: 'air', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } };
                },
                async lookAt() {},
                async activateBlock() {}
            },
            movement: {
                stop() {},
                goToward() {}
            },
            config: {
                own_grave: {
                    enabled: true,
                    interact_range: 3.5
                }
            },
            graveLoot: { active: false, targetKey: null },
            nearbyLoot: { active: false },
            deathRecovery: {
                ...createDeathRecoveryState(),
                active: true,
                phase: 'grave'
            },
            holdReflexes: false
        });

        await interrupt.run(ctx);
        assert.equal(chats.length, 1);
        assert.equal(chats[0], '自分の墓を見つけたよ (2, 64, 0)');
        assert.equal(ctx.bot.controls.sneak, false);
        assert.equal(ctx.deathRecovery.phase, 'items');
        assert.deepEqual(ctx.deathRecovery.collectionOrigin, { x: 2, y: 64, z: 0 });

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
     *   deathPhase: string,
     *   graveActive: boolean,
     *   suppressUntil: number,
     *   ownerWorkPhase: string
     * }>} [opts]
     */
    function makeLootCtx(opts = {}) {
        const botPos = opts.botPos || new Vec3(0, 64, 0);
        const itemPos = opts.itemPos || new Vec3(3, 64, 0);
        const ownerId = 99;
        const bot = {
            entity: { position: botPos },
            entities: {
                1: { name: 'item', position: itemPos }
            },
            inventory: {
                emptySlotCount: () => 1,
                items: () => []
            },
            players: opts.ownerPos
                ? { Steve: { entity: { id: ownerId, position: opts.ownerPos, yaw: opts.ownerYaw ?? 0 } } }
                : {}
        };
        if (opts.ownerPos) {
            bot.entities[ownerId] = bot.players.Steve.entity;
        }
        const ctx = {
            bot,
            ownerName: opts.ownerPos ? 'Steve' : null,
            ownerEntity: opts.ownerPos ? bot.players.Steve.entity : undefined,
            config: {
                awareness_radius: 10,
                nearby_loot: { enabled: true },
                owner_work: { enabled: true, all_players: true, fov_degrees: 100, swing_idle_ms: 1000, post_work_cooldown_ms: 4000 }
            },
            deathRecovery: {
                active: opts.deathActive === true,
                phase: opts.deathPhase || 'travel',
                emergencyUntil: 0
            },
            graveLoot: { active: opts.graveActive === true },
            nearbyLoot: { active: false, suppressUntil: opts.suppressUntil ?? 0 },
            playerWorkById: new Map()
        };
        const workPhase = opts.ownerWorkPhase || OWNER_WORK_PHASES.idle;
        if (workPhase !== OWNER_WORK_PHASES.idle && opts.ownerPos) {
            seedPlayerWorkPhase(ctx, ownerId, workPhase);
        }
        ctx.getCompanionAwareness = () => scanCompanionAwareness(bot, 10, botPos);
        ctx.invalidateCompanionAwareness = () => {};
        return ctx;
    }

    it('半径内に地面アイテムがあればshouldRunがtrueになる', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx()), true);
    });

    it('通常の近傍回収がRecovery移動目的地を奪わない', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            itemPos: new Vec3(2, 64, 0),
            deathActive: true
        })), false);
    });

    it('作業退避中でなければowner近傍のドロップも回収する', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(5, 64, 0),
            ownerPos: new Vec3(0, 64, 0)
        })), true);
    });

    it('owner作業中でもドロップがあればshouldRunがtrueになる', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(0, 64, 8),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring
        })), true);
    });

    it('owner作業後のcooldown中でもドロップがあればshouldRunがtrueになる', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(0, 64, 6),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.cooldown
        })), true);
    });

    it('owner作業から退避中でもdeathRecoveryの回収を続ける', () => {
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(makeLootCtx({
            botPos: new Vec3(2, 64, 0),
            itemPos: new Vec3(1, 64, 0),
            ownerPos: new Vec3(0, 64, 0),
            deathActive: true,
            ownerWorkPhase: OWNER_WORK_PHASES.deferring,
            deathPhase: 'items'
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

    it('墓ドロップ優先中はgive抑制中でもshouldRunがtrueになる', () => {
        const interrupt = new NearbyLootInterrupt();
        const gravePos = new Vec3(10, 64, 10);
        const ctx = makeLootCtx({
            botPos: new Vec3(12, 64, 12),
            itemPos: new Vec3(10.5, 64, 10.5),
            suppressUntil: Date.now() + 60_000
        });
        ctx.nearbyLoot.priorityUntil = Date.now() + 60_000;
        ctx.nearbyLoot.priorityOrigin = { x: gravePos.x, y: gravePos.y, z: gravePos.z };
        ctx.getCompanionAwareness = () => scanCompanionAwareness(ctx.bot, 12, gravePos);
        assert.equal(interrupt.shouldRun(ctx), true);
    });

    it('墓ドロップ優先中は戦闘中でもshouldRunがtrueになる', () => {
        const interrupt = new NearbyLootInterrupt();
        const gravePos = new Vec3(10, 64, 10);
        const ctx = makeLootCtx({
            botPos: new Vec3(12, 64, 12),
            itemPos: new Vec3(10.5, 64, 10.5),
            ownerPos: new Vec3(0, 64, 0)
        });
        ctx.nearbyLoot.priorityUntil = Date.now() + 60_000;
        ctx.nearbyLoot.priorityOrigin = { x: gravePos.x, y: gravePos.y, z: gravePos.z };
        ctx.bot.entities[2] = {
            name: 'zombie',
            type: 'hostile',
            position: new Vec3(11, 64, 11)
        };
        ctx.agent = { reflexes: { wantsCombat: true, isControllingMovement: true } };
        ctx.getCompanionAwareness = () => scanCompanionAwareness(ctx.bot, 12, gravePos);
        assert.equal(interrupt.shouldRun(ctx), true);
    });

    it('回収完了時に優先回収フラグをクリアする', () => {
        const ctx = makeLootCtx({ deathActive: true, deathPhase: 'items' });
        ctx.nearbyLoot.priorityUntil = Date.now() + 60_000;
        ctx.nearbyLoot.priorityOrigin = { x: 0, y: 64, z: 0 };
        ctx.deathRecovery = {
            ...createDeathRecoveryState(),
            active: true,
            phase: 'items'
        };
        completeDeathRecovery(ctx, 'owned-items-collected-equipped');
        assert.equal(ctx.nearbyLoot.priorityUntil, 0);
        assert.equal(ctx.nearbyLoot.priorityOrigin, null);
    });

    it('墓破壊時にcapture/deadlineをリセットする', () => {
        const ctx = makeLootCtx({ deathActive: true, deathPhase: 'grave' });
        const now = Date.now();
        ctx.deathRecovery = {
            ...createDeathRecoveryState(),
            active: true,
            phase: 'grave',
            collectionStartedAt: now - 20_000,
            collectionCaptureUntil: now - 15_000,
            collectionDeadlineAt: now - 5_000,
            ownedItemIds: [99],
            ownedItemIdsFrozen: true
        };
        requestRecoveryItemCollection(
            ctx,
            new Vec3(2, 64, 0),
            now,
            'grave',
            { preexistingItemIds: [1] }
        );
        assert.ok(ctx.deathRecovery.collectionCaptureUntil > now);
        assert.ok(ctx.deathRecovery.collectionDeadlineAt > now);
        assert.deepEqual(ctx.deathRecovery.ownedItemIds, []);
        assert.equal(ctx.deathRecovery.ownedItemIdsFrozen, false);
        assert.ok(ctx.nearbyLoot.priorityUntil > now);
    });

    it('deadline到達後は優先回収フラグを立てて通常回収へ引き継ぐ', async () => {
        const interrupt = new NearbyLootInterrupt();
        const ctx = makeLootCtx({ deathActive: true, deathPhase: 'items' });
        const now = Date.now();
        ctx.deathRecovery = {
            ...createDeathRecoveryState(),
            active: true,
            phase: 'items',
            startedAt: now,
            deathPos: { x: 0, y: 64, z: 0 },
            collectionOrigin: { x: 0, y: 64, z: 0 },
            collectionCaptureUntil: now - 1,
            collectionDeadlineAt: now - 1,
            ownedItemIds: [12],
            ownedItemIdsFrozen: true
        };
        ctx.config.nearby_loot = {
            enabled: true,
            radius: 8,
            recovery_capture_ms: 0,
            recovery_deadline_ms: 80,
            recovery_quiet_ms: 0,
            max_ms: 80,
            quiet_ms: 0,
            grace_ms: 0
        };
        ctx.bot.entities = {
            12: { id: 12, name: 'item', position: new Vec3(0.5, 64, 0.5) }
        };
        ctx.bot.nearestEntity = () => ctx.bot.entities[12] || null;
        ctx.movement = { stop() {} };
        ctx.holdReflexes = true;
        ctx.graveLoot = { active: false };
        ctx.agent = { companion: { autoEquip: { async equipBest() {} } } };

        await interrupt.run(ctx);

        assert.equal(ctx.deathRecovery.active, false);
        assert.ok((ctx.nearbyLoot.priorityUntil || 0) > now);
        assert.deepEqual(ctx.nearbyLoot.priorityOrigin, { x: 0, y: 64, z: 0 });
    });

    it('owner近傍に護衛脅威がいればshouldRunがfalseになる', () => {
        const interrupt = new NearbyLootInterrupt();
        const ctx = makeLootCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(3, 64, 0),
            ownerPos: new Vec3(0, 64, 0)
        });
        ctx.bot.entities[2] = {
            name: 'zombie',
            type: 'hostile',
            position: new Vec3(4, 64, 0)
        };
        assert.equal(interrupt.shouldRun(ctx), false);
    });

    it('pickupNearbyItems untilClear stops after quiet period with no items', async () => {
        const ctx = {
            bot: {
                entity: { position: new Vec3(0, 64, 0) },
                entities: {},
                interrupt_code: false
            },
            config: { awareness_radius: 10 },
            movement: { stop() {} },
            holdReflexes: true
        };
        ctx.getCompanionAwareness = () => scanCompanionAwareness(ctx.bot, 10, ctx.bot.entity.position);
        ctx.invalidateCompanionAwareness = () => {};
        // アイテムがなければgrace+quiet後、最大時間より十分早く終了する。
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

    it('RecoveryがItemCollectionを再利用し戦闘中も墓ドロップを所有して装備する', async () => {
        let equipped = 0;
        const ctx = makeLootCtx({ deathActive: true, deathPhase: 'items' });
        ctx.deathRecovery = {
            ...createDeathRecoveryState(),
            active: true,
            phase: 'items',
            deathPos: { x: 0, y: 64, z: 0 },
            collectionOrigin: { x: 0, y: 64, z: 0 }
        };
        ctx.config.nearby_loot = {
            enabled: true,
            radius: 8,
            recovery_capture_ms: 0,
            recovery_deadline_ms: 80,
            recovery_quiet_ms: 0,
            max_ms: 80,
            quiet_ms: 0,
            grace_ms: 0,
            owner_clearance: 8
        };
        ctx.bot.interrupt_code = false;
        ctx.bot.entities = {
            10: { id: 10, name: 'item', position: new Vec3(0.1, 64, 0) },
            11: { id: 11, name: 'item', position: new Vec3(0.2, 64, 0) },
            12: { id: 12, name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0) }
        };
        ctx.bot.nearestEntity = () => ctx.bot.entities[10] || ctx.bot.entities[11] || null;
        ctx.movement = { stop() {} };
        ctx.holdReflexes = true;
        ctx.graveLoot = { active: false };
        ctx.agent = {
            reflexes: { wantsCombat: true, isControllingMovement: true },
            companion: { autoEquip: { async equipBest() { equipped += 1; } } }
        };

        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(ctx), true);
        setTimeout(() => {
            delete ctx.bot.entities[10];
            delete ctx.bot.entities[11];
        }, 10);
        await interrupt.run(ctx);

        assert.equal(equipped, 1);
        assert.equal(ctx.deathRecovery.active, false);
        assert.equal(ctx.deathRecovery.phase, 'idle');
    });
});

describe('graveInteract', () => {
    it('interact_range を優先し、未設定時は dig_range にフォールバックする', () => {
        assert.equal(resolveOwnGraveInteractRange({ interact_range: 4 }), 4);
        assert.equal(resolveOwnGraveInteractRange({ dig_range: 2.5 }), 2.5);
        assert.equal(resolveOwnGraveInteractRange({ interact_range: 4, dig_range: 2.5 }), 4);
        assert.equal(resolveOwnGraveInteractRange({}), 3.5);
    });
});

describe('graveApproach', () => {
    it('段差の上にある墓でも水平距離が近ければ操作可能と判定する', () => {
        const bot = {
            entity: { position: new Vec3(10.2, 64, 10.2) }
        };
        const gravePos = new Vec3(10, 66, 10);
        assert.equal(isGraveWithinInteractReach(bot, gravePos, 3.5), true);
    });

    it('水平距離が遠い墓は操作不可と判定する', () => {
        const bot = {
            entity: { position: new Vec3(15, 64, 10.2) }
        };
        const gravePos = new Vec3(10, 65, 10);
        assert.equal(isGraveWithinInteractReach(bot, gravePos, 3.5), false);
    });
});

describe('grave detection regression', () => {
    function makeGraveCtx(overrides = {}) {
        const headPos = new Vec3(10, 64, 10);
        const ctx = {
            bot: {
                username: 'Trailmate',
                entity: { position: new Vec3(12, 68, 10) },
                entities: {
                    1: {
                        name: 'armor_stand',
                        position: new Vec3(10, 65, 10),
                        username: "Trailmate's Grave"
                    }
                },
                blockAt(pos) {
                    if (Math.floor(pos.x) === 10 && Math.floor(pos.y) === 64 && Math.floor(pos.z) === 10) {
                        return { name: 'player_head', position: headPos };
                    }
                    return { name: 'air', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } };
                }
            },
            config: {
                awareness_radius: 10,
                own_grave: { enabled: true, scan_radius: 12, interact_range: 3.5 }
            },
            graveLoot: { active: false, targetKey: null },
            deathRecovery: {
                ...createDeathRecoveryState(),
                active: true,
                phase: 'travel',
                deathPos: { x: 10, y: 64, z: 10 }
            },
            invalidateCompanionAwareness() {},
            ...overrides
        };
        return ctx;
    }

    it('travel中でも死亡地点到着範囲内なら墓を検知する', async () => {
        const { getGraveAwarenessSnapshot } = await import('../src/companion/utils/graveAwareness.js');
        const headPos = new Vec3(10, 64, 10);
        const ctx = makeGraveCtx({
            bot: {
                username: 'Trailmate',
                entity: { position: new Vec3(10.2, 64.2, 10.1) },
                entities: {
                    1: {
                        name: 'armor_stand',
                        position: new Vec3(10, 65, 10),
                        username: "Trailmate's Grave"
                    }
                },
                blockAt(pos) {
                    if (Math.floor(pos.x) === 10 && Math.floor(pos.y) === 64 && Math.floor(pos.z) === 10) {
                        return { name: 'player_head', position: headPos };
                    }
                    return { name: 'air', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } };
                }
            },
            config: {
                awareness_radius: 10,
                death_return: { arrive_range: 3 },
                own_grave: { enabled: true, scan_radius: 12, interact_range: 3.5 }
            }
        });
        const snap = getGraveAwarenessSnapshot(ctx);
        assert.ok(snap.displayEntities.length >= 1);
        const interrupt = new OwnGraveInterrupt();
        assert.equal(interrupt.shouldRun(ctx), true);
    });

    it('ボットが段差上でも死亡地点中心スキャンで墓を検知する', async () => {
        const { getGraveAwarenessSnapshot } = await import('../src/companion/utils/graveAwareness.js');
        const ctx = makeGraveCtx();
        const snap = getGraveAwarenessSnapshot(ctx);
        const { findOwnGravesFromAwareness } = await import('../src/world/graves.ts');
        const graves = findOwnGravesFromAwareness(ctx.bot, 'Trailmate', snap);
        assert.equal(graves.length, 1);
        assert.equal(graves[0].block.position.y, 64);
    });

    it('DeathReturnは水平距離で到着判定する', async () => {
        const ctx = {
            bot: {
                entity: { position: new Vec3(12, 70, -4) },
                game: { dimension: 'minecraft:overworld' },
                pvp: { stop() {} }
            },
            movement: {
                stop() {},
                goToward() {}
            },
            stuck: { reset() {} },
            deathRecovery: {
                ...createDeathRecoveryState(),
                active: true,
                phase: 'travel',
                deathPos: { x: 12, y: 64, z: -4 },
                startedAt: Date.now()
            },
            graveLoot: { active: false },
            nearbyLoot: { active: false },
            config: {
                death_return: { enabled: true, arrive_range: 3, timeout_ms: 90000 }
            }
        };
        const interrupt = new DeathReturnInterrupt();
        await interrupt.run(ctx);
        assert.equal(ctx.deathRecovery.phase, 'grave');
    });
});

describe('recovery combat defer', () => {
    it('武装済みかつ周囲に脅威があれば回収より戦闘を優先する', async () => {
        const { shouldDeferRecoveryForCombat } = await import('../src/companion/combatGate.js');
        const ctx = {
            deathRecovery: { active: true, phase: 'items' },
            bot: {
                entity: { position: new Vec3(0, 64, 0) },
                entities: { 12: { type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 0) } },
                inventory: { items: () => [{ name: 'iron_sword' }] }
            },
            agent: { reflexes: {} },
            ownerEntity: null,
            config: { reflexes: { hostile_range: 12 } }
        };
        assert.equal(shouldDeferRecoveryForCombat(ctx), true);
    });

    it('未武装の間は墓装備回収を優先して戦闘譲渡しない', async () => {
        const { shouldDeferRecoveryForCombat } = await import('../src/companion/combatGate.js');
        const ctx = {
            deathRecovery: { active: true, phase: 'items' },
            bot: {
                entity: { position: new Vec3(0, 64, 0) },
                entities: { 12: { type: 'hostile', name: 'zombie', position: new Vec3(2, 64, 0) } },
                inventory: { items: () => [] }
            },
            agent: { reflexes: {} },
            ownerEntity: null,
            config: { reflexes: { hostile_range: 12 } }
        };
        assert.equal(shouldDeferRecoveryForCombat(ctx), false);
    });

    it('武装済みかつ脅威があるRecovery中はnearbyLoot shouldRunがfalse', () => {
        const ctx = {
            deathRecovery: { active: true, phase: 'items', emergencyUntil: 0 },
            bot: {
                entity: { position: new Vec3(0, 64, 0) },
                entities: { 12: { type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 0) } },
                inventory: { items: () => [{ name: 'iron_sword' }] }
            },
            agent: { reflexes: {} },
            ownerEntity: null,
            config: {
                nearby_loot: { enabled: true },
                reflexes: { hostile_range: 12 }
            },
            nearbyLoot: { suppressUntil: 0 }
        };
        const interrupt = new NearbyLootInterrupt();
        assert.equal(interrupt.shouldRun(ctx), false);
    });
});

describe('pickup magnet range', () => {
    it('足元より下のアイテムは水平距離が近くても磁石範囲外と判定する', async () => {
        const { isWithinMagnetPickup } = await import('../src/companion/utils/pickupItems.js');
        const botPos = new Vec3(10.2, 66, 10.2);
        const itemPos = new Vec3(10.1, 65.2, 10.1);
        assert.equal(isWithinMagnetPickup(botPos, itemPos, 1.25), false);
        const sameLevel = new Vec3(10.1, 65.8, 10.1);
        assert.equal(isWithinMagnetPickup(botPos, sameLevel, 1.25), true);
    });
});
