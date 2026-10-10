import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { JobTarget } from "@chimera/protocol";

type CommandTarget = Pick<Extract<JobTarget, { command: string }>, "command" | "cwd" | "env" | "timeoutMs">;
type Host = { platform: string; uid: number; home: string };
const currentHost = (): Host => ({ platform: process.platform, uid: process.getuid?.() ?? -1, home: homedir() });
const quote = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";
const digest = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Pure plan: creating a job or opening this preview never authorizes or runs anything. */
export function planJobSudo(target: CommandTarget, host: Host = currentHost()) {
  if (!["darwin", "linux"].includes(host.platform)) throw new Error("Scheduled sudo is supported on macOS and Linux only.");
  if (!Number.isSafeInteger(host.uid) || host.uid <= 0) throw new Error("Sudo authorization requires a non-root local user.");
  const cwd = target.cwd ?? host.home;
  if (!isAbsolute(cwd) || cwd.includes("\0")) throw new Error("Sudo commands require an absolute working directory.");
  if (!target.command.trim() || target.command.includes("\0")) throw new Error("A nonempty command without NUL bytes is required.");
  const env = Object.entries(target.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (env.some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || v.includes("\0"))) throw new Error("Invalid sudo command environment.");
  const timeoutMs = target.timeoutMs ?? 600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 21_600_000) throw new Error("Invalid sudo command timeout.");
  const seconds = Math.ceil(timeoutMs / 1000);
  const fingerprint = digest(JSON.stringify({ version: 1, uid: host.uid, platform: host.platform, command: target.command, cwd, env, timeoutMs }));
  const etc = host.platform === "darwin" ? "/private/etc" : "/etc";
  const directory = `${etc}/chimera-scheduled-commands`;
  const wrapperPath = `${directory}/${host.uid}-${fingerprint}`;
  const policyPath = `${etc}/sudoers.d/chimera-job-${host.uid}-${fingerprint}`;
  const rootHome = host.platform === "darwin" ? "/var/root" : "/root";
  const wrapper = `#!/bin/sh\nset -eu\n[ "$#" -eq 0 ] || exit 64\n[ "$(/usr/bin/id -u)" -eq 0 ] || exit 77\ncd ${quote(cwd)}\nexec /usr/bin/env -i HOME=${quote(rootHome)} USER=root LOGNAME=root PATH=/usr/bin:/bin:/usr/sbin:/sbin ${env.map(([k, v]) => quote(`${k}=${v}`)).join(" ")} /bin/sh -c ${quote(target.command)}\n`;
  // No wildcard arguments, shell-wide grant, caller-controlled environment or cached ticket.
  // TIMEOUT is enforced by sudo's privileged monitor, which can kill root descendants.
  const policy = `# Chimera command snapshot ${fingerprint}\n#${host.uid} ALL=(root) TIMEOUT=${seconds}s NOPASSWD: NOSETENV: sha256:${digest(wrapper)} ${wrapperPath} ""\n`;
  const stat = host.platform === "darwin" ? '/usr/bin/stat -f "%u %Lp"' : '/usr/bin/stat -c "%u %a"';
  const guard = `safe() {
  [ ! -L "$1" ] || { echo 'Refusing a symlink in authorization paths' >&2; exit 1; }
  set -- $(${stat} "$1")
  [ "$1" = 0 ] && [ "$((0$2 & 022))" -eq 0 ] || { echo 'Authorization paths must be root-owned and not group/world writable' >&2; exit 1; }
}
`;
  const parents = host.platform === "darwin" ? ["/", "/private", etc] : ["/", etc];
  const preflight = `set -eu\numask 077\n[ "$(/usr/bin/id -u)" -eq 0 ] || exit 77\n${guard}${parents.map(p => `safe ${quote(p)}\n[ -d ${quote(p)} ] || exit 1`).join("\n")}\n`;
  const rootInstall = `${preflight}
# Refuse to claim success if this system does not load the dedicated policy directory.
/usr/bin/grep -Eq '^[[:space:]]*[#@]includedir[[:space:]]+(/private)?/etc/sudoers[.]d/?[[:space:]]*(#.*)?$' ${quote(`${etc}/sudoers`)} || { echo 'Use visudo to enable the sudoers.d include before authorizing this job.' >&2; exit 1; }
for dir in ${quote(directory)} ${quote(`${etc}/sudoers.d`)}; do
  if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then /bin/mkdir -m 0755 "$dir"; fi
  safe "$dir"; [ -d "$dir" ] || exit 1
done
wrapper=${quote(wrapperPath)}
policy=${quote(policyPath)}
for file in "$wrapper" "$policy"; do
  if [ -e "$file" ] || [ -L "$file" ]; then safe "$file"; [ -f "$file" ] || exit 1; fi
done
stage=$(/usr/bin/mktemp -d ${quote(`${directory}/.install.XXXXXXXX`)})
new_wrapper=0; new_policy=0; success=0
cleanup() {
  if [ "$success" -ne 1 ]; then
    [ "$new_policy" -ne 1 ] || /bin/rm -f "$policy"
    [ "$new_wrapper" -ne 1 ] || /bin/rm -f "$wrapper"
  fi
  /bin/rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf %s ${quote(wrapper)} > "$stage/wrapper"
printf %s ${quote(policy)} > "$stage/policy"
/usr/sbin/visudo -cf "$stage/policy" >/dev/null
if [ -e "$wrapper" ]; then /usr/bin/cmp -s "$stage/wrapper" "$wrapper"; else new_wrapper=1; /usr/bin/install -m 0700 "$stage/wrapper" "$wrapper"; fi
/bin/chmod 0700 "$wrapper"
if [ -e "$policy" ]; then /usr/bin/cmp -s "$stage/policy" "$policy"; else new_policy=1; /usr/bin/install -m 0440 "$stage/policy" "$policy"; fi
/usr/sbin/visudo -cf ${quote(`${etc}/sudoers`)} >/dev/null
success=1
printf '%s\\n' 'Authorization installed. The scheduled command was NOT executed.'
`;
  const rootRevoke = `${preflight}
for dir in ${quote(directory)} ${quote(`${etc}/sudoers.d`)}; do
  if [ -e "$dir" ] || [ -L "$dir" ]; then safe "$dir"; [ -d "$dir" ] || exit 1; fi
done
for file in ${quote(policyPath)} ${quote(wrapperPath)}; do
  if [ -e "$file" ] || [ -L "$file" ]; then safe "$file"; [ -f "$file" ] || exit 1; /bin/rm -f "$file"; fi
done
printf '%s\\n' 'Authorization removed. An already-running command is not interrupted.'
`;
  const confirmation = (verb: string, script: string) => `#!/bin/sh\nset -eu\n[ -t 0 ] || { echo 'Run this in an interactive terminal.' >&2; exit 1; }\n[ "$(/usr/bin/id -u)" -eq ${host.uid} ] || { echo 'Wrong local user.' >&2; exit 1; }\nprintf '%s\\n' ${quote(`${verb} root access for this exact command snapshot (${fingerprint}).\nCommand: ${target.command}\nDirectory: ${cwd}\nTimeout: ${seconds}s\nEnvironment: ${env.length ? env.map(([k, v]) => `${k}=${v}`).join("; ") : "clean root environment"}\nReferenced scripts/files are not frozen; their later changes affect this command.\nType ${verb} to continue:`)}\nIFS= read -r answer\n[ "$answer" = ${quote(verb)} ] || exit 1\n/usr/bin/sudo /bin/sh -c ${quote(script)}\n`;
  return { fingerprint, wrapperPath, policyPath, wrapper, policy, rootInstall, rootRevoke, authorizeScript: confirmation("AUTHORIZE", rootInstall), revokeScript: confirmation("REVOKE", rootRevoke), seconds };
}

/** Verify private root ownership before sudo; sudo verifies the script digest as root. */
export function sudoJobInvocation(target: CommandTarget, host: Host = currentHost(), fs = { lstatSync }) {
  const plan = planJobSudo(target, host);
  const parents = host.platform === "darwin" ? ["/", "/private", "/private/etc", "/private/etc/chimera-scheduled-commands"] : ["/", "/etc", "/etc/chimera-scheduled-commands"];
  try {
    for (const path of [...parents, plan.wrapperPath]) {
      const st = fs.lstatSync(path);
      if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0 || (path === plan.wrapperPath ? !st.isFile() : !st.isDirectory())) throw new Error("invalid snapshot");
    }
    if ((fs.lstatSync(plan.wrapperPath).mode & 0o077) !== 0) throw new Error("snapshot is not private");
  } catch {
    throw new Error("Sudo authorization is missing or changed. Open this schedule's sudo setup and authorize its current command before running it.");
  }
  return { command: "/usr/bin/sudo", args: ["-n", "--", plan.wrapperPath], timeoutMs: plan.seconds * 1000 + 5000 };
}
