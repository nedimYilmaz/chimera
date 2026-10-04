import { expect, it } from "vitest";
import { decodeFrames } from "../src/index.js";

it("ignores valid JSON scalars and arrays rather than crashing downstream dispatch", () => {
  const { frames, rest } = decodeFrames('null\n42\ntrue\n"text"\n[]\n{"id":"1","type":"request","method":"daemon.hello"}\n');
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ id: "1", type: "request" });
  expect(rest).toBe("");
});
