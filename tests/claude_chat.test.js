import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { CompanionDialogue } from '../src/companion/CompanionDialogue.js';
import { ClaudeChatBudget } from '../src/companion/ClaudeChatBudget.js';
import { WorldState } from '../src/companion/WorldState.js';
import { notifyPathBlocked } from '../src/companion/movement/playerBlockNotify.js';
import { tCommand } from '../src/i18n/index.js';
import { isWeatherGrounded } from '../src/companion/claudeChat.js';

function setEnv(t, values) {
    for (const [name, value] of Object.entries(values)) {
        const original = process.env[name];
        process.env[name] = value;
        t.after(() => {
            if (original === undefined) delete process.env[name];
            else process.env[name] = original;
        });
    }
}

test('nearby speech uses player distance rather than field of view or server presence alone', () => {
    const worldState = new WorldState();
    const entity = (z) => ({ position: new Vec3(0, 64, z), yaw: 0 });
    const bot = {
        username: 'Trailmate',
        entity: entity(0),
        players: {
            Trailmate: { entity: entity(0) },
            Far: { entity: entity(-16) },
            Near: { entity: entity(2) },
            Unloaded: {}
        }
    };
    worldState.update({ bot, config: { scan_radius: 32, fov_degrees: 90, owner_near_radius: 12 } });
    assert.deepEqual(worldState.visiblePlayers.map((player) => player.name), ['Far']);
    assert.deepEqual(worldState.nearbyPlayers.map((player) => player.name), ['Near']);
});

test('weather is unknown until reported and rain is mentioned only where supported', () => {
    const world = new WorldState();
    let biomeId = 1;
    let skyLight = 15;
    const bot = Object.assign(new EventEmitter(), {
        entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' }, isRaining: false,
        blockAt: () => ({ biome: { id: biomeId }, skyLight }), rainState: 1,
        registry: { biomes: { 1: { has_precipitation: false, temperature: 2 }, 2: { has_precipitation: true, temperature: 0.8 } } }
    });
    world.observeWeather(bot);
    bot.emit('game');
    assert.equal(world.getLocalRain(bot), null);
    bot.isRaining = true;
    bot.emit('rain');
    assert.equal(world.getLocalRain(bot), null);
    biomeId = 2;
    assert.equal(world.getLocalRain(bot), true);
    skyLight = 0;
    assert.equal(world.getLocalRain(bot), null);
    skyLight = 15;
    bot.rainState = 0;
    assert.equal(world.getLocalRain(bot), null);
    bot.isRaining = false;
    bot.emit('rain');
    assert.equal(world.getLocalRain(bot), false);
    bot.game.dimension = 'nether';
    bot.emit('game');
    assert.equal(world.getLocalRain(bot), null);
    assert.equal(isWeatherGrounded('雨の中だね。', 'ja', null), false);
    assert.equal(isWeatherGrounded('雨が降ってきたね。', 'ja', false), false);
    assert.equal(isWeatherGrounded('雨がやんだね。', 'ja', false, 'rain_stopped'), true);
    assert.equal(isWeatherGrounded('晴れたね。', 'ja', true), false);
});

