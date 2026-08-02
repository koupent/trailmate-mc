/**
 * Pure helpers for companion dialogue (no Minecraft / LLM imports).
 * Mode/owner come from deterministic keywords; commentary uses locale catalogs.
 */

import { tEvent } from '../i18n/index.js';
import { DEFAULT_FOLLOW_DISTANCE } from './movement/followConstants.js';
import { isNearOwnerHorizontally } from './movement/followGeometry.js';

const OVERLAY_CONTROL_OWNERS = new Set(['survival', 'recovery', 'combat', 'transfer']);

/**
 * @typedef {{
 *   mode: 'wait'|'follow',
 *   description: string,
 *   reply: string,
 *   keywordsJa: string[],
 *   keywordsEn: string[],
 * }} ModeCommandDef
 */

/**
 * @typedef {{
 *   action: 'give_all_items'|'set_spawnpoint',
 *   description: string,
 *   reply: string,
 *   replyEmpty?: string,
 *   replyUnavailable?: string,
 *   replyFailed: string,
 *   keywordsJa: string[],
 *   keywordsEn: string[],
 * }} ActionCommandDef
 */

/**
 * One-shot action commands (checked before mode switches).
 * Official chat words only: 全回収 / 拠点. Keep in sync with docs/companion-mode-commands.md.
 * @type {ActionCommandDef[]}
 */
export const ACTION_COMMANDS = [
    {
        action: 'give_all_items',
        description: '持ち物をすべて発言者へ渡す',
        reply: '全部渡すね',
        replyEmpty: '渡すものないよ',
        replyUnavailable: '近くにいないと渡せないよ',
        replyFailed: '渡せなかった…ごめん',
        keywordsJa: ['全回収'],
        keywordsEn: []
    },
    {
        action: 'set_spawnpoint',
        description: '現在地を死亡後の復活地点にする',
        reply: 'ここを拠点にしたよ',
        replyFailed: '拠点を設定できなかった…ごめん',
        keywordsJa: ['拠点'],
        keywordsEn: []
    }
];

/**
 * Mode switch commands (wait is matched before follow when both somehow match).
 * Official chat words only: 待機 / 追従. Keep in sync with docs/companion-mode-commands.md.
 * @type {ModeCommandDef[]}
 */
export const MODE_COMMANDS = [
    {
        mode: 'wait',
        description: 'その場で待機する',
        reply: 'わかった、ここで待つね',
        keywordsJa: ['待機'],
        keywordsEn: []
    },
    {
        mode: 'follow',
        description: '発言者を追従する',
        reply: 'ついていくね',
        keywordsJa: ['追従'],
        keywordsEn: []
    }
];

const ACTION_PATTERNS = Object.fromEntries(
    ACTION_COMMANDS.map((def) => [def.action, patternFromKeywords([...def.keywordsJa, ...def.keywordsEn])])
);

const MODE_PATTERNS = Object.fromEntries(
    MODE_COMMANDS.map((def) => [def.mode, patternFromKeywords([...def.keywordsJa, ...def.keywordsEn])])
);

/**
 * @param {string[]} keywords
 */
function patternFromKeywords(keywords) {
    const escaped = [...keywords]
        .sort((a, b) => b.length - a.length)
        .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(escaped.join('|'), 'i');
}

/**
 * Infer a one-shot action from clear player wording (JA/EN).
 * @param {string} text
 * @returns {'give_all_items'|'set_spawnpoint'|null}
 */
export function inferActionFromText(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    for (const def of ACTION_COMMANDS) {
        if (ACTION_PATTERNS[def.action].test(raw)) return def.action;
    }
    return null;
}

/**
 * Infer a registered mode from the official chat words (待機 / 追従).
 * Prefer wait when both somehow match.
 * @param {string} text
 * @param {string[]} allowedModeIds
 * @returns {'wait'|'follow'|null}
 */
export function inferModeFromText(text, allowedModeIds = []) {
    const allowed = new Set(allowedModeIds);
    const raw = String(text || '').trim();
    if (!raw) return null;

    for (const def of MODE_COMMANDS) {
        if (!allowed.has(def.mode)) continue;
        if (MODE_PATTERNS[def.mode].test(raw)) return def.mode;
    }
    return null;
}

