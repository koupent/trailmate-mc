/**
 * Validate and persist the companion's retention rules.
 *
 * The dashboard is the only process with a writable `config.json`, so it is the
 * only place a bad value can be stopped before it reaches the file. Everything
 * here is checked against the catalog the bot itself published — category ids,
 * item names and the bounds each total accepts all come from there — which is
 * why this module hard-codes none of them and cannot drift from the classifier.
 *
 * Nothing in here touches the filesystem or the network; `server.mjs` does the
 * reading and writing, and `tests/retention_settings.test.js` drives these
 * functions directly.
 */

/** A rejection the caller should turn into a 400, not a 500. */
export class RetentionValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RetentionValidationError';
    this.status = 400;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A whole number, or null when the value cannot be read as one.
 *
 * Deliberately strict: `"2"` is what an HTML number input sends, so it is
 * accepted, but `2.5`, `"two"` and `NaN` are refused rather than truncated.
 * Silently rounding a typo into a working limit is how someone ends up with a
 * companion that keeps a number they never chose.
 *
 * @param {unknown} value
 */
function asInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Category id → { label, limit bounds, item names } from a published catalog.
 * @param {{ categories?: Array<{ id: string, label?: string, limit?: { min?: number, max?: number, default?: number }, items?: Array<{ name: string }> }> }|null|undefined} catalog
 */
function indexCatalog(catalog) {
  const index = new Map();
  for (const category of catalog?.categories || []) {
    if (!category?.id) continue;
    index.set(category.id, {
      label: category.label || category.id,
      min: Number(category.limit?.min) || 0,
      max: Number(category.limit?.max) || 0,
      default: Number(category.limit?.default) || 0,
      items: new Set((category.items || []).map((item) => item.name))
    });
  }
  return index;
}

/**
 * @param {ReturnType<typeof indexCatalog>} index
 * @param {string} id
 */
function requireCategory(index, id) {
  const category = index.get(id);
  if (!category) {
    throw new RetentionValidationError(`知らないカテゴリです: ${id}`);
  }
  return category;
}

/**
 * Check one submitted retention block against the catalog and return the exact
 * shape to persist.
 *
 * Categories the caller left out keep their default total and no per-item
 * rules, so a partial submission is a valid one: the result always names every
 * category in the catalog.
 *
 * @param {object|null|undefined} catalog as published by the bot's control API
 * @param {unknown} input
 * @returns {Record<string, { limit: number, items: Record<string, number> }>}
 */
export function normalizeRetentionInput(catalog, input) {
  const index = indexCatalog(catalog);
  if (index.size === 0) {
    throw new RetentionValidationError(
      '相棒からアイテム一覧を取得できていないため保存できません。ボットの準備が終わってからお試しください。'
    );
  }
  if (!isPlainObject(input)) {
    throw new RetentionValidationError('保持設定の形式が正しくありません');
  }

  for (const id of Object.keys(input)) requireCategory(index, id);

  /** @type {Record<string, { limit: number, items: Record<string, number> }>} */
  const normalized = {};
  for (const [id, category] of index) {
    const submitted = input[id];
    if (submitted != null && !isPlainObject(submitted)) {
      throw new RetentionValidationError(`${category.label}の設定の形式が正しくありません`);
    }
    normalized[id] = {
      limit: normalizeLimit(category, submitted?.limit),
      items: normalizeItems(category, submitted?.items)
    };
  }
  return normalized;
}

/**
 * @param {{ label: string, min: number, max: number, default: number }} category
 * @param {unknown} value
 */
function normalizeLimit(category, value) {
  if (value == null || value === '') return category.default;
  const limit = asInteger(value);
  if (limit == null) {
    throw new RetentionValidationError(`${category.label}の合計は整数で入力してください`);
  }
  if (limit < category.min || limit > category.max) {
    // The floor is 1 on gear for a reason worth stating: at 1 the worn piece
    // fills the budget on its own, and 0 would ask the companion to hand back
    // what it is wearing.
    const note = category.min > 0
      ? `（装備カテゴリは ${category.min} 以上。${category.min} なら装備中の分だけを残します）`
      : '';
    throw new RetentionValidationError(
      `${category.label}の合計は ${category.min}〜${category.max} で入力してください${note}`
    );
  }
  return limit;
}

