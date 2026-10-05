// Reference contract for acting on a `laya_predict` / `laya_predict_batch` answer: parse the tool
// result the Chimera MCP route returns, then decide whether the choice may be EXECUTED or must be
// handed to the LLM. Laya only ranks a finite action set; it never validates, leases or verifies
// anything, so this gate keeps the safety properties on Chimera's side of the boundary:
//   - the choice must be one of the offered actions (finite-action validation);
//   - an abstention / low-confidence flag from the server always wins;
//   - a LOCAL confidence floor is applied as well, because the server cannot be relied on to have
//     applied one (see `layaServerGatesBatch`).
// Desktop leasing and re-observation after the action stay in the agent workflow (docs/computer-use.md).

export type LayaAbstention = "passed" | "abstained" | "unevaluated";
export type LayaDecision = {
  choice: string | null;
  probabilities: Record<string, number>;
  /** max(p) -- the figure `min_confidence` gates on. */
  answerConfidence: number | null;
  /** Entropy-based and NOT calibrated (the shipped checkpoint reports invalid temperatures). Advisory only. */
  confidence: number | null;
  /** 0.3.27+ only; null on 0.3.22, which has `lowConfidence` alone. */
  abstention: LayaAbstention | null;
  abstentionThreshold: number | null;
  lowConfidence: boolean;
  model: string | null;
  device: string | null;
  /** Server-side forward-pass time; for a batch item this is the per-request average. */
  latencyMs: number | null;
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const STRUCTURED_MARKER = "\nStructured result:";

/**
 * The route delivers the same payload three ways depending on the MCP client and server version:
 * `structuredContent.result` (a JSON string), `structuredContent` itself, or a text block wrapping
 * the JSON in an `<untrusted_tool_result>` envelope. Prefer the structured forms; the text form is
 * parsed only from the part before the structured echo so the payload is never read twice.
 */
export function layaPayload(result: unknown): Json | null {
  if (!isObj(result) || result.isError === true) return null;
  const sc = result.structuredContent;
  if (isObj(sc)) {
    if (typeof sc.result === "string") {
      const parsed = tryJson(sc.result);
      if (isObj(parsed)) return parsed;
    }
    if ("answers" in sc || "requests" in sc || "package_versions" in sc) return sc;
  }
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = isObj(first) && typeof first.text === "string" ? first.text : null;
  if (text === null) return null;
  const outer = tryJson(text);
  const inner = isObj(outer) && typeof outer.text === "string" ? outer.text : text;
  const head = inner.includes(STRUCTURED_MARKER) ? inner.slice(0, inner.indexOf(STRUCTURED_MARKER)) : inner;
  const start = head.indexOf("{");
  const end = head.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const parsed = tryJson(head.slice(start, end + 1));
  return isObj(parsed) ? parsed : null;
}

function tryJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function decisionFrom(item: unknown, question: string, latencyMs: number | null): LayaDecision | null {
  if (!isObj(item) || !isObj(item.answers)) return null;
  const answer = item.answers[question];
  if (!isObj(answer) || answer.type !== "choice") return null;
  const routing = isObj(item.routing) ? item.routing : {};
  const probabilities: Record<string, number> = {};
  if (isObj(answer.probabilities)) for (const [k, v] of Object.entries(answer.probabilities)) { const n = num(v); if (n !== null) probabilities[k] = n; }
  const abstention = answer.abstention;
  return {
    choice: str(answer.choice),
    probabilities,
    answerConfidence: num(answer.answer_confidence),
    confidence: num(answer.confidence),
    abstention: abstention === "passed" || abstention === "abstained" || abstention === "unevaluated" ? abstention : null,
    abstentionThreshold: num(answer.abstention_threshold),
    lowConfidence: answer.low_confidence === true,
    model: str(routing.model),
    device: str(item.device),
    latencyMs: num(item.latency_ms) ?? latencyMs,
  };
}

export function parseLayaDecision(result: unknown, question = "action"): LayaDecision | null {
  const payload = layaPayload(result);
  return payload ? decisionFrom(payload, question, null) : null;
}

/** One entry per request, in request order; an unreadable item is null so positions stay aligned. */
export function parseLayaBatch(result: unknown, question = "action"): (LayaDecision | null)[] | null {
  const payload = layaPayload(result);
  if (!payload || !Array.isArray(payload.requests)) return null;
  const perRequest = num(payload.per_request_latency_ms);
  return payload.requests.map((item) => decisionFrom(item, question, perRequest));
}

export type LayaFallbackReason =
  | "unparseable"
  | "invalid-choice"
  | "server-abstained"
  | "missing-confidence"
  | "below-threshold";
export type LayaGate = { execute: string } | { fallback: "llm"; reason: LayaFallbackReason };

/**
 * `execute` only when the choice is an offered action AND neither the server nor the local floor
 * objects. Everything else is `fallback: "llm"` -- Laya's answer is then discarded, not retried.
 * Validation is first so an out-of-set choice can never be executed whatever its confidence.
 */
export function gateLayaDecision(decision: LayaDecision | null, actions: Iterable<string>, opts: { minConfidence: number }): LayaGate {
  if (!(opts.minConfidence >= 0 && opts.minConfidence <= 1)) throw new RangeError(`minConfidence must be in [0, 1], got ${opts.minConfidence}`);
  if (!decision) return { fallback: "llm", reason: "unparseable" };
  const offered = new Set(actions);
  if (decision.choice === null || !offered.has(decision.choice)) return { fallback: "llm", reason: "invalid-choice" };
  if (decision.abstention === "abstained" || decision.lowConfidence) return { fallback: "llm", reason: "server-abstained" };
  if (decision.answerConfidence === null) return { fallback: "llm", reason: "missing-confidence" };
  if (decision.answerConfidence < opts.minConfidence) return { fallback: "llm", reason: "below-threshold" };
  return { execute: decision.choice };
}

export type LayaChoiceRequest = {
  state: { text: string };
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
  model: string;
  min_confidence: number;
};

/**
 * `laya_predict` arguments for one finite choice. `model` is always explicit: with the default
 * "auto", non-English text can route to the multilingual checkpoint, which is a separate multi-GB
 * download the caller may not have. Pass `model: "auto"` deliberately to opt back in.
 */
export function buildLayaChoiceRequest(o: {
  task: string; observation: string; actions: Record<string, string>; minConfidence: number; model?: string; question?: string;
}): LayaChoiceRequest {
  const keys = Object.keys(o.actions);
  if (keys.length < 2) throw new RangeError("a finite choice needs at least two actions");
  if (!(o.minConfidence >= 0 && o.minConfidence <= 1)) throw new RangeError(`minConfidence must be in [0, 1], got ${o.minConfidence}`);
  return {
    state: { text: `Task: ${o.task}\nObservation: ${o.observation}` },
    questions: { [o.question ?? "action"]: { type: "choice", instructions: "Choose the next action for the observed task.", criteria: { ...o.actions } } },
    model: o.model ?? "english",
    min_confidence: o.minConfidence,
  };
}

/**
 * Whether a batch result carries the server's own gate. 0.3.22's `laya_predict_batch` has no
 * `min_confidence` parameter and silently ignores one, so every item arrives without
 * abstention/low_confidence; 0.3.27 honours it. Callers must therefore not rely on the server for
 * batch gating -- `gateLayaDecision`'s local floor is the version-independent guarantee.
 */
export function layaServerGatesBatch(batchInputSchema: unknown): boolean {
  if (!isObj(batchInputSchema) || !isObj(batchInputSchema.properties)) return false;
  return "min_confidence" in batchInputSchema.properties;
}
