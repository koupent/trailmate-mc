import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * モブ（エンティティ）の日本語名。entities-ja.json は公式の ja_jp 言語ファイル
 * （26.2）の entity.minecraft.* から作ったもの。
 */
let entityNamesJa: Record<string, string> | null = null;

function loadEntityNamesJa(): Record<string, string> {
  if (entityNamesJa) return entityNamesJa;
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'entities-ja.json');
    entityNamesJa = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    entityNamesJa = {};
  }
  return entityNamesJa;
}

/** 日本語名が無いモブは null（呼び出し側が英語名などに戻す）。 */
export function entityDisplayNameJa(id: string): string | null {
  return loadEntityNamesJa()[id] ?? null;
}
