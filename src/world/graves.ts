import { Vec3 } from 'vec3';
import nbt from 'prismarine-nbt';

/** Max horizontal/vertical search from a nametag to its grave block. */
const GRAVE_BLOCK_SEARCH_DY = 3;
const GRAVE_BLOCK_SEARCH_XZ = 1;

/** Entity.displayName values that are type labels, not hologram text. */
const GENERIC_ENTITY_LABELS = new Set([
  'text display',
  'armor stand',
  'interaction',
  'item display',
  'block display',
  'item',
  'villager',
  'player'
]);

const NBT_TYPES = new Set([
  'compound', 'list', 'string', 'int', 'byte', 'short', 'long',
  'float', 'double', 'byteArray', 'intArray', 'longArray'
]);

export type GraveTarget = {
  ownerName: string;
  label: string;
  hologramPos: { x: number; y: number; z: number };
  block: {
    name: string;
    position: { x: number; y: number; z: number };
  };
};

/**
 * Strip Minecraft / legacy formatting codes from hologram text.
 */
export function stripFormatting(text: string): string {
  return stripCodes(text).replace(/\s+/g, ' ').trim();
}

function stripCodes(text: string): string {
  return String(text || '')
    .replace(/\u00a7./g, '')
    .replace(/§./g, '')
    .replace(/&[0-9a-fk-or]/gi, '');
}

/**
 * Convert prismarine-nbt typed objects into plain JSON-like values.
 */
export function unwrapNbt(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  const obj = value as { type?: string; value?: unknown };
  if (typeof obj.type === 'string' && NBT_TYPES.has(obj.type) && 'value' in obj) {
    try {
      return nbt.simplify(obj as any);
    } catch {
      if (obj.type === 'compound' && obj.value && typeof obj.value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(obj.value as Record<string, unknown>)) {
          out[key] = unwrapNbt(nested);
        }
        return out;
      }
      if (obj.type === 'list') {
        const list = obj.value as { type?: string; value?: unknown[] } | unknown[];
        const items = Array.isArray(list) ? list : list?.value;
        if (Array.isArray(items)) return items.map((item) => unwrapNbt(item));
      }
      return obj.value;
    }
  }
  return value;
}

/**
 * Flatten chat components / NBT-ish values to plain text.
 */
export function chatToPlain(value: unknown, depth = 0): string | null {
  if (value == null || depth > 10) return null;

  const unwrapped = depth === 0 ? unwrapNbt(value) : value;
  if (unwrapped !== value) {
    return chatToPlain(unwrapped, depth + 1);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return chatToPlain(JSON.parse(trimmed), depth + 1);
      } catch {
        /* keep raw string */
      }
    }
    // Keep surrounding spaces so chat "extra" fragments still join correctly.
    const plain = stripCodes(value);
    return plain.length ? plain : null;
  }

  // Bare numbers/booleans are metadata noise (opacity, line width, …), not hologram text.
  if (typeof value === 'number' || typeof value === 'boolean') {
    return null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((part) => chatToPlain(part, depth + 1))
      .filter((part) => part != null && part !== '');
    return parts.length ? stripFormatting(parts.join('')) : null;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, any>;

    // Still-typed NBT node deeper in the tree.
    if (typeof obj.type === 'string' && NBT_TYPES.has(obj.type) && 'value' in obj) {
      return chatToPlain(unwrapNbt(obj), depth + 1);
    }

    // prismarine-chat ChatMessage
    if (typeof obj.toString === 'function' && obj.toString !== Object.prototype.toString) {
      try {
        const asString = String(obj.toString());
        if (asString && asString !== '[object Object]') {
          const plain = stripFormatting(asString);
          if (plain && !GENERIC_ENTITY_LABELS.has(plain.toLowerCase())) return plain;
        }
      } catch {
        /* ignore */
      }
    }

    let text = '';
    if (typeof obj.text === 'string') text += obj.text;
    if (typeof obj.translate === 'string') text += obj.translate;
    if (Array.isArray(obj.extra)) {
      text += obj.extra.map((part: unknown) => chatToPlain(part, depth + 1) || '').join('');
    }
    if (typeof obj.with === 'object' && Array.isArray(obj.with)) {
      text += obj.with.map((part: unknown) => chatToPlain(part, depth + 1) || '').join(' ');
    }
    if (!text && obj.json != null) {
      return chatToPlain(obj.json, depth + 1);
    }
    if (!text && obj.message != null) {
      return chatToPlain(obj.message, depth + 1);
    }

    const plain = stripCodes(text).replace(/\s+/g, ' ');
    if (!plain.trim()) return null;
    return depth === 0 ? plain.trim() : plain;
  }

  return null;
}

