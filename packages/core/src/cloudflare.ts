import type { Keychain } from "./keychain.js";
import { scrubSecretShapes } from "./configstore.js";
import type { FedCloudflareUpStepResult } from "@chimera/protocol";

// Plan A of the Cloudflare federation design
// (docs/superpowers/plans/2026-07-28-cloudflare-federation.md, spec §2/§7). Mirrors
// network.ts's shape: an injectable fetch seam drives every Cloudflare v4 API call so no
// test ever touches the real network.
//
// SECURITY INVARIANTS (D0, same as network.ts's tailscale-authkey comment): the API token,
// the tunnel token, and the Access service-token secret live ONLY in the Keychain — never in
// a state file, an RPC response, an event, or an error message.

export type CfFetchFn = typeof fetch;

export class CloudflareApiError extends Error {
  code = "cloudflare-api" as const;
}

export const CLOUDFLARE_API_TOKEN_SERVICE = "chimera:cloudflare-api-token";
export function cloudflareTunnelTokenService(engineId: string): string {
  return `chimera:cloudflare-tunnel-token:${engineId}`;
}
export function cloudflareAccessSelfSecretService(engineId: string): string {
  return `chimera:cloudflare-access-self:${engineId}`;
}

export const KNOWN_CLOUDFLARED_PATHS = [
  "/usr/local/bin/cloudflared",
  "/opt/homebrew/bin/cloudflared",
  "/usr/bin/cloudflared",
];
export function resolveCloudflaredFallback(pathExists: (p: string) => boolean): string | null {
  return KNOWN_CLOUDFLARED_PATHS.find((p) => pathExists(p)) ?? null;
}

const API_BASE = "https://api.cloudflare.com/client/v4";

type CfResult<T> = { success: boolean; result: T; errors?: Array<{ message: string }> };

export type CloudflareProvisionResult = {
  steps: FedCloudflareUpStepResult[];
  tunnelId: string | null;
  zoneId: string | null;
  accessAppId: string | null;
  accessClientId: string | null;   // non-secret; the secret half lives only in the Keychain
};

export class CloudflareProvisioner {
  private engineId: string;
  private keychain: Keychain;
  private fetchFn: CfFetchFn;

  constructor(opts: { engineId: string; keychain: Keychain; fetchFn?: CfFetchFn; now?: () => number }) {
    this.engineId = opts.engineId;
    this.keychain = opts.keychain;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async cf<T>(method: string, path: string, token: string, body?: unknown): Promise<CfResult<T>> {
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await res.json()) as CfResult<T>;
  }