test('nearby activity notices are based on observed changes, not each swing or block update', (t) => {
    let now = 10000;
    t.mock.method(Date, 'now', () => now);
    const world = new WorldState();
    const miner = { id: 2, position: new Vec3(2, 64, 0) };
    const bot = Object.assign(new EventEmitter(), {
        entity: { id: 1, position: new Vec3(0, 64, 0) },
        players: { Bob: { username: 'Bob', entity: miner } },
        world: { raycast: () => null }, canSeeBlock: () => true
    });
    world.observeActivities({ bot, config: { owner_near_radius: 12 } });
    const block = { name: 'stone', position: new Vec3(3, 64, 0) };
    const zombie = { id: 3, type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 2) };
    bot.emit('blockBreakProgressObserved', block, 0, miner);
    assert.equal(world.recentObservations().at(-1).id, 'player_started_mining');
    assert.equal(world.recentObservations().at(-1).recipient, 'Bob');
    now += 500;
    bot.emit('blockBreakProgressObserved', block, 6, miner);
    bot.emit('entityHurt', zombie);
    bot.emit('entityHurt', zombie, miner);
    assert.match(world.recentObservations().at(-1).text, /switched from mining to fighting/);
    bot.emit('entityHurt', zombie, miner);
    assert.equal(world.recentObservations().length, 2);
    const chest = { ...block, name: 'chest' };
    bot.emit('blockUpdate', block, chest);
    assert.equal(world.recentObservations().at(-1).id, 'nearby_chest_appeared');
    assert.equal(world.recentObservations().at(-1).recipient, undefined);
    bot.emit('blockUpdate', chest, chest);
    bot.emit('blockUpdate', block, { ...block, name: 'bookshelf' });
    assert.match(world.recentObservations().at(-1).text, /stone to bookshelf/);
    bot.emit('entityHurt', bot.entity);
    bot.emit('entityHurt', bot.entity, miner);
    bot.emit('entityHurt', bot.entity, miner);
    assert.equal(world.recentObservations().length, 5);
    const damage = world.recentObservations().at(-1);
    assert.equal(damage.recipient, 'Bob');
    assert.deepEqual(damage.actionFacts, [{ actor: 'player', action: 'hit', target: 'companion' }]);
    assert.deepEqual(world.recentObservations(now + 9000), []);
    assert.equal(world.recentObservations(now + 9000, true).at(-1), damage);
    assert.deepEqual(world.recentObservations(now + 31000, true), []);
});

