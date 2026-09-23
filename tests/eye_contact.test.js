import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    EyeContactReaction,
    isLookingAt
} from '../src/companion/eyeContact.js';

const EYE_CONTACT_CONFIG = {
    enabled: true,
    max_distance: 8,
    dwell_ms: 500,
    cooldown_ms: 15000,
    chat_chance: 0.3
};

function entity(x, y, z, yaw = 0, pitch = 0) {
    return {
        position: new Vec3(x, y, z),
        height: 1.8,
        yaw,
        pitch
    };
}

function makeReactionFixture(overrides = {}) {
    let now = 0;
    let fsmId = 'follow';
    const controls = new Map();
    const sneakPackets = [];
    const lookCalls = [];
    const owner = entity(0, 64, 3, 0, 0);
    const botEntity = entity(0, 64, 0);
    let raycastResult = null;
    let spoken = 0;

    const bot = {
        entity: botEntity,
        world: {
            raycast() {
                return raycastResult;
            }
        },
        getControlState(name) {
            return controls.get(name) === true;
        },
        setControlState(name, value) {
            controls.set(name, value);
            if (name === 'sneak') sneakPackets.push(value);
        },
        clearControlStates() {
            for (const [name, value] of controls) {
                if (value) this.setControlState(name, false);
            }
        },
        async look(yaw, pitch, force) {
            lookCalls.push({ yaw, pitch, force });
        }
    };
    const manager = {
        getActiveFsmId() {
            return fsmId;
        }
    };
    const dialogue = {
        isActionBusy: false,
        async speakEyeContact() {
            spoken++;
            return true;
        }
    };
    const movement = { hasGoal: false, isMoving: false };
    const ctx = {
        bot,
        ownerName: 'Alice',
        ownerEntity: owner,
        movement,
        itemTransfer: { active: false },
        agent: { companion: { manager, dialogue } }
    };
    const reaction = new EyeContactReaction(
        { ...EYE_CONTACT_CONFIG, ...overrides.config },
        {
            now: () => now,
            random: () => overrides.random ?? 0.2
        }
    );

    return {
        bot,
        ctx,
        dialogue,
        lookCalls,
        movement,
        owner,
        reaction,
        sneakPackets,
        advance(ms) { now += ms; },
        setFsmId(value) { fsmId = value; },
        setRaycastResult(value) { raycastResult = value; },
        spoken() { return spoken; }
    };
}

async function reachReaction(fixture) {
    await fixture.reaction.tick(fixture.ctx);
    fixture.advance(500);
    await fixture.reaction.tick(fixture.ctx);
}

async function finishReaction(fixture, clearBeforeTick = false) {
    for (let i = 0; i < 3; i++) {
        fixture.advance(250);
        if (clearBeforeTick) fixture.bot.clearControlStates();
        await fixture.reaction.tick(fixture.ctx);
    }
}

describe('isLookingAt', () => {
    it('accepts an owner looking straight at the companion face', () => {
        assert.equal(
            isLookingAt(entity(0, 64, 3, 0, 0), entity(0, 64, 0), { maxDistance: 8 }),
            true
        );
    });

    it('rejects looking at the feet, sideways, behind, or beyond max distance', () => {
        assert.equal(isLookingAt(entity(0, 64, 3, 0, -0.6), entity(0, 64, 0), { maxDistance: 8 }), false);
        assert.equal(isLookingAt(entity(0, 64, 3, Math.PI / 2, 0), entity(0, 64, 0), { maxDistance: 8 }), false);
        assert.equal(isLookingAt(entity(0, 64, 3, 0, 0), entity(0, 64, 6), { maxDistance: 8 }), false);
        assert.equal(isLookingAt(entity(0, 64, 10, 0, 0), entity(0, 64, 0), { maxDistance: 8 }), false);
    });

    it('uses positive pitch for up and negative pitch for down', () => {
        const viewer = entity(0, 67, 3);
        viewer.pitch = Math.atan2(-3, 3);
        assert.equal(isLookingAt(viewer, entity(0, 64, 0), { maxDistance: 8 }), true);
    });
});

