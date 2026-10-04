import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("../../../scripts/install-pnpm.sh", import.meta.url));
const installer = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));

// Only source the package-manager selector, never the installer: no downloads,
// dependency changes, builds, service stops, or global package-manager writes.
function select(stubs: string, dryRun = false) {
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `
    set -euo pipefail
    info() { printf '%s\\n' "$1"; }
    fail() { printf '%s\\n' "$1" >&2; exit 1; }
    ${stubs}
    source "$1"
    select_install_pnpm 11.11.0
    printf 'ARG:%s\\n' "\${PNPM_CMD[@]}"
    printf 'READY\\n'
  `, "test", helper], {
    encoding: "utf8",
    env: { PATH: "/nonexistent", DRY_RUN: dryRun ? "1" : "0" },
    timeout: 5_000,
  });
}

const oldPnpm = `pnpm() { printf '9.15.4\\n'; }`;
const pinnedNpx = `npx() {
  [ "$#" -eq 4 ] && [ "$1" = --yes ] &&
  [ "$2" = --registry=https://registry.npmjs.org ] &&
  [ "$3" = pnpm@11.11.0 ] && [ "$4" = --version ] || return 90
  printf '11.11.0\\n'
}`;

describe.skipIf(process.platform === "win32")("installer pnpm selection", () => {
  it("keeps an already pinned pnpm without invoking npx", () => {
    const r = select(`pnpm() { printf '11.11.0\\n'; }
      npx() { printf 'UNEXPECTED' >&2; return 99; }`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ARG:pnpm\nREADY");
    expect(r.stderr).toBe("");
  });

  it.each([
    ["older pnpm", oldPnpm],
    ["missing pnpm", ""],
    ["broken pnpm", "pnpm() { return 1; }"],
  ])("selects exact, invocation-local pnpm for %s", (_name, stub) => {
    const r = select(`${stub}\n${pinnedNpx}`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("global pnpm is unchanged");
    expect(r.stdout).toContain(
      "ARG:npx\nARG:--yes\nARG:--registry=https://registry.npmjs.org\nARG:pnpm@11.11.0\nREADY",
    );
  });

  it("refuses when neither the pin nor npx is available", () => {
    const r = select(oldPnpm);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm/npx is unavailable");
    expect(r.stdout).not.toContain("READY");
  });

  it("refuses when npx cannot load the pin", () => {
    const r = select(`${oldPnpm}\nnpx() { return 1; }`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Could not load pnpm 11.11.0");
    expect(r.stdout).not.toContain("READY");
  });

  it("refuses a mismatched resolved version", () => {
    const r = select(`${oldPnpm}\nnpx() { printf '9.15.4\\n'; }`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unverified package-manager version");
    expect(r.stdout).not.toContain("READY");
  });

  it("does not invoke npx or download anything in dry-run", () => {
    const r = select(`${oldPnpm}\nnpx() { printf 'UNEXPECTED' >&2; return 99; }`, true);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no download in dry-run");
    expect(r.stdout).toContain("ARG:pnpm@11.11.0");
    expect(r.stderr).toBe("");
  });
});

describe("installer package-manager wiring", () => {
  const source = readFileSync(installer, "utf8");

  it("uses the selected command for install, checks, and build", () => {
    expect(source).toContain('source "$REPO_ROOT/scripts/install-pnpm.sh"');
    expect(source).toContain('select_install_pnpm "$PNPM_VERSION"');
    expect(source).toContain('"${PNPM_CMD[@]}" install --frozen-lockfile');
    expect(source).toContain('"${PNPM_CMD[@]}" run typecheck');
    expect(source).toContain('"${PNPM_CMD[@]}" tauri build');
    expect(source).not.toContain("corepack enable");
    expect(source).not.toContain("get.pnpm.io/install.sh");
  });

  it("checks installed dependencies before deciding whether an upgrade can install while running", () => {
    const comparison = source.indexOf('cmp -s "$REPO_ROOT/pnpm-lock.yaml" "$REPO_ROOT/node_modules/.pnpm/lock.yaml"');
    expect(comparison).toBeGreaterThan(0);
    const install = source.indexOf('"${PNPM_CMD[@]}" install --frozen-lockfile');
    expect(comparison).toBeLessThan(install);
    expect(source.slice(comparison, install)).toContain("stop_running_services");
  });
});

describe("installer dependency build policy", () => {
  const workspace = readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8");
  const policy = workspace.match(/^allowBuilds:\n((?:[ \t].*\n|\n)*)/m)?.[1] ?? "";

  it("explicitly decides the reviewed scripts so strict pnpm installs do not prompt", () => {
    expect(policy).toMatch(/^  esbuild: true$/m);
    expect(policy).toMatch(/^  onnxruntime-node: false$/m);
    expect(policy).toMatch(/^  protobufjs: false$/m);
    expect(policy).not.toContain("set this to true or false");
  });

  it("does not bypass review for unknown dependency scripts", () => {
    expect(workspace).not.toMatch(/^strictDepBuilds:\s*false/m);
    expect(workspace).not.toMatch(/^dangerouslyAllowAllBuilds:\s*true/m);
    const decisions = policy.split("\n").filter((line) => /^  [^#\s]/.test(line));
    expect(decisions).toEqual([
      "  esbuild: true",
      "  onnxruntime-node: false",
      "  protobufjs: false",
    ]);
  });
});
