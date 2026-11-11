import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

describe("constrained collection validation", () => {
  it.each(["max", "length"] as const)("refuses an oversized array before parsing children (%s)", mode => {
    const child = vi.fn((value: unknown) => value);
    const schema = z.array(z.preprocess(child, z.string()))[mode](2);
    const refused = schema.safeParse(Array.from({ length: 128 }, () => ({ invalid: true })));
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues.map(issue => issue.code)).toEqual(["too_big"]);
    expect(child).not.toHaveBeenCalled();
    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(child).toHaveBeenCalledTimes(2);
    if (mode === "max") expect(schema.parse(["a"])).toEqual(["a"]);
  });

  it("refuses an oversized set before parsing children and accepts its boundary", () => {
    const child = vi.fn((value: unknown) => value);
    const schema = z.set(z.preprocess(child, z.string())).max(2);
    const refused = schema.safeParse(new Set(Array.from({ length: 128 }, () => ({ invalid: true }))));
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues.map(issue => issue.code)).toEqual(["too_big"]);
    expect(child).not.toHaveBeenCalled();
    expect(schema.parse(new Set(["a", "b"]))).toEqual(new Set(["a", "b"]));
    expect(child).toHaveBeenCalledTimes(2);
    expect(schema.parse(new Set())).toEqual(new Set());
  });

  it("refuses an oversized map before parsing keys or values and accepts its boundary", () => {
    const key = vi.fn((value: unknown) => value), value = vi.fn((input: unknown) => input);
    const schema = z.map(z.preprocess(key, z.string()), z.preprocess(value, z.number())).check(z.maxSize(2));
    const refused = schema.safeParse(new Map(Array.from({ length: 128 }, (_, i) => [i, { invalid: true }])));
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues.map(issue => issue.code)).toEqual(["too_big"]);
    expect(key).not.toHaveBeenCalled();
    expect(value).not.toHaveBeenCalled();
    expect(schema.parse(new Map([["a", 1], ["b", 2]]))).toEqual(new Map([["a", 1], ["b", 2]]));
    expect(key).toHaveBeenCalledTimes(2);
    expect(value).toHaveBeenCalledTimes(2);
    expect(schema.parse(new Map())).toEqual(new Map());
  });
});
