import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { CompanionDialogue } from '../src/companion/CompanionDialogue.js';
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
    assert.deepEqual(lines, ['橋づくり、楽しみだね！ 覚えておくね！']);
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
    assert.equal(normalizeMemoryNotes({ prompt: 'invalid' }), null);
    assert.equal(normalizeMemoryNotes({ plans: 'invalid\nline' }), null);
});

test('dashboard chat retains a stated material goal without a Claude memory proposal', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-memory-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = createMemoryStore(path.join(dir, 'memory.json'));
    t.mock.method(companionMemory, 'list', store.list);
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    t.after(() => {
        if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = key;
    });
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (!String(url).startsWith('https://api.anthropic.com/')) return realFetch(url, options);
        const message = JSON.parse(JSON.parse(options.body).messages.at(-1).content).message;
        if (message.includes('金鉱石')) return new Response(null, { status: 429 });
        const text = message.includes('洞窟')
            ? '承知しました。\nMEMORY {"field":"preferences","note":"洞窟探検が好き"}'
            : 'いっしょに集めよっか？';
        return Response.json({ content: [{ type: 'text', text }] });
    });
    const spoken = [];
    const state = createControlState();
    const host = {
        bot: { username: 'Trailmate', entity: {}, health: 20, chat() {} },
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
    const send = async text => {
        const response = await realFetch(base + '/chat', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'message', text })
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).replied, true);
    };
    assert.deepEqual(await (await realFetch(base + '/memory')).json(), { players: [] });
    await send('今日は鉄鉱石と石炭を集めるよ');
    assert.equal(spoken.at(-1), 'いっしょに集めよっか？ 覚えておくね！');
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
    await send('これから金鉱石を集めるつもりだよ');
    assert.equal(spoken.at(-1), '覚えておくね！');
    assert.deepEqual(store.get('管理画面').notes, {
        plans: '素材集めの目標：金鉱石', preferences: '洞窟探検が好き'
    });
    t.mock.method(store, 'save', () => null);
    await send('今日は鉄を集めるよ');
    assert.doesNotMatch(spoken.at(-1), /覚えておくね|memory_saved/);
});