test('Claude addresses nearby players on changes and scales with the local budget', async (t) => {
    let now = 1000000;
    t.mock.method(Date, 'now', () => now);
    setEnv(t, {
        ANTHROPIC_API_KEY: 'test-key',
        CLAUDE_MONTHLY_BUDGET_USD: '40',
        ANTHROPIC_ADMIN_API_KEY: '',
        ANTHROPIC_WORKSPACE_ID: ''
    });

    const requests = [];
    const acknowledgements = [];
    const lines = [];
    const switched = [];
    const agent = {
        bot: { username: 'Trailmate', entity: {}, health: 20 },
        companion: { _interval: true, ctx: { worldState: new WorldState(), movement: { isHeld: true } } },
        openChat: async (line) => lines.push(line)
    };
    const manager = {
        getModeCatalog: () => [{ id: 'wait' }],
        getCurrentModeId: () => 'wait',
        describeDialogueActivity: () => ({ state: 'wait_example', task: '見張り', actions: ['周囲を確認する'], commentary: [] }),
        switchMode: async (mode) => switched.push(mode)
    };
    const dialogue = new CompanionDialogue(agent, manager, { chat: { spontaneous_chance: 1 } });
    let finishCommentary;
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
        const payload = JSON.parse(request.body);
        const { event } = JSON.parse(payload.messages.at(-1).content);
        if (event === 'wait' || event === 'eye_contact') {
            acknowledgements.push(event);
            const text = event === 'wait' ? 'ここでのんびり待ってるね！' : '目が合ったから、ぺこっとお辞儀したよ！';
            return Response.json({ content: [{ type: 'text', text }] });
        }
        requests.push(payload);
        if (requests.length === 4) await new Promise((resolve) => { finishCommentary = resolve; });
        const text = requests.length === 2 ? '\u200b/kick Alice'
            : requests.length === 8 ? 'SKIP' : '暗くなってきたね。足元に気をつけて。';
        return Response.json({ content: [{ type: 'text', text }] });
    });

    const worldState = agent.companion.ctx.worldState;
    worldState.observe({ text: 'Received a hit.', recipient: 'Alice', actionFacts: [{ actor: 'player', action: 'hit', target: 'companion' }] });
    assert.equal(await dialogue.handlePlayerMessage('Alice', '普通の会話だよ', true), false);
    assert.equal(await dialogue.handlePlayerMessage('Alice', '@Trailmate 今どう？'), false);
    assert.equal(await dialogue.handlePlayerMessage('Alice', '@Trailmate 待機中？', true), true);
    assert.equal(requests[0].max_tokens, 72);
    assert.deepEqual(requests[0].thinking, { type: 'disabled' });
    assert.match(requests[0].system, /タメ口/);
    assert.match(requests[0].messages[0].content, /待機中/);
    const replyContext = JSON.parse(requests[0].messages[0].content);
    assert.equal(replyContext.behavior, undefined);
    assert.deepEqual(replyContext.observations[0], {
        description: 'Received a hit.', actorIsAddressee: true, secondsAgo: 0,
        actionFacts: [{ actor: 'player', action: 'hit', target: 'companion' }]
    });
    assert.doesNotMatch(requests[0].messages[0].content, /Alice/);
    assert.deepEqual(switched, []);

    now += 3000;
    assert.equal(await dialogue.handlePlayerMessage('Alice', '@Trailmate 元気？', true), false);
    assert.equal(await dialogue.handlePlayerMessage('Alice', '待機', true), true);
    assert.deepEqual(switched, ['wait']);
    assert.deepEqual(acknowledgements, ['wait']);
    assert.equal(lines[1], 'ここでのんびり待ってるね！');

    now += 7000;
    assert.equal(await dialogue.handlePlayerMessage('Alice', '@Trailmate 元気？', true), true);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.length, 1);
    assert.equal(lines[2], tCommand('ja', 'reply_unavailable'));

    const nearbyPlayers = [{ name: 'Alice', distance: 2 }, { name: 'Bob', distance: 4 }];
    let snapshot = { ...dialogue._emptySnapshot('wait'), health: 20, isNight: false, isRaining: false };
    t.mock.method(dialogue, '_buildSnapshot', () => ({ ...snapshot, nearbyPlayers: worldState.nearbyPlayers }));
    now += 1000;
    await dialogue.maybeSpeak();
    worldState.nearbyPlayers = nearbyPlayers;
    snapshot = { ...snapshot, isRaining: true };
    await dialogue.maybeSpeak();
    assert.equal(requests.length, 2);

    now += 9000;
    await dialogue.maybeSpeak();
    assert.equal(requests.length, 2);

    worldState.nearbyPlayers = [];
    snapshot = { ...snapshot, isRaining: false };
    await dialogue.maybeSpeak();
    worldState.nearbyPlayers = nearbyPlayers;
    await dialogue.maybeSpeak();
    assert.equal(requests.length, 2);

    now += 6000;
    snapshot = { ...snapshot, isNight: true };
    await dialogue.maybeSpeak();
    await setImmediate();
    assert.equal(requests.length, 3);
    const commentaryContext = JSON.parse(requests[2].messages[0].content);
    assert.equal(commentaryContext.event, 'night');
    assert.equal(commentaryContext.nearbyPlayerCount, 2);
    assert.doesNotMatch(requests[2].messages[0].content, /Alice|Bob/);
    assert.match(lines[3], /^@Alice、暗くなって/);

    now += 230000;
    snapshot = { ...snapshot, isRaining: true };
    await dialogue.maybeSpeak();
    assert.equal(requests.length, 4);
    worldState.nearbyPlayers = [nearbyPlayers[1]];
    finishCommentary();
    await setImmediate();
    assert.equal(lines.length, 4);

    now += 230000;
    worldState.nearbyPlayers = nearbyPlayers;
    const activity = { state: 'new_job', task: '新しい作業', actionState: 'new_job', actions: ['片付ける'] };
    snapshot = { ...snapshot, activity: { ...activity, commentary: [{
        id: 'new_behavior_completed', text: 'Finished tidying.', recipient: 'Bob',
        actionFacts: [{ actor: 'companion', action: 'tidied up' }]
    }] } };
    await dialogue.maybeSpeak();
    await setImmediate();
    const newBehavior = JSON.parse(requests[4].messages[0].content);
    assert.equal(newBehavior.event, 'new_behavior_completed');
    assert.equal(newBehavior.focus.description, 'Finished tidying.');
    assert.deepEqual(newBehavior.focus.actionFacts, [{ actor: 'companion', action: 'tidied up' }]);
    assert.equal(newBehavior.behavior, undefined);
    assert.doesNotMatch(requests[4].messages[0].content, /Bob/);
    assert.match(lines[4], /^@Bob、/);

    now += 224000;
    snapshot = { ...snapshot, activity: {
        state: 'next_job', actionState: 'new_job', task: '別の作業', actions: [], commentary: []
    } };
    await dialogue.maybeSpeak();
    await setImmediate();
    assert.equal(requests.length, 5);
    worldState.observe({ id: 'new_sensor_event', text: 'A bell rang nearby.', priority: 0 });
    await dialogue.maybeSpeak();
    assert.equal(requests.length, 5);
    now += 1500;
    await dialogue.maybeSpeak();
    await setImmediate();
    const newObservation = JSON.parse(requests[5].messages[0].content);
    assert.equal(newObservation.event, 'new_sensor_event');
    assert.equal(newObservation.focus.description, 'A bell rang nearby.');
    assert.equal(newObservation.focus.actorIsAddressee, undefined);

    now += 1000;
    dialogue.lastEventAt.eye_contact = now - 16000;
    snapshot = { ...snapshot, activity: { ...snapshot.activity, commentary: [{
        id: 'eye_contact', text: 'We just made eye contact.', recipient: 'Bob', reaction: true
    }] } };
    await dialogue.maybeSpeak();
    await setImmediate();
    assert.deepEqual(acknowledgements, ['wait', 'eye_contact']);
    assert.match(lines[6], /^@Bob、.*目が合.*お辞儀/);

    now += 230000;
    const attack = worldState.observe({
        id: 'player_hit_hostile', recipient: 'Bob', target: 'zombie', priority: 2,
        text: 'The player switched from mining to fighting. The nearby player landed a hit on a zombie.',
        actionFacts: [{ actor: 'player', action: 'landed a hit on a zombie' }]
    });
    snapshot = { ...snapshot, controlOwner: 'combat', combatTarget: 'zombie',
        hostile: { name: 'zombie', distance: 3.2 }, hostileBand: 'near',
        activity: { state: 'combat', task: '敵に対処する', actions: ['攻撃する'], commentary: [] }
    };
    await dialogue.maybeSpeak();
    await setImmediate();
    const combat = JSON.parse(requests[6].messages[0].content);
    assert.equal(combat.event, 'player_hit_hostile');
    assert.match(combat.focus.description, /switched from mining to fighting/);
    assert.deepEqual(combat.hostile, { name: 'zombie', proximity: 'near' });
    assert.equal(combat.focus.actorIsAddressee, true);
    assert.ok(combat.recentCommentary.length);

    now += 16000;
    await dialogue.maybeSpeak();
    await setImmediate();
    assert.equal(requests.length, 7);
    assert.match(lines.at(-1), /^@Bob、/);
    assert.equal(attack.handled, true);

    now += 230000;
    const spoken = lines.length;
    worldState.observe({ id: 'small_change', text: 'A block changed nearby.', priority: 0 });
    await dialogue.maybeSpeak();
    await setImmediate();
    assert.equal(requests.length, 8);
    assert.equal(lines.length, spoken);
    worldState.observe({ id: 'another_change', text: 'A different block changed nearby.', priority: 0 });
    await dialogue.maybeSpeak();
    assert.equal(requests.length, 8);
});