/**
 * Deterministic one-shot action from player chat (no LLM).
 * Checked before mode commands.
 * @param {string} text
 * @param {string} speakerName
 * @returns {{ kind: 'action', action: 'give_all_items'|'set_spawnpoint', owner: string|null, message: string, replies: object }|null}
 */
export function classifyPlayerAction(text, speakerName) {
    const action = inferActionFromText(text);
    if (!action) return null;
    const def = ACTION_COMMANDS.find((c) => c.action === action);
    if (!def) return null;
    return {
        kind: 'action',
        action,
        owner: String(speakerName || '').trim() || null,
        message: def.reply,
        replies: {
            ok: def.reply,
            empty: def.replyEmpty,
            unavailable: def.replyUnavailable,
            failed: def.replyFailed
        }
    };
}

/**
 * Deterministic command from player chat (no LLM).
 * Actions take priority over mode switches.
 * @param {string} text
 * @param {string} speakerName
 * @param {string[]} allowedModeIds
 * @returns {{ kind: 'action'|'mode', mode?: 'wait'|'follow', action?: string, owner: string|null, message: string, replies?: object }|null}
 */
export function classifyPlayerCommand(text, speakerName, allowedModeIds = []) {
    const actionCmd = classifyPlayerAction(text, speakerName);
    if (actionCmd) return actionCmd;

    const mode = inferModeFromText(text, allowedModeIds);
    if (!mode) return null;
    const def = MODE_COMMANDS.find((c) => c.mode === mode);
    if (!def) return null;
    const owner = mode === 'follow'
        ? (String(speakerName || '').trim() || null)
        : null;
    return { kind: 'mode', mode, owner, message: def.reply };
}

/**
 * True if text contains Japanese script (hiragana / katakana / CJK).
 * @param {string} text
 */
export function looksJapanese(text) {
    return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(text || ''));
}

/** Reject agent/task-log lines (andy-micro often emits these even in Japanese). */
const AGENT_LOG_PATTERN = /(進捗|応用|目標\s*[:：]|資源|採掘|ポータル|ピッケル|オプシ|ネザー|継続検索|危険回避|不足|収集|優先待機|共闘|作成中|追加資源|丸石を集|➜|＞|／|!collect|!follow|!nearby|foundation|mapping out)/i;

export function isUsableCompanionChat(message) {
    const text = String(message || '').trim();
    if (!text || !looksJapanese(text)) return false;
    if (AGENT_LOG_PATTERN.test(text)) return false;
    if (text.length > 40) return false;
    return true;
}

/**
 * Derive follow phase from snapshot facts for accurate chat.
 * @param {object} snap
 * @param {{ follow_distance?: number, owner_near_radius?: number }} config
 * @returns {'near'|'chasing'|'far'|'lost'|'deferred'|null}
 */
export function deriveFollowPhase(snap, config = {}) {
    if (!snap || snap.mode !== 'follow') return null;

    const controlOwner = snap.controlOwner || 'follow';
    if (controlOwner !== 'follow') return 'deferred';

    if (!snap.owner) return null;

    if (snap.ownerEntityMissing) return 'lost';

    const followDistance = config.follow_distance ?? DEFAULT_FOLLOW_DISTANCE;
    const ownerNearRadius = config.owner_near_radius ?? 12;

    if (
        snap.ownerDistance != null
        && snap.ownerHasLos
        && snap.botPos
        && snap.ownerPos
        && isNearOwnerHorizontally(snap.botPos, snap.ownerPos, followDistance)
    ) {
        return 'near';
    }

    // Loaded nearby but out of FOV is still chaseable; beyond near radius is far.
    if (snap.ownerDistance != null && snap.ownerDistance > ownerNearRadius) {
        return 'far';
    }
    if (snap.ownerDistance != null || snap.ownerVisible) {
        return 'chasing';
    }

    return 'far';
}

/**
 * Locale command key for follow mode replies.
 * far/chasing share chase wording; only lost (unloaded) is "too far".
 * @param {'near'|'chasing'|'far'|'lost'|'deferred'|null} followPhase
 */
