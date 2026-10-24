/**
 * config.json の minecraft_version に対応する公式 ja_jp から、
 * アイテム名とモブ名の表を作り直す。
 *
 *   node scripts/sync-minecraft-ja.mjs
 *   node scripts/sync-minecraft-ja.mjs --version 1.21.6
 *
 * 手で対応表を編集しない。辞書に無い ID は実行時に minecraft:<id> と出る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ID_KEY = /^[a-z0-9_]+$/;

/**
 * @param {Record<string, string>} lang
 * @returns {{ items: Record<string, string>, entities: Record<string, string> }}
 */
export function namesFromJaJp(lang) {
  const items = {};
  const entities = {};
  for (const [key, value] of Object.entries(lang || {})) {
    if (typeof value !== 'string' || !value) continue;
    const block = /^block\.minecraft\.([a-z0-9_]+)$/.exec(key);
    if (block && ID_KEY.test(block[1])) items[block[1]] = value;
  }
  for (const [key, value] of Object.entries(lang || {})) {
    if (typeof value !== 'string' || !value) continue;
    const item = /^item\.minecraft\.([a-z0-9_]+)$/.exec(key);
    if (item && ID_KEY.test(item[1])) items[item[1]] = value;
    const entity = /^entity\.minecraft\.([a-z0-9_]+)$/.exec(key);
    if (entity && ID_KEY.test(entity[1])) entities[entity[1]] = value;
  }
  return { items: sortRecord(items), entities: sortRecord(entities) };
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function readDefaultVersion() {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const version = String(config.minecraft_version || '').trim();
  if (!version || version === 'auto') return '';
  return version;
}

function requestedVersion(argv) {
  const index = argv.indexOf('--version');
  if (index >= 0) {
    const version = argv[index + 1];
    if (!version || version.startsWith('--')) {
      throw new Error('--version のあとに Minecraft のバージョンを指定してください');
    }
    return version;
  }
  return readDefaultVersion();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} が ${response.status} を返しました`);
  return response.json();
}

async function fetchJaJp(version) {
  const manifest = await fetchJson(VERSION_MANIFEST);
  const entry = (manifest.versions || []).find((item) => item.id === version);
  if (!entry?.url) throw new Error(`バージョン一覧に ${version} がありません`);
  const versionJson = await fetchJson(entry.url);
  const indexUrl = versionJson.assetIndex?.url;
  if (!indexUrl) throw new Error(`${version} のアセット索引がありません`);
  const index = await fetchJson(indexUrl);
  const asset = index.objects?.['minecraft/lang/ja_jp.json'];
  if (!asset?.hash) throw new Error(`${version} の ja_jp.json がアセット索引にありません`);
  const url = `https://resources.download.minecraft.net/${asset.hash.slice(0, 2)}/${asset.hash}`;
  return fetchJson(url);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const version = requestedVersion(process.argv.slice(2));
  if (!version) throw new Error('config.json の minecraft_version が空です。--version で指定してください');
  const lang = await fetchJaJp(version);
  const { items, entities } = namesFromJaJp(lang);
  writeJson(path.join(root, 'src/i18n/items-ja.json'), items);
  writeJson(path.join(root, 'locales/items-ja.json'), items);
  writeJson(path.join(root, 'src/i18n/entities-ja.json'), entities);
  writeJson(path.join(root, 'src/i18n/ja-lang.manifest.json'), {
    minecraftVersion: version,
    source: 'mojang-asset-index:minecraft/lang/ja_jp.json',
    itemCount: Object.keys(items).length,
    entityCount: Object.keys(entities).length
  });
  console.log(`${version}: items ${Object.keys(items).length}, entities ${Object.keys(entities).length}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
