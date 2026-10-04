import { describe, expect, it } from "vitest";
import { daemonEndpoint, chimeraHome } from "@chimera/core/paths";
import { homedir } from "node:os";
import { join } from "node:path";

describe("platform-local IPC addresses", () => {
  it("keeps Unix filesystem sockets and uses Windows named pipes", () => {
    expect(daemonEndpoint("/tmp/chimera", "linux")).toBe("/tmp/chimera/daemon.sock");
    const pipe = daemonEndpoint("C:\\Users\\Alice\\.chimera", "win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\chimera-[a-f0-9]{16}$/);
    expect(pipe).toBe(daemonEndpoint("c:/users/alice/.chimera/", "win32"));
    expect(pipe).not.toBe(daemonEndpoint("C:\\Users\\Bob\\.chimera", "win32"));
  });
  it("does not interpret an empty CHIMERA_HOME as the current directory", () => {
    expect(chimeraHome({ CHIMERA_HOME: "" })).toBe(join(homedir(), ".chimera"));
  });
});
