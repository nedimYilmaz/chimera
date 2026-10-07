// Preserve module locations: daemon autostart and provider MCP launchers resolve sibling bins.
// Only workspace imports change; vendor SDKs keep their own npm/native binary resolution.
import { readFile, writeFile, mkdir, readdir, rm, copyFile, chmod } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/npm');
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--name', '--version', '--windows-publisher-thumbprint'].includes(args[i]) || args[i + 1] === undefined) throw new Error('Usage: build-npm.mjs [--name @scope/chimera] [--version 0.1.0] [--windows-publisher-thumbprint SHA1]');
  options[args[i].slice(2)] = args[i + 1];
}
const name = options.name ?? '@nedimyilmaz/chimera';
const version = options.version ?? '0.1.0';
const windowsPublisherThumbprint = options['windows-publisher-thumbprint'] || null;
if (windowsPublisherThumbprint && !/^[a-f0-9]{40}$/i.test(windowsPublisherThumbprint)) throw new Error('Invalid Windows publisher certificate thumbprint');
if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('Invalid npm package name');
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(version)) throw new Error('Invalid release version');
const packages = ['protocol', 'core', 'daemon', 'client', 'mcp', 'ui-state'];
const imports = {};
const dependencies = {};

// npm overrides in a dependency are ignored. Exact direct versions are taken from the
// installed lockfile tree; release preparation must also produce npm-shrinkwrap.json.
async function installedVersion(pkg, specifier) {
  const req = createRequire(join(root, 'packages', pkg, 'package.json'));
  for (const current of req.resolve.paths(specifier) ?? []) {
    try {
      const manifest = JSON.parse(await readFile(join(current, specifier, 'package.json'), 'utf8'));
      if (manifest.name === specifier) return manifest.version;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Cannot locate installed version of ${specifier}`);
}

function workspaceImports(context) {
  const visit = node => {
    if (ts.isStringLiteral(node) && node.text.startsWith('@chimera/')) {
      const parent = node.parent;
      if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
        || ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return ts.factory.createStringLiteral(node.text.replace('@chimera/', '#chimera/'));
      }
    }
    return ts.visitEachChild(node, visit, context);
  };
  return source => ts.visitNode(source, visit);
}

async function compileTree(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { await compileTree(path); continue; }
    if (!entry.isFile() || !/\.tsx?$/.test(path) || /\.d\.ts$/.test(path)) throw new Error(`Unexpected runtime asset: ${path}`);
    const compiled = ts.transpileModule(await readFile(path, 'utf8'), {
      fileName: path,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
      transformers: { before: [workspaceImports] },
      reportDiagnostics: true,
    });
    const errors = compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
    }));
    const target = join(out, relative(root, path).replace(/\.tsx?$/, '.js'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, compiled.outputText);
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const pkg of packages) {
  const manifest = JSON.parse(await readFile(join(root, 'packages', pkg, 'package.json'), 'utf8'));
  for (const [key, target] of Object.entries(manifest.exports ?? { '.': `./${manifest.main}` })) {
    imports[`#chimera/${pkg}${key === '.' ? '' : key.slice(1)}`] = `./packages/${pkg}/${target.replace(/^\.\//, '').replace(/\.tsx?$/, '.js')}`;
  }
  for (const specifier of Object.keys(manifest.dependencies ?? {})) {
    if (specifier.startsWith('@chimera/')) continue;
    const exact = await installedVersion(pkg, specifier);
    if (dependencies[specifier] && dependencies[specifier] !== exact) throw new Error(`Conflicting installed versions of ${specifier}`);
    dependencies[specifier] = exact;
  }
  await compileTree(join(root, 'packages', pkg, 'src'));
}

const bins = { chimera: ['client', 'cli'], chimerad: ['daemon', 'main'], 'chimera-mcp': ['mcp', 'server'] };
const bin = {};
for (const [command, [pkg, entry]] of Object.entries(bins)) {
  const path = `packages/${pkg}/bin/${command}.js`;
  bin[command] = path;
  await mkdir(dirname(join(out, path)), { recursive: true });
  const help = command === 'chimera' ? `
const arg = process.argv[2];
if (arg === '--version' || arg === '-v') { console.log(${JSON.stringify(version)}); process.exit(0); }
if (arg === 'install') {
  try { await (await import('../../../scripts/npm-install.mjs')).install(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else
if (!arg || arg === '--help' || arg === '-h') {
  console.log('Usage: chimera <install|doctor|start|stop|restart|status|spawn> [flags]\\nchimera install [--dry-run] [--no-open]: install CLI + desktop for macOS, Linux or Windows\\nAlso installed: chimerad, chimera-mcp');
  process.exit(0);
}
` : '';
  await writeFile(join(out, path), `#!/usr/bin/env node\n${help}\n${command === 'chimera' ? "if (arg !== 'install') " : ''}await import('../src/${entry}.js');\n`);
  await chmod(join(out, path), 0o755);
}

// Carry the source workspace's security overrides into npm's release lock generation.
const workspace = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
const section = workspace.split('\noverrides:\n')[1]?.split('\npatchedDependencies:')[0];
if (!section) throw new Error('Cannot read workspace security overrides');
const overrides = {};
for (const line of section.split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  const match = line.match(/^  '([^']+)': '([^']+)'$/);
  if (!match) throw new Error(`Unsupported override syntax: ${line}`);
  overrides[match[1]] = match[2];
}
await writeFile(join(out, 'package.json'), JSON.stringify({
  name, version, description: 'Chimera multi-agent daemon, CLI and MCP server',
  license: 'MIT', type: 'module', engines: { node: '>=24' },
  repository: { type: 'git', url: 'git+https://github.com/nedimYilmaz/chimera.git' },
  homepage: 'https://github.com/nedimYilmaz/chimera#readme',
  publishConfig: { access: 'public' },
  files: ['packages', 'scripts/npm-install*.mjs', 'README.md', 'LICENSE', 'npm-shrinkwrap.json'],
  chimeraRelease: { windowsPublisherThumbprint },
  bin, imports, dependencies, overrides,
}, null, 2) + '\n');
await copyFile(join(root, 'LICENSE'), join(out, 'LICENSE'));
// npm does not ship site/; use the public site's assets instead of broken relative images.
const readme = await readFile(join(root, 'README.md'), 'utf8');
await writeFile(join(out, 'README.md'), readme
  .replace(/(\]\(|src=")site\/assets\//g, '$1https://nedimyilmaz.github.io/chimera/assets/'));
await mkdir(join(out, 'scripts'), { recursive: true });
for (const file of ['npm-install.mjs', 'npm-install-portable.mjs', 'npm-install-platforms.mjs']) {
  await copyFile(join(root, 'scripts', file), join(out, 'scripts', file));
}
console.log(`Built ${name}@${version} in ${out}`);