  async provision(opts: { apiToken?: string; domain: string }): Promise<CloudflareProvisionResult> {
    const steps: FedCloudflareUpStepResult[] = [];
    let tunnelId: string | null = null;
    let zoneId: string | null = null;
    let accessAppId: string | null = null;
    let accessClientId: string | null = null;

    const apiToken = opts.apiToken ?? (await this.keychain.get(CLOUDFLARE_API_TOKEN_SERVICE));
    if (!apiToken) {
      steps.push({ step: "verify-token", ok: false, error: "no Cloudflare API token supplied or in Keychain" });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }

    // 1. verify-token
    try {
      const verify = await this.cf<{ status: string }>("GET", "/user/tokens/verify", apiToken);
      if (!verify.success || verify.result?.status !== "active") {
        const msg = verify.errors?.map((e) => e.message).join("; ") || "token not active";
        steps.push({ step: "verify-token", ok: false, error: scrubSecretShapes(msg) });
        return { steps, tunnelId, zoneId, accessAppId, accessClientId };
      }
      steps.push({ step: "verify-token", ok: true });
    } catch (err) {
      steps.push({ step: "verify-token", ok: false, error: scrubSecretShapes(String(err)) });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }
    await this.keychain.set(CLOUDFLARE_API_TOKEN_SERVICE, apiToken);

    // Account id: first account visible to the token. No documented single-account lookup
    // endpoint beyond listing accounts — accept the first result (single-account tokens are
    // the expected shape for this daemon's use).
    let accountId: string;
    try {
      const accounts = await this.cf<Array<{ id: string }>>("GET", "/accounts", apiToken);
      const first = accounts.result?.[0];
      if (!accounts.success || !first) {
        steps.push({ step: "resolve-zone", ok: false, error: "no Cloudflare account visible to this token" });
        return { steps, tunnelId, zoneId, accessAppId, accessClientId };
      }
      accountId = first.id;
    } catch (err) {
      steps.push({ step: "resolve-zone", ok: false, error: scrubSecretShapes(String(err)) });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }

    // 2. resolve-zone
    try {
      const zones = await this.cf<Array<{ id: string }>>("GET", `/zones?name=${opts.domain}`, apiToken);
      const zone = zones.result?.[0];
      if (!zones.success || !zone) {
        steps.push({ step: "resolve-zone", ok: false, error: `zone not found for domain ${opts.domain}` });
        return { steps, tunnelId, zoneId, accessAppId, accessClientId };
      }
      zoneId = zone.id;
      steps.push({ step: "resolve-zone", ok: true });
    } catch (err) {
      steps.push({ step: "resolve-zone", ok: false, error: scrubSecretShapes(String(err)) });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }

    // 3. create-tunnel (converge: lookup by deterministic name, create only if absent)
    const tunnelName = `chimera-${this.engineId}`;
    try {
      const existing = await this.cf<Array<{ id: string }>>(
        "GET",
        `/accounts/${accountId}/cfd_tunnel?name=${tunnelName}`,
        apiToken,
      );
      const found = existing.result?.[0];
      if (found) {
        tunnelId = found.id;
      } else {
        const created = await this.cf<{ id: string }>("POST", `/accounts/${accountId}/cfd_tunnel`, apiToken, {
          name: tunnelName,
          config_src: "cloudflare",
        });
        if (!created.success || !created.result?.id) {
          const msg = created.errors?.map((e) => e.message).join("; ") || "tunnel create failed";
          steps.push({ step: "create-tunnel", ok: false, error: scrubSecretShapes(msg) });
          return { steps, tunnelId, zoneId, accessAppId, accessClientId };
        }
        tunnelId = created.result.id;
      }
      steps.push({ step: "create-tunnel", ok: true });
    } catch (err) {
      steps.push({ step: "create-tunnel", ok: false, error: scrubSecretShapes(String(err)) });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }

    // 4. fetch-tunnel-token
    try {
      const tokenRes = await this.cf<string>("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`, apiToken);
      if (!tokenRes.success || !tokenRes.result) {
        steps.push({ step: "fetch-tunnel-token", ok: false, error: "could not fetch tunnel token" });
        return { steps, tunnelId, zoneId, accessAppId, accessClientId };
      }
      await this.keychain.set(cloudflareTunnelTokenService(this.engineId), tokenRes.result);
      steps.push({ step: "fetch-tunnel-token", ok: true });
    } catch (err) {
      steps.push({ step: "fetch-tunnel-token", ok: false, error: scrubSecretShapes(String(err)) });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }

    // 5. set-ingress
    const hostname = `${this.engineId}.${opts.domain}`;
    try {
      const ingress = await this.cf(
        "PUT",
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
        apiToken,
        { config: { ingress: [{ hostname, service: "ssh://localhost:22" }, { service: "http_status:404" }] } },
      );
      if (!ingress.success) {
        const msg = ingress.errors?.map((e) => e.message).join("; ") || "set-ingress failed";
        steps.push({ step: "set-ingress", ok: false, error: scrubSecretShapes(msg) });
        return { steps, tunnelId, zoneId, accessAppId, accessClientId };
      }
      steps.push({ step: "set-ingress", ok: true });
    } catch (err) {
      steps.push({ step: "set-ingress", ok: false, error: scrubSecretShapes(String(err)) });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }

    // 6. dns (converge: lookup by name, create only if absent)
    try {
      const existing = await this.cf<Array<{ id: string }>>(
        "GET",
        `/zones/${zoneId}/dns_records?name=${hostname}`,
        apiToken,
      );
      if (!existing.result?.[0]) {
        const created = await this.cf("POST", `/zones/${zoneId}/dns_records`, apiToken, {
          type: "CNAME",
          name: hostname,
          proxied: true,
          content: `${tunnelId}.cfargotunnel.com`,
        });
        if (!created.success) {
          const msg = (created as CfResult<unknown>).errors?.map((e) => e.message).join("; ") || "dns create failed";
          steps.push({ step: "dns", ok: false, error: scrubSecretShapes(msg) });
          return { steps, tunnelId, zoneId, accessAppId, accessClientId };
        }
      }
      steps.push({ step: "dns", ok: true });
    } catch (err) {
      steps.push({ step: "dns", ok: false, error: scrubSecretShapes(String(err)) });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }

    // 7. access-service-token (converge: lookup by name, create only if absent)
    const serviceTokenName = `chimera-${this.engineId}`;
    try {
      const existing = await this.cf<Array<{ id: string; name: string; client_id: string }>>(
        "GET",
        `/accounts/${accountId}/access/service_tokens`,
        apiToken,
      );
      const found = existing.result?.find((t) => t.name === serviceTokenName);
      if (found) {
        // Secret was minted at creation time only; a re-run cannot recover it — the Keychain
        // still holds it from the original create. Nothing new to store here.
        accessClientId = found.client_id;
      } else {
        const created = await this.cf<{ client_id: string; client_secret: string }>(
          "POST",
          `/accounts/${accountId}/access/service_tokens`,
          apiToken,
          { name: serviceTokenName },
        );
        if (!created.success || !created.result?.client_id) {
          const msg = created.errors?.map((e) => e.message).join("; ") || "access service token create failed";
          steps.push({ step: "access-service-token", ok: false, error: scrubSecretShapes(msg) });
          return { steps, tunnelId, zoneId, accessAppId, accessClientId };
        }
        accessClientId = created.result.client_id;
        await this.keychain.set(cloudflareAccessSelfSecretService(this.engineId), created.result.client_secret);
      }
      steps.push({ step: "access-service-token", ok: true });
    } catch (err) {
      steps.push({ step: "access-service-token", ok: false, error: scrubSecretShapes(String(err)) });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }

    // 8. access-app (converge: lookup by domain, create only if absent)
    try {
      const existing = await this.cf<Array<{ id: string; domain: string }>>(
        "GET",
        `/accounts/${accountId}/access/apps`,
        apiToken,
      );
      const found = existing.result?.find((a) => a.domain === hostname);
      if (found) {
        accessAppId = found.id;
      } else {
        const created = await this.cf<{ id: string }>("POST", `/accounts/${accountId}/access/apps`, apiToken, {
          type: "self_hosted",
          domain: hostname,
          policies: [{ decision: "non_identity", include: [{ service_token: {} }] }],
        });
        if (!created.success || !created.result?.id) {
          const msg = created.errors?.map((e) => e.message).join("; ") || "access app create failed";
          steps.push({ step: "access-app", ok: false, error: scrubSecretShapes(msg) });
          return { steps, tunnelId, zoneId, accessAppId, accessClientId };
        }
        accessAppId = created.result.id;
      }
      steps.push({ step: "access-app", ok: true });
    } catch (err) {
      steps.push({ step: "access-app", ok: false, error: scrubSecretShapes(String(err)) });
      return { steps, tunnelId, zoneId, accessAppId, accessClientId };
    }

    return { steps, tunnelId, zoneId, accessAppId, accessClientId };
  }
}
