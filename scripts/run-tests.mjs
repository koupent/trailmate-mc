import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Explicit files work on Node 22/24 and Windows without shell glob expansion.
const files = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => /\.test\.(js|ts)$/.test(name))
  .filter(name => process.argv[2] !== 'water' || ['swim_follow_physics.test.js', 'water_simulator_http.test.js'].includes(name))
  .sort().map(name => `tests/${name}`);
// mineflayer-statemachine brings node@19 and its .bin/node into npm's PATH.
// npm_node_execpath is the runtime selected by setup-node / the invoking user.
const runtime = process.env.npm_node_execpath || process.execPath;
const result = spawnSync(runtime, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
