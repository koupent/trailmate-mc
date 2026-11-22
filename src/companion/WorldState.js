import { isInHorizontalFov } from '../world/fov.js';
import { isHostile } from '../world/entities.js';
import { hasLineOfSight } from '../world/lineOfSight.js';

const OBSERVATION_FRESH_MS = 8000;
const OBSERVATION_MEMORY_MS = 30000;
const MAX_RECENT_OBSERVATIONS = 8;
const SAME_ACTIVITY_WINDOW_MS = 10000;
const CHEST_NAMES = new Set(['chest', 'trapped_chest']);

/**
 * Tracks visible and nearby players for follow behavior and dialogue.
 */
export class WorldState {
    constructor() {
        this.visiblePlayers = [];
        this.nearbyPlayers = [];
        this.ownerVisible = false;
        this.reportedRain = null;
        this.observations = [];
        this.playerActivityByName = new Map();
    }

    observeWeather(bot) {
        let dimension;
        bot.on('game', () => {
            const current = bot.game?.dimension;
            if (current !== dimension) {
                this.reportedRain = null;
                this.observations = [];
                this.playerActivityByName.clear();
            }
            dimension = current;
        });
        bot.on('rain', () => { this.reportedRain = bot.isRaining; });
    }

    getLocalRain(bot) {
        if (this.reportedRain !== true) return this.reportedRain;
        if (!(bot.rainState > 0) || !bot.entity?.position) return null;
        const block = bot.blockAt?.(bot.entity.position.offset(0, 1, 0), false);
        if (block?.skyLight !== 15) return null;
        const biome = bot.registry?.biomes?.[block.biome?.id];
        // The world rain flag also applies to biomes without local rain.
        return biome?.has_precipitation === true && biome.temperature >= 0.3 ? true : null;
    }

    describeLocation(bot) {
        const position = bot.entity?.position;
        if (!position) return undefined;
        const local = bot.blockAt?.(position, false);
        return {
            dimension: bot.game?.dimension,
            biome: local && bot.registry?.biomes?.[local.biome?.id]?.name
        };
    }

    observe(event, now = Date.now()) {
        const entry = { ...event, seenAt: now };
        this.observations = [...this.recentObservations(now, true), entry].slice(-MAX_RECENT_OBSERVATIONS);
        return entry;
    }

    recentObservations(now = Date.now(), includeConversationHistory = false) {
        const maxAge = includeConversationHistory ? OBSERVATION_MEMORY_MS : OBSERVATION_FRESH_MS;
        return this.observations.filter(({ seenAt }) => now - seenAt <= maxAge);
    }

