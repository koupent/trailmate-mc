/** Mob labels from the versioned ja_jp table. Logic keeps the raw kind id. */
let labels = null;

export async function loadEntityLabels() {
  try {
    const response = await fetch('/api/entity-labels');
    if (!response.ok) throw new Error('entity labels');
    const data = await response.json();
    labels = data && typeof data === 'object' ? data : {};
  } catch {
    labels = {};
  }
}

export function kindLabel(kind) {
  const key = String(kind || '').trim().toLowerCase().replace(/^minecraft:/, '');
  if (!key) return '不明';
  if (!labels) return key;
  return labels[key] || `minecraft:${key}`;
}