export function deriveFollowReplyKey(followPhase) {
    switch (followPhase) {
        case 'near':
            return 'follow';
        case 'chasing':
        case 'far':
            return 'follow_chase';
        case 'lost':
            return 'follow_too_far';
        case 'deferred':
            return 'follow_deferred';
        default:
            return 'follow';
    }
}

/**
 * Locale command key for owner lock announcements.
 * @param {'near'|'chasing'|'far'|'lost'|'deferred'|null} followPhase
 */
export function deriveOwnerLockedKey(followPhase) {
    if (followPhase === 'near') return 'owner_locked';
    if (followPhase === 'lost') return 'owner_locked_too_far';
    return 'owner_locked_chase';
}

/**
 * Snapshot-driven commentary via locale catalog (no LLM / no runtime MT).
 * @param {string} language
 * @param {string} eventId
 * @param {object} snap
 */
export function renderCommentary(language, eventId, snap = {}) {
    const vars = {
        owner: snap.owner || 'だれか',
        distance: snap.ownerDistance != null ? snap.ownerDistance : '?',
        health: snap.health != null ? Math.round(snap.health) : '?',
        damage: snap.lastDamageTaken != null && snap.lastDamageTaken > 0
            ? Math.round(snap.lastDamageTaken)
            : null,
        stuckSeconds: snap.stuckSeconds != null ? snap.stuckSeconds : '?',
        hostile: snap.combatTarget || snap.hostile?.name || '敵',
        hostileDistance: snap.hostile?.distance != null ? snap.hostile.distance : '?',
        mode: snap.mode || '?'
    };
    return tEvent(language || 'ja', String(eventId || ''), vars);
}

const DEFAULT_APPROACH_DISTANCES = [10, 6, 3];
const HOSTILE_BAND_RANK = { outer: 0, mid: 1, near: 2, close: 3 };
const HOSTILE_BAND_EVENT = {
    mid: 'hostile_approach_mid',
    near: 'hostile_approach_near',
    close: 'hostile_approach_close'
};

/**
 * Distance band for hostile approach commentary.
 * @param {number|null|undefined} distance
 * @param {number[]} [thresholds]
 * @returns {'outer'|'mid'|'near'|'close'|null}
 */
export function deriveHostileBand(distance, thresholds = DEFAULT_APPROACH_DISTANCES) {
    if (distance == null || !Number.isFinite(distance)) return null;
    const [midAt, nearAt, closeAt] = thresholds.length >= 3
        ? thresholds
        : DEFAULT_APPROACH_DISTANCES;
    if (distance <= closeAt) return 'close';
    if (distance <= nearAt) return 'near';
    if (distance <= midAt) return 'mid';
    return 'outer';
}

/**
 * First sighting or closer-band cross for hostiles.
 * @param {object|null} prev
 * @param {object} snap
 * @param {{ hostile_approach_distances?: number[] }} config
 * @returns {{ id: string, text: string, priority: number }|null}
 */
export function detectHostileApproach(prev, snap, config = {}) {
    if (!snap?.hostile) return null;

    const thresholds = config.hostile_approach_distances || DEFAULT_APPROACH_DISTANCES;
    const band = snap.hostileBand ?? deriveHostileBand(snap.hostile.distance, thresholds);
    const name = snap.hostile.name || '敵';
    const dist = snap.hostile.distance;

    if (!prev?.hostile) {
        return {
            id: 'hostile',
            text: `Hostile ${name} nearby (${dist}m)`,
            priority: 2
        };
    }

    const prevBand = prev.hostileBand
        ?? deriveHostileBand(prev.hostile?.distance, thresholds)
        ?? 'outer';
    const prevRank = HOSTILE_BAND_RANK[prevBand] ?? 0;
    const nextRank = HOSTILE_BAND_RANK[band] ?? 0;
    if (nextRank <= prevRank) return null;

    const eventId = HOSTILE_BAND_EVENT[band];
    if (!eventId) return null;
    return {
        id: eventId,
        text: `Hostile ${name} approaching (${band}, ${dist}m)`,
        priority: 2
    };
}

/**
 * Combat target switch while in combat control.
 * @param {object|null} prev
 * @param {object} snap
 * @returns {{ id: string, text: string, priority: number }|null}
 */
