import { describe, expect, it } from "vitest";
import {
  PeerEndpointSchema,
  PeerSshConfigSchema,
  CloudflareProvisionStatusSchema,
  FedCloudflareUpParamsSchema,
} from "../src/index";

describe("Cloudflare federation schema", () => {
  it("PeerEndpointSchema still parses a plain (no-cloudflare) endpoint unchanged", () => {
    expect(PeerEndpointSchema.parse({ socketPath: "/tmp/x.sock" }).cloudflareAccess).toBeUndefined();
  });

  it("PeerSshConfigSchema accepts an optional cloudflareAccess ref, secret never in the shape", () => {
    const parsed = PeerSshConfigSchema.parse({
      host: "a.example.com",
      cloudflareAccess: { hostname: "a.example.com", clientId: "cid" },
    });
    expect(parsed.cloudflareAccess).toEqual({ hostname: "a.example.com", clientId: "cid" });
    expect(() =>
      PeerSshConfigSchema.parse({
        host: "a.example.com",
        cloudflareAccess: { hostname: "a.example.com", clientId: "cid", secret: "nope" },
      }),
    ).toThrow();
  });

  it("FedCloudflareUpParamsSchema requires domain, apiToken optional", () => {
    expect(FedCloudflareUpParamsSchema.parse({ domain: "example.com" }).apiToken).toBeUndefined();
    expect(() => FedCloudflareUpParamsSchema.parse({})).toThrow();
  });

  it("CloudflareProvisionStatusSchema round-trips a pending-selfprobe status", () => {
    const s = {
      installed: true,
      provisioned: true,
      hostname: "a.example.com",
      tunnelHealth: "healthy" as const,
      selfprobe: "pending" as const,
      accessTokenExpiry: null,
    };
    expect(CloudflareProvisionStatusSchema.parse(s)).toEqual(s);
  });
});
