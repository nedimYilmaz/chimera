// Pinned upstream artifacts for the built-in computer-use integrations. Build-host tooling only.
//
// Every download is verified against a sha256 recorded HERE, never against a value fetched in the
// same request as the artifact. Provenance of each pin (all read from primary sources, 2026-10-05):
//   cua-driver  trycua/cua release `cua-driver-rs-v0.33.3` (MIT). Its SHA256SUMS asset and the
//               GitHub asset digest agree; the darwin binary is Developer-ID signed
//               ("Cua AI, Inc. (YCK386LBJ7)", hardened runtime).
//   python      astral-sh/python-build-standalone release 20261003 (PSF-2.0 + bundled licences);
//               hashes from that release's SHA256SUMS.
//   laya        PyPI laya 0.4.1 (Apache-2.0); wheel digest verified 2026-10-09 from the PyPI JSON API.
//   chrome      Chrome for Testing headless shell. Google publishes NO checksum for these, so the
//               pins are our own trust-on-first-use hashes (the build fails on any later change);
//               they are not an upstream attestation.
//   playwright  npm @playwright/mcp (Apache-2.0); `integrity` is the registry's sha512.

export const CUA_DRIVER = {
  version: '0.33.3',
  license: 'MIT',
  source: 'https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.3',
  base: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.33.3/',
  // macOS only: Chimera's native desktop host (packages/app/src-tauri/src/computer_use.rs) implements
  // the permission checks and live preview only on macOS and has never been run against the
  // Linux/Windows driver builds, so shipping them would claim a capability nobody verified. Their
  // upstream hashes are in the shared memory notes for when that is done.
  assets: {
    darwin: {
      file: 'cua-driver-rs-0.33.3-darwin-universal.tar.gz',
      sha256: 'e4d5a6c2f8b1dff776bc7260717b723d753c3deeb020469a6eb85eacf862bfca',
      dir: 'cua-driver-rs-0.33.3-darwin-universal',
    },
  },
  // The tarball also carries CuaDriver.app (a second signed identity that would compete with the
  // Chimera app for TCC), an SDK dylib and a node addon -- none are used by `cua-driver serve/mcp`.
  keep: ['cua-driver', 'cua-cursor-theme', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
};

const PBS = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/';
const pbs = (triple, sha256) => ({
  file: `cpython-3.12.15+20261003-${triple}-install_only_stripped.tar.gz`,
  url: `${PBS}cpython-3.12.15%2B20261003-${triple}-install_only_stripped.tar.gz`,
  sha256,
});
export const PYTHON = {
  version: '3.12.15',
  license: 'PSF-2.0',
  source: 'https://github.com/astral-sh/python-build-standalone/releases/tag/20261003',
  assets: {
    'darwin-arm64': pbs('aarch64-apple-darwin', 'ad8d0c637c0a36b967b310e2c07254f4d2ca8cabaa7699e55ed6290aceb481a2'),
    'darwin-x64': pbs('x86_64-apple-darwin', '562c30864ece2cb1d3e0ad66a1acd498611a47e5a10ce81b99158bef1ccbd355'),
    'linux-arm64': pbs('aarch64-unknown-linux-gnu', '6541297dd1798dec8b98c3ad7492808a5b9d1c126801ceb2011e7754cd20d1ce'),
    'linux-x64': pbs('x86_64-unknown-linux-gnu', '731af898886c5f821890dc901eca3c651cca8e51fa7308c159d12a1194aeac91'),
    'win32-arm64': pbs('aarch64-pc-windows-msvc', 'b39c6c3aac8a88ae42fd4f2ca5a832d1e78b55506f33f0498de4dd6fc38b5162'),
    'win32-x64': pbs('x86_64-pc-windows-msvc', '6fba7f2ae506facf41d457ea8293c7497910a675c69a4e954875169410a50402'),
  },
};

export const LAYA = {
  // Only native dependency closures reviewed and committed for this release.
  targets: ['darwin-arm64'],
  version: '0.4.1',
  license: 'Apache-2.0',
  source: 'https://pypi.org/project/laya/0.4.1/',
  wheel: {
    file: 'laya-0.4.1-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/b8/f6/9e3f039d08319e153721210667548e2cac1679b56461c8b5e81acc93b4db/laya-0.4.1-py3-none-any.whl',
    sha256: '5252730d8be604aecdc6c52adeb591e75d2b97ef3f52278cba9b37e403c784c7',
  },
  // The extra whose dependency closure the lock is resolved for (`laya[mcp]` = the MCP server).
  extra: 'mcp',
  // The wheel carries no weights: the model is downloaded from the Hub, so the PyPI version alone does
  // not identify what answers a decision. This is the reviewed English checkpoint the 0.3.22 -> 0.3.27
  // evaluation ran against (scripts/eval-laya.ts); laya.revisions.PINNED_REVISIONS in BOTH releases
  // names this same revision. The 0.3.28 evaluation also reproduced every decision on it; its
  // PINNED_REVISIONS is unchanged; the 0.4.1 evaluation reproduced every decision and probability.
  // Both this Hub revision and current main still name the same
  // weight digest (verified 2026-10-09). Recomputed from the cached snapshot: the sha256 equals the
  // git-LFS blob name, so it is the Hub's own digest, not a first-use hash.
  // Enforced: buildManifest copies it into manifest.json (strict schema), laya-install.ts downloads and
  // hashes exactly this revision, and the registered entry carries it as LAYA_REVISION +
  // LAYA_SHA256_DIGESTS with HF_HUB_OFFLINE=1. The multilingual / typed-decisions checkpoints Laya may
  // route to are NOT covered by this pin: they were never evaluated, so offline mode refuses them.
  checkpoint: {
    repo: 'convaiinnovations/laya',
    revision: '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851',
    files: { 'model.safetensors': '891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c' },
  },
};

// The ENTIRE browser dependency closure is pinned: @playwright/mcp depends on exactly these two other
// packages (both exact-version) and nothing else, so no part of chimera-browser's JavaScript floats
// with the registry at build time. integration-stage.mjs fails if any integrity differs.
export const PLAYWRIGHT_MCP = {
  version: '0.0.83',
  license: 'Apache-2.0',
  integrity: 'sha512-oNcl+Ae2/IAjhfPeP46BfIkSakfmprY+aOtkv5MjrQ4lPav4/yNtPhL0iq8SlIM90oApWgBDUxaNKvktazUKOg==',
  closure: {
    'node_modules/@playwright/mcp': { version: '0.0.83', integrity: 'sha512-oNcl+Ae2/IAjhfPeP46BfIkSakfmprY+aOtkv5MjrQ4lPav4/yNtPhL0iq8SlIM90oApWgBDUxaNKvktazUKOg==' },
    'node_modules/playwright': { version: '1.64.0-alpha-1790635538000', integrity: 'sha512-/5XDUMxpOd/9AojJtWDFIRV3EJZNQ0AwvK69wgt3CPzy8wTgiBG9pX45VfxtqtvIRGwfWzMhrvawNKreG69Snw==' },
    'node_modules/playwright-core': { version: '1.64.0-alpha-1790635538000', integrity: 'sha512-pNwaXirhXMRLaRQs4NQ18EpTdtDoFwyPH9FOaaDC7YXG4hpwE2xmwCic/1srbuExVQC7zT9LJSJpDBAru+Vo9A==' },
  },
};

const CFT = 'https://cdn.playwright.dev/builds/cft/155.0.8059.12/';
export const CHROME_HEADLESS_SHELL = {
  version: '155.0.8059.12',
  license: 'BSD-3-Clause (Chromium; third-party notices ship in the archive)',
  source: 'https://googlechromelabs.github.io/chrome-for-testing/ (build 155.0.8059.12, served from the Playwright CDN)',
  // No Chrome for Testing build exists for linux-arm64 / win32-arm64, so chimera-browser is
  // reported unsupported there instead of falling back to a system browser nobody pinned.
  assets: {
    'darwin-arm64': { dir: 'chrome-headless-shell-mac-arm64', url: `${CFT}mac-arm64/chrome-headless-shell-mac-arm64.zip`, sha256: 'fb75cf159f4bd5d880e0ea95600858f6404d57c9048aae71c12da7ee59a26836' },
    'darwin-x64': { dir: 'chrome-headless-shell-mac-x64', url: `${CFT}mac-x64/chrome-headless-shell-mac-x64.zip`, sha256: '2c59f4abfdce4da9095e39ecad29e2daf5130c9c4ceef3d8470a5fbc10ab6bfe' },
    'linux-x64': { dir: 'chrome-headless-shell-linux64', url: `${CFT}linux64/chrome-headless-shell-linux64.zip`, sha256: 'aeb9283943ef1f21864ea42ad1201b89f5bcf6a84c3e3d0d641529d251914bed' },
    'win32-x64': { dir: 'chrome-headless-shell-win64', url: `${CFT}win64/chrome-headless-shell-win64.zip`, sha256: '83f96980156d3fe15810143f13f4ce32dce44548e0f41857dc57ce57fff5018b' },
  },
};
