# Screenshot provenance

> Actual Chimera UI components rendered with fictional demo data. Not a live workspace, not a benchmark, not real user activity.

- Demo project: **Atlas website (fictional)** (every name, path, task, note, server and secret name is fictional)
- Captured: 2026-10-05 from source revision `8c088dc0377ee8aeacbbd40f154ca38109f9c043`
- Viewport: 1600x1000 at device scale factor 1 (Chrome/154.0.8037.93, headless)
- Rendering: Real React components on the real app store in headless Chromium; mocked RPC bridge; loopback-only network guard; no daemon, provider, account, filesystem, desktop or agent involved.
- Components: TopBar; AgentsScreen (AgentList, transcript); QueuesScreen (task list, TaskInspector, schedules panel and ScheduleDetail); MemoryScreen (FolderRail, note list, detail); SettingsScreen (MCP store section with ComputerUseCard, Secrets section); TeamsScreen (team detail, role provenance badges, RoleBindingOverrideEditor, AgentInspector); ProjectsScreen (project detail, sessions, checkpoints, FileTree, per-project settings); RolesScreen (role library, team role bindings, override editor); ComputerUseMonitor inside AgentsScreen's transcript panel (demo target); Footer
- Demo data: packages/app/test/fixtures/marketing-data.ts (workspace, queues, memory) and packages/app/test/fixtures/marketing-features.ts (MCP store, secrets, schedules, teams, roles, projects, computer-use demo); Relative to capture time; paths use the fictional /demo/atlas-website.
- Fixture notes: MCP servers are fictional entries on reserved .invalid hosts; secrets are names with masked state only, no values exist; no OAuth flow, tool call or schedule run is executed. Computer use: the monitor component is real, but its target image is a synthetic SVG drawn by the fixture and the lease, actions and status are scripted — no desktop was captured or controlled, and no permission was requested. Projects, checkpoints, files, teams and role bindings are scripted fixture data; no git, filesystem or agent exists behind them.
- Reproduce: `node scripts/marketing-preview.mjs --capture` (needs a local Chromium; set `CHIMERA_TEST_CHROME` to choose one)

| File | Size | Shows |
| --- | --- | --- |
| `chimera-workspace.png` | 1600x1000 | Workspace: fleet sidebar and the conductor's conversation |
| `chimera-queue.png` | 1600x1000 | Queue: dependency-ordered tasks with the task inspector |
| `chimera-memory.png` | 1600x1000 | Memory: shared notes, folders, links and capacity |
| `chimera-mcp-store.png` | 1600x1000 | MCP store: built-in and external servers, trust levels, OAuth status and discovered tools |
| `chimera-secrets.png` | 1600x1000 | Secrets: named secrets with masked values and per-agent access grants |
| `chimera-schedules.png` | 1600x1000 | Schedules: cron and interval jobs, retry state, and the run history of one job |
| `chimera-teams.png` | 1600x1000 | Teams: bound queue, members, role provenance badges, pinned vs inherited role settings and live workers |
| `chimera-projects.png` | 1600x1000 | Projects: checkpoints and the per-project setup / conductor-account settings |
| `chimera-roles.png` | 1600x1000 | Roles: role library beside team role bindings, with a binding's override editor showing pinned vs inherited |
| `chimera-computer-use.png` | 1600x1000 | Computer use (DEMO): the actual desktop-control monitor component showing a synthetic Atlas pricing preview |
| `og-image.png` | 1200x630 | Workspace view rendered at 1200x630 for social cards |
