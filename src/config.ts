import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export type ChatConfig = {
  enabled: boolean;
  min_interval_ms: number;
  event_cooldown_ms: number;
  player_reply_cooldown_ms: number;
  spontaneous_chance: number;
  idle_chance: number;
  low_health: number;
  stuck_seconds: number;
  hostile_range: number;
};

export type ReflexConfig = {
  self_defense: boolean;
  torch_placing: boolean;
  self_preservation: boolean;
  hostile_range: number;
};

export type DeathReturnConfig = {
  enabled: boolean;
  arrive_range: number;
  timeout_ms: number;
};

export type OwnGraveConfig = {
  enabled: boolean;
  dig_range: number;
};

export type NearbyLootConfig = {
  enabled: boolean;
  max_ms: number;
  quiet_ms: number;
  grace_ms: number;
  give_suppress_ms: number;
};

export type OwnerWorkConfig = {
  enabled: boolean;
  fov_degrees: number;
  swing_idle_ms: number;
  post_work_cooldown_ms: number;
};

export type ItemShareConfig = {
  enabled: boolean;
  interval_ms: number;
  keep_torch_stacks: number;
  keep_food_stacks: number;
  keep_equipment_sets: number;
};

export type CompanionConfig = {
  scan_radius: number;
  fov_degrees: number;
  follow_distance: number;
  follow_min_distance: number;
  owner_near_radius: number;
  stuck_detect_seconds: number;
  tick_ms: number;
  torch_light_threshold: number;
  awareness_radius: number;
  owner_work: OwnerWorkConfig;
  death_return: DeathReturnConfig;
  own_grave: OwnGraveConfig;
  nearby_loot: NearbyLootConfig;
  item_share: ItemShareConfig;
  reflexes: ReflexConfig;
  chat: ChatConfig;
};

export type AppConfig = {
  host: string;
  port: number;
  auth: 'offline' | 'microsoft';
  botName: string;
  minecraft_version: string;
  language: string;
  chat_ingame: boolean;
  companion: CompanionConfig;
};

const DEFAULT_COMPANION: CompanionConfig = {
  scan_radius: 48,
  fov_degrees: 120,
  follow_distance: 3,
  follow_min_distance: 2,
  owner_near_radius: 12,
  stuck_detect_seconds: 1.5,
  tick_ms: 250,
  torch_light_threshold: 7,
  awareness_radius: 10,
  owner_work: {
    enabled: true,
    fov_degrees: 100,
    swing_idle_ms: 1000,
    post_work_cooldown_ms: 4000
  },
  death_return: {
    enabled: true,
    arrive_range: 3,
    timeout_ms: 90000
  },
  own_grave: {
    enabled: true,
    dig_range: 3.5
  },
  nearby_loot: {
    enabled: true,
    max_ms: 15000,
    quiet_ms: 1500,
    grace_ms: 2500,
    give_suppress_ms: 12000
  },
  item_share: {
    enabled: true,
    interval_ms: 60000,
    keep_torch_stacks: 3,
    keep_food_stacks: 3,
    keep_equipment_sets: 3
  },
  reflexes: {
    self_defense: true,
    torch_placing: true,
    self_preservation: true,
    hostile_range: 8
  },
  chat: {
    enabled: true,
    min_interval_ms: 90000,
    event_cooldown_ms: 300000,
    player_reply_cooldown_ms: 1500,
    spontaneous_chance: 0.7,
    idle_chance: 0.35,
    low_health: 8,
    stuck_seconds: 5,
    hostile_range: 12
  }
};

function loadJsonConfig(): Record<string, unknown> {
  const configPath = process.env.CONFIG_PATH
    ? path.resolve(process.env.CONFIG_PATH)
    : path.join(root, 'config.json');
  const examplePath = path.join(root, 'config.example.json');
  const file = fs.existsSync(configPath) ? configPath : examplePath;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function loadConfig(): AppConfig {
  const file = loadJsonConfig();
  const companionFile = (file.companion || {}) as Partial<CompanionConfig>;
  const chat = {
    ...DEFAULT_COMPANION.chat,
    ...(companionFile.chat || {})
  };
  const reflexes = {
    ...DEFAULT_COMPANION.reflexes,
    ...(companionFile.reflexes || {})
  };
  const death_return = {
    ...DEFAULT_COMPANION.death_return,
    ...(companionFile.death_return || {})
  };
  const own_grave = {
    ...DEFAULT_COMPANION.own_grave,
    ...(companionFile.own_grave || {})
  };
  const nearby_loot = {
    ...DEFAULT_COMPANION.nearby_loot,
    ...(companionFile.nearby_loot || {})
  };
  const owner_work = {
    ...DEFAULT_COMPANION.owner_work,
    ...(companionFile.owner_work || {})
  };
  const item_share = {
    ...DEFAULT_COMPANION.item_share,
    ...(companionFile.item_share || {})
  };

  return {
    host: process.env.MC_HOST || 'viaproxy',
    port: Number(process.env.MC_PORT || 25568),
    auth: (process.env.MC_AUTH as 'offline' | 'microsoft') || 'offline',
    botName: process.env.BOT_NAME || 'Trailmate',
    minecraft_version: String(file.minecraft_version || '1.21.6'),
    language: String(file.language || 'ja'),
    chat_ingame: file.chat_ingame !== false,
    companion: {
      ...DEFAULT_COMPANION,
      ...companionFile,
      chat,
      reflexes,
      death_return,
      own_grave,
      nearby_loot,
      owner_work,
      item_share
    }
  };
}

export function projectRoot(): string {
  return root;
}
