import { describe, it, expect } from "vitest";
import { validateJsonSchemaLite } from "@chimera/core/json-schema-lite";

describe("validateJsonSchemaLite", () => {
  it("accepts a value matching a simple object schema", () => {
    const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
    expect(validateJsonSchemaLite({ name: "a" }, schema)).toEqual([]);
  });

  it("flags a missing required property", () => {
    const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
    expect(validateJsonSchemaLite({}, schema)).toEqual(['$: missing required property "name"']);
  });

  it("flags a type mismatch", () => {
    expect(validateJsonSchemaLite("nope", { type: "number" })).toEqual(['$: expected type "number", got "string"']);
  });

  it("distinguishes integer from a non-integer number", () => {
    expect(validateJsonSchemaLite(1.5, { type: "integer" })).toEqual(['$: expected type "integer", got "number"']);
    expect(validateJsonSchemaLite(2, { type: "integer" })).toEqual([]);
  });

  it("validates array items and bounds", () => {
    const schema = { type: "array", items: { type: "string" }, maxItems: 2 };
    expect(validateJsonSchemaLite(["a", "b", "c"], schema)).toEqual(['$: more than maxItems 2']);
    expect(validateJsonSchemaLite(["a", 1], schema)).toEqual(['$[1]: expected type "string", got "number"']);
  });

  it("validates enum membership", () => {
    expect(validateJsonSchemaLite("x", { enum: ["a", "b"] })).toEqual(['$: value not in enum']);
    expect(validateJsonSchemaLite("a", { enum: ["a", "b"] })).toEqual([]);
  });

  it("recurses into nested properties with a dotted path", () => {
    const schema = { type: "object", properties: { inner: { type: "object", required: ["x"] } } };
    expect(validateJsonSchemaLite({ inner: {} }, schema)).toEqual(['$.inner: missing required property "x"']);
  });

  it("is permissive when the schema itself is missing or malformed", () => {
    expect(validateJsonSchemaLite("anything", undefined)).toEqual([]);
    expect(validateJsonSchemaLite("anything", null)).toEqual([]);
  });

  it("flags unexpected additional properties only when additionalProperties:false", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(validateJsonSchemaLite({ a: "x", b: 1 }, schema)).toEqual([]);
    expect(validateJsonSchemaLite({ a: "x", b: 1 }, { ...schema, additionalProperties: false })).toEqual([
      '$: unexpected additional property "b"',
    ]);
  });
});
