// Materialize only the runtime from the already verified, version-matched desktop artifact.
// Keeping it inside the permanent npm installation gives its login daemon the same built-ins.
import { cp, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function prepareInstalledIntegrations({ source, permanent, plan, run }) {
  const runtime = JSON.parse(await readFile(join(source, 'runtime.json'), 'utf8'));
  if (runtime.version !== plan.version || runtime.platform !== plan.platform || runtime.arch !== plan.arch) throw new Error('Desktop integration runtime version/platform mismatch');
  const manifest = JSON.parse(await readFile(join(source, 'integrations/manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== plan.platform || manifest.arch !== plan.arch) throw new Error('Invalid desktop integration manifest');
  const relativeNode = plan.platform === 'win32' ? 'node/node.exe' : 'node/bin/node';
  for (const file of [relativeNode, 'prepare-integrations.mjs']) if (!(await lstat(join(source, file))).isFile()) throw new Error(`Missing regular runtime file: ${file}`);
  const root = join(permanent, 'desktop-runtime');
  try { await lstat(root); throw new Error('Refusing to replace an existing prepared runtime'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await cp(source, root, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  // This command installs only the pinned Python/model assets; it never starts a daemon or app.
  await run(join(root, relativeNode), [join(root, 'prepare-integrations.mjs'), plan.state, plan.version], { timeout: 45 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  return root;
}
