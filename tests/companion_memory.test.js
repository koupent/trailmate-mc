import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CompanionDialogue } from '../src/companion/CompanionDialogue.js';
import { createMemoryStore, normalizeMemoryNotes } from '../src/companion/memory.js';

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
    assert.equal(normalizeMemoryNotes({ prompt: 'invalid' }), null);
    assert.equal(normalizeMemoryNotes({ plans: 'invalid\nline' }), null);
});