describe('EyeContactReaction', () => {
    it('waits for dwell time, then looks back and bows twice over four ticks', async () => {
        const fixture = makeReactionFixture();

        await fixture.reaction.tick(fixture.ctx);
        fixture.advance(499);
        await fixture.reaction.tick(fixture.ctx);
        assert.deepEqual(fixture.sneakPackets, []);

        fixture.advance(1);
        await fixture.reaction.tick(fixture.ctx);
        await finishReaction(fixture);

        assert.equal(fixture.lookCalls.length, 4);
        assert.ok(fixture.lookCalls.every((call) => call.force === true));
        assert.deepEqual(fixture.sneakPackets, [true, false, true, false]);
        assert.equal(fixture.spoken(), 1);
    });

    it('does not duplicate sneak packets when stop clears controls before every tick', async () => {
        const fixture = makeReactionFixture();

        await reachReaction(fixture);
        await finishReaction(fixture, true);

        assert.deepEqual(fixture.sneakPackets, [true, false, true, false]);
    });

    it('does not react while moving, outside follow/wait, unlocked, blocked, or watched by someone else', async () => {
        const cases = [
            (f) => { f.movement.hasGoal = true; },
            (f) => { f.bot.setControlState('forward', true); },
            (f) => { f.setFsmId('combat'); },
            (f) => { f.ctx.ownerName = null; },
            (f) => { f.setRaycastResult({ name: 'stone' }); },
            (f) => { f.owner.yaw = Math.PI / 2; f.ctx.otherPlayer = entity(0, 64, 3, 0, 0); }
        ];

        for (const arrange of cases) {
            const fixture = makeReactionFixture();
            arrange(fixture);
            await fixture.reaction.tick(fixture.ctx);
            fixture.advance(1000);
            await fixture.reaction.tick(fixture.ctx);
            assert.deepEqual(fixture.sneakPackets.filter(Boolean), []);
        }
    });

    it('cancels an in-progress bow and stands up when movement starts', async () => {
        const fixture = makeReactionFixture();
        await reachReaction(fixture);
        assert.equal(fixture.bot.getControlState('sneak'), true);

        fixture.movement.hasGoal = true;
        fixture.advance(250);
        await fixture.reaction.tick(fixture.ctx);

        assert.equal(fixture.bot.getControlState('sneak'), false);
        assert.deepEqual(fixture.sneakPackets, [true, false]);
    });

    it('requires both a look-away and the cooldown before reacting again', async () => {
        const fixture = makeReactionFixture();
        await reachReaction(fixture);
        await finishReaction(fixture);

        fixture.advance(20000);
        await fixture.reaction.tick(fixture.ctx);
        assert.deepEqual(fixture.sneakPackets, [true, false, true, false]);

        fixture.owner.yaw = Math.PI / 2;
        await fixture.reaction.tick(fixture.ctx);
        fixture.owner.yaw = 0;
        await fixture.reaction.tick(fixture.ctx);
        fixture.advance(500);
        await fixture.reaction.tick(fixture.ctx);

        assert.deepEqual(fixture.sneakPackets, [true, false, true, false, true]);
    });

    it('does not restart before cooldown even after the owner looks away', async () => {
        const fixture = makeReactionFixture();
        await reachReaction(fixture);
        await finishReaction(fixture);

        fixture.owner.yaw = Math.PI / 2;
        await fixture.reaction.tick(fixture.ctx);
        fixture.owner.yaw = 0;
        fixture.advance(1000);
        await fixture.reaction.tick(fixture.ctx);
        fixture.advance(500);
        await fixture.reaction.tick(fixture.ctx);

        assert.deepEqual(fixture.sneakPackets, [true, false, true, false]);
    });

    it('requests chat only below chat_chance and does nothing when disabled', async () => {
        const speaks = makeReactionFixture({ random: 0.29 });
        await reachReaction(speaks);
        await finishReaction(speaks);
        assert.equal(speaks.spoken(), 1);

        const staysQuiet = makeReactionFixture({ random: 0.3 });
        await reachReaction(staysQuiet);
        await finishReaction(staysQuiet);
        assert.equal(staysQuiet.spoken(), 0);

        const disabled = makeReactionFixture({ config: { enabled: false } });
        await reachReaction(disabled);
        await finishReaction(disabled);
        assert.deepEqual(disabled.sneakPackets, []);
        assert.equal(disabled.spoken(), 0);
    });
});
