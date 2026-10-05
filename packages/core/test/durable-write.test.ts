import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileDurable, fsyncDirectory, realDurableWriteDeps, type DurableWriteDeps } from "@chimera/core/durable-write";

function tmpTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), "chimera-durable-write-"));
  return join(dir, "state.json");
}

describe("writeFileDurable", () => {
  it("writes the target file with the given content and leaves no .tmp behind", () => {
    const target = tmpTarget();
    writeFileDurable(target, JSON.stringify({ hello: "world" }));
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ hello: "world" }));
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("overwrites existing content atomically", () => {
    const target = tmpTarget();
    writeFileDurable(target, "first");
    writeFileDurable(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  it("calls deps in the durable order: write+fsync the tmp file, THEN rename, THEN fsync the containing dir", () => {
    const target = tmpTarget();
    const calls: string[] = [];
    const wrap = (label: string, real: (...a: unknown[]) => unknown) =>
      ((...args: unknown[]) => { calls.push(label === "open" ? `open:${String(args[0])}` : label); return real(...args); }) as unknown;
    const deps = {
      openSync: wrap("open", realDurableWriteDeps.openSync as unknown as (...a: unknown[]) => unknown),
      writeSync: wrap("write", realDurableWriteDeps.writeSync as unknown as (...a: unknown[]) => unknown),
      fsyncSync: wrap("fsync", realDurableWriteDeps.fsyncSync as unknown as (...a: unknown[]) => unknown),
      closeSync: wrap("close", realDurableWriteDeps.closeSync as unknown as (...a: unknown[]) => unknown),
      renameSync: wrap("rename", realDurableWriteDeps.renameSync as unknown as (...a: unknown[]) => unknown),
    } as unknown as DurableWriteDeps;
    writeFileDurable(target, "content", deps);
    // tmp file: open -> write -> fsync -> close, THEN rename, THEN dir: open -> fsync -> close
    expect(calls).toEqual([
      `open:${target}.tmp`, "write", "fsync", "close",
      "rename",
      `open:${dirname(target)}`, "fsync", "close",
    ]);
  });

  it("a crash between the tmp write and the rename leaves the PRIOR target file intact (no torn state)", () => {
    const target = tmpTarget();
    writeFileSync(target, "known-good");
    const deps: DurableWriteDeps = {
      ...realDurableWriteDeps,
      renameSync: (() => { throw new Error("simulated crash before rename"); }) as unknown as DurableWriteDeps["renameSync"],
    };
    expect(() => writeFileDurable(target, "new-content", deps)).toThrow("simulated crash before rename");
    expect(readFileSync(target, "utf8")).toBe("known-good");   // untouched — rename never landed
    expect(readFileSync(`${target}.tmp`, "utf8")).toBe("new-content");   // new data safely off to the side
  });
});

// Windows refuses fsync on a directory handle with EPERM; the daemon's first state write threw it
// and the daemon never came up. These run on every host by injecting the platform.
describe("directory fsync on Windows", () => {
  const recording = (): { deps: DurableWriteDeps; opened: string[] } => {
    const opened: string[] = [];
    const deps = {
      ...realDurableWriteDeps,
      openSync: ((path: string, flags: string) => { opened.push(String(path)); return realDurableWriteDeps.openSync(path, flags); }) as DurableWriteDeps["openSync"],
    };
    return { deps, opened };
  };

  it("writeFileDurable never opens the containing directory on win32", () => {
    const target = tmpTarget();
    const { deps, opened } = recording();
    writeFileDurable(target, "content", deps, "win32");
    expect(readFileSync(target, "utf8")).toBe("content");
    expect(opened).toEqual([`${target}.tmp`]);
  });

  it("still fsyncs the directory everywhere else", () => {
    const target = tmpTarget();
    const { deps, opened } = recording();
    writeFileDurable(target, "content", deps, "linux");
    expect(opened).toEqual([`${target}.tmp`, dirname(target)]);
  });

  it("fsyncDirectory is a no-op on win32 even when the directory cannot be opened", () => {
    const { deps, opened } = recording();
    expect(() => fsyncDirectory("/nonexistent/chimera-dir", deps, "win32")).not.toThrow();
    expect(opened).toEqual([]);
  });
});
