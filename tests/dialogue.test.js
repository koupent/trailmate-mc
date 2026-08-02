import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_COMMANDS,
  MODE_COMMANDS,
  classifyPlayerCommand,
  detectCombatCommentary,
  detectHostileApproach,
  detectSituationEvent,
  detectIdleCommentary,
  deriveFollowPhase,
  deriveFollowReplyKey,
  deriveHostileBand,
  inferModeFromText,
  inferActionFromText,
  renderCommentary,
  isUsableCompanionChat
} from '../src/companion/dialogueParse.js';
import { tCommand } from '../src/i18n/index.js';

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

describe('deriveFollowPhase', () => {
  const cfg = { follow_distance: 3, owner_near_radius: 12 };

  it('returns deferred when control is not follow', () => {
    const phase = deriveFollowPhase({
      mode: 'follow',
      controlOwner: 'combat',
      owner: 'Alice'
    }, cfg);
    assert.equal(phase, 'deferred');
  });

  it('returns near when close with line of sight', () => {
    const phase = deriveFollowPhase({
      mode: 'follow',
      controlOwner: 'follow',
      owner: 'Alice',
      ownerEntityMissing: false,
      ownerHasLos: true,
      botPos: { x: 0, y: 64, z: 0 },
      ownerPos: { x: 1, y: 64, z: 0 },
      ownerDistance: 1,
      ownerVisible: true
    }, cfg);
    assert.equal(phase, 'near');
  });

  it('returns chasing when owner is visible but far', () => {
    const phase = deriveFollowPhase({
      mode: 'follow',
      controlOwner: 'follow',
      owner: 'Alice',
      ownerEntityMissing: false,
      ownerHasLos: false,
      ownerDistance: 5,
      ownerVisible: true,
      botPos: { x: 0, y: 64, z: 0 },
      ownerPos: { x: 5, y: 64, z: 0 }
    }, cfg);
    assert.equal(phase, 'chasing');
  });

  it('returns lost when owner entity is missing', () => {
    const phase = deriveFollowPhase({
      mode: 'follow',
      controlOwner: 'follow',
      owner: 'Alice',
      ownerEntityMissing: true
    }, cfg);
    assert.equal(phase, 'lost');
  });

  it('returns far when owner is not visible and beyond near radius', () => {
    const phase = deriveFollowPhase({
      mode: 'follow',
      controlOwner: 'follow',
      owner: 'Alice',
      ownerEntityMissing: false,
      ownerVisible: false,
      ownerDistance: 20,
      botPos: { x: 0, y: 64, z: 0 },
      ownerPos: { x: 20, y: 64, z: 0 }
    }, cfg);
    assert.equal(phase, 'far');
  });

  it('returns chasing when loaded nearby but outside FOV', () => {
    const phase = deriveFollowPhase({
      mode: 'follow',
      controlOwner: 'follow',
      owner: 'Alice',
      ownerEntityMissing: false,
      ownerVisible: false,
      ownerHasLos: false,
      ownerDistance: 5,
      botPos: { x: 0, y: 64, z: 0 },
      ownerPos: { x: 5, y: 64, z: 0 }
    }, cfg);
    assert.equal(phase, 'chasing');
  });
});

describe('deriveFollowReplyKey', () => {
  it('maps phases to locale command keys', () => {
    assert.equal(deriveFollowReplyKey('near'), 'follow');
    assert.equal(deriveFollowReplyKey('chasing'), 'follow_chase');
    assert.equal(deriveFollowReplyKey('far'), 'follow_chase');
    assert.equal(deriveFollowReplyKey('lost'), 'follow_too_far');
    assert.equal(deriveFollowReplyKey('deferred'), 'follow_deferred');
  });
});

