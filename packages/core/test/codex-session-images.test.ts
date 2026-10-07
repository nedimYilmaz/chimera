import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open as openAsync, opendir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionImages } from "@chimera/core/backends/codex-session-images";
import { CodexAgentBackend, normalizeCodexEvent, type CodexFactory } from "@chimera/core/backends/codex";
import { TOOL_OUTPUT_IMAGE_MAX_BYTES } from "@chimera/core/backends/tool-result-images";
import type { BackendEvent } from "@chimera/core/backend";
import { EventLog } from "@chimera/core/events";
import { initialState, reduce } from "../../ui-state/src/index.js";
import { cxSpec } from "./codex-backend-helpers.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir) };
});

// Captured event_msg/item_completed shape from exec 0.160.0; all identifiers,
// prompt/path and image bytes replaced. No provider request is made by this test.
const captured = JSON.parse(readFileSync(new URL("./fixtures/codex-exec-native-image.json", import.meta.url), "utf8"));
const id = captured.payload.thread_id;
const turn = captured.payload.turn_id;
const png = captured.payload.item.result;
const homes: string[] = [];
const line = (value: unknown) => JSON.stringify(value) + "\n";
const meta = (owner = id) => line({ type: "session_meta", payload: { id: owner } });
const start = (timestamp = Date.now(), turnId = turn) => line({ type: "event_msg", timestamp: new Date(timestamp).toISOString(), payload: { type: "task_started", turn_id: turnId } });
const image = (over: Record<string, unknown> = {}, payloadOver: Record<string, unknown> = {}, timestamp = Date.now()) => line({ ...captured,
  timestamp: new Date(timestamp).toISOString(), payload: { ...captured.payload, ...payloadOver, item: { ...captured.payload.item, ...over } } });
