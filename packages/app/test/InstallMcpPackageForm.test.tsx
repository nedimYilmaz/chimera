import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallMcpPackageForm } from "../src/components/InstallMcpPackageForm";
import type { McpPackageReview } from "@chimera/protocol";

const review: McpPackageReview = { reviewId: "12345678-1234-4234-9234-123456789012", packageName: "@test/mcp", version: "1.2.3", integrity: "sha512-fixture", bins: ["test-mcp", "other"], hasInstallScripts: true, expiresAt: Date.now() + 600_000 };
let renderer: ReactTestRenderer;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });
async function fixture() {
  const inspect = vi.fn(async () => review); const install = vi.fn(async () => {}); const onDone = vi.fn();
  await act(async () => { renderer = create(<InstallMcpPackageForm inspect={inspect} install={install} onDone={onDone} />); });
  const change = (label: string, value: string) => act(() => renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }));
  const click = async (text: string) => { await act(async () => { renderer.root.findAllByType("button").find((b) => b.children.join("") === text)!.props.onClick(); }); };
  change("npm package", "@test/mcp"); change("Exact version", "1.2.3");
  return { inspect, install, onDone, change, click };
}
describe("InstallMcpPackageForm", () => {
  it("requires explicit inspection and install, shows risk and preserves chosen args", async () => {
    const f = await fixture();
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
    await f.click("inspect package");
    expect(JSON.stringify(renderer.toJSON())).toContain("not a sandbox");
    expect(f.install).not.toHaveBeenCalled();
    f.change("Executable", "other"); f.change("Arguments (JSON)", '["/my/project"]');
    await f.click("install disabled");
    expect(f.install).toHaveBeenCalledExactlyOnceWith({ reviewId: review.reviewId, name: "mcp", bin: "other", args: ["/my/project"] });
    expect(f.onDone).toHaveBeenCalledOnce();
  });
  it("invalidates review when the package or version changes", async () => {
    const f = await fixture(); await f.click("inspect package");
    f.change("Exact version", "2.0.0");
    expect(renderer.root.findAllByType("button").some((b) => b.children.join("") === "install disabled")).toBe(false);
  });
  it("refuses floating versions and non-array arguments without installing", async () => {
    const f = await fixture(); f.change("Exact version", "latest"); await f.click("inspect package");
    expect(f.inspect).not.toHaveBeenCalled();
    f.change("Exact version", "1.2.3"); await f.click("inspect package");
    f.change("Arguments (JSON)", '{}'); await f.click("install disabled");
    expect(f.install).not.toHaveBeenCalled(); expect(renderer.root.findByProps({ role: "alert" })).toBeTruthy();
  });
  it("shows install failures inline and keeps the form for retry", async () => {
    const f = await fixture(); await f.click("inspect package");
    f.install.mockRejectedValueOnce({ code: "protocol", message: "Another install is in progress." });
    await f.click("install disabled");
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("in progress");
    expect(f.onDone).not.toHaveBeenCalled();
    await f.click("install disabled"); expect(f.onDone).toHaveBeenCalledOnce();
  });
});
