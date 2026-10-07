// Runs with the bundled Node, including when launched from Finder without a shell PATH.
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { setupEnvironment } = require('./node_modules/dugite/build/lib/git-environment.js');
const { env, gitLocation } = setupEnvironment({});
// Windows treats Path and PATH as the same variable; Node passes only one to children.
for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'path') delete process.env[key];
for (const [key, value] of Object.entries(env)) if (key.toLowerCase() !== 'path' && value !== undefined) process.env[key] = value;
const previousPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
process.env.PATH = [dirname(process.execPath), dirname(gitLocation), previousPath].join(delimiter);

if (process.argv[2] === '--check') {
  const { execFileSync } = await import('node:child_process');
  console.log(JSON.stringify({ node: process.version, git: execFileSync(gitLocation, ['--version'], { encoding: 'utf8' }).trim(), root }));
} else {
  const { ChimeraClient } = await import('./packages/client/src/client.js');
  const client = await ChimeraClient.connect({ exitWithParent: false });
  try {
    const status = await client.request('daemon.status', {});
    if (status.protocolVersion !== 1) throw new Error('Unsupported daemon protocol');
    // Direct desktop launches have no npm setup phase. Start the same pinned setup on
    // first open and expose installing/failed/ready through the existing Settings card.
    // --service-only is reserved for the offline relocated-runtime smoke below.
    if (!process.argv.includes('--service-only')) {
      const builtIns = await client.request('computerUse.builtins.status', {});
      const laya = builtIns.integrations.find(row => row.id === 'laya');
      if (laya?.state === 'not-installed') await client.request('computerUse.builtins.install', { id: 'laya' });
    }

    console.log('Chimera background service ready');
  } finally { client.close(); }
}
