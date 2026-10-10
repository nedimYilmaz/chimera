import * as sudoModule from "@chimera/core/job-sudo";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { planJobSudo, sudoJobInvocation } from "@chimera/core/job-sudo";
import { runShellCommand } from "@chimera/core/jobs";
import { JobTargetSchema } from "@chimera/protocol";

const host = { platform: "darwin", uid: 501, home: "/Users/operator" };
const target = { command: "printf '%s\\n' ok", timeoutMs: 30_000, restartBackoffMs: 5000, sudo: true };
const fakeFs = (wrapper: string) => ({
  lstatSync: vi.fn((p: string) => ({ uid: 0, mode: /[a-f0-9]{64}$/.test(p) ? 0o700 : 0o755, isSymbolicLink: () => false, isFile: () => /[a-f0-9]{64}$/.test(p), isDirectory: () => !/[a-f0-9]{64}$/.test(p) })),
  readFileSync: vi.fn(() => wrapper),
});

describe("sudo command snapshots", () => {
  it("defaults to ordinary execution and round-trips explicit opt-in", () => {
    expect(JobTargetSchema.parse({ command: "echo ok" })).not.toHaveProperty("sudo");
    expect(JobTargetSchema.parse(target)).toMatchObject({ sudo: true });
    expect(() => JobTargetSchema.parse({ ...target, password: "secret" })).toThrow();
  });
  it("binds approval to command, cwd, env, timeout, user and platform, but canonicalizes environment ordering", () => {
    const p = planJobSudo(target, host);
    for (const delta of [{ command: "echo changed" }, { cwd: "/tmp" }, { env: { X: "1" } }, { timeoutMs: 31000 }]) expect(planJobSudo({ ...target, ...delta }, host).fingerprint).not.toBe(p.fingerprint);
    expect(planJobSudo(target, { ...host, uid: 502 }).fingerprint).not.toBe(p.fingerprint);
    expect(planJobSudo(target, { ...host, platform: "linux" }).fingerprint).not.toBe(p.fingerprint);
    expect(planJobSudo({ ...target, env: { B: "2", A: "1" } }, host).fingerprint).toBe(planJobSudo({ ...target, env: { A: "1", B: "2" } }, host).fingerprint);
  });
  it("grants only a root-owned no-argument wrapper with a policy-enforced timeout", () => {
    const p = planJobSudo(target, host);
    expect(p.policy).toContain(`#501 ALL=(root) TIMEOUT=30s NOPASSWD: NOSETENV: sha256:${createHash("sha256").update(p.wrapper).digest("hex")} ${p.wrapperPath} ""`);
    expect(p.policy).not.toContain("NOPASSWD: ALL");
    expect(p.policy).not.toContain("/bin/sh");
    expect(p.wrapper).toContain('[ "$#" -eq 0 ] || exit 64');
    expect(p.wrapper).toContain("exec /usr/bin/env -i");
    expect(p.authorizeScript).toContain("AUTHORIZE");
    expect(p.authorizeScript).toContain("visudo -cf");
    expect(p.authorizeScript).toContain("Wrong local user");
    expect(p.authorizeScript).toContain("not group/world writable");
    expect(p.authorizeScript).toContain("Refusing a symlink");
    expect(p.authorizeScript).toContain("new_policy");
    expect(p.revokeScript).toContain("REVOKE");
    expect(p.revokeScript).toContain(p.policyPath);
    expect(p.authorizeScript).not.toContain("sudo -S");
    expect(p.authorizeScript).not.toContain("timestamp_timeout");
  });
  it.skipIf(process.platform === "win32")("shell-quotes hostile command/environment literals and parses on both POSIX platforms without execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-sudo-syntax-"));
    try {
      for (const platform of ["darwin", "linux"]) {
        const p = planJobSudo({ ...target, command: "printf '%s' \"$(touch /DO-NOT-RUN)\"\nprintf '`x`'", env: { X: "';$(nope)\n`oops`" } }, { ...host, platform });
        for (const [name, text] of Object.entries({ install: p.authorizeScript, revoke: p.revokeScript, wrapper: p.wrapper })) {
          const file = join(dir, name); writeFileSync(file, text);
          const checked = spawnSync("/bin/sh", ["-n", file], { encoding: "utf8" });
          expect(checked.stderr).toBe(""); expect(checked.status).toBe(0);
        }
        const rule = join(dir, "policy"); writeFileSync(rule, p.policy);
        if (process.platform === "darwin" || process.platform === "linux") {
          const checked = spawnSync("/usr/sbin/visudo", ["-cf", rule], { encoding: "utf8" });
          if (!checked.error) expect(checked.status, checked.stderr).toBe(0);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses unsupported hosts, root daemons, relative cwd and malformed input", () => {
    expect(() => planJobSudo(target, { ...host, platform: "win32" })).toThrow(/macOS and Linux/);
    expect(() => planJobSudo(target, { ...host, uid: 0 })).toThrow(/non-root/);
    expect(() => planJobSudo({ ...target, cwd: "relative" }, host)).toThrow(/absolute/);
    expect(() => planJobSudo({ ...target, command: "a\0b" }, host)).toThrow(/NUL/);
    expect(() => planJobSudo({ ...target, env: { "X;evil": "x" } }, host)).toThrow(/environment/);
    expect(() => planJobSudo({ ...target, timeoutMs: 0 }, host)).toThrow(/timeout/);
  });
  it("uses only noninteractive argv after snapshot verification", () => {
    const p = planJobSudo(target, host);
    const fs = fakeFs(p.wrapper);
    expect(sudoJobInvocation(target, host, fs as never)).toEqual({ command: "/usr/bin/sudo", args: ["-n", "--", p.wrapperPath], timeoutMs: 35000 });
    expect(fs.lstatSync).toHaveBeenCalledWith("/private/etc/chimera-scheduled-commands");
  });
  it.each(["missing", "owner", "writable", "symlink", "public", "directory"])("rejects %s authorization without shell fallback", kind => {
    const p = planJobSudo(target, host); const fs = fakeFs(p.wrapper);
    const real = fs.lstatSync.getMockImplementation()!;
    fs.lstatSync.mockImplementation(path => {
      if (kind === "missing") throw new Error("ENOENT");
      const s = real(path);
      if (kind === "owner") s.uid = 501;
      if (kind === "writable") s.mode = 0o777;
      if (kind === "public") s.mode = 0o755;
      if (kind === "symlink") s.isSymbolicLink = () => true;
      if (kind === "directory") s.isFile = () => false;
      return s;
    });

    expect(() => sudoJobInvocation(target, host, fs as never)).toThrow(/authorization is missing or changed/);
  });
  it("the real runner refuses an uninstalled unique snapshot without running the command", async () => {
    const r = await runShellCommand({ ...target, command: `echo must-not-run-${Date.now()}` });
    expect(r.exitCode).toBeNull(); expect(r.output).toBe(""); expect(r.error).toMatch(/authorization|non-root|macOS and Linux/);
  });
});


