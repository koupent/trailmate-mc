import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncHtml,
  syncProp,
  syncText,
  syncTextKeepingScroll
} from '../dashboard/public/domSync.js';

/**
 * ブラウザの乱暴なところだけを真似る偽の要素。
 * innerHTML / textContent への代入は、同じ文字列でも内容の入れ替えとして数え、
 * スクロール位置を先頭へ戻す（本物がテキスト選択とスクロールを失うのと同じ）。
 */
function makeEl({ scrollTop = 0 } = {}) {
  const stored = { innerHTML: '', textContent: '' };
  const writes = { innerHTML: 0, textContent: 0 };
  const el = { scrollTop, writes };
  for (const prop of ['innerHTML', 'textContent']) {
    Object.defineProperty(el, prop, {
      configurable: true,
      get() {
        return stored[prop];
      },
      set(value) {
        stored[prop] = value;
        writes[prop] += 1;
        el.scrollTop = 0;
      }
    });
  }
  return el;
}

describe('domSync syncHtml', () => {
  it('writes once and then leaves identical markup alone', () => {
    const el = makeEl();
    assert.equal(syncHtml(el, '<div>a</div>'), true);
    assert.equal(syncHtml(el, '<div>a</div>'), false);
    assert.equal(syncHtml(el, '<div>a</div>'), false);
    assert.equal(el.writes.innerHTML, 1);
    assert.equal(el.innerHTML, '<div>a</div>');
  });

  it('writes again as soon as the markup differs', () => {
    const el = makeEl();
    syncHtml(el, '<div>a</div>');
    assert.equal(syncHtml(el, '<div>b</div>'), true);
    assert.equal(el.writes.innerHTML, 2);
  });

  it('keeps a scrolled panel untouched while its content is unchanged', () => {
    const el = makeEl();
    syncHtml(el, '<div>a</div>');
    el.scrollTop = 120;
    syncHtml(el, '<div>a</div>');
    assert.equal(el.scrollTop, 120);
  });

  it('ignores a missing element', () => {
    assert.equal(syncHtml(null, '<div></div>'), false);
  });
});

describe('domSync 保持ピッカーの描き方', () => {
  it('値を markup に載せなければ、値が変わってもノードは作り直されない', () => {
    // 行の骨格だけを描き、checked / value は syncProp で入れる（retention.js と同じ手順）
    const rowsHtml = '<li data-row="apple"><input type="checkbox"><input type="number"></li>';
    const panel = makeEl();
    const keep = { checked: false };
    const limit = { value: '', disabled: false };

    syncHtml(panel, rowsHtml);
    syncProp(keep, 'checked', true);
    assert.equal(panel.writes.innerHTML, 1);

    // チェックを外す：state が変わっても markup は同じ → 作り直さない
    syncHtml(panel, rowsHtml);
    syncProp(keep, 'checked', false);
    syncProp(limit, 'disabled', true);
    assert.equal(panel.writes.innerHTML, 1);
    assert.equal(keep.checked, false);
    assert.equal(limit.disabled, true);

    // カテゴリを切り替えたときだけ作り直す
    syncHtml(panel, '<li data-row="iron_sword"><input type="checkbox"></li>');
    assert.equal(panel.writes.innerHTML, 2);
  });
});

describe('domSync syncText', () => {
  it('writes once and then leaves identical text alone', () => {
    const el = makeEl();
    assert.equal(syncText(el, '保存しました'), true);
    assert.equal(syncText(el, '保存しました'), false);
    assert.equal(el.writes.textContent, 1);
  });

  it('does not confuse a text write with a markup write', () => {
    const el = makeEl();
    syncHtml(el, '<div>a</div>');
    // エラーメッセージで上書きされた後は、同じ markup でも貼り直す必要がある
    assert.equal(syncText(el, 'HTTP 500'), true);
    assert.equal(syncHtml(el, '<div>a</div>'), true);
    assert.equal(el.innerHTML, '<div>a</div>');
  });
});

describe('domSync syncTextKeepingScroll', () => {
  it('puts the reader back where they were after the text changes', () => {
    const el = makeEl();
    syncTextKeepingScroll(el, 'line1\nline2\n');
    el.scrollTop = 240;
    assert.equal(syncTextKeepingScroll(el, 'line2\nline3\n'), true);
    assert.equal(el.scrollTop, 240);
  });

  it('does not touch the node at all when the log has not changed', () => {
    const el = makeEl();
    syncTextKeepingScroll(el, 'line1\n');
    el.scrollTop = 80;
    assert.equal(syncTextKeepingScroll(el, 'line1\n'), false);
    assert.equal(el.writes.textContent, 1);
    assert.equal(el.scrollTop, 80);
  });
});

describe('domSync syncProp', () => {
  it('leaves a property that already holds the value alone', () => {
    let writes = 0;
    const input = {
      get value() {
        return this._value ?? '';
      },
      set value(next) {
        this._value = next;
        writes += 1;
      }
    };
    input.value = '5';
    writes = 0;

    assert.equal(syncProp(input, 'value', '5'), false);
    assert.equal(writes, 0);
    assert.equal(syncProp(input, 'value', '7'), true);
    assert.equal(writes, 1);
    assert.equal(input.value, '7');
  });

  it('flips checked and disabled only on a real change', () => {
    const input = { checked: true, disabled: false };
    assert.equal(syncProp(input, 'checked', true), false);
    assert.equal(syncProp(input, 'checked', false), true);
    assert.equal(syncProp(input, 'disabled', true), true);
    assert.equal(input.checked, false);
    assert.equal(input.disabled, true);
  });

  it('ignores a missing element', () => {
    assert.equal(syncProp(null, 'value', '1'), false);
  });
});
