import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.js';

export const MEMORY_FIELDS = ['nickname', 'preferences', 'plans', 'milestones'] as const;
type Field = typeof MEMORY_FIELDS[number];
type Notes = Partial<Record<Field, string>>;
type Memory = { player: string; notes: Notes; revision: number };

export function materialGoal(message: string): string | undefined {
  // An explicit plan in the player's own words is usable even if Claude omits a candidate.
  const match = /^(?:今日(?:の目標は|は)?|これから(?:は)?)[、,\s]*([\p{L}\p{N}ー・、, ]{1,64}?)を(?:集め(?:る|たい|ます)|掘(?:る|りたい))(?:(?:予定|つもり)(?:だ|です)?)?(?:よ|ね)?[。！!]*$/u.exec(message.trim());
  const materials = match?.[1].trim();
  if (materials) return '素材集めの目標：' + materials;
}

function playerKey(player: unknown): string {
  if (player === '管理画面') return 'dashboard';
  if (typeof player !== 'string' || !/^[a-z0-9_]{1,16}$/i.test(player)) return '';
  return 'player-' + player.toLowerCase();
}

export function normalizeMemoryNotes(value: unknown): Notes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const notes: Notes = {};
  for (const [field, text] of Object.entries(value)) {
    if (!MEMORY_FIELDS.includes(field as Field) || typeof text !== 'string' || text.trim().length > 140
        || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text)) return null;
    if (text.trim()) notes[field as Field] = text.trim();
  }
  return notes;
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
      if (current && MEMORY_FIELDS.every(field => current.notes[field] === notes[field])) return current;
      all[key] = entry;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(all, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      return entry;
    }
  };
}

export const companionMemory = createMemoryStore(path.join(projectRoot(), 'data', 'companion-memory.json'));