    observeActivities(ctx) {
        const bot = ctx.bot;
        const radius = ctx.config.owner_near_radius ?? 12;
        const visibleNearby = (entity) => Boolean(bot.entity?.position && entity?.position && bot.world
            && bot.entity.position.distanceTo(entity.position) <= radius && hasLineOfSight(bot, entity));
        const visibleBlock = (block) => Boolean(bot.entity?.position && block?.position
            && bot.entity.position.distanceTo(block.position) <= radius && bot.canSeeBlock?.(block));
        const identifyPlayer = (source) => source?.id != null && source.id !== bot.entity?.id
            ? Object.values(bot.players).find((entry) => entry.entity?.id === source.id)
            : null;
        const notePlayerActivity = (player, kind, event) => {
            const now = Date.now();
            const previous = this.playerActivityByName.get(player.username);
            const active = previous && now - previous.seenAt < SAME_ACTIVITY_WINDOW_MS;
            this.playerActivityByName.set(player.username, { kind, seenAt: now });
            if (active && previous.kind === kind) return;
            this.observe({
                ...event,
                text: active ? `The player switched from ${previous.kind} to ${kind}. ${event.text}` : event.text,
                recipient: player.username
            }, now);
        };
        bot.on('entityHurt', (target, source) => {
            if (!target || !source) return;
            const player = identifyPlayer(source);
            if (target.id === bot.entity?.id) {
                const actor = player?.username ? 'player' : source.type !== 'player' ? source.name : null;
                if (!actor || source.id === target.id) return;
                const id = player?.username ? 'companion_hit_by_player' : 'companion_hit_by_mob';
                if (this.recentObservations().some((entry) => entry.id === id && entry.recipient === player?.username)) return;
                if (player?.username) {
                    ctx.agent?.companion?.dialogue?.rememberPlayerInteraction?.(player.username,
                        'received_hit', 'このプレイヤーの攻撃が相棒に当たったことがある。意図は不明。');
                }
                this.observe({
                    id, priority: 3, cooldownKey: 'companion_took_damage', recipient: player?.username,
                    text: 'The damage source was identified. The attacker’s intent is unknown.',
                    actionFacts: [{ actor, action: 'hit', target: 'companion' }]
                });
                return;
            }
            if (!isHostile(target) || !visibleNearby(target)) return;
            if (source.id === bot.entity?.id) {
                if (this.recentObservations().some((entry) => entry.id === 'companion_hit_hostile')) return;
                this.observe({
                    id: 'companion_hit_hostile', priority: 2, target: target.name,
                    text: 'The companion landed a hit.',
                    actionFacts: [{ actor: 'companion', action: 'hit', target: target.name }]
                });
                return;
            }
            if (!player?.username || !visibleNearby(source)) return;
            notePlayerActivity(player, 'fighting', {
                id: 'player_hit_hostile',
                text: `The nearby player landed a hit on a ${target.name}.`,
                actionFacts: [{ actor: 'player', action: `landed a hit on a ${target.name}` }],
                target: target.name,
                priority: 2
            });
        });
        bot.on('blockBreakProgressObserved', (block, _stage, source) => {
            const player = identifyPlayer(source);
            if (!player?.username || !visibleNearby(source) || !visibleBlock(block)) return;
            notePlayerActivity(player, 'mining', {
                id: 'player_started_mining',
                text: 'A nearby player started breaking blocks.',
                actionFacts: [{ actor: 'player', action: 'started breaking blocks', block: block.name }],
                priority: 0
            });
        });
        bot.on('blockUpdate', (oldBlock, block) => {
            if (!oldBlock || !block || oldBlock.name === block.name || !visibleBlock(block)) return;
            const chestPlaced = CHEST_NAMES.has(block.name) && !CHEST_NAMES.has(oldBlock.name);
            const id = chestPlaced ? 'nearby_chest_appeared' : 'nearby_block_changed';
            if (this.recentObservations().some((entry) => entry.id === id)) return;
            this.observe({
                id, priority: 0,
                text: `A visible block changed from ${oldBlock.name} to ${block.name}. What caused the change is unknown.`
            });
        });
        bot.on('playerLeft', (player) => this.playerActivityByName.delete(player.username));
    }

    /**
     * @param {import('./CompanionContext.js').CompanionContext} ctx
     */
    update(ctx) {
        const bot = ctx.bot;
        const config = ctx.config;
        const pos = bot.entity.position;
        const yaw = bot.entity.yaw;

        const players = [];
        for (const name of Object.keys(bot.players)) {
            if (name === bot.username) continue;
            const entity = bot.players[name]?.entity;
            if (!entity) continue;
            const distance = pos.distanceTo(entity.position);
            if (distance > config.scan_radius) continue;
            players.push({
                name,
                entity,
                distance,
                inFov: isInHorizontalFov(pos, yaw, entity.position, config.fov_degrees)
            });
        }
        players.sort((a, b) => a.distance - b.distance);
        const nearRadius = config.owner_near_radius ?? 12;
        this.nearbyPlayers = players.filter((p) => p.distance <= nearRadius);
        this.visiblePlayers = players.filter((p) => {
            if (!p.inFov) return false;
            try {
                return typeof bot.canSeeEntity === 'function' ? bot.canSeeEntity(p.entity) : true;
            } catch {
                return true;
            }
        });

        if (ctx.ownerName) {
            const owner = players.find((p) => p.name === ctx.ownerName);
            this.ownerVisible = !!(owner && (owner.inFov || owner.distance <= config.owner_near_radius));
        } else {
            this.ownerVisible = false;
        }
    }
}
