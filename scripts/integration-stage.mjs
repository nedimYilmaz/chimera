// Build-host tooling only: stages the built-in computer-use integrations into the standalone
// runtime and writes `integrations/manifest.json`. The manifest is consumed at daemon start by
// packages/core/src/builtin-integrations.ts, which re-validates every path as RELATIVE -- nothing
// here may record a build-host or install-location path.
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, posix } from 'node:path';
import { CHROME_HEADLESS_SHELL, CUA_DRIVER, LAYA, PLAYWRIGHT_MCP, PYTHON } from './integration-pins.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const LOCK_LINE = /^[A-Za-z0-9][A-Za-z0-9._-]*==[A-Za-z0-9][A-Za-z0-9.!+_-]* --hash=sha256:[a-f0-9]{64}$/;

// Every distribution pip would install for `laya[mcp]`, except laya itself (installed from the
// bundled wheel), as `name==version --hash=sha256:<digest of the exact archive pip resolved>`. With
// `--require-hashes` the first-use installer can then only ever install these bytes.
export function lockFromPipReport(report) {
  if (!report || !Array.isArray(report.install)) throw new Error('pip report has no install list');
  const lines = new Map();
  for (const item of report.install) {
    const { name, version } = item.metadata ?? {};
    if (item.requested === true && String(name).toLowerCase() === 'laya') continue;
    const digest = item.download_info?.archive_info?.hashes?.sha256;
    if (!name || !version || !/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error(`pip report entry without a sha256: ${name ?? '?'}`);
    const key = String(name).toLowerCase().replace(/[-_.]+/g, '-');
    if (lines.has(key)) throw new Error(`pip report lists ${name} twice`);
    lines.set(key, `${name}==${version} --hash=sha256:${digest}`);
  }
  if (lines.size === 0) throw new Error('pip report resolved no dependencies');
  return [...lines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, line]) => line).join('\n') + '\n';
}

export function validateLock(text) {
  const lines = text.split('\n').filter(line => line.trim() && !line.startsWith('#'));
  const bad = lines.find(line => !LOCK_LINE.test(line));
  if (bad !== undefined) throw new Error(`Malformed dependency lock line: ${bad}`);
  if (lines.some(line => /^laya==/i.test(line))) throw new Error('The dependency lock must not contain laya itself');
  if (lines.length === 0) throw new Error('The dependency lock is empty');
  return lines.length;
}

const unsupported = reason => ({ state: 'unsupported-platform', reason });

