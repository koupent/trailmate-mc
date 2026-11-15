import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Explicit files work on Node 22/24 and Windows without shell glob expansion.
const files = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => /\.test\.(js|ts)$/.test(name)).sort().map(name => `tests/${name}`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
