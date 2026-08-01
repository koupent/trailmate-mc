import { loadConfig } from './config.js';
import { bootHost } from './host/BotHost.js';

async function main() {
  const config = loadConfig();
  console.log(`[trailmate] connecting to ${config.host}:${config.port} as ${config.botName}`);
  const host = await bootHost(config);

  const shutdown = (signal: string) => {
    console.log(`[trailmate] shutting down (${signal})`);
    try {
      host.reflexes?.flushLearning?.();
      if (host.companion?._interval) clearInterval(host.companion._interval);
      host.bot.quit('trailmate shutdown');
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[trailmate] fatal:', err);
  process.exit(1);
});
