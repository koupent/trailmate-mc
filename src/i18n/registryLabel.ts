const MINECRAFT_PREFIX = 'minecraft:';

/** Registry id without a minecraft: prefix. Comparison keys stay lowercase. */
export function registryKey(id: string): string {
  let key = String(id || '').trim().toLowerCase();
  if (key.startsWith(MINECRAFT_PREFIX)) key = key.slice(MINECRAFT_PREFIX.length);
  return key;
}

/**
 * Japanese label from a versioned map.
 * A missing id stays a raw registry id so a gap in the language data is visible.
 */
export function lookupJa(map: Record<string, string>, id: string): string {
  const key = registryKey(id);
  if (!key) return '不明';
  return map[key] || `${MINECRAFT_PREFIX}${key}`;
}