// Execute the installer logic only in a temporary filesystem with uid/stat/visudo seams.
// No sudo invocation, system policy write or scheduled command execution occurs here.
describe("sudo setup transaction in an unprivileged sandbox", () => {
  const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  it.skipIf(process.platform === "win32").each(["success", "policy-failure", "symlink", "writable", "owner", "existing-different"])("%s preserves transaction and ownership boundaries", mode => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-sudo-install-test-"));
    try {
      const platform = process.platform === "darwin" ? "darwin" : "linux";
      const p = planJobSudo({ ...target, command: "touch " + q(join(dir, "must-not-run")), cwd: dir }, { ...host, platform });
      const etc = platform === "darwin" ? "/private/etc" : "/etc";
      const root = join(dir, "etc"); mkdirSync(root);
      const included = join(root, "sudoers.d"); mkdirSync(included);
      writeFileSync(join(root, "sudoers"), `@includedir ${etc}/sudoers.d\n`);
      const stat = join(dir, "stat.cjs");
      writeFileSync(stat, `const s=require('fs').lstatSync(process.argv.at(-1));console.log('${mode === "owner" ? 501 : 0} '+(s.mode&4095).toString(8));`);
      const noCheck = join(dir, "visudo");
      writeFileSync(noCheck, `#!/bin/sh\n${mode === "policy-failure" ? 'case "$*" in *sudoers) echo synthetic-policy-failure >&2; exit 1;; esac' : ':'}\nexit 0\n`, { mode: 0o755 });
      const adapt = (s: string) => s.replaceAll(etc + "/", root + "/").replaceAll(q(etc), q(root)).replaceAll("/usr/bin/id -u", "printf 0").replaceAll("/usr/bin/stat", `${q(process.execPath)} ${q(stat)}`).replaceAll("/usr/sbin/visudo", q(noCheck));
      const wrapper = p.wrapperPath.replace(etc, root);
      const policy = p.policyPath.replace(etc, root);
      const outside = join(dir, "outside"); mkdirSync(outside);
      writeFileSync(join(outside, "sentinel"), "unchanged");
      if (mode === "symlink") symlinkSync(outside, join(root, "chimera-scheduled-commands"));
      if (mode === "writable") chmodSync(root, 0o777);
      if (mode === "existing-different") { mkdirSync(join(root, "chimera-scheduled-commands")); writeFileSync(wrapper, "existing-root-content"); }
      const installed = spawnSync("/bin/sh", ["-c", adapt(p.rootInstall)], { encoding: "utf8" });
      if (mode === "success") {
        expect(installed.status, installed.stderr).toBe(0);
        expect(readFileSync(wrapper, "utf8")).toBe(adapt(p.wrapper));
        expect(statSync(wrapper).mode & 0o777).toBe(0o700);
        expect(readFileSync(policy, "utf8")).toBe(p.policy.replaceAll(etc + "/", root + "/"));
        expect(spawnSync("/bin/sh", ["-c", adapt(p.rootInstall)], { encoding: "utf8" }).status).toBe(0);
        const revoked = spawnSync("/bin/sh", ["-c", adapt(p.rootRevoke)], { encoding: "utf8" });
        expect(revoked.status, revoked.stderr).toBe(0);
      } else {
        expect(installed.status).not.toBe(0);
        if (mode === "symlink") expect(installed.stderr).toContain("Refusing a symlink");
        if (mode === "writable" || mode === "owner") expect(installed.stderr).toContain("root-owned and not group/world writable");
        if (mode === "policy-failure") expect(installed.stderr).toContain("synthetic-policy-failure");
      }
      if (mode === "existing-different") expect(readFileSync(wrapper, "utf8")).toBe("existing-root-content");
      else expect(existsSync(wrapper)).toBe(false);
      expect(existsSync(policy)).toBe(false);
      expect(existsSync(join(dir, "must-not-run"))).toBe(false);
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("unchanged");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe("sudo runner integration without elevation", () => {
  it("launches approved argv without a shell, closes stdin and does not inherit daemon credentials", async () => {
    const launch = vi.spyOn(sudoModule, "sudoJobInvocation").mockReturnValue({
      command: process.execPath,
      args: ["-e", "let n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>{console.log(JSON.stringify({stdin:n,secret:process.env.CHIMERA_SUDO_TEST_SECRET??null,askpass:process.env.SUDO_ASKPASS??null}));});"],
      timeoutMs: 1000,
    });
    const old = process.env.CHIMERA_SUDO_TEST_SECRET;
    process.env.CHIMERA_SUDO_TEST_SECRET = "do-not-inherit";
    try {
      const r = await runShellCommand({ ...target, command: "this shell command must not execute", env: { SUDO_ASKPASS: "not-allowed" } });
      expect(launch).toHaveBeenCalledOnce();
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.output)).toEqual({ stdin: 0, secret: null, askpass: null });
    } finally {
      launch.mockRestore();
      if (old === undefined) delete process.env.CHIMERA_SUDO_TEST_SECRET; else process.env.CHIMERA_SUDO_TEST_SECRET = old;
    }
  });
});
