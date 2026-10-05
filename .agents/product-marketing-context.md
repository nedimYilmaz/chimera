# Product Marketing Context

*Last updated: 2026-10-05. Drafted from the README, the package code and the shipped desktop screens. Anything not verifiable from those is marked **unknown**. This file is part of the public repository, so keep it free of internal hostnames, customer names and private paths.*

## Product Overview
**One-liner:** One desktop workspace for your Claude and Codex agent teams — agents, queues, shared memory and every running task in view.

**What it does:** Chimera is a daemon that supervises many AI coding agents at once — across providers and accounts, each in its own git worktree — behind one control surface. You use it through a desktop app, or from inside any MCP client (Claude Code, Codex, any stdio MCP client). Teams of agents drain a shared task queue, leave notes in a shared memory, and fail over between accounts when one hits a rate limit.

**Product category:** Multi-agent orchestration for AI coding agents (the shelf: "run several Claude Code / Codex agents at once", "agent team manager", "AI coding agent workspace").

**Product type:** Open-source developer tool — a local daemon, a Tauri desktop app and an MCP server. Tested on macOS Apple Silicon only; see Stage.

**Business model:** MIT-licensed, free. Provider usage is billed by whichever provider/account the user connects. No hosted service, pricing or paid tier described anywhere in the repo; any plan beyond that is **unknown**.

**Stage:** Early access. Signed public downloads are not available yet (v0.1.0 is still being prepared); the path today is a source install. The packaged desktop runtime has been run from a clean home folder on macOS Apple Silicon only; macOS Intel is untested, Linux has a source installer but no packaged build and no end-to-end verification, Windows is unsupported. Computer-use tools are macOS-first (desktop control is macOS-only; browser tools unsupported on Linux arm64 and Windows arm64). The optional local decision model (Laya) needs macOS 14+ and downloads its model on first use, so a fresh install is not fully offline. Never claim Linux/Windows readiness, offline-first, or an available download. Do not make legal or provider-terms assertions (for example about running several accounts); the product flow does not depend on them.

## Target Audience
**Target companies:** Individual developers and small engineering teams already paying for Claude and/or Codex. Company size, industry and stage: **unknown** (no research on file).

**Decision-makers:** The developer who installs it is the buyer. Team leads who coordinate several agents across a repo are the second reader.

**Primary use case:** Run more than one coding agent at once without losing track — fan a task out, keep a team working a queue while you do something else, and stop re-explaining context to fresh sessions.

**Jobs to be done:**
- Hand a backlog to a team of agents and review results instead of babysitting terminals.
- Keep agents from colliding in the same working tree.
- Keep work moving when one account or provider rate-limits.

**Use cases:**
- A team with roles (implementer, reviewer, ...) draining a queue where some tasks `dependsOn` others.
- A persistent per-project "conductor" agent that owns a repo.
- Scheduled jobs (cron, interval, one-shot) that spawn or message agents.
- An agent that orchestrates other agents through the `chimera` MCP server.

## Personas
| Persona | Cares about | Challenge | Value we promise |
|---------|-------------|-----------|------------------|
| Developer running several agents | Throughput without chaos | Terminal tabs, context lost between sessions, one account's rate limit | One workspace that shows every agent, queue and note, each agent in an isolated worktree |
| Team lead coordinating agents | Visibility and control | Knowing what each agent did, what is blocked, and what needs approval | Queues with dependencies and gates, permission profiles, a human-in-the-loop path |
| Technical influencer / skeptic | Safety and honesty | Agents with broad filesystem access | Plain statement that worktrees isolate changes, not processes; permission profiles; early-access limits listed on the page |

## Problems & Pain Points
**Core problem:** One agent in one terminal works until you want two things to happen at once. Then you are juggling tabs, remembering which directory holds which uncommitted changes, re-explaining context to fresh sessions, and hitting the same rate limit on the same account.

**Why alternatives fall short:**
- Separate terminal tabs / tmux: no shared queue, no shared memory, no overview.
- Each vendor's own agent tooling: stays inside one provider and one session.
- Doing the work serially by hand: slow, and the human is the scheduler.

**What it costs them:** Time spent supervising rather than reviewing, and context lost on every reset. Quantified cost: **unknown** — no measurements exist, so none are claimed.

**Emotional tension:** Losing the thread; fear of agents overwriting each other's work; not trusting what an agent with broad access just did.

## Competitive Landscape
**Direct:** Other multi-agent orchestration tools for coding agents — **unknown**, not researched. Do not publish named comparisons until researched.

**Secondary:** Running agents in separate terminals or tmux panes — falls short because there is no queue, memory or visibility layer.

**Indirect:** One agent, run by hand, one task at a time — falls short because the human becomes the bottleneck.

## Differentiation
**Key differentiators:**
- One workspace over Claude, Codex, Kimi and any OpenAI-compatible endpoint, behind one RPC contract.
- Every agent gets its own git worktree.
- Task queues with `dependsOn`, retries, pause/resume and gates (shell, artifact, human approval, critic loop).
- Shared memory (hybrid lexical + semantic search, `[[wiki-link]]` backlinks) that survives session resets.
- The desktop app is a projection of the daemon's event log, so the UI cannot show a different reality than the daemon.
- The same daemon is reachable as ~180 MCP tools, so an agent can orchestrate other agents.