export function pythonRel(platform) { return platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'; }

// Pure: turns what was actually staged into the manifest, so the "unsupported" decisions are
// testable without a network or a build host of that platform.
export function buildManifest({ platform, arch, nodeRel, desktop, browser, laya }) {
  const key = `${platform}-${arch}`;
  return {
    schemaVersion: 1, platform, arch,
    integrations: {
      'chimera-desktop': desktop ?? unsupported(
        platform === 'darwin'
          ? `No pinned desktop driver build for ${key}.`
          : 'Chimera hosts desktop control only in its macOS app in this release; the Linux and Windows hosts are not shipped.'),
      'chimera-browser': browser
        ? {
          state: 'bundled', version: PLAYWRIGHT_MCP.version, node: nodeRel, cli: 'node_modules/@playwright/mcp/cli.js',
          executable: browser.executable, browserVersion: CHROME_HEADLESS_SHELL.version, browserSha256: browser.sha256,
          browserSource: CHROME_HEADLESS_SHELL.source, license: PLAYWRIGHT_MCP.license,
        }
        : unsupported(`Google publishes no Chrome for Testing headless shell for ${key}, so Chimera ships no browser for it.`),
      laya: laya
        ? { state: 'managed-download', version: LAYA.version, python: pythonRel(platform), wheel: laya.wheel, wheelSha256: laya.wheelSha256, lock: laya.lock, lockSha256: laya.lockSha256, source: LAYA.source, checkpoint: LAYA.checkpoint }
        : unsupported(`No pinned Python runtime for ${key}.`),
    },
  };
}

async function verified(download, url, expected, what) {
  const bytes = await download(url);
  if (sha256(bytes) !== expected) throw new Error(`${what} checksum mismatch (expected the pinned ${expected})`);
  return bytes;
}

async function must(path, what) {
  try { if ((await stat(path)).isFile()) return; } catch { /* reported below */ }
  throw new Error(`Staged integration is missing ${what}: ${path}`);
}

function extract(run, archive, dest, platform) {
  // bsdtar (macOS, Windows) reads zip; GNU tar does not, so non-Windows hosts use unzip.
  if (archive.endsWith('.zip') && platform !== 'win32') run('unzip', ['-q', archive, '-d', dest], dest);
  else run('tar', ['-xf', archive, '-C', dest], dest);
}

// pip must not read the builder's index/proxy config or HOME while pinning, and must not write
// bytecode into the runtime (a signed .app's seal covers every file in it).
function scrubbedEnv(home, platform) {
  const env = {
    HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home, PIP_CACHE_DIR: join(home, 'cache'),
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    PATH: platform === 'win32' ? (process.env.PATH ?? '') : '/usr/bin:/bin',
  };
  if (platform === 'win32') env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return env;
}

async function resolveLock({ python, wheel, stage, platform, log }) {
  const home = await mkdtemp(join(stage, 'pip-home-'));
  const report = join(home, 'report.json');
  log('Resolving the Laya dependency closure on this build host (CHIMERA_RESOLVE_LAYA_LOCK=1)…');
  execFileSync(python, [
    '-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple',
    '--report', report, '--target', join(home, 'site'), `${wheel}[${LAYA.extra}]`,
  ], { env: scrubbedEnv(home, platform), stdio: 'inherit', timeout: 900_000 });
  return lockFromPipReport(JSON.parse(await readFile(report, 'utf8')));
}

// The reviewed lock for this platform lives in the repo. Fail CLOSED when it is absent: a lock
// resolved live would put whatever the index serves today into a release without review, so that
// only happens on an explicit opt-in, which writes the result into the repo for review.
export async function obtainLock({ repoRoot, key, resolve, log = console.log, env = process.env }) {
  const name = `laya-${LAYA.version}-${key}.lock`;
  const committed = join(repoRoot, 'scripts', 'integration-locks', name);
  try { const text = await readFile(committed, 'utf8'); log(`Using committed Laya lock ${name}.`); return text; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (env.CHIMERA_RESOLVE_LAYA_LOCK !== '1') {
    throw new Error(`No committed Laya dependency lock for ${key} (${name}). Run once with CHIMERA_RESOLVE_LAYA_LOCK=1 to resolve it on this host, review the written file and commit it.`);
  }
  const lock = await resolve();
  validateLock(lock);
  await mkdir(dirname(committed), { recursive: true });
  await writeFile(committed, `# Hash lock for laya ${LAYA.version}[${LAYA.extra}] on CPython ${PYTHON.version} / ${key}. RESOLVED LIVE: review before committing.\n${lock}`);
  log(`WROTE scripts/integration-locks/${name} -- review and commit it; release builds refuse to run without it.`);
  return lock;
}

// Returns { manifest, notice, artifacts } and leaves the staged files under `out`.
export async function stageIntegrations({ out, stage, platform, arch, nodeRel, download, run, repoRoot, log = console.log }) {
  const key = `${platform}-${arch}`;
  const integrations = join(out, 'integrations');
  await mkdir(integrations, { recursive: true });
  const artifacts = {};
  let desktop, browser, laya;

  // ----- chimera-desktop: the verified cua-driver, only the files `serve`/`mcp` use -----
  const cua = CUA_DRIVER.assets[platform];
  if (cua) {
    log(`Staging cua-driver ${CUA_DRIVER.version}…`);
    const archive = join(stage, cua.file);
    await writeFile(archive, await verified(download, `${CUA_DRIVER.base}${cua.file}`, cua.sha256, 'cua-driver archive'));
    const dest = join(stage, 'cua');
    await mkdir(dest);
    extract(run, archive, dest, platform);
    const dir = join(integrations, 'cua-driver');
    await mkdir(dir);
    for (const name of CUA_DRIVER.keep) {
      await must(join(dest, cua.dir, name), `cua-driver file ${name}`);
      await copyFile(join(dest, cua.dir, name), join(dir, name));
    }
    // Explicit so an archive extracted under a restrictive umask cannot ship a non-executable driver.
    for (const name of ['cua-driver', 'cua-cursor-theme']) await chmod(join(dir, name), 0o755);
    desktop = { state: 'bundled', version: CUA_DRIVER.version, driver: 'integrations/cua-driver/cua-driver', license: CUA_DRIVER.license, source: CUA_DRIVER.source };
    artifacts['chimera-desktop'] = { version: CUA_DRIVER.version, archive: cua.file, archiveSha256: cua.sha256 };
  }

  // ----- python runtime (carries pip for the first-use Laya install) -----
  const py = PYTHON.assets[key];
  if (py) {
    log(`Staging CPython ${PYTHON.version} (${key})…`);
    const archive = join(stage, py.file);
    await writeFile(archive, await verified(download, py.url, py.sha256, 'Python archive'));
    const dest = join(stage, 'py');
    await mkdir(dest);
    extract(run, archive, dest, platform);
    await rename(join(dest, 'python'), join(out, 'python'));
    const python = join(out, ...pythonRel(platform).split('/'));
    await must(python, 'the python executable');
    const probe = await mkdtemp(join(stage, 'py-probe-'));
    execFileSync(python, ['-c', 'import pip, ssl, sqlite3, venv'], { env: scrubbedEnv(probe, platform), stdio: 'inherit', timeout: 60_000 });

    // ----- laya: the hash-checked wheel + a hash lock; torch & the pinned model download at install time -----
    const wheelDir = join(integrations, 'laya');
    await mkdir(wheelDir);
    const wheelBytes = await verified(download, LAYA.wheel.url, LAYA.wheel.sha256, 'Laya wheel');
    const wheelPath = join(wheelDir, LAYA.wheel.file);
    await writeFile(wheelPath, wheelBytes);
    const lock = await obtainLock({ repoRoot, key, resolve: () => resolveLock({ python, wheel: wheelPath, stage, platform, log }), log });
    const locked = validateLock(lock);
    log(`Laya lock: ${locked} hash-pinned distributions.`);
    await writeFile(join(wheelDir, 'requirements.lock'), lock);
    laya = {
      wheel: `integrations/laya/${LAYA.wheel.file}`, wheelSha256: LAYA.wheel.sha256,
      lock: 'integrations/laya/requirements.lock', lockSha256: sha256(Buffer.from(lock)),
    };
    artifacts.python = { version: PYTHON.version, archive: py.file, archiveSha256: py.sha256 };
    artifacts.laya = { version: LAYA.version, wheelSha256: LAYA.wheel.sha256, lockSha256: laya.lockSha256, lockedDistributions: locked, checkpoint: LAYA.checkpoint };
  }

  // ----- chimera-browser: pinned headless shell + the @playwright/mcp that npm installed -----
  const chrome = CHROME_HEADLESS_SHELL.assets[key];
  if (chrome) {
    log(`Staging Chrome headless shell ${CHROME_HEADLESS_SHELL.version} (${key})…`);
    const archive = join(stage, `${chrome.dir}.zip`);
    await writeFile(archive, await verified(download, chrome.url, chrome.sha256, 'Chrome headless shell archive'));
    const dest = join(stage, 'cft');
    await mkdir(dest);
    extract(run, archive, dest, platform);
    const browserDir = join(integrations, 'browser');
    await mkdir(browserDir);
    await rename(join(dest, chrome.dir), join(browserDir, chrome.dir));
    const executable = `integrations/browser/${chrome.dir}/chrome-headless-shell${platform === 'win32' ? '.exe' : ''}`;
    await must(join(out, ...executable.split('/')), 'the Chrome headless shell executable');
    const tree = JSON.parse(await readFile(join(out, 'node_modules', '.package-lock.json'), 'utf8')).packages ?? {};
    for (const [path, pin] of Object.entries(PLAYWRIGHT_MCP.closure)) {
      if (tree[path]?.version !== pin.version || tree[path]?.integrity !== pin.integrity) {
        throw new Error(`${path} resolved to ${tree[path]?.version} (${tree[path]?.integrity}), not the pinned ${pin.version}`);
      }
    }
    const extra = Object.keys(tree['node_modules/@playwright/mcp'].dependencies ?? {}).filter(name => !PLAYWRIGHT_MCP.closure[`node_modules/${name}`]);
    if (extra.length > 0) throw new Error(`@playwright/mcp gained unpinned dependencies: ${extra.join(', ')}`);
    await must(join(out, 'node_modules', '@playwright', 'mcp', 'cli.js'), '@playwright/mcp/cli.js');
    browser = { executable, sha256: chrome.sha256 };
    artifacts['chimera-browser'] = { version: PLAYWRIGHT_MCP.version, browserVersion: CHROME_HEADLESS_SHELL.version, browserArchiveSha256: chrome.sha256, npmIntegrity: Object.fromEntries(Object.entries(PLAYWRIGHT_MCP.closure).map(([path, pin]) => [path.replace('node_modules/', ''), pin.integrity])) };
  }

  const manifest = buildManifest({ platform, arch, nodeRel, desktop, browser, laya });
  await writeFile(join(integrations, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const rows = [
    ['chimera-desktop', 'cua-driver', desktop ? CUA_DRIVER.version : null, CUA_DRIVER.license, CUA_DRIVER.source],
    ['chimera-browser', '@playwright/mcp + Chrome headless shell', browser ? `${PLAYWRIGHT_MCP.version} + ${CHROME_HEADLESS_SHELL.version}` : null, `${PLAYWRIGHT_MCP.license}; ${CHROME_HEADLESS_SHELL.license}`, CHROME_HEADLESS_SHELL.source],
    ['laya', 'laya + CPython', laya ? `${LAYA.version} + ${PYTHON.version}` : null, `${LAYA.license}; ${PYTHON.license}`, LAYA.source],
  ];
  await writeFile(join(integrations, 'NOTICE.md'), [
    '# Built-in integrations', '',
    'Chimera ships these third-party components unmodified, pinned by checksum (see manifest.json):', '',
    ...rows.map(([id, what, version, license, source]) => `- **${id}** — ${what} ${version ?? '(not shipped on this platform)'} — ${license} — ${source}`), '',
    'Laya\'s PyTorch dependencies and model weights are NOT included; Chimera downloads them when Laya is installed and verifies the model against the pinned revision and checksum in manifest.json.', '',
  ].join('\n'));
  const names = await readdir(integrations);
  log(`Integrations staged for ${key}: ${names.join(', ')}`);
  return { manifest, artifacts };
}
