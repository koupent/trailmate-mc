/**
 * The item picker: which items the companion keeps, and how many.
 *
 * Three rules shape this file.
 *
 * The edits live in `state.retention`, never in the DOM. Switching tabs throws
 * the panel away and redraws it from that object, so a number typed on the
 * armor tab is still there after a trip to the food tab and back.
 *
 * Nothing redraws on a timer. The status panel next door is replaced wholesale
 * every two seconds, which would eat a half-typed number; this zone reloads
 * only when it is opened with no unsaved edits, exactly like `#settings-form`.
 *
 * Markup is only built when the *structure* changes — a different category, a
 * different set of items. Ticking a box changes no structure, so the row is
 * written back one property at a time and the row someone is looking at stays
 * exactly where it is, with the keyboard focus still on it.
 */

import { syncHtml, syncProp, syncText } from './domSync.js';

const ZONE_ID = 'retention-zone';
const tabsEl = document.getElementById('retention-tabs');
const panelsEl = document.getElementById('retention-panels');
const saveBtn = document.getElementById('retention-save');
const resetBtn = document.getElementById('retention-reset');
const msgEl = document.getElementById('retention-msg');

const state = {
  /** @type {{ categories: Array<any> }|null} */
  catalog: null,
  /** @type {Record<string, { limit: number, items: Record<string, number> }>} */
  retention: {},
  /** @type {string|null} */
  activeCategory: null,
  loading: false,
  loaded: false,
  saving: false,
  /** Unsaved edits: suppresses the reload a tab switch would otherwise do. */
  dirty: false
};

/* ===== helpers ===== */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function setMsg(text, kind = '') {
  if (!msgEl) return;
  syncText(msgEl, text || '');
  syncProp(msgEl, 'className', `msg ${kind}`.trim());
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }
  return data;
}

function categoryById(id) {
  return (state.catalog?.categories || []).find((category) => category.id === id) || null;
}

function entryFor(id) {
  if (!state.retention[id]) state.retention[id] = { limit: 0, items: {} };
  return state.retention[id];
}

/* ===== model edits ===== */
function setCategoryLimit(id, raw) {
  entryFor(id).limit = raw === '' ? '' : Number(raw);
  markDirty();
}

function setItemKept(categoryId, name, kept) {
  const entry = entryFor(categoryId);
  if (kept) {
    delete entry.items[name];
  } else {
    entry.items[name] = 0;
  }
  markDirty();
}

function setItemLimit(categoryId, name, raw) {
  const entry = entryFor(categoryId);
  if (raw === '') {
    // An empty box is "no cap of its own", which is the absence of a rule —
    // not a zero, which would strike the item off the list entirely.
    delete entry.items[name];
  } else {
    entry.items[name] = Number(raw);
  }
  markDirty();
}

function markDirty() {
  state.dirty = true;
  setMsg('未保存の変更があります');
  syncActions();
}

/* ===== rendering ===== */
function syncActions() {
  const ready = Boolean(state.catalog) && !state.saving;
  if (saveBtn) saveBtn.disabled = !ready;
  if (resetBtn) resetBtn.disabled = !ready;
}