**How we do it differently:** A supervising daemon plus a single event log, instead of a wrapper around one CLI.

**Why that's better:** The user sees one source of truth for what every agent is doing and what is queued, blocked or done.

**Why customers choose us:** Evidence on file: **none** (no customers, interviews or reviews). Do not write a customer-reason claim.

## Objections
| Objection | Response |
|-----------|----------|
| "Is this safe to run on my repo?" | Worktrees isolate changes, not processes or filesystem access; an agent with full access can modify anything your OS user can. Use `readOnly` / `acceptEdits` / `full` profiles and keep `full` for trusted work. |
| "Can I install it today?" | From source, on a Mac (Apple Silicon is the tested platform). Linux has a source installer but it is unverified end to end. There is no public download yet; release installers (`npx @nedimyilmaz/chimera install`) arrive with v0.1.0. Windows is not supported. |
| "Is it production-ready?" | No. It is early access. Federation, the Kimi backend and voice are the youngest surfaces and are labelled as such. |

**Anti-persona:** Anyone who needs Windows today, a hosted/managed service, or a finished product with support guarantees. Also anyone who wants a single-agent chat UI only.

## Switching Dynamics
**Push:** Terminal-tab sprawl, context lost on every session reset, repeated rate limits on one account.
**Pull:** A visible queue, per-agent worktrees, shared notes, account/provider failover.
**Habit:** Existing Claude Code / Codex workflow in a terminal; Chimera keeps both — it supervises them rather than replacing them.
**Anxiety:** Early-stage software with broad file access; installing a daemon and login service; no public download yet; only macOS Apple Silicon is tested; Windows not supported.

## Customer Language
**How they describe the problem:** **unknown** — no verbatim customer language collected. Do not invent quotes.
**How they describe us:** **unknown.**
**Words to use:** agents, team, queue, workspace, worktree, shared memory, gate, early access.
**Words to avoid:** "autonomous engineer", "replace your team", "10x", unsubstantiated speed or savings claims, "production-ready", anything implying Windows or a published download that does not exist, and any mention of a terminal UI (retired).
**Glossary:**
| Term | Meaning |
|------|---------|
| Agent | One supervised AI coding session (Claude, Codex, Kimi or an OpenAI-compatible model) |
| Team / role | A role is a reusable agent spec minus its prompt; a team binds roles to a queue and a concurrency cap |
| Queue | Priority + FIFO task list; tasks may `dependsOn` others |
| Gate | A check that must pass for a workflow step: shell command, artifact check, human approval, critic loop |
| Conductor | An optional persistent per-project agent with its own permission profile |
| Worktree | The isolated `git worktree` each agent works in |
| Memory | The shared, searchable note store agents read and write |

## Brand Voice
**Tone:** Calm, plain, technical. Confident without hype.
**Style:** Direct, concrete verbs; says what exists and what does not. Sentence case. No exclamation points.
**Personality:** precise, candid, unhurried, builder-to-builder.

## Proof Points
**Metrics:** None. No benchmarks, usage numbers or speed claims exist; none may be published.
**Customers:** None on file.
**Testimonials:** None on file.
**Value themes:**
| Theme | Proof |
|-------|-------|
| See every agent in one place | Actual Chimera UI screenshots with fictional demo data (Atlas website) |
| Work in parallel without collisions | One git worktree per agent (README, `packages/core`) |
| Ordered work | Queue tasks with `dependsOn`, `blocked` state and retries |
| Context that survives | Shared memory with hybrid search and backlinks |
| Honest limits | The README "Status and limitations" section |

## Goals
**Business goal:** Make the project understandable and trustworthy to the first developers who might try it. Revenue goals: **unknown**.
**Conversion action:** "Explore on GitHub" (https://github.com/nedimYilmaz/chimera); secondary: run the source install.
**Current metrics:** **unknown** (no analytics on the page by design).

## Copy decisions (landing page)
**Hero headline (chosen):** Your agents. One workspace.
**Alternatives:**
- A: "Run Claude and Codex as one team." — names both providers; stronger for search, less evocative.
- B: "One desk for your whole agent team." — warmer, vaguer about what it does.
- C: "Stop juggling terminals. Run the team." — pain-first, but leans on a negative.

**Primary CTA (chosen):** Explore on GitHub. Alternatives: "Read the source", "Run it from source" (secondary, kept as a link to the install section).

**Meta title:** Chimera — one desktop workspace for Claude and Codex agent teams
**Meta description:** Open-source desktop workspace for Claude and Codex agent teams: queues, shared memory and every running task in view, each agent in its own git worktree.

**Screenshot caption rule:** Use exactly "Actual Chimera interface · demo data". Keep captions short; do not add disclaimers. Never publish usage or benchmark numbers.
