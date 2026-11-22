import mineflayer, { type Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';
import type { AppConfig } from '../config.js';
import { startCompanion } from '../companion/index.js';
import { WorldState } from '../companion/WorldState.js';
import { Reflexes } from '../reflexes/Reflexes.js';
import { setupAutoEat } from './autoEat.js';
import { extractKickReason } from '../runtime/spawnErrors.js';
import { installMovementPacketLimiter } from './movementPackets.js';

export type ChatEntry = { kind: 'companion' | 'message' | 'command'; text: string; at: number; player?: string };

export type TrailmateHost = {
  bot: Bot;
  name: string;
  shut_up: boolean;
  language: string;
  chat_ingame: boolean;
  chatEntries: ChatEntry[];
  openChat: (text: string) => Promise<void>;
  companion: any;
  reflexes: Reflexes | null;
  autoEatTree?: ReturnType<typeof setupAutoEat>;
};

export function recordChat(host: TrailmateHost, kind: ChatEntry['kind'], text: string, player?: string): void {
  host.chatEntries.push({ kind, text, at: Date.now(), ...(player && { player }) });
  if (host.chatEntries.length > 100) host.chatEntries.shift();
}

export function createBot(config: AppConfig): Bot {
  const options: mineflayer.BotOptions = {
    username: config.botName,
    host: config.host,
    port: config.port,
    auth: config.auth,
    version: config.minecraft_version,
    checkTimeoutInterval: 60000
  };
  if (!config.minecraft_version || config.minecraft_version === 'auto') {
    delete options.version;
  }

  const bot = mineflayer.createBot(options);

  installMovementPacketLimiter(bot);

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(armorManager);

  return bot;
}

export async function bootHost(config: AppConfig): Promise<TrailmateHost> {
  const bot = createBot(config);
  const worldState = new WorldState();
  worldState.observeWeather(bot);

  const host: TrailmateHost = {
    bot,
    name: config.botName,
    shut_up: false,
    language: config.language,
    chat_ingame: config.chat_ingame,
    chatEntries: [],
    companion: null,
    reflexes: null,
    openChat: async (text: string) => {
      const message = String(text || '').trim();
      if (!message || host.shut_up) return;
      console.log(`[chat] ${host.name}: ${message}`);
      if (host.chat_ingame) {
        bot.chat(message);
      }
      recordChat(host, 'companion', message);
    }
  };

  await new Promise<void>((resolve, reject) => {
    let kickReason: string | null = null;
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onKicked = (reason: unknown) => {
      kickReason = extractKickReason(reason);
      console.warn(`[trailmate] kicked before spawn: ${kickReason}`);
    };
    const onEnd = (reason: string) => {
      cleanup();
      const detail = kickReason || reason || 'ended';
      reject(new Error(`bot ended before spawn: ${detail}`));
    };
    const cleanup = () => {
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('error', onError);
      bot.removeListener('kicked', onKicked);
      bot.removeListener('end', onEnd);
    };
    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('kicked', onKicked);
    bot.once('end', onEnd);
  });

  trackDamage(bot);
  host.autoEatTree = setupAutoEat(bot, config.companion.auto_eat);

  host.reflexes = new Reflexes(
    bot,
    config.companion.reflexes,
    config.companion.torch_light_threshold
  );

  await startCompanion(host, config.companion, worldState);

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    void host.companion?.manager?.handlePlayerMessage(username, message, true).catch((err: unknown) => {
      console.error('[companion] chat error:', err);
    });
  });
  bot.on('whisper', (username, message) => {
    if (username === bot.username) return;
    void host.companion?.manager?.handlePlayerMessage(username, message).catch((err: unknown) => {
      console.error('[companion] whisper error:', err);
    });
  });

  await host.companion.manager.handleLifecycle('ready');
  console.log(`[trailmate] spawned as ${host.name}`);
  return host;
}

function trackDamage(bot: Bot): void {
  (bot as any).lastDamageTime = 0;
  (bot as any).lastDamageTaken = 0;
  let lastHealth = bot.health;

  bot.on('health', () => {
    const hp = bot.health;
    if (hp < lastHealth) {
      (bot as any).lastDamageTaken = lastHealth - hp;
      (bot as any).lastDamageTime = Date.now();
    }
    lastHealth = hp;
  });

  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    (bot as any).lastDamageTime = Date.now();
    if (!(bot as any).lastDamageTaken) {
      const delta = lastHealth - bot.health;
      (bot as any).lastDamageTaken = delta > 0 ? delta : 1;
    }
  });
}
