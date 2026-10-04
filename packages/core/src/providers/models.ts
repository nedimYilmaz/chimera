// F23-1A: live GET /models probe. The catalog's `models` array is a fallback only (model IDs
// churn within days per the research doc) — Settings (F23-2B's providers.list RPC) is meant to
// call this and show live IDs, falling back to the catalog list when a provider has no
// modelsEndpoint, the request fails, or the response is empty/malformed.
import type { ProviderProfile } from "@chimera/protocol";

// Two response shapes recognized: the openai-compat convention `{data:[{id}]}` (used by
// every provider except Gemini's native API), and Gemini's own `{models:[{name}]}` where
// `name` is "models/<id>" -- the "models/" prefix is stripped below so the returned id
// matches what `?model=` / the chat client's URL path (gemini-native.ts) actually expects.
type ModelsListResponse = { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };

export async function fetchProviderModels(
  profile: ProviderProfile,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  if (!profile.modelsEndpoint) return profile.models;
  const headerName = profile.authHeader ?? "Authorization";
  const scheme = headerName === "Authorization" ? "Bearer " : "";
  try {
    const res = await fetchFn(profile.modelsEndpoint, {
      headers: { ...(apiKey ? { [headerName]: `${scheme}${apiKey}` } : {}), ...profile.extraHeaders },
    });
    if (!res.ok) return profile.models;
    const json = (await res.json()) as ModelsListResponse;
    const ids = json.data
      ? json.data.map((m) => m.id).filter((id): id is string => !!id)
      : (json.models ?? [])
          .map((m) => m.name?.replace(/^models\//, ""))
          .filter((id): id is string => !!id);
    return ids.length ? ids : profile.models;
  } catch {
    return profile.models;
  }
}
