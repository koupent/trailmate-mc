import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.js';

/** @type {Record<string, string> | null} */
let itemNamesJa: Record<string, string> | null = null;

function loadItemNamesJa(): Record<string, string> {
  if (itemNamesJa) return itemNamesJa;
  const file = path.join(projectRoot(), 'locales', 'items-ja.json');
  try {
    itemNamesJa = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    itemNamesJa = {};
  }
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