describe('situation events', () => {
  const basePrev = {
    owner: null,
    health: 20,
    stuckSeconds: 0,
    isNight: false,
    hostile: null,
    lastDamageAgeMs: null,
    controlOwner: 'follow',
    foodCount: 3,
    torchCount: 5,
    hunger: 20
  };

  it('detects owner found and low health', () => {
    const prev = { ...basePrev };
    const snap = {
      owner: 'Alice',
      health: 6,
      stuckSeconds: 0,
      isNight: false,
      hostile: null,
      lastDamageAgeMs: null,
      mode: 'follow',
      controlOwner: 'follow',
      ownerVisible: true,
      ownerDistance: 1,
      ownerEntityMissing: false,
      ownerHasLos: true,
      botPos: { x: 0, y: 64, z: 0 },
      ownerPos: { x: 1, y: 64, z: 0 },
      foodCount: 3,
      torchCount: 5,
      hunger: 20
    };
    const event = detectSituationEvent(prev, snap, { low_health: 8 });
    assert.equal(event?.id, 'owner_found');
  });

  it('detects owner_found_chase when not near', () => {
    const prev = { ...basePrev };
    const snap = {
      owner: 'Alice',
      health: 20,
      stuckSeconds: 0,
      isNight: false,
      hostile: null,
      lastDamageAgeMs: null,
      mode: 'follow',
      controlOwner: 'follow',
      ownerVisible: true,
      ownerDistance: 8,
      ownerEntityMissing: false,
      ownerHasLos: false,
      botPos: { x: 0, y: 64, z: 0 },
      ownerPos: { x: 8, y: 64, z: 0 },
      foodCount: 3,
      torchCount: 5,
      hunger: 20
    };
    const event = detectSituationEvent(prev, snap, { low_health: 8 });
    assert.equal(event?.id, 'owner_found_chase');
  });

  it('detects control_combat on overlay takeover', () => {
    const prev = { ...basePrev, controlOwner: 'follow' };
    const snap = {
      ...prev,
      controlOwner: 'combat'
    };
    const event = detectSituationEvent(prev, snap, {});
    assert.equal(event?.id, 'control_combat');
  });

  it('skips control_follow when switching from wait without overlay', () => {
    const prev = { ...basePrev, controlOwner: 'wait' };
    const snap = { ...prev, controlOwner: 'follow' };
    const event = detectSituationEvent(prev, snap, {});
    assert.equal(event, null);
  });

  it('detects no_food when hungry and out of food', () => {
    const prev = { ...basePrev, foodCount: 2, hunger: 16 };
    const snap = {
      ...prev,
      foodCount: 0,
      hunger: 10
    };
    const event = detectSituationEvent(prev, snap, { low_food_hunger: 14 });
    assert.equal(event?.id, 'no_food');
  });

  it('detects no_torch when torches run out', () => {
    const prev = { ...basePrev, torchCount: 2 };
    const snap = { ...prev, torchCount: 0, isNight: true };
    const event = detectSituationEvent(prev, snap, {});
    assert.equal(event?.id, 'no_torch');
    assert.equal(event?.priority, 2);
  });

  it('detects damaged_combat when hit during combat', () => {
    const prev = {
      ...basePrev,
      lastDamageAgeMs: 5000,
      health: 14
    };
    const snap = {
      ...prev,
      lastDamageAgeMs: 500,
      lastDamageTaken: 2,
      health: 12,
      hostile: { name: 'zombie', distance: 3 }
    };
    const event = detectSituationEvent(prev, snap, { low_health: 8 });
    assert.equal(event?.id, 'damaged_combat');
  });

  it('detects damaged_low when hit at low health', () => {
    const prev = {
      ...basePrev,
      lastDamageAgeMs: 5000,
      health: 7
    };
    const snap = {
      ...prev,
      lastDamageAgeMs: 500,
      lastDamageTaken: 1,
      health: 6
    };
    const event = detectSituationEvent(prev, snap, { low_health: 8 });
    assert.equal(event?.id, 'damaged_low');
  });

  it('detects stuck from stuckAlert even after recovery reset (low stuckSeconds)', () => {
    const prev = {
      ...basePrev,
      owner: 'Alice',
      stuckSeconds: 0,
      stuckAlert: false
    };
    const snap = {
      ...prev,
      stuckSeconds: 1.5,
      stuckAlert: true
    };
    const event = detectSituationEvent(prev, snap, { stuck_seconds: 5 });
    assert.equal(event?.id, 'stuck');
    assert.equal(event?.priority, 2);
  });

  it('keeps stuck pending while stuckAlert remains for gate retry', () => {
    const prev = {
      ...basePrev,
      owner: 'Alice',
      stuckSeconds: 1.5,
      stuckAlert: true
    };
    const snap = { ...prev };
    const event = detectSituationEvent(prev, snap, { stuck_seconds: 5 });
    assert.equal(event?.id, 'stuck');
  });

  it('stops stuck event after stuckAlert clears', () => {
    const prev = {
      ...basePrev,
      owner: 'Alice',
      stuckSeconds: 1.5,
      stuckAlert: true
    };
    const snap = {
      ...prev,
      stuckSeconds: 0,
      stuckAlert: false
    };
    const event = detectSituationEvent(prev, snap, { stuck_seconds: 5 });
    assert.notEqual(event?.id, 'stuck');
  });
});

