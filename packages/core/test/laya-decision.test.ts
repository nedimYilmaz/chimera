import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildLayaChoiceRequest, gateLayaDecision, layaPayload, layaServerGatesBatch, parseLayaBatch, parseLayaDecision, type LayaDecision } from "../src/laya-decision.js";

// Real results captured through the Chimera route (mcp_store_call) from the two releases; see the
// `_note` in each fixture. They pin the parser to what the servers actually emit, not to a guess.
const fixture = (v: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/laya-route-${v}.json`, import.meta.url)), "utf8"));
const OLD = fixture("0.3.22");
const NEW = fixture("0.3.27");
const ACTIONS = ["click", "close", "wait"];

const decision = (over: Partial<LayaDecision> = {}): LayaDecision => ({
  choice: "click", probabilities: { click: 0.97, close: 0.02, wait: 0.01 }, answerConfidence: 0.97, confidence: 0.86,
  abstention: null, abstentionThreshold: null, lowConfidence: false, model: "english", device: "mps", latencyMs: 12, ...over,
});

describe("parseLayaDecision against real route output", () => {
  it("0.3.22: a confident answer carries no server verdict at all", () => {
    const d = parseLayaDecision(OLD.predict)!;
    expect(d).toMatchObject({ choice: "click", answerConfidence: 0.9725, abstention: null, abstentionThreshold: null, lowConfidence: false, model: "english", device: "mps" });
    expect(d.probabilities).toEqual({ click: 0.9725, close: 0.0163, wait: 0.0112 });
    expect(d.latencyMs).toBe(3874.933);
  });
  it("0.3.22: low_confidence is the only abstention signal, and a gate honours it", () => {
    const d = parseLayaDecision(OLD.predictAmb)!;
    expect(d).toMatchObject({ choice: "click", answerConfidence: 0.935, lowConfidence: true, abstention: null });
    expect(gateLayaDecision(d, ACTIONS, { minConfidence: 0 })).toEqual({ fallback: "llm", reason: "server-abstained" });
  });
  it("0.3.27: adds abstention + threshold next to low_confidence", () => {
    expect(parseLayaDecision(NEW.predict)).toMatchObject({ abstention: "passed", abstentionThreshold: 0.9, lowConfidence: false });
    const d = parseLayaDecision(NEW.predictAmb)!;
    expect(d).toMatchObject({ abstention: "abstained", abstentionThreshold: 0.99, lowConfidence: true });
    expect(gateLayaDecision(d, ACTIONS, { minConfidence: 0 })).toEqual({ fallback: "llm", reason: "server-abstained" });
  });
  it("the same checkpoint yields the same choice and probabilities in both releases", () => {
    const [o, n] = [parseLayaDecision(OLD.predict)!, parseLayaDecision(NEW.predict)!];
    expect([o.choice, o.probabilities, o.answerConfidence]).toEqual([n.choice, n.probabilities, n.answerConfidence]);
  });
  it("reads the text envelope when the client only surfaces content[0].text", () => {
    const textOnly = { content: NEW.predict.content };
    expect(parseLayaDecision(textOnly)).toEqual(parseLayaDecision(NEW.predict));
    expect(layaPayload(textOnly)).toHaveProperty("answers.action.choice", "click");
  });
  it("accepts an already-structured payload and a bare JSON text block", () => {
    const payload = JSON.parse(NEW.predict.structuredContent.result);
    expect(parseLayaDecision({ structuredContent: payload })).toEqual(parseLayaDecision(NEW.predict));
    expect(parseLayaDecision({ content: [{ type: "text", text: JSON.stringify(payload) }] })).toEqual(parseLayaDecision(NEW.predict));
  });
  it("does not parse a tool error, garbage, or a non-choice answer", () => {
    expect(parseLayaDecision({ isError: true, content: [{ type: "text", text: "{}" }] })).toBeNull();
    expect(parseLayaDecision(null)).toBeNull();
    expect(parseLayaDecision({ content: [{ type: "text", text: "no json here" }] })).toBeNull();
    expect(parseLayaDecision({ structuredContent: { result: "not json" }, content: [] })).toBeNull();
    expect(parseLayaDecision({ structuredContent: { answers: { action: { type: "number", value: 3 } } } })).toBeNull();
    expect(parseLayaDecision(NEW.predict, "other_question")).toBeNull();
  });
  it("ignores non-finite or non-numeric probabilities rather than coercing them", () => {
    const d = parseLayaDecision({ structuredContent: { answers: { action: { type: "choice", choice: "wait", probabilities: { wait: 0.9, click: "high", close: null }, answer_confidence: "0.9" } } } })!;
    expect(d.probabilities).toEqual({ wait: 0.9 });
    expect(d.answerConfidence).toBeNull();
  });
});

describe("parseLayaBatch", () => {
  it("keeps request order and shares the per-request latency", () => {
    const old = parseLayaBatch(OLD.batch)!;
    expect(old.map(d => d?.choice)).toEqual(["click", "wait"]);
    expect(old.map(d => d?.latencyMs)).toEqual([383.791, 383.791]);
    expect(old.every(d => d?.abstention === null)).toBe(true);
    const next = parseLayaBatch(NEW.batch)!;
    expect(next.map(d => [d?.choice, d?.answerConfidence, d?.abstention])).toEqual([["click", 0.943, "passed"], ["wait", 0.9952, "passed"]]);
  });
  it("leaves a null in place of an unreadable item so positions stay aligned", () => {
    const batch = { structuredContent: { requests: [{ answers: { action: { type: "choice", choice: "wait", answer_confidence: 0.99 } } }, { answers: {} }, "junk"] } };
    expect(parseLayaBatch(batch)!.map(d => d?.choice ?? null)).toEqual(["wait", null, null]);
    expect(parseLayaBatch({ structuredContent: { answers: {} } })).toBeNull();
  });
});

describe("gateLayaDecision keeps finite-action validation and the LLM fallback", () => {
  it("executes only a confident, offered, un-abstained choice", () => {
    expect(gateLayaDecision(decision(), ACTIONS, { minConfidence: 0.9 })).toEqual({ execute: "click" });
    expect(gateLayaDecision(decision({ abstention: "passed", abstentionThreshold: 0.9 }), ACTIONS, { minConfidence: 0.9 })).toEqual({ execute: "click" });
  });
  it("rejects a choice outside the offered set whatever its confidence", () => {
    expect(gateLayaDecision(decision({ choice: "format_disk", answerConfidence: 1 }), ACTIONS, { minConfidence: 0 })).toEqual({ fallback: "llm", reason: "invalid-choice" });
    expect(gateLayaDecision(decision({ choice: null }), ACTIONS, { minConfidence: 0 })).toEqual({ fallback: "llm", reason: "invalid-choice" });
  });
  it("hands over on any server abstention, even when the local floor would pass", () => {
    expect(gateLayaDecision(decision({ abstention: "abstained" }), ACTIONS, { minConfidence: 0 })).toEqual({ fallback: "llm", reason: "server-abstained" });
    expect(gateLayaDecision(decision({ lowConfidence: true }), ACTIONS, { minConfidence: 0 })).toEqual({ fallback: "llm", reason: "server-abstained" });
  });
  it("applies its own floor, which is the only gate on a 0.3.22 batch item", () => {
    const old = parseLayaBatch(OLD.batch)!;
    // 0.3.22 ignored min_confidence on the batch, so neither item is flagged ...
    expect(old.every(d => d && !d.lowConfidence)).toBe(true);
    // ... yet the 0.943 item must still be held back at a 0.95 floor.
    expect(gateLayaDecision(old[0]!, ["click", "close", "wait"], { minConfidence: 0.95 })).toEqual({ fallback: "llm", reason: "below-threshold" });
    expect(gateLayaDecision(old[1]!, ["click", "close", "wait"], { minConfidence: 0.95 })).toEqual({ execute: "wait" });
  });
  it("treats a missing confidence as unsafe and a missing decision as unparseable", () => {
    expect(gateLayaDecision(decision({ answerConfidence: null }), ACTIONS, { minConfidence: 0.5 })).toEqual({ fallback: "llm", reason: "missing-confidence" });
    expect(gateLayaDecision(null, ACTIONS, { minConfidence: 0.5 })).toEqual({ fallback: "llm", reason: "unparseable" });
  });
  it("uses >= so a confidence exactly at the floor executes", () => {
    expect(gateLayaDecision(decision({ answerConfidence: 0.9 }), ACTIONS, { minConfidence: 0.9 })).toEqual({ execute: "click" });
    expect(gateLayaDecision(decision({ answerConfidence: 0.8999 }), ACTIONS, { minConfidence: 0.9 })).toEqual({ fallback: "llm", reason: "below-threshold" });
  });
  it.each([-0.1, 1.1, Number.NaN])("rejects an out-of-range floor %s instead of silently executing", floor => {
    expect(() => gateLayaDecision(decision(), ACTIONS, { minConfidence: floor })).toThrow(RangeError);
  });
});

describe("buildLayaChoiceRequest", () => {
  const actions = { click: "Click the visible button", wait: "Wait for the page to load" };
  it("matches the documented laya_predict question shape and pins the english checkpoint", () => {
    const req = buildLayaChoiceRequest({ task: "Accept the cookie banner", observation: "A banner with an Accept button is visible", actions, minConfidence: 0.9 });
    expect(req.model).toBe("english");
    expect(req.min_confidence).toBe(0.9);
    expect(req.state.text).toContain("Accept the cookie banner");
    expect(req.questions.action).toEqual({ type: "choice", instructions: "Choose the next action for the observed task.", criteria: actions });
  });
  it("copies the action map so later edits cannot change the offered set", () => {
    const mine = { ...actions };
    const req = buildLayaChoiceRequest({ task: "t", observation: "o", actions: mine, minConfidence: 0.5 });
    mine.click = "mutated";
    expect(req.questions.action!.criteria.click).toBe("Click the visible button");
  });
  it("allows an explicit model override and a custom question name", () => {
    const req = buildLayaChoiceRequest({ task: "t", observation: "o", actions, minConfidence: 0, model: "auto", question: "next" });
    expect(req.model).toBe("auto");
    expect(Object.keys(req.questions)).toEqual(["next"]);
  });
  it("refuses a one-action 'choice' and an out-of-range floor", () => {
    expect(() => buildLayaChoiceRequest({ task: "t", observation: "o", actions: { click: "x" }, minConfidence: 0.5 })).toThrow(RangeError);
    expect(() => buildLayaChoiceRequest({ task: "t", observation: "o", actions, minConfidence: 2 })).toThrow(RangeError);
  });
});

describe("layaServerGatesBatch reads the advertised schema, not the version string", () => {
  it("is false for 0.3.22's batch tool and true for 0.3.27's", () => {
    expect(Object.keys(OLD.batchTool.inputSchema.properties)).toEqual(["requests", "batch_size"]);
    expect(layaServerGatesBatch(OLD.batchTool.inputSchema)).toBe(false);
    expect(layaServerGatesBatch(NEW.batchTool.inputSchema)).toBe(true);
  });
  it("is false for anything that is not a schema", () => {
    expect(layaServerGatesBatch(undefined)).toBe(false);
    expect(layaServerGatesBatch({})).toBe(false);
  });
  it("laya_predict advertises min_confidence in both releases", () => {
    for (const f of [OLD, NEW]) expect(Object.keys(f.predictTool.inputSchema.properties)).toContain("min_confidence");
  });
});
