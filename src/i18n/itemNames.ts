import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../config.js';

/** @type {Record<string, string> | null} */
let itemNamesJa: Record<string, string> | null = null;

function loadItemNamesJa(): Record<string, string> {
  if (itemNamesJa) return itemNamesJa;

  const here = path.dirname(fileURLToPath(import.meta.url));
  // 1) ホストの ./locales マウント（カスタム可）
  // 2) イメージ同梱（src 配下。volume で上書きされない）
  const candidates = [
    path.join(projectRoot(), 'locales', 'items-ja.json'),
    path.join(here, 'items-ja.json')
  ];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
      // 空のホストマウントで同梱データを潰さない
      if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
        continue;
      }
      itemNamesJa = parsed;
      return itemNamesJa;
    } catch {
      /* try next */
    }
  }

  itemNamesJa = {};
  return itemNamesJa;
}

/**
 * Mineflayer registry name → Japanese display label.
 * Falls back to the registry name when unknown.
 */
export function itemDisplayNameJa(registryName: string): string {
  const key = String(registryName || '').trim();
  if (!key) return '不明';
  const map = loadItemNamesJa();
  return map[key] || key;
}
