// Run only by explicit installation, before activating the new daemon. No provider or desktop calls.
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function prepareIntegrations({ root, home, version, host = process, load, log = console.log }) {
  if (!home || resolve(home) !== home || dirname(home) === home) throw new Error('An absolute user state directory is required');
  const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  if (runtime.version !== version || runtime.platform !== host.platform || runtime.arch !== host.arch) throw new Error('Desktop runtime does not match the installed package');
  const module = load ?? (name => import(pathToFileURL(join(root, `packages/core/src/${name}.js`)).href));
  const { loadBuiltInContext, resolveBuiltIns } = await module('builtin-integrations');
  const ctx = loadBuiltInContext(root, host);
  const statuses = () => resolveBuiltIns(ctx, home);
  for (const [id, value] of Object.entries(statuses())) {
    if (value.status.state === 'unavailable') throw new Error(`${id}: ${value.status.reason}`);
    if (value.status.state === 'unsupported-platform') log(`${id}: ${value.status.reason}`);
  }
  if (ctx.manifest.integrations.laya.state === 'managed-download') {
    if (statuses().laya.status.state !== 'ready') {
      log('Installing pinned Laya dependencies and model. Installation is not complete until verification passes…');
      const { McpStoreRegistry } = await module('mcpstore');
      const { installLaya, layaInstallIdle } = await module('laya-install');
      const options = { ctx, home, store: new McpStoreRegistry(home) };
      // Without onReconciled the helper does not change the live MCP registry; daemon startup
      // registers the prepared files after the installation transaction activates this runtime.
      installLaya(options);
      await layaInstallIdle(options);
      const status = statuses().laya.status;
      if (status.state !== 'ready') throw new Error(`Laya setup failed: ${status.reason ?? status.state}`);
    }
    log('Laya model verified and ready for offline use.');
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  const root = dirname(fileURLToPath(import.meta.url));
  const [home, version] = process.argv.slice(2);
  await prepareIntegrations({ root, home, version });
}