describe('idle commentary', () => {
  const cfg = { follow_distance: 3, owner_near_radius: 12 };

  it('detects idle_follow_near when close', () => {
    const idle = detectIdleCommentary({
      mode: 'follow',
      controlOwner: 'follow',
      owner: 'Alice',
      ownerDistance: 2,
      ownerEntityMissing: false,
      ownerHasLos: true,
      ownerVisible: true,
      botPos: { x: 0, y: 64, z: 0 },
      ownerPos: { x: 2, y: 64, z: 0 }
    }, cfg);
    assert.equal(idle?.id, 'idle_follow_near');
  });

  it('detects idle_follow_far when distant', () => {
    const idle = detectIdleCommentary({
      mode: 'follow',
      controlOwner: 'follow',
      owner: 'Alice',
      ownerDistance: 20,
      ownerEntityMissing: false,
      ownerHasLos: false,
      ownerVisible: false,
      botPos: { x: 0, y: 64, z: 0 },
      ownerPos: { x: 20, y: 64, z: 0 }
    }, cfg);
    assert.equal(idle?.id, 'idle_follow_far');
  });

  it('returns null for deferred follow control', () => {
    const idle = detectIdleCommentary({
      mode: 'follow',
      controlOwner: 'combat',
      owner: 'Alice'
    }, cfg);
    assert.equal(idle, null);
  });

  it('detects idle_wait in wait mode', () => {
    const idle = detectIdleCommentary({ mode: 'wait' }, cfg);
    assert.equal(idle?.id, 'idle_wait');
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

  it('uses first-person damage lines without ambiguous wording', () => {
    const damaged = renderCommentary('ja', 'damaged', { health: 10 });
    const low = renderCommentary('ja', 'low_health', { health: 5 });
    assert.doesNotMatch(damaged, /だいじょうぶ/);
    assert.doesNotMatch(damaged, /ダメージ受けた/);
    assert.doesNotMatch(low, /だいじょうぶ/);
  });

  it('still validates Japanese chat usability helper', () => {
    assert.equal(isUsableCompanionChat('そばにいるね'), true);
    assert.equal(isUsableCompanionChat('hello'), false);
  });
});

describe('i18n command keys (#13)', () => {
  it('embeds coordinates in death_return_start', () => {
    const text = tCommand('ja', 'death_return_start', { x: 10, y: 64, z: -5 });
    assert.match(text, /10/);
    assert.match(text, /64/);
    assert.match(text, /-5/);
    assert.match(text, /死亡地点へ戻るよ/);
  });

  it('embeds coordinates in own_grave_found', () => {
    const text = tCommand('ja', 'own_grave_found', { x: 1, y: 2, z: 3 });
    assert.match(text, /自分の墓を見つけたよ/);
    assert.match(text, /1, 2, 3/);
  });
});

describe('hostile approach bands', () => {
  const distances = [10, 6, 3];

  it('classifies distance bands', () => {
    assert.equal(deriveHostileBand(12, distances), 'outer');
    assert.equal(deriveHostileBand(8, distances), 'mid');
    assert.equal(deriveHostileBand(4, distances), 'near');
    assert.equal(deriveHostileBand(2, distances), 'close');
    assert.equal(deriveHostileBand(null, distances), null);
  });

  it('detects first sighting as hostile with priority 2', () => {
    const prev = { hostile: null, hostileBand: null };
    const snap = {
      hostile: { name: 'zombie', distance: 11 },
      hostileBand: 'outer'
    };
    const event = detectHostileApproach(prev, snap, {
      hostile_approach_distances: distances
    });
    assert.equal(event?.id, 'hostile');
    assert.equal(event?.priority, 2);
  });

  it('crosses mid / near / close bands', () => {
    const mid = detectHostileApproach(
      {
        hostile: { name: 'zombie', distance: 12 },
        hostileBand: 'outer'
      },
      {
        hostile: { name: 'zombie', distance: 8 },
        hostileBand: 'mid'
      },
      { hostile_approach_distances: distances }
    );
    assert.equal(mid?.id, 'hostile_approach_mid');

    const near = detectHostileApproach(
      {
        hostile: { name: 'zombie', distance: 8 },
        hostileBand: 'mid'
      },
      {
        hostile: { name: 'zombie', distance: 4 },
        hostileBand: 'near'
      },
      { hostile_approach_distances: distances }
    );
    assert.equal(near?.id, 'hostile_approach_near');

    const close = detectHostileApproach(
      {
        hostile: { name: 'zombie', distance: 4 },
        hostileBand: 'near'
      },
      {
        hostile: { name: 'zombie', distance: 2 },
        hostileBand: 'close'
      },
      { hostile_approach_distances: distances }
    );
    assert.equal(close?.id, 'hostile_approach_close');
  });

  it('ignores same-band distance changes', () => {
    const event = detectHostileApproach(
      {
        hostile: { name: 'zombie', distance: 9 },
        hostileBand: 'mid'
      },
      {
        hostile: { name: 'zombie', distance: 7 },
        hostileBand: 'mid'
      },
      { hostile_approach_distances: distances }
    );
    assert.equal(event, null);
  });

  it('detects hostile again after enemy disappears', () => {
    const gone = detectSituationEvent(
      {
        owner: 'Alice',
        health: 20,
        stuckSeconds: 0,
        isNight: false,
        hostile: { name: 'zombie', distance: 5 },
        hostileBand: 'near',
        lastDamageAgeMs: null,
        controlOwner: 'follow',
        foodCount: 3,
        torchCount: 5,
        hunger: 20
      },
      {
        owner: 'Alice',
        health: 20,
        stuckSeconds: 0,
        isNight: false,
        hostile: null,
        hostileBand: null,
        lastDamageAgeMs: null,
        controlOwner: 'follow',
        foodCount: 3,
        torchCount: 5,
        hunger: 20
      },
      { hostile_approach_distances: distances }
    );
    assert.equal(gone, null);

    const again = detectSituationEvent(
      {
        owner: 'Alice',
        health: 20,
        stuckSeconds: 0,
        isNight: false,
        hostile: null,
        hostileBand: null,
        lastDamageAgeMs: null,
        controlOwner: 'follow',
        foodCount: 3,
        torchCount: 5,
        hunger: 20
      },
      {
        owner: 'Alice',
        health: 20,
        stuckSeconds: 0,
        isNight: false,
        hostile: { name: 'skeleton', distance: 10 },
        hostileBand: 'mid',
        lastDamageAgeMs: null,
        controlOwner: 'follow',
        foodCount: 3,
        torchCount: 5,
        hunger: 20
      },
      { hostile_approach_distances: distances }
    );
    assert.equal(again?.id, 'hostile');
    assert.equal(again?.priority, 2);
  });
});

describe('combat commentary', () => {
  it('embeds hostile name in control_combat lines', () => {
    const text = renderCommentary('ja', 'control_combat', {
      hostile: { name: 'creeper', distance: 5 }
    });
    assert.match(text, /creeper/);
  });

  it('detects combat_target_switch when target changes in combat', () => {
    const prev = {
      owner: 'Alice',
      health: 20,
      stuckSeconds: 0,
      isNight: false,
      hostile: { name: 'zombie', distance: 3 },
      hostileBand: 'close',
      lastDamageAgeMs: null,
      controlOwner: 'combat',
      combatTarget: 'zombie',
      foodCount: 3,
      torchCount: 5,
      hunger: 20
    };
    const snap = {
      ...prev,
      combatTarget: 'skeleton',
      hostile: { name: 'skeleton', distance: 2 }
    };
    const event = detectSituationEvent(prev, snap, {});
    assert.equal(event?.id, 'combat_target_switch');
  });

  it('returns combat_fighting while in combat with a target', () => {
    const event = detectCombatCommentary({
      controlOwner: 'combat',
      combatTarget: 'zombie',
      hostile: { name: 'zombie', distance: 2.5 }
    });
    assert.equal(event?.id, 'combat_fighting');
    assert.equal(event?.priority, 2);
  });

  it('does not idle-follow while in combat', () => {
    const idle = detectIdleCommentary({
      mode: 'follow',
      controlOwner: 'combat',
      owner: 'Alice',
      ownerDistance: 2,
      ownerEntityMissing: false,
      ownerHasLos: true,
      ownerVisible: true,
      botPos: { x: 0, y: 64, z: 0 },
      ownerPos: { x: 2, y: 64, z: 0 },
      combatTarget: 'zombie'
    }, { follow_distance: 3, owner_near_radius: 12 });
    assert.equal(idle, null);
  });

  it('prefers combatTarget name in commentary vars', () => {
    const text = renderCommentary('ja', 'combat_fighting', {
      combatTarget: 'skeleton',
      hostile: { name: 'zombie', distance: 3 }
    });
    assert.match(text, /skeleton/);
  });
});
