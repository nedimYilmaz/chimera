import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDoctor, supportReport } from "../src/doctor.js";

describe("offline doctor and private support reports", () => {
  it("checks prerequisites without starting a daemon", () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-doctor-"));
    const report = collectDoctor(home, { nodeVersion: "22.0.0", commandAvailable: () => false });
    expect(report.ok).toBe(false);
    expect(report.checks.find(c => c.id === "node")?.status).toBe("error");
    expect(report.checks.find(c => c.id === "config")?.status).toBe("warn");
  });
  it("never includes configuration contents or paths, including malformed JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-private-"));
    for (const config of ['{"apiKey":"secret-token","path":"/private/customer"}', 'secret-token invalid']) {
      writeFileSync(join(home, "config.json"), config);
      const report = supportReport(collectDoctor(home, { nodeVersion: "24.0.0", commandAvailable: () => true }));
      const text = JSON.stringify(report);
      expect(text).not.toContain("secret-token");
      expect(text).not.toContain(home);
      expect(text).not.toContain("/private/customer");
    }
  });
});