test('describes a blocked path once during repeated failures and falls back after a new blockage', async (t) => {
    let now = 1000000;
    t.mock.method(Date, 'now', () => now);
    setEnv(t, {
        ANTHROPIC_API_KEY: 'test-key', CLAUDE_MONTHLY_BUDGET_USD: '200',
        ANTHROPIC_ADMIN_API_KEY: '', ANTHROPIC_WORKSPACE_ID: ''
    });
    const worldState = new WorldState();
    worldState.nearbyPlayers = [{ name: 'Alice', distance: 2 }];
    const ctx = { worldState };
    const lines = [];
    const agent = {
        bot: { entity: {}, health: 20 }, companion: { ctx, _interval: true },
        openChat: async line => lines.push(line)
    };
    const dialogue = new CompanionDialogue(agent, { getCurrentModeId: () => 'follow' }, {
        chat: { spontaneous_chance: 1, min_interval_ms: 0, priority_min_interval_ms: 0, event_cooldown_ms: 0 }
    });
    t.mock.method(dialogue, '_buildSnapshot', () => ({ ...dialogue._emptySnapshot('follow'), nearbyPlayers: worldState.nearbyPlayers }));
    const contexts = [];
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
        contexts.push(JSON.parse(JSON.parse(request.body).messages.at(-1).content));
        if (contexts.length === 2) return new Response(null, { status: 429 });
        return Response.json({ content: [{ type: 'text', text: 'ちょっと狭いね、ここで待ってるよ！' }] });
    });
    for (let i = 0; i < 20; i++) {
        notifyPathBlocked(ctx);
        await dialogue.maybeSpeak();
        await setImmediate();
        now += 1000;
    }
    assert.deepEqual(lines, ['@Alice、ちょっと狭いね、ここで待ってるよ！']);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].event, 'path_blocked');
    assert.match(contexts[0].focus.description, /safe way past nearby players/);

    now += 6000;
    notifyPathBlocked(ctx);
    await dialogue.maybeSpeak();
    await setImmediate();
    assert.equal(contexts.length, 2);
    assert.equal(lines[1], '@Alice、ここ、ぶつからずに通るのは難しそう。ちょっと待ってるね。');
});

