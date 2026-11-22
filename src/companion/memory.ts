import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.js';

export const DASHBOARD_MEMORY = '管理画面';
export const COMPANION_MEMORY = '相棒';
type Notes = Record<string, string>;
type Memory = { player: string; notes: Notes; revision: number };

export function materialGoal(message: string): string | undefined {
  // An explicit plan in the player's own words is usable even if Claude omits a candidate.
  const match = /^(?:今日(?:の目標は|は)?|これから(?:は)?)[、,\s]*([\p{L}\p{N}ー・、, ]{1,64}?)を(?:集め(?:る|たい|ます)|掘(?:る|りたい))(?:(?:予定|つもり)(?:だ|です)?)?(?:よ|ね)?[。！!]*$/u.exec(message.trim());
  const materials = match?.[1].trim();
  if (materials) return '素材集めの目標：' + materials;
}

export function isMinecraftPlayerName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z0-9_]{1,16}$/i.test(name);
}

function playerKey(player: unknown): string {
  if (player === DASHBOARD_MEMORY) return 'dashboard';
  if (player === COMPANION_MEMORY) return 'companion';
  if (!isMinecraftPlayerName(player)) return '';
  return 'player-' + player.toLowerCase();
}

export function normalizeMemoryNotes(value: unknown): Notes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const notes: Notes = {};
  const entries = Object.entries(value);
  if (entries.length > 32) return null;
  for (const [key, text] of entries) {
    const field = key.trim();
    if (!/^[\p{L}\p{N} _・-]{1,24}$/u.test(field) || Object.hasOwn(Object.prototype, field)
        || typeof text !== 'string' || text.trim().length > 140
        || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text)) return null;
    if (Object.hasOwn(notes, field)) return null;
    if (text.trim()) notes[field] = text.trim();
  }
  return notes;
}

export function statedName(message: string) {
  const text = message.trim().replace(/[。！!]+$/u, '');
  const companion = /^(?:あなた|君|きみ|相棒)の(?:名前|呼び名)は[、, ]*(?:[「『])?([\p{L}\p{N}_ー・-]{1,24})(?:[」』])?(?:だよ|だね|だ|です)$/u.exec(text);
  if (companion) return { subject: 'companion', field: 'nickname', name: companion[1] };
  const player = /^(?:私|僕|俺|わたし|ぼく|おれ)(?:のこと)?(?:は|を)[、, ]*(?:[「『])?([\p{L}\p{N}_ー・-]{1,24})(?:[」』])?(?:と|って)呼んで(?:ね|よ)?$/u.exec(text);
  if (player) return { subject: 'player', field: 'nickname', name: player[1] };
  const personal = /^(?:私|僕|俺|わたし|ぼく|おれ)の名前は[、, ]*(?:[「『])?([\p{L}\p{N}_ー・-]{1,24})(?:[」』])?(?:だよ|だ|です)$/u.exec(text);
  if (personal) return { subject: 'player', field: 'name', name: personal[1] };
}

export function createMemoryStore(file: string) {
  function read(): Record<string, Memory> {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  return {
    list: () => Object.values(read()).sort((a, b) => a.player.localeCompare(b.player)),
    get(player: string): Memory | undefined {
      const key = playerKey(player);
      if (key) return read()[key];
    },
    save(player: string, notes: Notes, expectedRevision: number): Memory | null {
      const key = playerKey(player);
      if (!key) throw new Error('Minecraftのプレイヤー名を入力してください。');
      const all = read();
      const current = all[key];
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) return null;
      const entry = { player: current?.player ?? player, notes, revision: revision + 1 };
      if (current && Object.keys(current.notes).length === Object.keys(notes).length
          && Object.entries(notes).every(([field, text]) => current.notes[field] === text)) return current;
      all[key] = entry;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(all, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      return entry;
    }
  };
}

export const companionMemory = createMemoryStore(path.join(projectRoot(), 'data', 'companion-memory.json'));
