/**
 * Pure helpers for companion dialogue (no Minecraft / LLM imports).
 * Mode/owner come from deterministic keywords; commentary uses locale catalogs.
 */

import { tEvent } from '../i18n/index.js';


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

/**
 * Reject English and agent/task-log style lines (even if they contain some Japanese).
 * @param {string} message
 */
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
 * Snapshot-driven commentary via locale catalog (no LLM / no runtime MT).
 * Fact fields are deterministic; wording variants may vary slightly.
 * @param {string} language
 * @param {string} eventId
 * @param {object} snap
 */
export function renderCommentary(language, eventId, snap = {}) {
    const vars = {
        owner: snap.owner || 'だれか',
        distance: snap.ownerDistance != null ? snap.ownerDistance : '?',
        health: snap.health != null ? Math.round(snap.health) : '?',
        stuckSeconds: snap.stuckSeconds != null ? snap.stuckSeconds : '?',
        hostile: snap.hostile?.name || '敵',
        hostileDistance: snap.hostile?.distance != null ? snap.hostile.distance : '?',
        mode: snap.mode || '?'
    };
    return tEvent(language || 'ja', String(eventId || ''), vars);
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
 * Detect a notable situation change for spontaneous chat.
 * @param {object|null} prev
 * @param {object} snap
 * @param {{ low_health?: number, stuck_seconds?: number }} config
 * @returns {{ id: string, text: string, priority: number }|null}
 */
export function detectSituationEvent(prev, snap, config = {}) {
    if (!prev || !snap) return null;
    const lowHealth = config.low_health ?? 8;
    const stuckSeconds = config.stuck_seconds ?? 5;

    if (!prev.owner && snap.owner) {
        return { id: 'owner_found', text: `Found owner ${snap.owner}`, priority: 2 };
    }
    if (prev.owner && !snap.owner) {
        return { id: 'owner_lost', text: 'Lost sight of owner for a long time', priority: 1 };
    }
    if (
        snap.health != null
        && snap.health <= lowHealth
        && (prev.health == null || prev.health > lowHealth)
    ) {
        return { id: 'low_health', text: `Health is low (${snap.health})`, priority: 2 };
    }
    if (
        snap.lastDamageAgeMs != null
        && snap.lastDamageAgeMs < 2000
        && (prev.lastDamageAgeMs == null || prev.lastDamageAgeMs >= 2000)
    ) {
        return { id: 'damaged', text: `Took damage recently (${snap.lastDamageTaken})`, priority: 2 };
    }
    if (
        snap.stuckSeconds >= stuckSeconds
        && prev.stuckSeconds < stuckSeconds
    ) {
        return { id: 'stuck', text: `Stuck for ${snap.stuckSeconds}s`, priority: 1 };
    }
    if (snap.isNight && !prev.isNight) {
        return { id: 'night', text: 'Night has fallen', priority: 0 };
    }
    if (!snap.isNight && prev.isNight) {
        return { id: 'day', text: 'Morning has come', priority: 0 };
    }
    if (!prev.hostile && snap.hostile) {
        return {
            id: 'hostile',
            text: `Hostile ${snap.hostile.name} nearby (${snap.hostile.distance}m)`,
            priority: 1
        };
    }
    return null;
}

/**
 * Soft idle mutter while following or waiting (no situation change required).
 * @param {object} snap
 * @returns {{ id: string, text: string, priority: number }|null}
 */
export function detectIdleCommentary(snap) {
    if (!snap) return null;
    if (snap.mode === 'follow') {
        const owner = snap.owner || 'だれか';
        const dist = snap.ownerDistance != null ? `${snap.ownerDistance}m` : '近く';
        return {
            id: 'idle_follow',
            text: `${owner} の後ろをついていく（距離 ${dist}）。いまの気持ちを短くつぶやく。`,
            priority: 0
        };
    }
    if (snap.mode === 'wait') {
        return {
            id: 'idle_wait',
            text: 'その場で待っている。いまの気持ちを短くつぶやく。',
            priority: 0
        };
    }
    return null;
}