function fixture(content = meta()) {
  const home = mkdtempSync(join(tmpdir(), "chimera-codex-images-")); homes.push(home);
  const dir = join(home, "sessions", "2026", "10", "07"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${id}.jsonl`); writeFileSync(path, content);
  return { home, path };
}
const normalized = (events: any[]) => events.flatMap(event => normalizeCodexEvent(event) ?? []) as BackendEvent[];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("Codex exec native image rollout delivery", () => {
  it("stops after an ambiguous second turn start, never attributing an old completion to the invocation", async () => {
    const { home } = fixture(meta() + start() + start(Date.now(), "33333333-3333-3333-3333-333333333333") + image());
    const rows = await new CodexSessionImages(home, id, 0).read();
    expect(rows).toEqual([{ type: "image_output.warning", reason: "ambiguous-turn" }]);
  });

  it("bounds discovery work, total/per-pass bytes and cooperative elapsed work", async () => {
    const { home } = fixture(meta() + start() + image());
    for (const [limits, reason] of [
      [{ maxDiscoveryEntries: 1 }, "discovery-limit"],
      [{ maxDiscoveryDirectories: 1 }, "discovery-limit"],
      [{ maxTotalReadBytes: 80 }, "scan-limit"],
      [{ maxReadBytes: 80 }, "read-limit"],
    ] as const) {
      expect(await new CodexSessionImages(home, id, 0, { limits }).read()).toEqual([{ type: "image_output.warning", reason }]);
    }
    let clock = 0;
    expect(await new CodexSessionImages(home, id, 0, { now: () => ++clock, limits: { maxDiscoveryMs: 1 } }).read())
      .toEqual([{ type: "image_output.warning", reason: "discovery-limit" }]);
    for (const limits of [{ maxReadMs: 1 }, { maxTotalReadMs: 1 }]) {
      clock = 0;
      expect(await new CodexSessionImages(home, id, 0, { now: () => ++clock, limits }).read())
        .toEqual([{ type: "image_output.warning", reason: "read-work-limit" }]);
    }
    const cumulative = new CodexSessionImages(home, id, 0, { limits: { maxTotalReadBytes: 1000 } });
    await cumulative.prime();
    expect(await cumulative.read()).toEqual([]);
    appendFileSync(join(home, "sessions", "2026", "10", "07", `rollout-${id}.jsonl`), start() + image());
    expect(await cumulative.read()).toEqual([{ type: "image_output.warning", reason: "scan-limit" }]);
  });

  it("rejects a nonregular matching path before any file read and finds a newly flushed session", async () => {
    const { home, path } = fixture(); rmSync(path); mkdirSync(path);
    // Exercise filesystem identity/rediscovery independently of CI scheduling latency.
    // The separate deadline controls below retain the production elapsed-work bounds.
    const options = { now: () => 0 };
    vi.mocked(openAsync).mockClear();
    expect(await new CodexSessionImages(home, id, 0, options).read()).toEqual([{ type: "image_output.warning", reason: "nonregular-rollout" }]);
    expect(openAsync).not.toHaveBeenCalled();
    rmSync(path, { recursive: true });
    const reader = new CodexSessionImages(home, id, 0, options);
    expect(await reader.read()).toEqual([]);
    writeFileSync(path, meta() + start() + image());
    expect(normalized(await reader.read()).at(-1)?.data.images).toEqual([{ mediaType: "image/png", data: png }]);
  });

  it("reports the default discovery deadline if filesystem work exhausts the budget", async () => {
    const { home } = fixture(meta() + start() + image());
    let clock = 0;
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(opendir).mockImplementationOnce(async (...args: Parameters<typeof opendir>) => {
      const directory = await actual.opendir(...args);
      clock = 101;
      return directory;
    });
    vi.mocked(openAsync).mockClear();
    const reader = new CodexSessionImages(home, id, 0, { now: () => clock });
    expect(await reader.read()).toEqual([{ type: "image_output.warning", reason: "discovery-limit" }]);
    expect(openAsync).not.toHaveBeenCalled();
    expect(await reader.read()).toEqual([]);
  });

  it("fails closed for ambiguous discovery, truncated files and missing/incomplete final identity", async () => {
    const { home, path } = fixture(meta() + start() + image());
    const another = join(home, "sessions", "2026", "10", "08"); mkdirSync(another);
    const duplicate = join(another, `rollout-${id}.jsonl`); writeFileSync(duplicate, meta());
    expect(await new CodexSessionImages(home, id, 0).read()).toEqual([{ type: "image_output.warning", reason: "ambiguous-session" }]);
    rmSync(duplicate);
    const reader = new CodexSessionImages(home, id, 0); await reader.prime();
    writeFileSync(path, meta());
    expect(await reader.read()).toEqual([{ type: "image_output.warning", reason: "rollout-replaced" }]);
    writeFileSync(path, meta() + start() + image().slice(0, -1));
    const partial = new CodexSessionImages(home, id, 0);
    expect(await partial.read()).toEqual([]);
    expect(await partial.read(true)).toEqual([{ type: "image_output.warning", reason: "incomplete-record" }]);
    writeFileSync(path, "");
    const newFile = new CodexSessionImages(home, id, 0);
    expect(await newFile.read()).toEqual([]);
    writeFileSync(path, meta() + start() + image());
    expect(normalized(await newFile.read(true)).at(-1)?.data.images).toEqual([{ mediaType: "image/png", data: png }]);
    expect(await new CodexSessionImages(home + "-absent", id, 0).read(true)).toEqual([{ type: "image_output.warning", reason: "missing-rollout" }]);
  });

  it("skips giant unrelated JSON lines with a visible omission and still captures the following bounded image", async () => {
    const { home, path } = fixture(meta() + start());
    const huge = "private-unrelated-text".repeat(400_000);
    appendFileSync(path, line({ type: "response_item", payload: { text: huge } }) + image());
    const rows = normalized(await new CodexSessionImages(home, id, 0).read());
    expect(rows[0]?.data).toMatchObject({ role: "system", text: "Codex native image output omitted (record-too-large)." });
    expect(rows.at(-1)?.data.images).toEqual([{ mediaType: "image/png", data: png }]);
    expect(JSON.stringify(rows)).not.toContain("private-unrelated-text");
  });

  it("deduplicates repeated safety warnings and bounds completed items per invocation", async () => {
    const { home, path } = fixture(meta() + start());
    const reader = new CodexSessionImages(home, id, 0);
    const giant = line({ type: "response_item", payload: { text: "x".repeat(8 * 1024 * 1024) } });
    appendFileSync(path, giant);
    expect(await reader.read()).toEqual([{ type: "image_output.warning", reason: "record-too-large" }]);
    appendFileSync(path, giant);
    expect(await reader.read()).toEqual([]);
    appendFileSync(path, image());
    expect(normalized(await reader.read()).at(-1)?.data.images).toEqual([{ mediaType: "image/png", data: png }]);
    const many = fixture(meta() + start() + Array.from({ length: 65 }, (_, index) => image({ id: `image-${index}` })).join(""));
    const rows = await new CodexSessionImages(many.home, id, 0).read();
    expect(rows.filter(row => row.type === "item.completed")).toHaveLength(64);
    expect(rows.at(-1)).toEqual({ type: "image_output.warning", reason: "too-many-records" });
  });

  it("publishes safety omissions as an owning system transcript message without images", () => {
    const row = normalized([{ type: "image_output.warning", reason: "scan-limit" }])[0]!;
    expect(row.kind).toBe("message_complete");
    const state = reduce(initialState, { type: "event", event: { ...row, agentId: "owner", seq: 1, ts: 1 } });
    expect(state.agents.owner!.transcript).toEqual([expect.objectContaining({ role: "system", text: "Codex native image output omitted (scan-limit)." })]);
    expect(state.agents.owner!.transcript[0]).not.toHaveProperty("images");
  });

  it("preserves available image output at turn.failed without consuming another provider frame or queued continuation", async () => {
    const { home, path } = fixture(meta());
    let closed = false; let resumedAfterFailure = false; let runs = 0;
    const factory: CodexFactory = () => ({
      startThread: () => ({ id, runStreamed: async () => { runs++; return { events: (async function* () {
        try {
          appendFileSync(path, start());
          yield { type: "thread.started", thread_id: id };
          yield { type: "turn.started" };
          appendFileSync(path, image());
          yield { type: "turn.failed", error: { message: "provider failed" } };
          resumedAfterFailure = true;
          yield { type: "item.completed", item: { id: "late-text", type: "agent_message", text: "must not become success" } };
        } finally { closed = true; }
      })() }; } }),
      resumeThread() { return this.startThread(); },
    });
    const events: BackendEvent[] = [];
    const spec = cxSpec({ resume: id }); spec.env.CODEX_HOME = home;
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(spec, event => events.push(event), async () => true);
    await handle.send("queued continuation");
    await vi.waitFor(() => expect(closed).toBe(true));
    await vi.waitFor(() => expect(events.some(event => event.kind === "tool_result")).toBe(true));
    expect(runs).toBe(1);
    expect(resumedAfterFailure).toBe(false);
    expect(events.filter(event => event.kind === "tool_result")).toHaveLength(1);
    expect(events.some(event => event.kind === "result" || event.data.text === "must not become success")).toBe(false);
    expect(events.find(event => event.kind === "error")?.data.message).toBe("provider failed");
  });

  it("closes promptly when the provider would never yield again after failure", async () => {
    const { home, path } = fixture(meta());
    let closed = false; let nextAfterFailure = false; let runs = 0;
    const factory: CodexFactory = () => ({
      startThread: () => ({ id, runStreamed: async (_input, options) => {
        runs++;
        return { events: (async function* () {
          try {
            appendFileSync(path, start());
            yield { type: "thread.started", thread_id: id };
            yield { type: "turn.started" };
            yield { type: "turn.failed", error: { message: "terminal failure" } };
            nextAfterFailure = true;
            await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          } finally { closed = true; }
        })() };
      } }),
      resumeThread() { return this.startThread(); },
    });
    const events: BackendEvent[] = []; const spec = cxSpec({ resume: id }); spec.env.CODEX_HOME = home;
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(spec, event => events.push(event), async () => true);
    try {
      await handle.send("must not execute");
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(nextAfterFailure).toBe(false);
      expect(runs).toBe(1);
      expect(events.filter(event => event.kind === "error")).toHaveLength(1);
      expect(events.some(event => event.kind === "result")).toBe(false);
      await expect(handle.send("too late")).rejects.toThrow("input stream closed");
    } finally { await handle.kill(); }
  });

  it("retains abort-flushed completed output before a queued turn and deduplicates only within its owning turn", async () => {
    const { home, path } = fixture(meta());
    const nextTurn = "33333333-3333-3333-3333-333333333333";
    let runs = 0; let waiting = false;
    const factory: CodexFactory = () => ({
      startThread: () => ({ id, runStreamed: async (_input, options) => {
        const current = ++runs;
        return { events: (async function* () {
          const ownerTurn = current === 1 ? turn : nextTurn;
          appendFileSync(path, start(Date.now(), ownerTurn));
          yield { type: "thread.started", thread_id: id };
          yield { type: "turn.started" };
          if (current === 1) {
            try {
              waiting = true;
              await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
            } finally { appendFileSync(path, image({ id: "reused-id" })); }
          } else {
            appendFileSync(path, image({ id: "reused-id" }, { turn_id: ownerTurn }));
            appendFileSync(path, image({ id: "reused-id" }, { turn_id: ownerTurn }));
            yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "continued" } };
            yield { type: "turn.completed", usage: {} };
          }
        })() };
      } }),
      resumeThread() { return this.startThread(); },
    });
    const events: BackendEvent[] = [];
    const spec = cxSpec({ resume: id }); spec.env.CODEX_HOME = home;
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(spec, event => events.push(event), async () => true);
    try {
      await vi.waitFor(() => expect(waiting).toBe(true));
      await handle.send("queued continuation");
      await handle.interrupt();
      await vi.waitFor(() => expect(events.some(event => event.kind === "result")).toBe(true));
      const results = events.filter(event => event.kind === "tool_result");
      expect(results.map(event => event.data.toolId)).toEqual(["reused-id", "reused-id"]);
      expect(events.indexOf(results[0]!)).toBeLessThan(events.findIndex(event => event.kind === "turn_complete" && event.data.interrupted));
      expect(events.at(-1)?.data.text).toBe("continued");
      expect(events.filter(event => event.kind === "result")).toHaveLength(1);
      expect(runs).toBe(2);
      expect(events.some(event => event.kind === "error")).toBe(false);
    } finally { await handle.kill(); }
  });

  it("keeps completed images and visible warnings from implying a successful failed or interrupted result", async () => {
    for (const outcome of ["failed", "interrupted", "missing"] as const) {
      const { home, path } = fixture(meta());
      const factory: CodexFactory = () => ({
        startThread: () => ({ id, runStreamed: async () => ({ events: (async function* () {
          appendFileSync(path, start() + image());
          yield { type: "thread.started", thread_id: id };
          yield { type: "turn.started" };
          if (outcome === "failed") yield { type: "turn.failed", error: { message: "failure" } };
          else if (outcome === "interrupted") yield { type: "turn.completed", interrupted: true, usage: {} };
        })() }) }),
        resumeThread() { return this.startThread(); },
      });
      const events: BackendEvent[] = []; const spec = cxSpec({ resume: id }); spec.env.CODEX_HOME = home;
      new CodexAgentBackend({ codexFactory: factory }).spawn(spec, event => events.push(event), async () => true);
      await vi.waitFor(() => expect(events.some(event => event.kind === "error")).toBe(true));
      expect(events.filter(event => event.kind === "tool_result")).toHaveLength(1);
      expect(events.some(event => event.kind === "result")).toBe(false);
    }
  });
  it("delivers the captured extension through the existing correlated image normalizer, without raw copies or saved paths", async () => {
    const { home } = fixture(meta() + start() + image());
    const rows = normalized(await new CodexSessionImages(home, id, 0).read());
    expect(rows.map(row => row.kind)).toEqual(["tool_call", "tool_result"]);
    expect(rows[1]!.data).toMatchObject({ toolId: "exec-sanitized-generation", images: [{ mediaType: "image/png", data: png }] });
    expect(JSON.stringify(rows.map(row => row.raw))).not.toContain(png);
    expect(JSON.stringify(rows)).not.toContain("/synthetic/");
    expect(JSON.stringify(rows)).not.toContain("private prompt");
  });

  it("persists the normalized payload once and replays it into only its owning transcript", async () => {
    const { home } = fixture(meta() + start() + image());
    const rows = normalized(await new CodexSessionImages(home, id, 0).read());
    const log = new EventLog(home);
    log.append({ agentId: "other", kind: "tool_call", data: { toolId: captured.payload.item.id, toolName: "parallel" } });
    for (const row of rows) log.append({ ...row, agentId: "owner" });
    const bytes = readFileSync(join(home, "events", "events.jsonl"), "utf8");
    expect(bytes.split(png)).toHaveLength(2);
    const replay = new EventLog(home).replay({ limit: 20 });
    const live = replay.reduce((state, event) => reduce(state, { type: "event", event }), initialState);
    expect(live.agents.owner!.transcript).toEqual([expect.objectContaining({ role: "tool", status: "done", images: [{ mediaType: "image/png", data: png }] })]);
    expect(live.agents.other!.transcript[0]).not.toHaveProperty("images");
    const history = reduce(initialState, { type: "backfillHistory", agentId: "owner", events: replay });
    expect(history.agents.owner!.transcript).toEqual(live.agents.owner!.transcript);
    expect(history.agents.other).toBeUndefined();
    expect(reduce(history, { type: "backfillHistory", agentId: "owner", events: replay }).agents.owner!.transcript).toEqual(history.agents.owner!.transcript);
  });

  it("keeps a recovered completion done when delayed stdout starts the same tool afterwards", async () => {
    const { home, path } = fixture(meta());
    const factory: CodexFactory = () => ({
      startThread: () => ({ id, runStreamed: async () => ({ events: (async function* () {
        appendFileSync(path, start() + image());
        yield { type: "thread.started", thread_id: id };
        yield { type: "turn.started" };
        yield { type: "item.started", item: { ...captured.payload.item, type: "imageGeneration" } };
        yield { type: "turn.completed", usage: {} };
      })() }) }),
      resumeThread() { return this.startThread(); },
    });
    const events: BackendEvent[] = [];
    const spec = cxSpec({ resume: id }); spec.env.CODEX_HOME = home;
    new CodexAgentBackend({ codexFactory: factory }).spawn(spec, event => events.push(event), async () => true);
    await vi.waitFor(() => expect(events.some(event => event.kind === "result")).toBe(true));
    expect(events.filter(event => ["tool_call", "tool_result"].includes(event.kind)).map(event => event.kind)).toEqual(["tool_call", "tool_result"]);
  });

  it("skips resumed history, incrementally finishes split records and deduplicates repeat completions", async () => {
    const { home, path } = fixture(meta() + start() + image());
    const reader = new CodexSessionImages(home, id, 0); await reader.prime();
    expect(await reader.read()).toEqual([]);
    appendFileSync(path, start());
    const current = image({ id: "new-image" });
    appendFileSync(path, current.slice(0, -20));
    expect(await reader.read()).toEqual([]);
    appendFileSync(path, current.slice(-20));
    expect(normalized(await reader.read()).at(-1)?.data.toolId).toBe("new-image");
    appendFileSync(path, current);
    expect(await reader.read()).toEqual([]);
  });

  it("rejects wrong session, thread, turn, historical timestamps and records without a current task start", async () => {
    const foreign = "33333333-3333-3333-3333-333333333333";
    for (const [content, reason] of [
      [meta(foreign) + start() + image(), "invalid-session-identity"],
      [meta() + start() + image({}, { thread_id: foreign }), "wrong-image-owner"],
      [meta() + start() + image({}, { turn_id: foreign }), "wrong-image-owner"],
      [meta() + start(1) + image({}, {}, 1), undefined],
      [meta() + image(), "missing-turn-identity"],
    ]) {
      const { home } = fixture(content);
      expect(await new CodexSessionImages(home, id, Date.now() - 1000).read()).toEqual(reason ? [{ type: "image_output.warning", reason }] : []);
    }
    const { home } = fixture(meta() + start() + image());
    expect(await new CodexSessionImages(home, "../../secrets", 0).read()).toEqual([{ type: "image_output.warning", reason: "invalid-session-id" }]);
  });

  it("does not follow symlinks or consume a replaced rollout", async () => {
    const { home, path } = fixture(meta() + start() + image());
    renameSync(path, path + ".original"); symlinkSync(path + ".original", path);
    const symlinkReader = new CodexSessionImages(home, id, 0);
    expect(await symlinkReader.read()).toEqual([{ type: "image_output.warning", reason: "nonregular-rollout" }]);
    expect(await symlinkReader.read()).toEqual([]);
    rmSync(path); renameSync(path + ".original", path);
    const reader = new CodexSessionImages(home, id, 0); await reader.prime();
    renameSync(path, path + ".original"); writeFileSync(path, meta() + start() + image());
    expect(await reader.read()).toEqual([{ type: "image_output.warning", reason: "rollout-replaced" }]);
  });

  it("makes oversized/malformed/failing output explicit and never invents an image from a savedPath", async () => {
    const large = Buffer.alloc(TOOL_OUTPUT_IMAGE_MAX_BYTES + 1); Buffer.from(png, "base64").copy(large);
    for (const [item, expected] of [
      [{ result: large.toString("base64") }, { imageOutputWarnings: ["too-large"] }],
      [{ result: "malformed" }, { imageOutputWarnings: ["invalid-or-unsupported"] }],
      [{ result: null, savedPath: "/synthetic/exists.png" }, { imageOutputWarnings: ["invalid-or-unsupported"] }],
      [{ status: "failed", failure: { type: "usageLimitExceeded" }, result: "" }, { isError: true, result: "Image generation failed" }],
    ] as const) {
      const { home } = fixture(meta() + start() + image(item));
      const rows = normalized(await new CodexSessionImages(home, id, 0).read());
      expect(rows.at(-1)?.data).toMatchObject(expected);
      expect(rows.at(-1)?.data.images).toBeUndefined();
      expect(JSON.stringify(rows.map(row => row.raw))).not.toContain(large.toString("base64"));
    }
    const { home, path } = fixture(meta() + start());
    appendFileSync(path, image({ result: "x".repeat(8 * 1024 * 1024) }));
    appendFileSync(path, image({ id: "after-large" }));
    const rows = normalized(await new CodexSessionImages(home, id, 0).read());
    expect(rows[0]?.data).toMatchObject({ imageOutputOmitted: true, reason: "record-too-large" });
    expect(rows.at(-1)?.data.toolId).toBe("after-large");
    expect(await new CodexSessionImages(home + "-missing", id, 0).read()).toEqual([]);
  });

  it.each(["none", "imageGeneration", "Extension"])("delivers missing exec output once with stdout=%s, including exit flush", async (forwarded) => {
    const { home, path } = fixture(meta() + start() + image({ id: "old-image" }));
    const factory: CodexFactory = () => ({
      startThread: () => ({ id, runStreamed: async () => ({ events: (async function* () {
        appendFileSync(path, start());
        yield { type: "thread.started", thread_id: id };
        yield { type: "turn.started" };
        appendFileSync(path, image());
        if (forwarded !== "none") yield { type: "item.completed", item: { ...captured.payload.item, type: forwarded } };
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } };
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
        appendFileSync(path, image({ id: "exit-image" }));
      })() }) }),
      resumeThread() { return this.startThread(); },
    });
    const events: BackendEvent[] = [];
    const log = new EventLog(home);
    log.append({ agentId: "other", kind: "tool_call", data: { toolId: captured.payload.item.id, toolName: "parallel" } });
    const spec = cxSpec({ resume: id }); spec.env.CODEX_HOME = home;
    new CodexAgentBackend({ codexFactory: factory }).spawn(spec, event => {
      events.push(event); log.append({ ...event, agentId: "owner" });
    }, async () => true);
    await vi.waitFor(() => expect(events.some(event => event.kind === "result")).toBe(true));
    const results = events.filter(event => event.kind === "tool_result");
    expect(results.map(event => event.data.toolId)).toEqual(["exec-sanitized-generation", "exit-image"]);
    expect(results.every(event => (event.data.images as any[])[0].data === png)).toBe(true);
    expect(events.findIndex(event => event === results[0])).toBeLessThan(events.findIndex(event => event.kind === "turn_complete"));
    expect(JSON.stringify(results.map(event => event.raw))).not.toContain(png);
    expect(events.at(-1)?.kind).toBe("result");
    const stored = readFileSync(join(home, "events", "events.jsonl"), "utf8");
    expect(stored.split(png)).toHaveLength(3);
    const replay = new EventLog(home).replay({ limit: 100 });
    const state = replay.reduce((state, event) => reduce(state, { type: "event", event }), initialState);
    expect(state.agents.owner!.transcript.filter(item => item.images?.length)).toHaveLength(2);
    expect(state.agents.other!.transcript[0]).not.toHaveProperty("images");
    const backfill = reduce(initialState, { type: "backfillHistory", agentId: "owner", events: replay });
    expect(backfill.agents.owner!.transcript).toEqual(state.agents.owner!.transcript);
    expect(backfill.agents.other).toBeUndefined();
  });
});
