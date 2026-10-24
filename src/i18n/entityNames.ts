import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupJa } from './registryLabel.js';

/**
 * モブ（エンティティ）の日本語名。
 * entities-ja.json は対象バージョンの公式 ja_jp（entity.minecraft.*）から
 * `npm run i18n:sync` で作る。
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

/** ダッシュボードや箱庭へ渡す、id → 日本語名の表。 */
export function entityLabelsJa(): Record<string, string> {
  return { ...loadEntityNamesJa() };
}

/**
 * 日本語名が無いモブは `minecraft:<id>`。
 * 英語の displayName には戻さない。空は「不明」。
 */
export function entityDisplayNameJa(id: string): string {
  return lookupJa(loadEntityNamesJa(), id);
}
