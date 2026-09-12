import { createControlState, despawnCompanion, startControlServer } from './runtime/controlServer.js';

async function main() {
  const state = createControlState();
  startControlServer(state);

  const shutdown = async (signal: string) => {
    console.log(`[trailmate] shutting down (${signal})`);
    try {
      await despawnCompanion(state);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err) => {
  console.error('[trailmate] fatal:', err);
  process.exit(1);
});