/**
 * @param {{ label: string, max: number, items: Set<string> }} category
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function normalizeItems(category, value) {
  if (value == null) return {};
  if (!isPlainObject(value)) {
    throw new RetentionValidationError(`${category.label}のアイテム設定の形式が正しくありません`);
  }

  /** @type {Record<string, number>} */
  const items = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!category.items.has(name)) {
      throw new RetentionValidationError(`${category.label}にないアイテムです: ${name}`);
    }
    // An empty box means "no cap of its own" — the category total still applies.
    if (raw == null || raw === '') continue;
    const limit = asInteger(raw);
    if (limit == null) {
      throw new RetentionValidationError(`${name} の個数は整数で入力してください`);
    }
    if (limit < 0 || limit > category.max) {
      throw new RetentionValidationError(
        `${name} の個数は 0〜${category.max} で入力してください（0 で保持しない）`
      );
    }
    items[name] = limit;
  }
  return items;
}

/**
 * What the picker should show: every catalog category, the total in force, and
 * only the per-item rules that still refer to an item the catalog offers.
 *
 * Reading is lenient where writing is strict. `config.json` can be hand-edited
 * and can predate a Minecraft version bump, and neither is a reason to refuse
 * to draw the screen — an unusable value simply falls back to the default.
 *
 * @param {object|null|undefined} catalog
 * @param {unknown} stored the `companion.item_share.retention` block, if any
 * @returns {Record<string, { limit: number, items: Record<string, number> }>}
 */
export function effectiveRetention(catalog, stored) {
  const index = indexCatalog(catalog);
  const block = isPlainObject(stored) ? stored : {};

  /** @type {Record<string, { limit: number, items: Record<string, number> }>} */
  const effective = {};
  for (const [id, category] of index) {
    const entry = isPlainObject(block[id]) ? block[id] : {};
    const limit = asInteger(entry.limit);
    /** @type {Record<string, number>} */
    const items = {};
    if (isPlainObject(entry.items)) {
      for (const [name, raw] of Object.entries(entry.items)) {
        const value = asInteger(raw);
        if (value == null || value < 0 || !category.items.has(name)) continue;
        items[name] = Math.min(value, category.max);
      }
    }
    effective[id] = {
      limit: limit == null
        ? category.default
        : Math.min(category.max, Math.max(category.min, limit)),
      items
    };
  }
  return effective;
}

/**
 * The retention block inside a parsed `config.json`, or undefined.
 * @param {unknown} config
 */
export function readRetentionBlock(config) {
  if (!isPlainObject(config)) return undefined;
  const companion = config.companion;
  if (!isPlainObject(companion)) return undefined;
  const itemShare = companion.item_share;
  if (!isPlainObject(itemShare)) return undefined;
  return itemShare.retention;
}

/**
 * Put a retention block into a parsed `config.json`, creating the `companion`
 * and `item_share` levels if this install has never had them — a real
 * `config.json` often has neither.
 *
 * Mutates and returns the object it was given, so the caller writes back
 * exactly the file it read plus this one branch.
 *
 * @template {Record<string, any>} T
 * @param {T} config
 * @param {Record<string, { limit: number, items: Record<string, number> }>} retention
 * @returns {T}
 */
export function mergeRetentionIntoConfig(config, retention) {
  const target = isPlainObject(config) ? config : /** @type {any} */ ({});
  if (!isPlainObject(target.companion)) target.companion = {};
  if (!isPlainObject(target.companion.item_share)) target.companion.item_share = {};
  target.companion.item_share.retention = retention;
  return /** @type {T} */ (target);
}
