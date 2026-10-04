import { describe, expect, it, vi } from "vitest";

const openArtifactUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/rpc/bridge", () => ({ openArtifactUrl }));

const { isOpenableLinkUrl, openInlineLinkUrl } = await import("../src/components/linkUrl");

// CLICKABLE-LINKS: the scheme allowlist is the real security boundary — an
// arbitrary scheme handed to the OS opener is worse than a live <a> in the
// webview, so only http(s) may ever reach openArtifactUrl.
describe("isOpenableLinkUrl", () => {
  it("allows http and https", () => {
    expect(isOpenableLinkUrl("http://example.com")).toBe(true);
    expect(isOpenableLinkUrl("https://example.com/path?x=1")).toBe(true);
  });

  it("rejects file, javascript, data, and custom schemes", () => {
    expect(isOpenableLinkUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isOpenableLinkUrl("myapp://do-something")).toBe(false);
  });

  it("rejects unparseable urls", () => {
    expect(isOpenableLinkUrl("not a url")).toBe(false);
    expect(isOpenableLinkUrl("")).toBe(false);
  });
});

describe("openInlineLinkUrl", () => {
  it("forwards an http(s) url to the opener command", async () => {
    openInlineLinkUrl("https://example.com");
    await new Promise((r) => setTimeout(r, 0));
    expect(openArtifactUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("never forwards a disallowed scheme to the opener command", async () => {
    openArtifactUrl.mockClear();
    openInlineLinkUrl("javascript:alert(1)");
    openInlineLinkUrl("file:///etc/passwd");
    openInlineLinkUrl("data:text/html,x");
    await new Promise((r) => setTimeout(r, 0));
    expect(openArtifactUrl).not.toHaveBeenCalled();
  });
});
