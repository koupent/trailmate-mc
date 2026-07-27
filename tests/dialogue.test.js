import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_COMMANDS,
  MODE_COMMANDS,
  classifyPlayerCommand,
  detectSituationEvent,
  detectIdleCommentary,
  inferModeFromText,
  inferActionFromText,
  renderCommentary,
  isUsableCompanionChat
} from '../src/companion/dialogueParse.js';

describe('commands', () => {
  const allowed = ['follow', 'wait'];

  it('detects official mode words only', () => {
    assert.equal(inferModeFromText('待機', allowed), 'wait');
    assert.equal(inferModeFromText('追従', allowed), 'follow');
    assert.equal(inferModeFromText('待って', allowed), null);
    assert.equal(inferModeFromText('follow me', allowed), null);
  });

  it('builds mode command payloads', () => {
    const wait = classifyPlayerCommand('待機', 'Alice', allowed);
    assert.equal(wait?.kind, 'mode');
    assert.equal(wait?.mode, 'wait');
    assert.equal(wait?.message, MODE_COMMANDS.find((c) => c.mode === 'wait')?.reply);

    const follow = classifyPlayerCommand('追従', 'Bob', allowed);
    assert.equal(follow?.mode, 'follow');
    assert.equal(follow?.owner, 'Bob');
  });

  it('detects 全回収 / 拠点', () => {
    assert.equal(inferActionFromText('全回収'), 'give_all_items');
    assert.equal(inferActionFromText('拠点'), 'set_spawnpoint');
    assert.ok(ACTION_COMMANDS.length >= 2);
  });
});

describe('situation events', () => {
  it('detects owner found and low health', () => {
    const prev = {
      owner: null,
      health: 20,
      stuckSeconds: 0,
      isNight: false,
      hostile: null,
      lastDamageAgeMs: null
    };
    const snap = {
      owner: 'Alice',
      health: 6,
      stuckSeconds: 0,
      isNight: false,
      hostile: null,
      lastDamageAgeMs: null
    };
    const event = detectSituationEvent(prev, snap, { low_health: 8 });
    assert.equal(event?.id, 'owner_found');
  });

  it('detects idle follow commentary candidate', () => {
    const idle = detectIdleCommentary({ mode: 'follow', owner: 'Alice', ownerDistance: 3 });
    assert.equal(idle?.id, 'idle_follow');
  });
});

describe('rule commentary', () => {
  it('embeds facts from snapshot', () => {
    const text = renderCommentary('ja', 'hostile', {
      hostile: { name: 'zombie', distance: 4.2 },
      owner: 'Alice'
    });
    assert.match(text, /zombie/);
  });

  it('embeds distance when template includes it', () => {
    // Retry a few times because wording variants are random.
    let sawDistance = false;
    for (let i = 0; i < 20; i++) {
      const text = renderCommentary('ja', 'hostile', {
        hostile: { name: 'zombie', distance: 4.2 }
      });
      if (/4\.2/.test(text)) {
        sawDistance = true;
        break;
      }
    }
    assert.equal(sawDistance, true);
  });

  it('embeds health on low_health', () => {
    const text = renderCommentary('ja', 'low_health', { health: 5 });
    assert.match(text, /5/);
  });

  it('still validates Japanese chat usability helper', () => {
    assert.equal(isUsableCompanionChat('そばにいるね'), true);
    assert.equal(isUsableCompanionChat('hello'), false);
  });
});
