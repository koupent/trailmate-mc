import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { action, describeTreeActivity, runTree } from '../src/companion/behaviorTree/bt.js';
import { NormalBehavior } from '../src/companion/stateMachine/behaviors/NormalBehavior.js';
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
    let fsmId = 'normal';
    const controls = new Map();
    const sneakPackets = [];
    const lookCalls = [];
    const owner = entity(0, 64, 3, 0, 0);
    const botEntity = entity(0, 64, 0);
    let raycastResult = null;
    const topics = [];

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
    const dialogue = { isActionBusy: false };
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
        async tick() {
            const result = await reaction.tick(ctx);
            if (result?.commentary) topics.push(result.commentary);
        },
        advance(ms) { now += ms; },
        setFsmId(value) { fsmId = value; },
        setRaycastResult(value) { raycastResult = value; },
        topics
    };
}

async function reachReaction(fixture) {
    await fixture.tick();
    fixture.advance(500);
    await fixture.tick();
}

async function finishReaction(fixture, clearBeforeTick = false) {
    for (let i = 0; i < 3; i++) {
        fixture.advance(250);
        if (clearBeforeTick) fixture.bot.clearControlStates();
        await fixture.tick();
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
    it('runs in the normal behavior tree and reports the completed bow there', async () => {
        const fixture = makeReactionFixture();
        const { ctx, reaction } = fixture;
        ctx.agent.companion.eyeContact = reaction;
        const waitTree = action('待機する', () => true);
        const waitMode = { tree: waitTree, tick: () => runTree(waitTree, ctx) };
        const normal = new NormalBehavior({ ctx, agent: ctx.agent, waitMode, followMode: waitMode, preferredMode: 'wait' });
        normal.onStateEntered();
        await normal.runTick();
        fixture.advance(500);
        await normal.runTick();
        assert.equal(fixture.bot.getControlState('sneak'), true);
        assert.deepEqual(describeTreeActivity(normal.tree).commentary, []);
        for (let i = 0; i < 3; i++) {
            fixture.advance(250);
            await normal.runTick();
        }
        const activity = describeTreeActivity(normal.tree);
        assert.ok(activity.actions.includes('目が合った相手にお辞儀をする'));
        assert.equal(activity.commentary[0]?.id, 'eye_contact');
        assert.deepEqual(activity.commentary[0].actionFacts.map(({ actor }) => actor), ['player', 'companion']);
        assert.equal(activity.commentary[0].reaction, true);
        await normal.runTick();
        assert.deepEqual(describeTreeActivity(normal.tree).commentary, []);
    });

    it('stands up when the normal state gives up control', async () => {
        const fixture = makeReactionFixture();
        await reachReaction(fixture);
        fixture.reaction.cancel(fixture.ctx);
        assert.equal(fixture.bot.getControlState('sneak'), false);
        assert.equal(fixture.reaction.state, 'resting');
    });

    it('waits for dwell time, then looks back and bows twice over four ticks', async () => {
        const fixture = makeReactionFixture();

        await fixture.tick();
        fixture.advance(499);
        await fixture.tick();
        assert.deepEqual(fixture.sneakPackets, []);

        fixture.advance(1);
        await fixture.tick();
        await finishReaction(fixture);

        assert.equal(fixture.lookCalls.length, 4);
        assert.ok(fixture.lookCalls.every((call) => call.force === true));
        assert.deepEqual(fixture.sneakPackets, [true, false, true, false]);
        assert.equal(fixture.topics.length, 1);
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
            await fixture.tick();
            fixture.advance(1000);
            await fixture.tick();
            assert.deepEqual(fixture.sneakPackets.filter(Boolean), []);
        }
    });

    it('cancels an in-progress bow and stands up when movement starts', async () => {
        const fixture = makeReactionFixture();
        await reachReaction(fixture);
        assert.equal(fixture.bot.getControlState('sneak'), true);

        fixture.movement.hasGoal = true;
        fixture.advance(250);
        await fixture.tick();

        assert.equal(fixture.bot.getControlState('sneak'), false);
        assert.deepEqual(fixture.sneakPackets, [true, false]);
    });

    it('requires both a look-away and the cooldown before reacting again', async () => {
        const fixture = makeReactionFixture();
        await reachReaction(fixture);
        await finishReaction(fixture);

        fixture.advance(20000);
        await fixture.tick();
        assert.deepEqual(fixture.sneakPackets, [true, false, true, false]);

        fixture.owner.yaw = Math.PI / 2;
        await fixture.tick();
        fixture.owner.yaw = 0;
        await fixture.tick();
        fixture.advance(500);
        await fixture.tick();

        assert.deepEqual(fixture.sneakPackets, [true, false, true, false, true]);
    });

    it('does not restart before cooldown even after the owner looks away', async () => {
        const fixture = makeReactionFixture();
        await reachReaction(fixture);
        await finishReaction(fixture);

        fixture.owner.yaw = Math.PI / 2;
        await fixture.tick();
        fixture.owner.yaw = 0;
        fixture.advance(1000);
        await fixture.tick();
        fixture.advance(500);
        await fixture.tick();

        assert.deepEqual(fixture.sneakPackets, [true, false, true, false]);
    });

    it('requests chat only below chat_chance and does nothing when disabled', async () => {
        const speaks = makeReactionFixture({ random: 0.29 });
        await reachReaction(speaks);
        await finishReaction(speaks);
        assert.deepEqual(speaks.topics.map(({ id, recipient }) => [id, recipient]), [['eye_contact', 'Alice']]);

        const staysQuiet = makeReactionFixture({ random: 0.3 });
        await reachReaction(staysQuiet);
        await finishReaction(staysQuiet);
        assert.equal(staysQuiet.topics.length, 0);

        const disabled = makeReactionFixture({ config: { enabled: false } });
        await reachReaction(disabled);
        await finishReaction(disabled);
        assert.deepEqual(disabled.sneakPackets, []);
        assert.equal(disabled.topics.length, 0);
    });
});