export function detectCombatTargetSwitch(prev, snap) {
    if (!snap || snap.controlOwner !== 'combat') return null;
    if (!snap.combatTarget) return null;
    if (!prev || prev.controlOwner !== 'combat') return null;
    if (prev.combatTarget === snap.combatTarget) return null;
    if (!prev.combatTarget) return null;
    return {
        id: 'combat_target_switch',
        text: `Combat target -> ${snap.combatTarget}`,
        priority: 2
    };
}

/**
 * Ongoing combat commentary while fighting.
 * @param {object} snap
 * @returns {{ id: string, text: string, priority: number }|null}
 */
export function detectCombatCommentary(snap) {
    if (!snap || snap.controlOwner !== 'combat') return null;
    if (!snap.combatTarget) return null;
    const dist = snap.hostile?.distance != null ? `${snap.hostile.distance}m` : '?';
    return {
        id: 'combat_fighting',
        text: `Fighting ${snap.combatTarget} (${dist})`,
        priority: 2
    };
}

/**
 * @deprecated Prefer renderCommentary with a snapshot. Kept for older tests.
 * @param {string} eventId
 */
export function cuteFallbackForEvent(eventId) {
    return renderCommentary('ja', eventId, {});
}

/**
 * Parse optional LLM commentary into chat text only.
 * @param {string} raw
 * @returns {{ message: string }}
 */
export function parseDialogueResponse(raw) {
    let text = String(raw ?? '').trim();
    if (!text) return { message: '' };

    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (text.includes('</think>')) {
        text = text.split('</think>').pop().trim();
    }
    if (/^<think>/i.test(text)) {
        return { message: '' };
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let message = '';

    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (typeof parsed.message === 'string') {
                message = parsed.message;
            } else if (typeof parsed.text === 'string') {
                message = parsed.text;
            }
        } catch {
            const field = jsonMatch[0].match(/"(?:message|text)"\s*:\s*"((?:\\.|[^"\\])*)"/);
            message = field ? field[1].replace(/\\"/g, '"') : '';
        }
    }

    message = sanitizeChatMessage(message);
    if (!isUsableCompanionChat(message)) {
        return { message: '' };
    }
    return { message };
}

/**
 * Strip command-like tokens and collapse whitespace.
 * @param {string} message
 */
export function sanitizeChatMessage(message) {
    let text = String(message ?? '');
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (text.includes('</think>')) {
        text = text.split('</think>').pop().trim();
    }
    if (/^<think>/i.test(text) || /^First, the user/i.test(text)) {
        return '';
    }
    text = text.replace(/!\w+(\([^)]*\))?/g, '').trim();
    text = text.replace(/```[\s\S]*?```/g, '').trim();
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 80) text = text.slice(0, 80).trim();
    if (text === '\t' || text === '...') return '';
    return text;
}

/**
 * @param {object|null} prev
 * @param {object} snap
 * @param {string} owner
 */
function ownerFoundEventId(snap, config) {
    const phase = deriveFollowPhase(snap, config);
    return phase === 'near' ? 'owner_found' : 'owner_found_chase';
}

/**
 * @param {object|null} prev
 * @param {object} snap
 * @param {{ low_health?: number, stuck_seconds?: number, low_food_hunger?: number }} config
 */
function detectDamagedEvent(prev, snap, config) {
    const recentDamage = snap.lastDamageAgeMs != null
        && snap.lastDamageAgeMs < 2000
        && (prev.lastDamageAgeMs == null || prev.lastDamageAgeMs >= 2000);
    if (!recentDamage) return null;

    const lowHealth = config.low_health ?? 8;
    if (snap.health != null && snap.health <= lowHealth) {
        return { id: 'damaged_low', text: `Low HP damage (${snap.health})`, priority: 2 };
    }
    if (snap.hostile) {
        return {
            id: 'damaged_combat',
            text: `Combat damage from ${snap.hostile.name}`,
            priority: 2
        };
    }
    return { id: 'damaged', text: `Took damage (${snap.lastDamageTaken})`, priority: 2 };
}