function renderTabs() {
  if (!tabsEl) return;
  const categories = state.catalog?.categories || [];
  // どれが選ばれているかは markup に含めない。選択の移動で作り直さないため。
  syncHtml(
    tabsEl,
    categories
      .map(
        (category) => `<button type="button" class="tab" role="tab" aria-selected="false"
        data-retention-tab="${escapeHtml(category.id)}">${escapeHtml(category.label)}</button>`
      )
      .join('')
  );
  tabsEl.querySelectorAll('[data-retention-tab]').forEach((button) => {
    const active = button.getAttribute('data-retention-tab') === state.activeCategory;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

/**
 * 行の骨格だけ。checked / value / disabled は書かない——ここに書くと、
 * チェック1つで markup が変わり、パネルごと作り直すことになる。
 * 値は描いた後に syncItemRow が入れる。
 */
function renderItemRow(category, item) {
  const detail = item.foodPoints != null ? `満腹度 ${item.foodPoints}` : '';
  const name = escapeHtml(item.name);
  return `<li class="retention-item" data-retention-row="${name}">
    <label class="retention-item-name">
      <input type="checkbox" data-retention-keep="${name}" />
      <span>${escapeHtml(item.label || item.name)}</span>
    </label>
    <span class="retention-item-detail muted">${escapeHtml(detail)}</span>
    <label class="retention-item-limit">
      上限
      <input type="number" inputmode="numeric" min="0" max="${category.limit.max}"
        placeholder="なし" data-retention-item-limit="${name}" />
    </label>
  </li>`;
}

function panelHtml(category) {
  const floorNote = category.limit.min > 0
    ? `（最小 ${category.limit.min}。${category.limit.min} なら装備中の分だけを残します）`
    : '（0 で一切残さない）';

  return `
    <div class="retention-total">
      <label>
        ${escapeHtml(category.label)}は合計
        <input type="number" inputmode="numeric" id="retention-category-limit"
          min="${category.limit.min}" max="${category.limit.max}" />
        個まで
      </label>
      <span class="muted">${escapeHtml(floorNote)}</span>
    </div>
    <p class="muted retention-hint">
      チェックを外したアイテムは残さず返します。「上限」を空にすると、合計の範囲でいくつでも残します。
    </p>
    <ul class="retention-items">
      ${category.items.map((item) => renderItemRow(category, item)).join('')}
    </ul>
  `;
}

/** 行1つを state から書き戻す。作り直さないので、位置もフォーカスも動かない。 */
function syncItemRow(row, categoryId, name) {
  const configured = entryFor(categoryId).items[name];
  const kept = configured !== 0;
  row.classList.toggle('is-off', !kept);
  syncProp(row.querySelector('[data-retention-keep]'), 'checked', kept);
  const limitInput = row.querySelector('[data-retention-item-limit]');
  syncProp(limitInput, 'disabled', !kept);
  syncProp(limitInput, 'value', kept && configured != null ? String(configured) : '');
}

function syncPanelValues(category) {
  const entry = entryFor(category.id);
  syncProp(
    panelsEl.querySelector('#retention-category-limit'),
    'value',
    entry.limit === '' ? '' : String(entry.limit)
  );
  panelsEl.querySelectorAll('[data-retention-row]').forEach((row) => {
    syncItemRow(row, category.id, row.getAttribute('data-retention-row'));
  });
}

function renderPanel() {
  if (!panelsEl) return;
  const category = categoryById(state.activeCategory);
  if (!category) {
    syncHtml(panelsEl, '<div class="muted">カテゴリがありません</div>');
    return;
  }
  // 同じカテゴリを描き直しても markup は同じ。作り直さず、値だけ書き戻す。
  syncHtml(panelsEl, panelHtml(category));
  syncPanelValues(category);
}

function render() {
  renderTabs();
  renderPanel();
  syncActions();
}

/* ===== load / save ===== */
async function loadRetention({ force = false } = {}) {
  if (state.loading) return;
  if (state.loaded && !force) return;
  state.loading = true;
  try {
    const data = await api('/api/retention');
    if (!data.catalog) {
      state.catalog = null;
      state.loaded = false;
      const message = data.message || 'アイテム一覧を取得できませんでした。';
      syncHtml(panelsEl, `<div class="muted">${escapeHtml(message)}</div>`);
      syncHtml(tabsEl, '');
      syncActions();
      return;
    }
    state.catalog = data.catalog;
    state.retention = data.retention || {};
    state.activeCategory = state.catalog.categories[0]?.id || null;
    state.loaded = true;
    state.dirty = false;
    setMsg('');
    render();
  } catch (error) {
    state.loaded = false;
    syncHtml(panelsEl, `<div class="msg err">${escapeHtml(error.message)}</div>`);
    syncActions();
  } finally {
    state.loading = false;
  }
}

async function saveRetention() {
  if (!state.catalog || state.saving) return;
  state.saving = true;
  syncActions();
  setMsg('保存中…');
  try {
    const result = await api('/api/retention', {
      method: 'POST',
      body: JSON.stringify({ retention: state.retention })
    });
    if (result.retention) state.retention = result.retention;
    if (result.catalog) state.catalog = result.catalog;
    state.dirty = false;
    state.loaded = true;
    render();
    setMsg(result.message || '保存しました', result.applied ? 'ok' : '');
  } catch (error) {
    setMsg(error.message, 'err');
  } finally {
    state.saving = false;
    syncActions();
  }
}

function resetToDefaults() {
  if (!state.catalog) return;
  for (const category of state.catalog.categories) {
    state.retention[category.id] = { limit: category.limit.default, items: {} };
  }
  render();
  markDirty();
  setMsg('既定に戻しました。保存すると反映されます。');
}

/* ===== events ===== */
tabsEl?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-retention-tab]');
  if (!button) return;
  state.activeCategory = button.getAttribute('data-retention-tab');
  render();
});

panelsEl?.addEventListener('change', (event) => {
  const target = event.target;
  if (!target || !state.activeCategory) return;
  if (target.id === 'retention-category-limit') {
    setCategoryLimit(state.activeCategory, target.value);
    return;
  }
  const keepName = target.getAttribute?.('data-retention-keep');
  if (keepName) {
    setItemKept(state.activeCategory, keepName, target.checked);
    // 変わったのはこの行だけ。パネルごと作り直すと、外した行が視界から消える。
    const row = target.closest('[data-retention-row]');
    if (row) syncItemRow(row, state.activeCategory, keepName);
    return;
  }
  const limitName = target.getAttribute?.('data-retention-item-limit');
  if (limitName) setItemLimit(state.activeCategory, limitName, target.value);
});

saveBtn?.addEventListener('click', () => void saveRetention());
resetBtn?.addEventListener('click', resetToDefaults);

document.addEventListener('trailmate:tab', (event) => {
  if (event.detail?.tabId !== 'settings') return;
  // Half-typed edits outrank a refresh: only a clean form is ever replaced.
  if (state.dirty) return;
  void loadRetention({ force: state.loaded });
});

if (document.getElementById(ZONE_ID)) void loadRetention();