test('delivers a completed reaction once even when it starts behind a player reply', async (t) => {
    t.mock.method(Date, 'now', () => 1000000);
    setEnv(t, {
        ANTHROPIC_API_KEY: 'test-key', CLAUDE_MONTHLY_BUDGET_USD: '200',
        ANTHROPIC_ADMIN_API_KEY: '', ANTHROPIC_WORKSPACE_ID: ''
    });
    const worldState = new WorldState();
    worldState.nearbyPlayers = [{ name: 'Alice', distance: 2 }];
    const lines = [];
    const agent = {
        bot: { username: 'Trailmate', entity: {}, health: 20 },
        companion: { _interval: true, ctx: { worldState } },
        openChat: async line => lines.push(line)
    };
    const dialogue = new CompanionDialogue(agent, { getCurrentModeId: () => 'wait' });
    const snapshot = { ...dialogue._emptySnapshot('wait'), nearbyPlayers: worldState.nearbyPlayers };
    t.mock.method(dialogue, '_buildSnapshot', () => snapshot);

    let finishReply;
    const pendingReply = new Promise(resolve => { finishReply = resolve; });
    const contexts = [];
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
        const context = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
        contexts.push(context);
        if (context.message) {
            await pendingReply;
            return Response.json({ content: [{ type: 'text', text: 'おはよ！' }] });
        }
        return Response.json({ content: [{ type: 'text', text: 'ぺこっ！目が合ったね。' }] });
    });

    const reply = dialogue.handlePlayerMessage('Alice', '@Trailmate おはよ！', true);
    worldState.observe({ id: 'companion_took_damage', text: 'A recent hit.', priority: 2 });
    worldState.observe({
        id: 'eye_contact', text: 'Made eye contact and completed a bow.',
        reaction: true, recipient: 'Alice', priority: 0
    });
    await dialogue.maybeSpeak();
    await dialogue.maybeSpeak();
    assert.equal(contexts.length, 1, 'reaction waits for the pending reply');
    finishReply();
    assert.equal(await reply, true);
    await setImmediate();
    await dialogue.maybeSpeak();
    assert.deepEqual(contexts.map(context => context.event), [undefined, 'eye_contact']);
    assert.equal(contexts[1].focus.required, true);
    assert.deepEqual(lines, ['おはよ！', '@Alice、ぺこっ！目が合ったね。']);
});

