import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { CompanionDialogue } from '../src/companion/CompanionDialogue.js';
import { WorldState } from '../src/companion/WorldState.js';
import { companionMemory, createMemoryStore, normalizeMemoryNotes } from '../src/companion/memory.js';
import { createControlState, startControlServer } from '../src/runtime/controlServer.js';

test('companion saves summaries across restarts and uses only the current player’s notes', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-memory-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'memory.json');
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    t.after(() => {
        if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = key;
    });

    const contexts = [];
    const lines = [];
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
        const { messages } = JSON.parse(request.body);
        const context = JSON.parse(messages.at(-1).content);
        contexts.push(context);
        const line = context.message.includes('石橋')
            ? '橋づくり、楽しみだね！\nMEMORY {"field":"plans","note":"川に橋を架ける"}'
            : contexts.length === 2 ? '川の橋、続きをやろっか？' : '今日もいっしょに行こっか？';
        return Response.json({ content: [{ type: 'text', text: line }] });
    });
    const createDialogue = () => new CompanionDialogue({
        bot: { username: 'Trailmate', entity: {}, health: 20 },
        companion: { _interval: true },
        openChat: async (line) => { lines.push(line); }
    }, { getCurrentModeId: () => 'wait' }, { chat: { player_reply_cooldown_ms: 0 } }, createMemoryStore(file));

    await createDialogue().handlePlayerMessage('Alice', '@Trailmate あの川に石橋を造るんだ', true);
    assert.deepEqual(lines, ['橋づくり、楽しみだね！']);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /あの川に石橋を造るんだ/);
    const dialogue = createDialogue();
    await dialogue.handlePlayerMessage('alice', '@Trailmate 次は何しよっか', true);
    await dialogue.handlePlayerMessage('Bob', '@Trailmate 次は何しよっか', true);
    assert.deepEqual(contexts[1].memory, { plans: '川に橋を架ける' });
    assert.equal(contexts[2].memory, undefined);
    assert.deepEqual(createMemoryStore(file).list().map(({ player }) => player), ['Alice']);
});

test('manual edits and clearing survive reload and stale generated updates cannot overwrite them', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-memory-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'memory.json');
    const store = createMemoryStore(file);
    const initial = store.save('Alice', { nickname: 'アリス' }, 0);
    assert.equal(store.save('Alice', {}, initial.revision)?.revision, 2);
    assert.equal(store.save('alice', { nickname: '以前の呼び方' }, initial.revision), null);
    assert.deepEqual(createMemoryStore(file).get('Alice')?.notes, {});
    assert.equal(normalizeMemoryNotes({ '見出し：不正': 'invalid' }), null);
    assert.equal(normalizeMemoryNotes(JSON.parse('{"__proto__":"invalid"}')), null);
    assert.deepEqual(normalizeMemoryNotes({ '一緒に釣り': '桟橋を作った' }), { '一緒に釣り': '桟橋を作った' });
    assert.equal(normalizeMemoryNotes({ plans: 'invalid\nline' }), null);
});

