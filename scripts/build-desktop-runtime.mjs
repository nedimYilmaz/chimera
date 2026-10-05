// Build-host tooling only. End users receive Node, npm, Git and compiled Chimera together.
import { readFile, writeFile, mkdir, readdir, rm, cp, rename, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { PLAYWRIGHT_MCP } from './integration-pins.mjs';
import { stageIntegrations } from './integration-stage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'packages/app/src-tauri/standalone/runtime');
const stage = await mkdtemp(join(tmpdir(), 'chimera-desktop-runtime-'));
const out = join(stage, 'runtime');
const nodeVersion = '24.16.0';
const platform = process.platform;
if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported desktop build host');
const nodePlatform = platform === 'win32' ? 'win' : platform;
const nodeName = `node-v${nodeVersion}-${nodePlatform}-${process.arch}`;
const archive = `${nodeName}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
const base = `https://nodejs.org/dist/v${nodeVersion}/`;
const run = (cmd, args, cwd = out) => execFileSync(cmd, args, { cwd, stdio: 'inherit', timeout: 300_000 });
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
const packages = ['protocol', 'core', 'daemon', 'client', 'mcp', 'ui-state'];
// @playwright/mcp is the chimera-browser built-in; its whole 3-package closure is integrity-checked
// against integration-pins.mjs in integration-stage.mjs (the rest of this tree resolves live, as before).
const imports = {}, dependencies = { dugite: '3.2.3', '@playwright/mcp': PLAYWRIGHT_MCP.version };
function rewriteImports(context) {
  const visit = node => {
    if (ts.isStringLiteral(node) && node.text.startsWith('@chimera/')) {
      const p = node.parent;
      if (((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node)
        || (ts.isCallExpression(p) && p.expression.kind === ts.SyntaxKind.ImportKeyword)) {
        return ts.factory.createStringLiteral(node.text.replace('@chimera/', '#chimera/'));
      }
    }
    return ts.visitEachChild(node, visit, context);
  };
  return source => ts.visitNode(source, visit);
}
async function compile(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { await compile(path); continue; }
    if (!entry.isFile() || !/\.tsx?$/.test(path) || /\.d\.ts$/.test(path)) throw new Error(`Unrecognized runtime asset: ${path}`);
    const result = ts.transpileModule(await readFile(path, 'utf8'), {
      fileName: path,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
      transformers: { before: [rewriteImports] }, reportDiagnostics: true,
    });
    if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(`Compilation failed: ${path}`);
    const output = join(out, relative(root, path).replace(/\.tsx?$/, '.js'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, result.outputText);
  }
}
try {
  await mkdir(out);
  for (const pkg of packages) {
    const path = join(root, 'packages', pkg, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const require = createRequire(path);
    for (const [key, value] of Object.entries(manifest.exports ?? { '.': `./${manifest.main}` })) {
      imports[`#chimera/${pkg}${key === '.' ? '' : key.slice(1)}`] = `./packages/${pkg}/${value.replace(/^\.\//, '').replace(/\.tsx?$/, '.js')}`;
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith('@chimera/')) continue;
      let version;
      for (const location of require.resolve.paths(name) ?? []) {
        try { version = JSON.parse(await readFile(join(location, name, 'package.json'), 'utf8')).version; break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!version || (dependencies[name] && dependencies[name] !== version)) throw new Error(`Missing or conflicting dependency: ${name}`);
      dependencies[name] = version;
    }
    await compile(join(root, 'packages', pkg, 'src'));
  }
  const bins = { chimera: ['client', 'cli'], chimerad: ['daemon', 'main'], 'chimera-mcp': ['mcp', 'server'] };
  for (const [name, [pkg, entry]] of Object.entries(bins)) {
    const bin = join(out, 'packages', pkg, 'bin', `${name}.js`);
    await mkdir(dirname(bin), { recursive: true });
    await writeFile(bin, `#!/usr/bin/env node\nawait import('../src/${entry}.js');\n`, { mode: 0o755 });
  }
  const overrides = {};
  const section = (await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')).split('\noverrides:\n')[1]?.split('\npatchedDependencies:')[0];
  if (!section) throw new Error('Missing workspace security overrides');
  for (const line of section.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^  '([^']+)': '([^']+)'$/);
    if (!match) throw new Error(`Unsupported override: ${line}`);
    overrides[match[1]] = match[2];
  }
  // The release dependency graph also contains dugite/npm-facing transitive dependencies.
  // Stay on the same major while closing advisories newer than the workspace override pins.
  delete overrides['fast-uri@>=3 <3.1.7'];
  delete overrides['ip-address@>=10 <10.7.0'];
  overrides['fast-uri@>=3 <3.1.8'] = '3.1.8';
  overrides['ip-address@>=10 <10.7.3'] = '10.7.3';
  const version = JSON.parse(await readFile(join(root, 'packages/app/src-tauri/tauri.conf.json'), 'utf8')).version;
  await writeFile(join(out, 'package.json'), JSON.stringify({ name: 'chimera-desktop-runtime', version, private: true, type: 'module', imports, dependencies, overrides }, null, 2));
  const checksumText = (await download(`${base}SHASUMS256.txt`)).toString();
  const expected = checksumText.split('\n').find(line => line.trim().endsWith(` ${archive}`))?.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Node archive missing from official checksum manifest');
  console.log(`Downloading verified Node ${nodeVersion} (${platform}-${process.arch})…`);
  const bytes = await download(`${base}${archive}`);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node archive checksum mismatch');
  await writeFile(join(stage, archive), bytes);
  run('tar', ['-xf', join(stage, archive), '-C', stage], stage);
  await rename(join(stage, nodeName), join(out, 'node'));
  await rm(join(out, 'node/include'), { recursive: true, force: true });
  const node = join(out, platform === 'win32' ? 'node/node.exe' : 'node/bin/node');
  const npm = join(out, platform === 'win32' ? 'node/node_modules/npm/bin/npm-cli.js' : 'node/lib/node_modules/npm/bin/npm-cli.js');
  run(node, [npm, 'install', '--ignore-scripts', '--omit=dev', '--no-fund', '--no-audit', '--registry=https://registry.npmjs.org']);
  run(node, [npm, 'audit', '--omit=dev', '--audit-level=high', '--registry=https://registry.npmjs.org']);
  // Only this checksum-verifying downloader runs; arbitrary dependency install hooks do not.
  run(node, [join(out, 'node_modules/dugite/script/download-git.js')]);
  await cp(join(root, 'scripts/desktop-bootstrap.mjs'), join(out, 'bootstrap.mjs'));
  await cp(join(root, 'LICENSE'), join(out, 'LICENSE'));
  run(node, [join(out, 'bootstrap.mjs'), '--check']);
  const { artifacts } = await stageIntegrations({
    out, stage, platform, arch: process.arch, repoRoot: root, download, run,
    nodeRel: platform === 'win32' ? 'node/node.exe' : 'node/bin/node',
  });
  await writeFile(join(out, 'runtime.json'), JSON.stringify({ version, platform, arch: process.arch, nodeVersion, nodeSha256: expected, git: 'dugite@3.2.3', integrations: artifacts }, null, 2));
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(out, target, { recursive: true, verbatimSymlinks: true });
  console.log(`Standalone runtime ready: ${target}`);
} finally { await rm(stage, { recursive: true, force: true }); }