test('a quota rejection falls back for commentary and public replies, then Claude resumes', async (t) => {
    let now = 1000000;
    t.mock.method(Date, 'now', () => now);
    setEnv(t, {
        ANTHROPIC_API_KEY: 'test-key', CLAUDE_MONTHLY_BUDGET_USD: '200',
        ANTHROPIC_ADMIN_API_KEY: '', ANTHROPIC_WORKSPACE_ID: ''
    });
    const nearbyPlayers = [{ name: 'Alice' }];
    const lines = [];
    const agent = {
        bot: { username: 'Trailmate', entity: {}, health: 20 },
        companion: { _interval: true, ctx: { worldState: { nearbyPlayers } } },
        openChat: async (line) => lines.push(line)
    };
    const dialogue = new CompanionDialogue(agent, { getCurrentModeId: () => 'wait' }, { chat: { spontaneous_chance: 1 } });
    let snapshot = { ...dialogue._emptySnapshot('wait'), nearbyPlayers, health: 20, isNight: false, isRaining: false };
    t.mock.method(dialogue, '_buildSnapshot', () => snapshot);
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
        if (fetch.mock.callCount() === 0) return new Response(null, { status: 429 });
        if (fetch.mock.callCount() === 2) {
            return Response.json({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '途中までの返' }] });
        }
        if (fetch.mock.callCount() === 3) {
            return Response.json({ content: [{ type: 'text', text: '雨で少し冷えますね。' }] });
        }
        if (fetch.mock.callCount() === 4) {
            return Response.json({ content: [{ type: 'text', text: 'はい、ここで待っていますよ。' }] });
        }
        return Response.json({ content: [{ type: 'text', text: 'おかえり！ おしゃべりしよっか？' }] });
    });

    await dialogue.maybeSpeak();
    snapshot = { ...snapshot, isRaining: true };
    await dialogue.maybeSpeak();
    await setImmediate();
    assert.equal(lines[0], '@Alice、あっ、雨だ。屋根の下でひと休みしよっか？');

    assert.equal(await dialogue.handlePlayerMessage('Alice', '@Trailmate 今どう？', true), true);
    assert.equal(lines[1], tCommand('ja', 'reply_unavailable'));
    assert.equal(fetch.mock.callCount(), 1);

    now += 60001;
    assert.equal(await dialogue.handlePlayerMessage('Alice', '@Trailmate 今どう？', true), true);
    assert.equal(lines[2], 'おかえり！ おしゃべりしよっか？');
    assert.equal(fetch.mock.callCount(), 2);

    now += 1500;
    assert.equal(await dialogue.handlePlayerMessage('Alice', '@Trailmate 今どう？', true), true);
    assert.equal(lines[3], tCommand('ja', 'reply_unavailable'));

    now += 45001;
    snapshot = { ...snapshot, isNight: true };
    await dialogue.maybeSpeak();
    await setImmediate();
    assert.match(lines[4], /^@Alice、(?:あっ、もう夜だね|暗くなって)/);

    assert.equal(await dialogue.handlePlayerMessage('Alice', '@Trailmate 今どう？', true), true);
    assert.equal(lines[5], tCommand('ja', 'reply_unavailable'));
});

test('Console lookup failure pauses Claude and retains the latest speech cadence', async (t) => {
    setEnv(t, {
        CLAUDE_MONTHLY_BUDGET_USD: '75',
        ANTHROPIC_ADMIN_API_KEY: 'test-admin-key',
        ANTHROPIC_WORKSPACE_ID: 'wrkspc_test'
    });
    const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
        assert.equal(url.searchParams.get('workspace_id'), 'wrkspc_test');
        if (fetch.mock.callCount()) return new Response(null, { status: 403 });
        return Response.json({ data: [{
            amount: '2000', currency: 'USD', is_enabled: true, period: 'monthly',
            scope: { type: 'workspace', workspace_id: 'wrkspc_test' }
        }] });
    });
    const budget = new ClaudeChatBudget();
    assert.equal(budget.fraction, 0);
    assert.equal(budget.speechFraction, 0.375);
    budget.refresh(1000);
    await setImmediate();
    assert.equal(budget.fraction, 0.1);
    budget.refresh(2000);
    assert.equal(fetch.mock.callCount(), 1);
    budget.refresh(301000);
    await setImmediate();
    assert.equal(budget.fraction, 0);
    assert.equal(budget.speechFraction, 0.1);
});