test('dashboard chat retains a stated material goal without a Claude memory proposal', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-memory-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = createMemoryStore(path.join(dir, 'memory.json'));
    t.mock.method(companionMemory, 'list', store.list);
    t.mock.method(companionMemory, 'get', store.get);
    t.mock.method(companionMemory, 'save', store.save);
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    t.after(() => {
        if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = key;
    });
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, options);
        const context = JSON.parse(JSON.parse(options.body).messages.at(-1).content);
        const { message } = context;
        if (message.includes('金鉱石')) return new Response(null, { status: 429 });
        if (message === '私の名前は？') {
            assert.deepEqual(context.nameQuestion, { subject: 'player', field: 'name', answer: 'のぺぽ' });
            assert.equal(context.memory, undefined);
            assert.equal(context.companionIdentity, undefined);
            return Response.json({ content: [{ type: 'text', text: 'のぺぽ！ もちろん覚えてるよ。' }] });
        }
        const text = message.includes('洞窟')
            ? '承知しました。\nMEMORY {"field":"preferences","note":"洞窟探検が好き"}'
            : 'いっしょに集めよっか？';
        return Response.json({ content: [{ type: 'text', text }] });
    });
    const spoken = [];
    const state = createControlState();
    const host = {
        bot: { username: 'Trailmate', entity: {}, health: 20, players: { Alice: {}, Bob: {} }, chat() {} },
        chatEntries: [], chat_ingame: true,
        companion: { _interval: true, manager: {} },
        openChat: async line => { spoken.push(line); }
    };
    const dialogue = new CompanionDialogue(host, { getCurrentModeId: () => 'wait' }, {
        chat: { player_reply_cooldown_ms: 0 }
    }, store);
    host.companion.manager.handlePlayerMessage = (...args) => dialogue.handlePlayerMessage(...args);
    state.host = host;
    const server = startControlServer(state, { host: '127.0.0.1', port: 0 });
    if (!server.listening) await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const send = async (text, player) => {
        const response = await realFetch(base + '/chat', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'message', text, player })
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).replied, true);
    };
    assert.deepEqual(await (await realFetch(base + '/memory')).json(), { players: [], onlinePlayers: ['Alice', 'Bob'] });
    await send('今日は鉄鉱石と石炭を集めるよ');
    assert.equal(spoken.at(-1), 'いっしょに集めよっか？');
    await send('今日は鉄鉱石と石炭を集めるよ');
    assert.equal(spoken.at(-1), 'いっしょに集めよっか？');
    await send('今日は銅を集める？');
    assert.equal(spoken.at(-1), 'いっしょに集めよっか？');
    assert.equal(store.get('管理画面').revision, 1);
    await send('洞窟探検が好き');
    assert.equal(spoken.at(-1), '覚えておくね！');
    const memory = await (await realFetch(base + '/memory')).json();
    assert.deepEqual(memory.players, [{
        player: '管理画面', revision: 2,
        notes: { plans: '素材集めの目標：鉄鉱石と石炭', preferences: '洞窟探検が好き' }
    }]);
    store.save('相棒', { nickname: 'MameCollie' }, 0);
    const dashboardMemory = store.get('管理画面');
    store.save('管理画面', { ...dashboardMemory.notes, nickname: 'のぺぽ' }, dashboardMemory.revision);
    await send('私の名前は？');
    assert.equal(spoken.at(-1), 'のぺぽ！ もちろん覚えてるよ。');
    await send('これから金鉱石を集めるつもりだよ');
    assert.equal(spoken.at(-1), 'のぺぽ、覚えておくね！');
    assert.deepEqual(store.get('管理画面').notes, {
        plans: '素材集めの目標：金鉱石', preferences: '洞窟探検が好き', nickname: 'のぺぽ'
    });
    await send('僕のことはリクって呼んで', 'Alice');
    assert.equal(store.get('Alice').notes.nickname, 'リク');
    assert.equal(store.get('Bob'), undefined);
    assert.equal(store.get('管理画面').notes.nickname, 'のぺぽ');
    delete host.bot.players.Alice;
    const disconnected = await realFetch(base + '/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'message', text: '僕のことはケイって呼んで', player: 'Alice' })
    });
    assert.equal(disconnected.status, 409);
    assert.equal(store.get('Alice').notes.nickname, 'リク');
    const added = await realFetch(base + '/memory', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ player: 'bob', revision: 0, notes: { '一緒に釣り': '桟橋を作った' } })
    });
    assert.equal(added.status, 200);
    assert.equal((await added.json()).entry.player, 'Bob');
    await send('私の名前は？', 'Bob');
    assert.equal(spoken.at(-1), '名前はまだ聞いてないよ。なんて呼べばいい？');
    await send('私の名前は？');
    assert.equal(spoken.at(-1), 'のぺぽだよね！');
    await send('あなたの名前は？');
    assert.equal(spoken.at(-1), 'ぼくの名前はMameCollieだよ！');
    await send('僕の名前はソラだよ', 'Bob');
    await send('僕のことはそらっちって呼んで', 'Bob');
    await send('僕の名前は何ですか？', 'Bob');
    assert.equal(spoken.at(-1), 'ソラだよね！');
    await send('僕の呼び方は？', 'Bob');
    assert.equal(spoken.at(-1), 'そらっちって呼んでるよ！');
    t.mock.method(store, 'save', () => null);
    await send('今日は鉄を集めるよ');
    assert.doesNotMatch(spoken.at(-1), /覚えておくね|memory_saved/);
});

