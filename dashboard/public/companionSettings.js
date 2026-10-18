/**
 * 設定タブの分類切り替えと、相棒の設定項目（Bot が配る定義から組み立てる）。
 *
 * 項目はセクションごとのカードにまとめ、普段触らない項目は「詳細」に折りたたむ。
 * 編集中の値は state.edits に持ち、保存までは再読み込みで上書きしない。
 */

import { syncHtml, syncProp, syncText } from './domSync.js';

const navEl = document.getElementById('settings-cats');
const saveBar = document.getElementById('settings-save-bar');
const saveBtn = document.getElementById('settings-save');
const msgEl = document.getElementById('settings-msg');

const state = {
  /** @type {Array<{ id: string, sections: Array<{ title: string, fields: Array<any> }> }>|null} */
  categories: null,
  /** config.json の現在値（パス → 値。未保存は undefined）。 */
  values: {},
  /** 未保存の変更（パス → 保存値。null は既定に戻す）。 */
  edits: {},
  activeCategory: 'connection'
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function setMsg(text, kind = '') {
  syncText(msgEl, text || '');
  syncProp(msgEl, 'className', `msg ${kind}`.trim());
}

/** 保存値 → 画面表示（ミリ秒→秒、確率→% など）。 */
function toShown(field, value) {
  if (field.kind !== 'number' || value == null) return value;
  return Math.round(value * (field.scale ?? 1) * 1000) / 1000;
}

function currentValue(field) {
  if (field.path in state.edits) return state.edits[field.path] ?? field.default;
  return state.values[field.path] ?? field.default;
}

function fieldHtml(field) {
  const value = currentValue(field);
  const id = `setting-${field.path.replaceAll('.', '-')}`;
  const isDefault = JSON.stringify(value) === JSON.stringify(field.default);
  const defaultText = field.kind === 'bool'
    ? (field.default ? 'オン' : 'オフ')
    : `${toShown(field, field.default)} ${field.unit || ''}`;
  const reset = isDefault
    ? ''
    : `<button type="button" class="link" data-setting-reset="${escapeHtml(field.path)}">既定（${escapeHtml(defaultText)}）に戻す</button>`;
  const help = field.help ? `<span class="name-help">${escapeHtml(field.help)}</span>` : '';
  if (field.kind === 'bool') {
    return `
      <div class="setting-field">
        <label class="setting-check" for="${id}">
          <input type="checkbox" id="${id}" data-setting="${escapeHtml(field.path)}" ${value ? 'checked' : ''} />
          ${escapeHtml(field.label)}
        </label>${help}${reset}
      </div>`;
  }
  return `
    <div class="setting-field">
      <label for="${id}">${escapeHtml(field.label)}</label>
      <div class="row">
        <input type="number" class="setting-number" id="${id}" data-setting="${escapeHtml(field.path)}"
          value="${escapeHtml(toShown(field, value))}" min="${field.min}" max="${field.max}" step="${field.step ?? 1}" />
        <span class="muted">${escapeHtml(field.unit || '')}</span>
      </div>${help}${reset}
    </div>`;
}

function sectionHtml(section) {
  const basic = section.fields.filter((field) => !field.advanced);
  const advanced = section.fields.filter((field) => field.advanced);
  return `
    <article class="card">
      <div class="card-head"><h2 class="card-title">${escapeHtml(section.title)}</h2></div>
      ${basic.map(fieldHtml).join('')}
      ${advanced.length
        ? `<details class="setting-advanced"><summary>詳細（${advanced.length} 項目）</summary>${advanced.map(fieldHtml).join('')}</details>`
        : ''}
    </article>`;
}

function fieldByPath(path) {
  for (const category of state.categories || []) {
    for (const section of category.sections) {
      const field = section.fields.find((candidate) => candidate.path === path);
      if (field) return field;
    }
  }
  return null;
}

function render() {
  for (const category of state.categories || []) {
    const el = document.querySelector(`[data-settings-fields="${category.id}"]`);
    if (!el) continue;
    // 開いている「詳細」は描き直しても開いたままにする。
    const open = [...el.querySelectorAll('details[open] summary')].map((summary) => summary.closest('article')?.querySelector('.card-title')?.textContent);
    syncHtml(el, category.sections.map(sectionHtml).join(''));
    el.querySelectorAll('article').forEach((article) => {
      if (open.includes(article.querySelector('.card-title')?.textContent)) article.querySelector('details')?.setAttribute('open', '');
    });
  }
  syncProp(saveBtn, 'disabled', Object.keys(state.edits).length === 0);
}

function showCategory(id) {
  state.activeCategory = id;
  navEl?.querySelectorAll('[data-settings-cat]').forEach((button) => {
    const active = button.getAttribute('data-settings-cat') === id;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
    panel.hidden = panel.getAttribute('data-settings-panel') !== id;
  });
  // 保存ボタンは自動生成の項目がある分類でだけ出す。
  saveBar.hidden = !state.categories?.some((category) => category.id === id);
}

async function loadSettings() {
  if (Object.keys(state.edits).length) return;
  const data = await fetch('/api/companion-settings').then((response) => response.json()).catch(() => null);
  if (!data?.categories) {
    document.querySelectorAll('[data-settings-fields]').forEach((el) => {
      syncHtml(el, `<p class="muted">${escapeHtml(data?.message || '設定項目を取得できませんでした。')}</p>`);
    });
    return;
  }
  state.categories = data.categories;
  state.values = data.values || {};
  render();
  showCategory(state.activeCategory);
}

async function saveSettings() {
  syncProp(saveBtn, 'disabled', true);
  try {
    const response = await fetch('/api/companion-settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: state.edits })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
    state.edits = {};
    state.values = data.values || {};
    render();
    setMsg(data.message, 'ok');
  } catch (error) {
    setMsg(`保存に失敗しました: ${error.message}`, 'err');
    syncProp(saveBtn, 'disabled', false);
  }
}

navEl?.addEventListener('click', (event) => {
  const id = event.target?.closest?.('[data-settings-cat]')?.getAttribute('data-settings-cat');
  if (id) showCategory(id);
});

document.addEventListener('change', (event) => {
  const path = event.target?.getAttribute?.('data-setting');
  const field = path && fieldByPath(path);
  if (!field) return;
  if (field.kind === 'bool') {
    state.edits[path] = event.target.checked;
  } else {
    const shown = Number(event.target.value);
    if (!Number.isFinite(shown)) return;
    state.edits[path] = shown / (field.scale ?? 1);
  }
  setMsg('未保存の変更があります。');
  render();
});

document.addEventListener('click', (event) => {
  const path = event.target?.getAttribute?.('data-setting-reset');
  if (!path) return;
  state.edits[path] = null;
  setMsg('未保存の変更があります。');
  render();
});

saveBtn?.addEventListener('click', () => void saveSettings());

document.addEventListener('trailmate:tab', (event) => {
  if (event.detail?.tabId === 'settings') void loadSettings();
});

if (navEl) void loadSettings();
