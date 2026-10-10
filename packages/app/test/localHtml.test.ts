import { describe, expect, it } from "vitest";
import { localResourcePath } from "../src/screens/localHtml";

describe("local HTML resources", () => {
  it("resolves against the HTML/CSS file, including spaces and parent assets", () => {
    expect(localResourcePath("/project/pages/My Page.html", "../images/my%20image.png?v=1#preview")).toBe("/project/images/my image.png");
    expect(localResourcePath("/project/styles/theme.css", "../images/bg.png")).toBe("/project/images/bg.png");
    expect(localResourcePath("C:\\Project Files\\pages\\demo.html", "../images/a.png")).toBe("C:/Project Files/images/a.png");
  });
  it.each(["https://example.com/a.png", "http://localhost/a.png", "//server/share", "\\\\server\\share", "file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,AAA", "#anchor", "", "%zz"])("does not treat %s as a relative local asset", reference => {
    expect(localResourcePath("/project/a.html", reference)).toBeNull();
  });
  it("does not invent a root when an older daemon supplies no canonical path", () => {
    expect(localResourcePath(undefined, "a.png")).toBeNull();
    expect(localResourcePath("relative.html", "a.png")).toBeNull();
  });
});