/**
 * Extract the grave owner username from a hologram label.
 * Supports bare names and GravesX defaults like "Name's Grave".
 */
export function extractGraveOwnerName(displayText: string): string | null {
  const cleaned = stripFormatting(displayText);
  if (!cleaned) return null;

  const graveMatch = cleaned.match(/(?:^|\s)([A-Za-z0-9_]{1,16})(?:'s|’s)\s+Grave\b/i);
  if (graveMatch?.[1]) return graveMatch[1];

  // Some servers show only the player name on the first hologram line.
  // Require at least one letter so metadata numbers like "3" are not treated as names.
  if (/^[A-Za-z0-9_]{1,16}$/.test(cleaned) && /[A-Za-z]/.test(cleaned)) return cleaned;

  return null;
}

/**
 * True when the hologram identifies `username` as the sole owner.
 */
export function isOwnGraveLabel(displayText: string, username: string): boolean {
  if (!username) return false;
  const owner = extractGraveOwnerName(displayText);
  return owner != null && owner === username;
}

/**
 * Blocks that may represent a GravesX / death-chest grave object.
 * Ambiguous terrain (dirt, stone, …) is intentionally excluded.
 */
export function isGraveCandidateBlock(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = String(name).toLowerCase();
  if (n === 'player_head' || n === 'player_wall_head') return true;
  if (n.endsWith('_head') || n.endsWith('_skull')) return true;
  if (n === 'chest' || n === 'trapped_chest' || n === 'barrel') return true;
  if (n.endsWith('shulker_box')) return true;
  return false;
}

function isGenericEntityLabel(text: string | null | undefined): boolean {
  if (!text) return true;
  return GENERIC_ENTITY_LABELS.has(stripFormatting(text).toLowerCase());
}

/**
 * Read a named entity metadata field via minecraft-data metadataKeys index.
 */
export function readNamedMetadata(entity: any, field: string, registry?: any): unknown {
  if (!entity?.metadata) return undefined;
  const keys = registry?.entitiesByName?.[entity.name]?.metadataKeys
    || entity.metadataKeys;
  if (Array.isArray(keys)) {
    const idx = keys.indexOf(field);
    if (idx >= 0 && entity.metadata[idx] !== undefined) {
      return entity.metadata[idx];
    }
  }
  // Some builds keep a parallel named map.
  if (entity.metadata[field] !== undefined) return entity.metadata[field];
  return undefined;
}

/**
 * Best-effort text from armor stands / text displays / custom-named entities.
 * Never treats generic type labels like "Text Display" as hologram content.
 */
export function readEntityDisplayText(entity: any, registry?: any): string | null {
  if (!entity) return null;

  const prefer: unknown[] = [];

  // text_display: the hologram body lives in metadata "text", not displayName.
  const textMeta = readNamedMetadata(entity, 'text', registry);
  if (textMeta !== undefined) prefer.push(textMeta);

  const customMeta = readNamedMetadata(entity, 'custom_name', registry);
  if (customMeta !== undefined) prefer.push(customMeta);

  prefer.push(
    entity.username,
    entity.customName,
    typeof entity.getCustomName === 'function' ? entity.getCustomName() : null
  );

  // Fall back to scanning remaining metadata values (skip pure type labels later).
  if (entity.metadata && typeof entity.metadata === 'object') {
    for (const value of Object.values(entity.metadata)) {
      prefer.push(value);
    }
  }

  // displayName last: for text_display it is only the entity type ("Text Display").
  if (typeof entity.displayName === 'string') prefer.push(entity.displayName);

  for (const raw of prefer) {
    const plain = chatToPlain(raw);
    if (!plain || isGenericEntityLabel(plain)) continue;
    return plain;
  }
  return null;
}

function isHologramEntity(entity: any, registry?: any): boolean {
  if (!entity?.position) return false;
  const name = String(entity.name || '').toLowerCase();
  if (name === 'armor_stand' || name === 'text_display' || name === 'interaction') return true;
  // Named floating labels without a known type still count if they have readable text.
  return readEntityDisplayText(entity, registry) != null
    && (entity.type === 'object' || entity.type === 'other');
}

type BotLike = {
  username?: string;
  entity?: { position: { x: number; y: number; z: number; distanceTo: (p: any) => number } };
  entities?: Record<string | number, any>;
  blockAt?: (pos: Vec3) => { name?: string; position: { x: number; y: number; z: number } } | null;
  registry?: { entitiesByName?: Record<string, { metadataKeys?: string[] }> };
};

/**
 * Find graves owned by `username` within `radius` of the bot.
 * Requires a readable owner label AND a known grave-like block under/near it.
 */
export function findOwnGravesNear(bot: BotLike, username: string, radius = 10): GraveTarget[] {
  if (!bot?.entity || !username) return [];

  const results: GraveTarget[] = [];
  const seenBlocks = new Set<string>();
  const registry = bot.registry;

  for (const entity of Object.values(bot.entities || {})) {
    if (!isHologramEntity(entity, registry)) continue;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist > radius) continue;

    const label = readEntityDisplayText(entity, registry);
    if (!label || !isOwnGraveLabel(label, username)) continue;

    const block = findGraveBlockNearHologram(bot, entity.position);
    if (!block) continue;

    const key = `${Math.floor(block.position.x)},${Math.floor(block.position.y)},${Math.floor(block.position.z)}`;
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key);

    results.push({
      ownerName: username,
      label: stripFormatting(label),
      hologramPos: {
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z
      },
      block: {
        name: String(block.name),
        position: {
          x: block.position.x,
          y: block.position.y,
          z: block.position.z
        }
      }
    });
  }

  results.sort((a, b) => {
    const da = bot.entity!.position.distanceTo(a.block.position);
    const db = bot.entity!.position.distanceTo(b.block.position);
    return da - db;
  });
  return results;
}

