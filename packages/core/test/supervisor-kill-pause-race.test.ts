import { describe, it, expect, vi } from "vitest";
import { makeSupervisor } from "./helpers.js";

describe("kill wins over an in-flight pause", () => {
  it("ignores late backend results and pause events after kill", async () => {
    const { sup, fake, events } = makeSupervisor([[{ awaitSend: true }]]);
    const spawns = vi.spyOn(fake, "spawn");
    const r = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    const sink = spawns.mock.calls[0]![1];
    await sup.kill(r.agentId);
    sink({ kind: "status", data: { state: "paused", paused: true } });
    sink({ kind: "result", data: { text: "late completion" } });
    expect(r.state).toBe("killed");
    expect(events.tail(r.agentId, 30).some((e) => e.data.paused === true || e.kind === "result")).toBe(false);
  });
  it.each(["idle", "hold"] as const)("does not return to paused after a delayed %s teardown", async (kind) => {
    const { sup, fake, events } = makeSupervisor([[{ awaitSend: true }]]);
    const spawns = vi.spyOn(fake, "spawn");
    const r = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    const handle = spawns.mock.results[0]!.value;
    let finish!: () => void;
    vi.spyOn(handle, "kill").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pausing = kind === "idle" ? sup.parkIdle(r.agentId, 1000) : sup.hold(r.agentId);
    await sup.kill(r.agentId);
    expect(r.state).toBe("killed");
    finish();
    await pausing;
    expect(r.state).toBe("killed");
    expect(events.tail(r.agentId, 30).filter((e) => e.data.paused === true)).toHaveLength(0);
  });
});
