# Chimera npm distribution

The npm release contains the daemon, CLI and MCP server as compiled
JavaScript. Node.js 24+ and Git are required. A source checkout, pnpm, tsx, Bun and
Rust are not required on the user's machine. Provider authentication is still
required before running real agents.

Published versions are available as `@nedimyilmaz/chimera` on npm.
Combined desktop installation requires the matching
[GitHub desktop release](https://github.com/nedimYilmaz/chimera/releases).

## One command: CLI + desktop on macOS and Linux

```sh
npx @nedimyilmaz/chimera install
```

Alternatively, use the public bootstrap:

```sh
curl -fsSL https://raw.githubusercontent.com/nedimYilmaz/chimera/main/scripts/install-public.sh | bash
```

Windows releases wait for a code-signing certificate; until then `install` refuses
Windows before downloading anything. Once enabled, the same `npx` command works in Windows
PowerShell and Command Prompt. A native
PowerShell bootstrap is also available as `scripts/install-public.ps1` (with
`-DryRun` and `-NoOpen` switches); it does not change execution policy.

`CHIMERA_VERSION=<published-version> bash scripts/install-public.sh` pins the bootstrap version.
The npm command supports `install --dry-run` (prints paths and URLs, no changes)
and `install --no-open` (does not open the app after installing).

OS and architecture are detected automatically (x64/arm64). The CLI is copied to
a permanent versioned directory, independent of the npx cache. All platforms
verify SHA-256, install the matching desktop, verify daemon health and open the app.

| Platform | Desktop | Daemon at login | Additional checks |
| --- | --- | --- | --- |
| macOS | `~/Applications/chimera.app` | launchd user agent | Bundle ID/version, signature, Gatekeeper, notarization |
| Linux | `~/.local/share/chimera/desktop/chimera.AppImage`, applications menu entry | systemd user unit | ELF architecture, type-2 AppImage runtime |
| Windows | `%LOCALAPPDATA%/chimera/desktop/chimera.exe`, Start menu shortcut | Current-user Startup shortcut | PE architecture, pinned Authenticode publisher, timestamp, product version |

Linux uses extract-and-run so FUSE is not required. It requires a glibc desktop
distribution with a functioning systemd user session; release builds target
Ubuntu 22.04 or newer. Other distributions still need clean-machine validation.
Musl/Alpine and non-systemd systems are not advertised as supported desktops.

Windows checks for WebView2 and, only when absent, downloads Microsoft's signed
Evergreen bootstrapper and runs `/silent /install` as the current user. This shared
Microsoft runtime is retained if a later Chimera step fails. The daemon launches
hidden on login; unlike launchd/systemd this does not supervise crash restarts.
`chimera start` can start it again. The Windows CLI directory is added to the user
PATH; use a new terminal afterward. No machine-wide service or admin elevation is used.

Node.js 24+, npm and Git must already be installed. No sudo, pnpm, Rust or local
desktop build is needed. If `~/.local/bin` is absent from PATH, the installer
prints the shell profile line to add. Provider setup happens in the app.
The combined installer uses the standard `~/.chimera` state directory; use the
source installer for a custom `CHIMERA_HOME`. Re-run a newer pinned package's
`install` command to upgrade. Preparation completes before stopping the previous
daemon; activation failures restore the previous app, CLI launchers and startup
configuration. If a previous standalone daemon was stopped, it may need a manual
restart after a failed migration. Older CLI release directories remain for recovery.

## Built-in Computer Use

The following setup behavior requires **0.1.4 or newer**. Earlier releases did not
include the bundled Computer Use runtime.

The desktop and its npm-installed daemon use the same bundled Computer Use runtime.
Setup prepares Laya's pinned Python dependencies and downloads and verifies its model
before activating the new installation. A model download or checksum failure fails setup;
it is not reported as a completed installation. Direct standalone desktop launches start
this setup automatically on first open and show its progress in Settings.

Current reviewed integration support is platform-specific: desktop control is hosted by
the macOS app; the browser is bundled on macOS and Linux x64; Laya's reviewed native
Python dependency lock currently supports Apple Silicon macOS 14+. Other targets report
an explicit unsupported status, rather than silently using unreviewed dependencies.
macOS still requires the operator's Accessibility and Screen Recording grants.

To let desktop agents use an already signed-in Chrome/Chromium profile, open
**Settings → MCP → Chimera Computer Use → Allow existing browser access**.
Review the scope, check the acknowledgement, and confirm. This permission is off
by default and is separate from macOS screen permissions. It is saved for future
launches and can be removed in the same panel.

If desktop control is running, confirmation restarts only that service; an
in-progress browser action may need to be retried. Chimera and agent sessions stay
open. Saving permission while stopped does not start desktop control. The panel
shows whether permission is saved or active, including a failed service restart.
Agents cannot grant this permission through an MCP tool or a chat acknowledgement.

## Uninstall

Uninstall support is first published in **0.1.3**. Use these commands after that version
is published; older packages do not provide this command. Close the desktop first
(or use the installed `chimera uninstall` with version 0.1.3 or newer):

```sh
npx @nedimyilmaz/chimera@latest uninstall
npx @nedimyilmaz/chimera@latest uninstall --dry-run
npx @nedimyilmaz/chimera@latest uninstall --purge-data
```

Normal uninstall preserves accounts, history, configuration and project data. It
validates installation ownership before stopping the owned login service and
Chimera daemons, then removes the managed desktop, shortcuts, CLI launchers and
versioned payloads. A separate global npm package is removed only after its exact
package name and global prefix are verified. A daemon from an npm npx cache can
be stopped after verifying its package provenance, but the npx cache stays under
npm's ownership. No whole npm cache cleanup, provider CLI login removal, or shared
Node, Git or WebView2 removal is performed.

`--purge-data` enumerates the selected state directory, managed projects and
worktrees inside it, the exact `dev.chimera.desktop` app cache, and owned
credential records before asking you to type the selected directory's full path.
It requires an interactive terminal and has no confirmation bypass. The app cache
is shared application storage outside the selected state directory and is shown
separately. Keychain deletion on macOS requires canonical Chimera service names
and verified account/service attributes; passwords are never read. Credential
refs without a supported native ownership adapter on Linux/Windows are reported
and retained. External environment/provider stores and external repositories
referenced by projects are untouched.

`CHIMERA_HOME` explicitly selects the purge target; otherwise it is `~/.chimera`.
The combined desktop service uses `~/.chimera` regardless of this override. When
they differ, both homes are named in the preview/confirmation; the unselected
home's data and its shared credential records are preserved. This does not claim
to erase all data from other homes. Overlapping selected/preserved homes are
rejected. Root/home targets, symlink ancestors/targets, repository roots,
foreign launchers/receipts and unrecognized service or daemon provenance cause a
failure instead of removal. Nested dependency links are unlinked without following
their destinations; Windows links require a known SymbolicLink/Junction type.
Unknown reparses and cross-device data subtrees are rejected. Owned processes
still exiting after service shutdown have a bounded wait. Stop failures leave payload and data intact; removal
failures stop before purging data. Some installation files can already be removed
if a later removal fails; the remaining paths can be inspected and retried safely
or removed manually after ownership verification.

`--dry-run`, including with `--purge-data`, prints the expected footprint and
credential candidates without stopping processes, writing files, changing
credentials or accessing the network. Native ownership checks are required by
the real operation. Windows dry-run names the native cache location contract;
the exact known-folder path is resolved before purge confirmation. Missing owned installations are idempotent. This command
handles npm-managed installations; use `scripts/install.sh --uninstall` for a
source-checkout installation. Linux/Windows receipts are in
`<install root>/install.json`; macOS legacy installs are verified through their
npm payloads, launchers and exact bundle identity.

## CLI only

```sh
npm install --global @nedimyilmaz/chimera
chimera doctor
chimera status
```

For a temporary CLI invocation:

```sh
npx @nedimyilmaz/chimera --help
npx @nedimyilmaz/chimera status
```

`status` and the MCP server automatically start the daemon when
needed. The npm install itself does not start processes or install login services.
For a persistent daemon, use a global installation rather than an npx cache entry.
Use `chimera stop` before upgrading, then `npm install --global
@nedimyilmaz/chimera@<version>` and `chimera start`. User state remains in
`~/.chimera` (or `CHIMERA_HOME`). Remove the package with `npm uninstall --global
@nedimyilmaz/chimera`; stop the daemon first. User data is retained; the guarded `uninstall` command above also checks this global package.

MCP clients can run `chimera-mcp` after a global install, or use:

```json
{
  "command": "npx",
  "args": ["--yes", "--package=@nedimyilmaz/chimera@<version>", "chimera-mcp"]
}
```

Pin a published version in client configuration. Claude/Codex SDKs remain ordinary
npm dependencies so their platform-specific executables can be resolved normally.
Do not omit optional dependencies: those SDKs need their platform packages.
The optional local Transformers embedding runtime is not included; memory search
retains its Ollama/lexical fallback.

## Desktop application

The Tauri desktop app is a separate native download retrieved by `chimera install`
on supported platforms. It is not embedded in the npm tarball. The desktop is a
daemon client; the combined installer provisions its startup. See the
[published release assets](https://github.com/nedimYilmaz/chimera/releases) for
available versions and architectures. Windows desktop installation remains
disabled until signed Windows assets are available.

`scripts/install.sh` in a source checkout can build and install the desktop app
and login service. The npm installer fails with a missing-release error before
altering an existing installation.
