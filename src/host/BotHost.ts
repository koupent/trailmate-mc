import mineflayer, { type Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';
import type { AppConfig } from '../config.js';
import { startCompanion } from '../companion/index.js';
import { Reflexes } from '../reflexes/Reflexes.js';
import { setupAutoEat } from './autoEat.js';

export type TrailmateHost = {
  bot: Bot;
  name: string;
  shut_up: boolean;
  language: string;
  chat_ingame: boolean;
  openChat: (text: string) => Promise<void>;
  companion: any;
  reflexes: Reflexes | null;
};

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

  // Throttle position packets (Paper kick mitigation)
  let lastPositionUpdate = 0;
  let pending: { name: string; data: any } | null = null;
  const POSITION_THROTTLE_MS = 50;
  const originalWrite = bot._client.write.bind(bot._client);
  bot._client.write = function (name: string, data: any) {
    if (name === 'position' || name === 'position_look' || name === 'look') {
      const now = Date.now();
      if (now - lastPositionUpdate >= POSITION_THROTTLE_MS) {
        lastPositionUpdate = now;
        return originalWrite(name, data);
      }
      pending = { name, data };
      return;
    }
    return originalWrite(name, data);
  };
  setInterval(() => {
    if (!pending) return;
    const packet = pending;
    pending = null;
    lastPositionUpdate = Date.now();
    originalWrite(packet.name, packet.data);
  }, POSITION_THROTTLE_MS);

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(armorManager);

  return bot;
}

export async function bootHost(config: AppConfig): Promise<TrailmateHost> {
  const bot = createBot(config);

  const host: TrailmateHost = {
    bot,
    name: config.botName,
    shut_up: false,
    language: config.language,
    chat_ingame: config.chat_ingame,
    companion: null,
    reflexes: null,
    openChat: async (text: string) => {
      const message = String(text || '').trim();
      if (!message || host.shut_up) return;
      console.log(`[chat] ${host.name}: ${message}`);
      if (host.chat_ingame) {
        bot.chat(message);
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onEnd = (reason: string) => {
      cleanup();
      reject(new Error(`bot ended before spawn: ${reason}`));
    };
    const cleanup = () => {
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('error', onError);
      bot.removeListener('end', onEnd);
    };
    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('end', onEnd);
  });

  trackDamage(bot);
  setupAutoEat(bot);

  host.reflexes = new Reflexes(
    bot,
    config.companion.reflexes,
    config.companion.torch_light_threshold
  );

  await startCompanion(host, config.companion);

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    void host.companion?.dialogue?.handlePlayerMessage?.(username, message);
  });
  bot.on('whisper', (username, message) => {
    if (username === bot.username) return;
    void host.companion?.dialogue?.handlePlayerMessage?.(username, message);
  });

  await host.openChat(`${host.name} trailmate ready`);
  console.log(`[trailmate] spawned as ${host.name}`);
  return host;
}

function trackDamage(bot: Bot): void {
  (bot as any).lastDamageTime = 0;
  (bot as any).lastDamageTaken = 0;
  bot.on('health', () => {
    /* mineflayer emits health; damage is tracked via entityHurt if available */
  });
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    (bot as any).lastDamageTime = Date.now();
    // amount not always available; CompanionDialogue uses presence of recent damage
    (bot as any).lastDamageTaken = Math.max(1, (bot as any).lastDamageTaken || 1);
  });
}