/**
 * Search under/near a hologram for a known grave-like block.
 */
export function findGraveBlockNearHologram(
  bot: BotLike,
  hologramPos: { x: number; y: number; z: number }
): { name: string; position: { x: number; y: number; z: number } } | null {
  if (!bot.blockAt) return null;

  const baseX = Math.floor(hologramPos.x);
  const baseY = Math.floor(hologramPos.y);
  const baseZ = Math.floor(hologramPos.z);

  /** Prefer blocks closer to the hologram, then lower Y (head sits under the label). */
  const candidates: { name: string; position: { x: number; y: number; z: number }; score: number }[] = [];

  for (let dy = 0; dy >= -GRAVE_BLOCK_SEARCH_DY; dy--) {
    for (let dx = -GRAVE_BLOCK_SEARCH_XZ; dx <= GRAVE_BLOCK_SEARCH_XZ; dx++) {
      for (let dz = -GRAVE_BLOCK_SEARCH_XZ; dz <= GRAVE_BLOCK_SEARCH_XZ; dz++) {
        const pos = new Vec3(baseX + dx, baseY + dy, baseZ + dz);
        const block = bot.blockAt(pos);
        if (!block?.name || !isGraveCandidateBlock(block.name)) continue;
        const score = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 0.5;
        candidates.push({
          name: block.name,
          position: { x: block.position.x, y: block.position.y, z: block.position.z },
          score
        });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  return { name: best.name, position: best.position };
}