/**
 * Detect a notable situation change for spontaneous chat.
 * @param {object|null} prev
 * @param {object} snap
 * @param {{ low_health?: number, stuck_seconds?: number, low_food_hunger?: number }} config
 * @returns {{ id: string, text: string, priority: number }|null}
 */
export function detectSituationEvent(prev, snap, config = {}) {
    if (!prev || !snap) return null;
    const lowHealth = config.low_health ?? 8;
    const stuckSeconds = config.stuck_seconds ?? 5;
    const lowFoodHunger = config.low_food_hunger ?? 14;

    if (prev.controlOwner !== snap.controlOwner) {
        const next = snap.controlOwner || 'follow';
        if (
            (next === 'follow' || next === 'wait')
            && !OVERLAY_CONTROL_OWNERS.has(prev.controlOwner)
        ) {
            /* skip — registered mode switch already has a command reply */
        } else {
            return { id: `control_${next}`, text: `Control -> ${next}`, priority: 2 };
        }
    }

    const targetSwitch = detectCombatTargetSwitch(prev, snap);
    if (targetSwitch) return targetSwitch;

    if (!prev.owner && snap.owner) {
        return {
            id: ownerFoundEventId(snap, config),
            text: `Found owner ${snap.owner}`,
            priority: 2
        };
    }
    if (prev.owner && !snap.owner) {
        return { id: 'owner_lost', text: 'Lost sight of owner for a long time', priority: 1 };
    }

    if (
        snap.foodCount === 0
        && snap.hunger != null
        && snap.hunger <= lowFoodHunger
        && (
            (prev.foodCount ?? 0) > 0
            || prev.hunger == null
            || prev.hunger > lowFoodHunger
        )
    ) {
        return { id: 'no_food', text: 'Out of food', priority: 2 };
    }

    if (
        snap.torchCount === 0
        && (prev.torchCount ?? 0) > 0
    ) {
        return {
            id: 'no_torch',
            text: 'Out of torches',
            priority: snap.isNight ? 2 : 1
        };
    }

    if (
        snap.health != null
        && snap.health <= lowHealth
        && (prev.health == null || prev.health > lowHealth)
    ) {
        return { id: 'low_health', text: `Health is low (${snap.health})`, priority: 2 };
    }

    const damaged = detectDamagedEvent(prev, snap, config);
    if (damaged) return damaged;

    if (snap.stuckAlert) {
        return { id: 'stuck', text: `Stuck for ${snap.stuckSeconds}s`, priority: 2 };
    }
    if (
        snap.stuckSeconds >= stuckSeconds
        && prev.stuckSeconds < stuckSeconds
    ) {
        return { id: 'stuck', text: `Stuck for ${snap.stuckSeconds}s`, priority: 2 };
    }
    if (snap.isNight && !prev.isNight) {
        return { id: 'night', text: 'Night has fallen', priority: 0 };
    }
    if (!snap.isNight && prev.isNight) {
        return { id: 'day', text: 'Morning has come', priority: 0 };
    }

    const approach = detectHostileApproach(prev, snap, config);
    if (approach) return approach;

    return null;
}

/**
 * Soft idle mutter while following or waiting (no situation change required).
 * @param {object} snap
 * @param {{ follow_distance?: number, owner_near_radius?: number }} config
 * @returns {{ id: string, text: string, priority: number }|null}
 */
export function detectIdleCommentary(snap, config = {}) {
    if (!snap) return null;
    if (snap.controlOwner === 'combat') return null;

    if (snap.mode === 'follow') {
        const phase = deriveFollowPhase(snap, config);
        if (!phase || phase === 'deferred') return null;

        const idleIds = {
            near: 'idle_follow_near',
            chasing: 'idle_follow_chasing',
            far: 'idle_follow_far',
            lost: 'idle_follow_lost'
        };
        const id = idleIds[phase];
        if (!id) return null;

        const dist = snap.ownerDistance != null ? `${snap.ownerDistance}m` : '近く';
        return {
            id,
            text: `${snap.owner || 'だれか'} follow ${phase} (${dist})`,
            priority: 0
        };
    }

    if (snap.mode === 'wait') {
        return {
            id: 'idle_wait',
            text: 'Waiting in place',
            priority: 0
        };
    }
    return null;
}