test('keeps the companion name, each player’s memory, and verified interactions separate', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-memory-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'memory.json');
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    t.after(() => {
        if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = key;
    });
    const store = createMemoryStore(file);
    store.save('Alice', { preferences: '石造りが好き' }, 0);
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const { messages } = JSON.parse(options.body);
        const context = JSON.parse(messages.at(-1).content);
        requests.push({ context, history: messages.slice(0, -1) });
        const note = context.message?.includes('リク') ? '\nMEMORY {"subject":"companion","field":"nickname","note":"リク"}'
            : context.message?.includes('釣り') ? '\nMEMORY {"subject":"player","field":"釣りの場所","note":"小屋の裏の桟橋"}' : '';
        const line = context.statedName?.subject === 'companion' ? 'ポチって名前、気に入ったよ！'
            : context.nameQuestion?.subject === 'companion' ? 'ポチだよ。呼んでくれたらうれしいな！'
            : context.message?.includes('釣り') ? 'ソラ、今度いっしょに釣ろっか？'
            : context.memory?.nickname === 'リク' ? 'リク、どこに行こっか？'
            : context.recipientNickname ? context.recipientNickname + '、目が合ったね！' : 'うん、いいね！';
        return Response.json({ content: [{ type: 'text', text: line + note }] });
    });
    const bot = Object.assign(new EventEmitter(), {
        username: 'Trailmate', health: 20, entity: { id: 1 },
        players: { Alice: { username: 'Alice', entity: { id: 2 } }, Bob: { username: 'Bob', entity: { id: 3 } } }
    });
    const lines = [];
    const agent = { bot, companion: { _interval: true }, openChat: async line => lines.push(line) };
    const dialogue = new CompanionDialogue(agent, { getCurrentModeId: () => 'wait' }, {
        chat: { player_reply_cooldown_ms: 0 }
    }, store);
    agent.companion.dialogue = dialogue;
    const world = new WorldState();
    world.observeActivities({ agent, bot, config: {} });
    const say = (player, line) => dialogue.handlePlayerMessage(player, '@Trailmate ' + line, true);

    await say('Alice', '私のことはリクって呼んで');
    assert.equal(store.get('相棒'), undefined);
    await say('Alice', '君の名前はポチだよ');
    assert.equal(lines.at(-1), 'ポチって名前、気に入ったよ！');
    assert.deepEqual(requests.at(-1).context.statedName, { subject: 'companion', field: 'nickname', name: 'ポチ' });
    await say('Alice', 'あなたの名前は何ですか？');
    assert.equal(lines.at(-1), 'ポチだよ。呼んでくれたらうれしいな！');
    assert.deepEqual(requests.at(-1).context.nameQuestion, { subject: 'companion', field: 'name', answer: 'ポチ' });
    assert.equal(requests.at(-1).context.memory, undefined);
    assert.equal(requests.at(-1).context.companionIdentity, undefined);
    assert.equal(store.get('Alice').notes.nickname, 'リク');
    await say('Bob', '僕の名前はソラだよ');
    await say('Bob', '僕のことはソラって呼んで');
    await say('Bob', 'いつも小屋の裏の桟橋で釣りをするんだ');
    assert.match(lines.at(-1), /^ソラ、/);
    assert.doesNotMatch(lines.at(-1), /リク|プレイヤー/);
    assert.equal(requests.at(-1).history.some(message => message.content.includes('リク')), false);
    await say('Alice', '次は何しよっか');
    assert.equal(lines.at(-1), 'リク、どこに行こっか？');
    assert.equal(requests.at(-1).context.memory.nickname, 'リク');
    assert.equal(requests.at(-1).context.companionIdentity.nickname, 'ポチ');
    assert.equal(requests.at(-1).context.memory['釣りの場所'], undefined);
    assert.ok(requests.at(-1).history.some(message => message.content.includes('ポチ')));
    bot.emit('entityHurt', bot.entity, bot.players.Alice.entity);
    bot.emit('entityHurt', bot.entity, { type: 'player', id: 99 });
    assert.equal(store.get('Bob').notes.received_hit, undefined);
    assert.match(store.get('Alice').notes.received_hit, /意図は不明/);
    bot.emit('entityHurt', bot.entity, bot.players.Bob.entity);
    const reloaded = createMemoryStore(file);
    assert.match(reloaded.get('Bob').notes.received_hit, /意図は不明/);
    assert.equal(reloaded.get('Bob').notes['釣りの場所'], '小屋の裏の桟橋');
    assert.equal(reloaded.get('Bob').notes.name, 'ソラ');
    assert.equal(reloaded.get('Alice').notes.preferences, '石造りが好き');
    assert.equal(reloaded.get('相棒').notes.nickname, 'ポチ');

    agent.companion.ctx = { worldState: world };
    world.nearbyPlayers = [{ name: 'Alice', distance: 2 }, { name: 'Bob', distance: 3 }];
    t.mock.method(dialogue, '_buildSnapshot', () => ({
        ...dialogue._emptySnapshot('wait'), nearbyPlayers: world.nearbyPlayers
    }));
    world.observe({ id: 'bow_completed', text: 'Bowed to Bob', reaction: true, priority: 0, recipient: 'Bob' });
    await dialogue.maybeSpeak();
    await setImmediate();
    assert.equal(requests.at(-1).context.recipientNickname, 'ソラ');
    assert.equal(lines.at(-1), 'ソラ、目が合ったね！');
});
