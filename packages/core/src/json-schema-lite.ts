// SDK-ADOPTION #4: minimal, dependency-free structural validator for the bounded JSON-Schema
// subset chimera's own resultSchema field actually documents (see AgentSpecSchema.resultSchema's
// own .describe() text: type/properties/required/items/enum/maxItems/maxLength/minLength). NOT a
// general JSON-Schema validator — deliberately does not support $ref, allOf/anyOf/oneOf/not,
// pattern, format, or any draft keyword beyond the list below. Chosen over adding ajv as a new
// direct dependency: ajv@8.20.0 is only a TRANSITIVE dependency today (pulled in via
// @modelcontextprotocol/sdk's optional peer), and promoting it to direct requires a real `pnpm
// install` — unsafe to run against a live multi-agent worktree tree, where node_modules is
// symlinked straight into the shared main checkout other concurrently-running agents build
// against (see CLAUDE.md's worktree node_modules warning). This closes the actual gap (a Codex
// result that's syntactically-valid JSON but violates the schema shape — wrong types, missing
// required fields) without that risk.
export type JsonSchemaLite = {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  enum?: unknown[];
  properties?: Record<string, JsonSchemaLite>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaLite;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};

function jsTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// Returns a list of human-readable violations (empty ⇒ valid). Malformed/non-object schemas are
// treated permissively (no constraint), mirroring resultSchema's own z.record(z.string(),
// z.unknown()) — protocol doesn't itself validate the schema's shape, only the result against it.
export function validateJsonSchemaLite(value: unknown, schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as JsonSchemaLite;
  const errors: string[] = [];

  if (s.type !== undefined) {
    const actual = jsTypeOf(value);
    const ok = s.type === "integer" ? actual === "number" && Number.isInteger(value) : actual === s.type;
    if (!ok) return [`${path}: expected type "${s.type}", got "${actual}"`];   // type mismatch makes deeper checks meaningless
  }
  if (s.enum !== undefined) {
    const json = JSON.stringify(value);
    if (!s.enum.some((v) => JSON.stringify(v) === json)) errors.push(`${path}: value not in enum`);
  }
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${path}: string shorter than minLength ${s.minLength}`);
    if (s.maxLength !== undefined && value.length > s.maxLength) errors.push(`${path}: string longer than maxLength ${s.maxLength}`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: above maximum ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: fewer than minItems ${s.minItems}`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: more than maxItems ${s.maxItems}`);
    if (s.items) value.forEach((v, i) => errors.push(...validateJsonSchemaLite(v, s.items, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (s.properties) {
      for (const [key, subSchema] of Object.entries(s.properties)) {
        if (key in obj) errors.push(...validateJsonSchemaLite(obj[key], subSchema, `${path}.${key}`));
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in s.properties)) errors.push(`${path}: unexpected additional property "${key}"`);
        }
      }
    }
  }
  return errors;
}
