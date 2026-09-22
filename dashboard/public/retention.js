/**
 * The item picker: which items the companion keeps, and how many.
 *
 * Two rules shape this file.
 *
 * The edits live in `state.retention`, never in the DOM. Switching tabs throws
 * the panel away and redraws it from that object, so a number typed on the
 * armor tab is still there after a trip to the food tab and back.
 *
 * Nothing redraws on a timer. The status panel next door is replaced wholesale
 * every two seconds, which would eat a half-typed number; this zone reloads
 * only when it is opened with no unsaved edits, exactly like `#settings-form`.
 */

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
  msgEl.textContent = text || '';
  msgEl.className = `msg ${kind}`.trim();
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
  tabsEl.innerHTML = (state.catalog?.categories || [])
    .map((category) => {
      const active = category.id === state.activeCategory;
      return `<button type="button" class="tab${active ? ' is-active' : ''}"
        role="tab" aria-selected="${active ? 'true' : 'false'}"
        data-retention-tab="${escapeHtml(category.id)}">${escapeHtml(category.label)}</button>`;
    })
    .join('');
}

function renderItemRow(category, item) {
  const entry = entryFor(category.id);
  const configured = entry.items[item.name];
  const kept = configured !== 0;
  const limit = kept && configured != null ? configured : '';
  const detail = item.foodPoints != null ? `満腹度 ${item.foodPoints}` : '';
  return `<li class="retention-item${kept ? '' : ' is-off'}">
    <label class="retention-item-name">
      <input type="checkbox" data-retention-keep="${escapeHtml(item.name)}" ${kept ? 'checked' : ''} />
      <span>${escapeHtml(item.label || item.name)}</span>
    </label>
    <span class="retention-item-detail muted">${escapeHtml(detail)}</span>
    <label class="retention-item-limit">
      上限
      <input type="number" inputmode="numeric" min="0" max="${category.limit.max}"
        placeholder="なし" value="${escapeHtml(limit)}"
        data-retention-item-limit="${escapeHtml(item.name)}" ${kept ? '' : 'disabled'} />
    </label>
  </li>`;
}

function renderPanel() {
  if (!panelsEl) return;
  const category = categoryById(state.activeCategory);
  if (!category) {
    panelsEl.innerHTML = '<div class="muted">カテゴリがありません</div>';
    return;
  }
  const entry = entryFor(category.id);
  const floorNote = category.limit.min > 0
    ? `（最小 ${category.limit.min}。${category.limit.min} なら装備中の分だけを残します）`
    : '（0 で一切残さない）';

  panelsEl.innerHTML = `
    <div class="retention-total">
      <label>
        ${escapeHtml(category.label)}は合計
        <input type="number" inputmode="numeric" id="retention-category-limit"
          min="${category.limit.min}" max="${category.limit.max}"
          value="${escapeHtml(entry.limit)}" />
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
      if (panelsEl) {
        panelsEl.innerHTML = `<div class="muted">${escapeHtml(
          data.message || 'アイテム一覧を取得できませんでした。'
        )}</div>`;
      }
      if (tabsEl) tabsEl.innerHTML = '';
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
    if (panelsEl) panelsEl.innerHTML = `<div class="msg err">${escapeHtml(error.message)}</div>`;
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
    renderPanel();
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
