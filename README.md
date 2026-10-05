# Chimera

**Your agents. One workspace.**

Chimera is a desktop workspace for teams of Claude and Codex coding agents.
Agents, teams, task queues, shared memory and visible execution live in one
place, and every agent works in its own git worktree so five of them can edit
the same repository without colliding.

[**Explore the site**](https://nedimyilmaz.github.io/chimera/) ·
[**Feature guide**](https://nedimyilmaz.github.io/chimera/features.html) ·
[**Run it from source**](#install) ·
[**Share feedback**](https://github.com/nedimYilmaz/chimera/issues)

[![Chimera's Agents view: a team of agents working on a fictional project, with their status, transcripts and worktrees](site/assets/chimera-workspace.png)](https://nedimyilmaz.github.io/chimera/)

<sub>Actual Chimera interface · demo data</sub>

> **Early access.** Chimera is MIT-licensed and under active development.
> Signed public downloads are not available yet: today you run it from source,
> and the platform you can expect to work is macOS on Apple Silicon. See
> [Platform availability](#platform-availability) and
> [Known limits](#known-limits) before relying on it.

## Why

Running one AI coding agent in a terminal works fine until you want more than
one thing to happen at once. Then you're juggling tabs, remembering which
directory holds which uncommitted changes, re-explaining context to a fresh
session, and hitting the same rate limit on the same account. Chimera turns
"one agent, one terminal" into a small operations layer:

- **Fan work out.** Spawn a team of agents with different roles against a
  shared task queue; the daemon drains the queue up to the team's concurrency
  cap.
- **Serialize what depends on other work.** Queue tasks can declare
  `dependsOn` other tasks. A dependent task stays `blocked` until its
  dependencies finish, and cascades to failed if one of them fails.
- **Stop agents from colliding.** Every agent gets its own git worktree, so
  concurrent agents never fight over one working tree.
- **Carry knowledge across agents and sessions.** A shared memory store lets
  one agent leave a note — a fact, a decision, a todo — that any other agent
  or a future session can find with hybrid lexical + semantic search, linked
  into a backlink graph with `[[wiki-links]]`.
- **Survive rate limits instead of stalling.** Accounts and providers can have
  a failover order; when one cools down or errors out, the daemon retries on
  the next.
- **Keep a human in the loop without babysitting.** Agents can pause for
  approval on a tool call, or `ask_human` / `ask_team` and wait for an answer
  (or a timeout that applies a default).
- **Route work by project.** A project binds a repo path to a team, a queue and
  an optional always-on "conductor" agent with its own permission profile.

## Platform availability

| Platform | Status |
| --- | --- |
| macOS · Apple Silicon | **Tested.** The only platform where the packaged desktop runtime has been run from a clean home folder. |
| macOS · Intel | Not tested. |
| Linux | **Source only.** There is a source installer, but no packaged build, and it has not been verified end to end. |
| Windows | **Unsupported.** |

Desktop control is macOS-only, and the built-in browser tools are unsupported on
Linux arm64 and Windows arm64. The optional local decision model (Laya) needs
macOS 14 or newer and downloads one English model, pinned to a full revision and
checked against a digest, when you install it, so a fresh install is **not** fully
offline. After that it runs offline: multilingual and typed-decision requests fail
rather than fetch a model Chimera has not reviewed. Signed public downloads are not available yet.

## Install

Chimera is early access. The path that works today is installing from source.

### From source

```sh
git clone https://github.com/nedimYilmaz/chimera.git && cd chimera
./scripts/install.sh
```

This needs Git, Node.js 24+, pnpm and, for the desktop app, Rust (pnpm and Rust
are installed if missing). It installs `chimerad` and `chimera` into
`~/.local/bin`, builds the desktop app and sets up a login service. `--no-app`
skips the desktop build, `--no-service` skips the login service, and on macOS
`--enable-wake` lets scheduled jobs wake a sleeping machine.

On macOS the login service is a launchd user agent, and that is the path that
has been tested. On Linux the installer uses a systemd user unit and an
AppImage; treat that as less proven.

A fresh `~/.chimera` starts with no accounts; the app's first screen walks you
through connecting a provider. Run `chimera doctor` to check prerequisites and
configuration without starting the daemon.

### Packaged installer and npm (once v0.1.0 is published)

The first public release is still being prepared, so the commands below do not
work yet. They will:

```sh
npx @nedimyilmaz/chimera install
```

or, without npx:

```sh
curl -fsSL https://raw.githubusercontent.com/nedimYilmaz/chimera/main/scripts/install-public.sh | bash
```

The installer detects your OS and architecture, verifies the download's
SHA-256, installs the desktop app and the `chimera` CLI, starts the daemon at
login and opens the app. `install --dry-run` prints what it would do without
changing anything; `install --no-open` skips opening the app.

For the CLI and MCP server only:

```sh
npm install --global @nedimyilmaz/chimera
chimera doctor
claude mcp add chimera -- chimera-mcp
```

`chimera status` and the MCP server start the daemon automatically when it is
not running. Any stdio MCP client (Claude Code, Codex, ...) can use
`chimera-mcp`.

### Uninstall

Run `chimera stop`, close the app, then remove the login item (the macOS
LaunchAgent, or `systemctl --user disable --now chimerad.service` on Linux), the
app and the `chimera` install directory. Keep `~/.chimera` if you want your
accounts and history.

## Early access: try it and tell us what breaks

The most useful thing you can do right now is run Chimera from source on a Mac,
point it at a repository you can afford to experiment on, and report what
breaks or confuses you.

- [Open an issue](https://github.com/nedimYilmaz/chimera/issues) with what you
  tried and what happened. `chimera support-report` prints a privacy-minimized
  JSON report (no credentials, transcripts or user paths) you can attach.
- Star or watch the [repository](https://github.com/nedimYilmaz/chimera) to
  follow the v0.1.0 release.

## The two surfaces

| Surface | What it's for |
|---|---|
| **Desktop app** | The full UI: agent transcripts, spawn forms, permission prompts, an in-repo file tree and viewer, an in-app terminal, push-to-talk voice and meeting rooms — over agents, projects, teams, queues, schedules, events and memory. |
| **`chimera` MCP server** | Lets any MCP client spawn and coordinate agents as tool calls from inside its own session — an agent orchestrating other agents. |

Both sit on the same daemon and the same RPC contract. Neither holds state of
its own: the app is a projection of the daemon's event log (see
[How it works](#how-it-works)).

## Features

The [feature guide](https://nedimyilmaz.github.io/chimera/features.html) walks
through every area below with a scenario, a screenshot where one exists and the
smaller capabilities that don't fit in this list.

- **Agents** — spawned with a prompt, a working directory, a model, a
  permission profile, and an account/provider. Lifecycle covers resume,
  interrupt, compaction, remote control, and kill.
- **Teams and roles** — a role is a reusable job description (an agent spec
  minus its prompt); a team binds roles to a queue and a concurrency cap.
- **Queues** — priority + FIFO task lists, with per-task `dependsOn`, retries,
  pause/resume, and a default gate workflow applied to every task that flows
  through them.
- **Workflows and gates** — a DAG engine: steps connected by edges with routing
  conditions and bounded loop-back, fan-out/join, and nested sub-workflows. A
  step's gate can be a shell command, an artifact check, a human approval, an
  evaluator-optimizer "critic" loop, or a "plan" step that compiles a fresh
  sub-workflow at runtime.
- **Scheduled jobs** — cron, interval, or one-shot jobs that target a
  team/role, spawn an inline agent, or deliver to a pinned agent, with overlap
  policy, timezone, budget ceiling and catch-up after restart. A job that fires
  late because the machine slept runs late and coalesced, unless wake is
  enabled (macOS only).
- **Projects and conductors** — a project binds a repo path to a team/queue and
  can keep a persistent "conductor" agent with its own permission profile.
- **Shared memory** — hybrid lexical + semantic search over notes tagged by
  kind (note/decision/fact/todo/question), author, team and project, with a
  `[[wiki-link]]` backlink graph.
- **Artifacts** — reports, diffs, charts, files or links an agent produces,
  addressable by ID and usable as workflow gate checks.
- **Checkpoints** — full working-tree git snapshots that never touch HEAD, the
  index or history, so an agent's tree can be reverted to a known-good point
  without a real commit.
- **Budgets and usage** — a spend ceiling on a whole spawn tree (a root agent
  plus everything it spawns); breaching it pauses the tree.
- **Permission profiles** — `readOnly` / `acceptEdits` / `full`, enforced per
  backend and overridable per project or per spawn.
- **Providers and accounts** — subscription login, OS keychain, environment
  variable, external command or OAuth accounts, with failover across accounts
  and, optionally, across providers.
- **Hooks** — observational rules on daemon events (an agent settling, a task
  changing state, a gate verdict, a budget warning, ...) that notify someone,
  push a queue task, spawn an agent, run a sandboxed local command, or send a
  toast/OS/webhook notification.
- **The MCP tool surface** — a broad set of tools. A small core (spawn, wait,
  send, ask, memory, team basics) is always visible; the rest are discovered and
  called on demand through `chimera_tools`/`chimera_call`, so their schemas
  aren't billed on every turn.
- **The MCP store** — connects Chimera *out* to other MCP servers (Slack,
  GitHub, Jira, a Kubernetes cluster, ...), so agents reach one tool surface
  instead of every client configuring the same servers. Packages are reviewed
  first and installed disabled, with lifecycle scripts off.
- **Computer use** — built-in integrations for a local decision model (Laya), a
  headless browser and desktop control. macOS-first; see
  [Platform availability](#platform-availability) for what each needs.
- **Voice** — native Codex voice on an agent's existing authenticated thread
  (per-agent opt-in), and preview **meeting rooms** where an approved roster of
  agents talks within a duration/utterance budget while you join or mute.
  Push-to-talk transcription to text agents is a separate path.
- **Federation** — pairs two Chimera daemons on two machines over an
  SSH-tunneled unix socket; peers exchange account names, never provider
  credentials, and start read-only until explicitly granted (the single-use
  pairing token does travel in the invite). The most experimental feature here.
- **Diagnostics** — `chimera doctor` checks prerequisites and configuration
  without starting the daemon; `chimera support-report` prints a
  privacy-minimized JSON report.

## How it works

```mermaid
flowchart LR
    subgraph Clients
        MCPCLIENT["MCP client<br/>(Claude Code, Codex, ...)"]
        APP["Desktop app"]
    end

    MCPSRV["chimera MCP server<br/>(packages/mcp)"]
    CLIENTLIB["RPC client<br/>(packages/client)"]

    MCPCLIENT --> MCPSRV --> CLIENTLIB
    APP --> CLIENTLIB

    CLIENTLIB -- "unix socket, framed RPC" --> DAEMON

    subgraph DAEMON["chimerad (packages/daemon)"]
        ENGINE["Engine (packages/core)"]
    end

    ENGINE --> SCHED["Scheduler<br/>queues, workflows, gates"]
    ENGINE --> SUP["Supervisor<br/>lifecycle, budgets, failover"]
    ENGINE --> MEM["MemoryStore"]
    ENGINE --> HOOKS["HookEngine"]

    SUP --> BACKENDS["Backends<br/>claude / codex / kimi / generic"]
    BACKENDS --> WT["one git worktree per agent"]

    ENGINE --> EVENTS[("events/*.jsonl")]
    EVENTS --> UISTATE["reducer<br/>(packages/ui-state)"]
    UISTATE --> APP
```

**The daemon and the engine.** `packages/daemon` is a thin unix-socket RPC
server plus persistence. Everything that matters — the engine, scheduler,
supervisor and provider backends — lives in `packages/core`.

**The protocol is the contract.** `packages/protocol` defines every schema and
every RPC request/response shape, and the MCP tool surface is derived from the
same table, so the tools an agent sees and the RPCs the daemon serves can't
drift apart.

**Provider backends** (`packages/core/src/backends/`):

- `claude.ts` — the Claude Agent SDK.
- `codex.ts` — the Codex SDK and app-server.
- `kimi.ts` — the Agent Client Protocol over the `kimi acp` subprocess.
- `generic.ts` — any OpenAI-compatible chat endpoint (Groq, Together,
  Fireworks, DeepSeek, Mistral, xAI, ...), with local tool execution and MCP
  tool hosting.

**Event log and UI projection.** Every state change is appended to
`~/.chimera/events/*.jsonl`. The desktop app never mutates its own state: it
feeds the event stream through one reducer (`packages/ui-state`), so the UI
can't show a different reality than the daemon.

**Worktree isolation.** Spawning an agent against a repo runs `git worktree
add` under `.chimera/worktrees/<key>`, so concurrent agents never share a
working tree or step on each other's uncommitted changes.

| Package | Contents |
|---|---|
| `packages/core` | Engine, scheduler, supervisor, memory, hooks, checkpoints, budgets, provider backends |
| `packages/daemon` | The long-running process: RPC server, persistence, singleton lock |
| `packages/protocol` | Zod schemas and the RPC contract every other package imports |
| `packages/mcp` | The `chimera` MCP server |
| `packages/app` | The Tauri desktop app |
| `packages/ui-state` | The reducer the app projects from the event log |
| `packages/client` | The daemon RPC client and the `chimera` CLI |

## Security

Git worktrees isolate changes, **not processes or filesystem access**: an agent
with full access can modify anything your OS user can. Use full access only for
trusted work, run Chimera as your regular user, keep the daemon on local IPC
(never behind an unauthenticated proxy), protect `~/.chimera` and provider
sessions, and review imported jobs, MCP servers, skills and commands before
enabling them.

To report a vulnerability, use **Security → Report a vulnerability** on this
repository. Please don't put credentials, exploit details or private
transcripts in a public issue.

## Known limits

- **Signed public downloads are not available yet.** The first release (v0.1.0)
  is being prepared; until then, install from source.
- **One platform is tested:** macOS on Apple Silicon. Linux has a source
  installer but no packaged build; Windows is unsupported.
- **Young or partial surfaces:** federation and the Kimi backend have seen the
  least use, voice is a preview, memory scoping is ranking rather than access
  control, and some budgets are estimated from token counts.

Issues are welcome. This repository is published from the maintainer's
development tree, so changes from pull requests are applied there rather than
merged here directly.

## License

[MIT](LICENSE). Distributed third-party dependencies retain their own licenses.
