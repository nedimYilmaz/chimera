import { expect, it } from "vitest";
import { meetingRecipient } from "../src/voice/meetingRecipient";
const participants = [
  { agentId: "c", name: "chimera-codex", role: "conductor" },
  { agentId: "a", name: "Atlas", role: "agent" },
  { agentId: "n", name: "Nova", role: "agent" },
  { agentId: "s", name: "sohbet-arkadasi", role: "agent" },
];
it.each([
  ["Nasılsınız?", "c", "conductor"],
  ["Nova, fikrin nedir?", "n", "named"],
  ["Atlas'a soruyorum", "a", "named"],
  ["Sohbet arkadaşı, ne düşünüyorsun?", "s", "named"],
  ["Codex bunu düzelt", "c", "named"],
  ["Atlas ve Nova ne düşünüyorsunuz?", undefined, "ambiguous"],
  ["Atlas, Nova’nın önerisini değerlendirir misin?", "a", "named"],
  ["İnovasyon güzel", "c", "conductor"],
])("routes %s to one seat", (text, agentId, reason) => {
  expect(meetingRecipient(text, participants)).toEqual({ agentId, reason });
});

it("requires a clear leading address before routing unfinished speech", () => {
  expect(meetingRecipient("Sohbet arkadaşı ne diyorsun", participants, true)).toEqual({ agentId: "s", reason: "named" });
  expect(meetingRecipient("Atlas", participants, true)).toEqual({ reason: "pending" });
  expect(meetingRecipient("Atlas ve Nova", participants, true)).toEqual({ reason: "pending" });
  expect(meetingRecipient("Bunu Atlas", participants, true)).toEqual({ reason: "pending" });
});
