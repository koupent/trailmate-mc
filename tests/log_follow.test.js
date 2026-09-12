import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogFollowState,
  isScrolledToBottom
} from '../dashboard/public/logFollow.js';

function makeEl({ scrollTop = 0, scrollHeight = 1000, clientHeight = 200, text = '' } = {}) {
  return {
    textContent: text,
    scrollTop,
    scrollHeight,
    clientHeight
  };
}

describe('logFollow isScrolledToBottom', () => {
  it('detects bottom within threshold', () => {
    assert.equal(
      isScrolledToBottom(makeEl({ scrollTop: 780, scrollHeight: 1000, clientHeight: 200 }), 24),
      true
    );
    assert.equal(
      isScrolledToBottom(makeEl({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 }), 24),
      false
    );
  });
});

describe('logFollow sticky re-fetch', () => {
  it('keeps following on re-fetch even if a prior pin left scrollTop at 0', () => {
    const follow = createLogFollowState();
    const el = makeEl({ scrollTop: 0, scrollHeight: 100, clientHeight: 200 });

    // First paint: content fits (at bottom). Then content grows but pin is ignored
    // by a closed/hidden container (scrollTop stays 0) — the old bug path.
    follow.setText(el, 'line1\n');
    el.scrollHeight = 2000;
    el.clientHeight = 200;
    el.scrollTop = 0;

    // Old logic would call isScrolledToBottom() here → false → never follow again.
    // Sticky state must still follow because the user never scrolled away.
    const pinned = follow.setText(el, 'line1\n'.repeat(80));
    assert.equal(pinned, true);
    assert.equal(follow.stickToBottom, true);
    assert.equal(el.scrollTop, el.scrollHeight);
    assert.match(el.textContent, /line1/);
  });

  it('stops following after the user scrolls up, then resumes at bottom', () => {
    const follow = createLogFollowState();
    const el = makeEl({ scrollTop: 1800, scrollHeight: 2000, clientHeight: 200 });

    follow.setText(el, 'a\n'.repeat(50), { forceBottom: true });
    assert.equal(el.scrollTop, el.scrollHeight);

    el.scrollTop = 0;
    follow.onScroll(el);
    assert.equal(follow.stickToBottom, false);

    el.scrollHeight = 3000;
    const pinned = follow.setText(el, 'a\n'.repeat(80));
    assert.equal(pinned, false);
    assert.equal(el.scrollTop, 0);

    el.scrollTop = el.scrollHeight - el.clientHeight;
    follow.onScroll(el);
    assert.equal(follow.stickToBottom, true);
    follow.setText(el, 'a\n'.repeat(100));
    assert.equal(el.scrollTop, el.scrollHeight);
  });

  it('forceBottom re-enables follow after the user scrolled up', () => {
    const follow = createLogFollowState();
    const el = makeEl({ scrollTop: 0, scrollHeight: 2000, clientHeight: 200 });
    follow.onScroll(el);
    assert.equal(follow.stickToBottom, false);

    follow.setText(el, 'latest\n'.repeat(40), { forceBottom: true });
    assert.equal(follow.stickToBottom, true);
    assert.equal(el.scrollTop, el.scrollHeight);
  });

  it('runs afterLayout hooks so pin happens after details open / reflow', () => {
    const follow = createLogFollowState();
    const el = makeEl({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
    const calls = [];
    const afterLayout = (fn) => {
      calls.push('schedule');
      // simulate layout: content becomes scrollable only after open
      el.scrollHeight = 2000;
      el.clientHeight = 200;
      fn();
    };

    follow.setText(el, 'x\n'.repeat(60), { forceBottom: true, afterLayout });
    assert.ok(calls.length >= 2);
    assert.equal(el.scrollTop, 2000);
  });

  it('does not unpin when textContent assignment fires a scroll-to-top', () => {
    const follow = createLogFollowState();
    const el = makeEl({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 });
    let stored = '';

    Object.defineProperty(el, 'textContent', {
      configurable: true,
      get() {
        return stored;
      },
      set(value) {
        stored = value;
        el.scrollTop = 0;
        el.scrollHeight = 2500;
        follow.onScroll(el);
      }
    });

    follow.setText(el, 'new\n'.repeat(80), {
      afterLayout: (fn) => fn()
    });
    assert.equal(follow.stickToBottom, true);
    assert.equal(el.scrollTop, el.scrollHeight);
  });
});
