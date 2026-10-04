// F23-2A: SKELETON ONLY — deliberately NOT registered in engine.ts's oauthFlows map, and
// the "gemini" catalog entry (catalog.ts) deliberately keeps authModes: ["apiKey"] only, so
// this class is unreachable from accounts.oauth_start today. Do not wire it live.
//
// Why it stops here (research doc §E/§G): Google's Gemini-for-subscription path
// (gemini-cli / Code Assist) is explicitly disallowed by Google's ToS for third-party
// access, AND — more importantly for shipping this — reportedly had its consumer/
// subscription serving CUT around 2026-06-18 in favor of "Antigravity". The mechanics
// below are still present in gemini-cli's source at the time of that research, but nobody
// has live-tested whether loadCodeAssist/onboardUser still serve a consumer account. Wiring
// this live without that confirmation risks shipping a flow that 403s for every user who
// tries it. If a future task gets a manual live-test confirming it still works, promote this
// into an OAuthFlow (oauth-flows.ts) and register it in engine.ts exactly like Copilot's.
//
// Reference shape (google-gemini/gemini-cli: code_assist/oauth2.ts, server.ts, setup.ts):
//   - OAuth: Google installed-app flow, PKCE-less (classic authorization_code + refresh_token).
//     client_id      gemini-cli's embedded installed-app client (code_assist/oauth2.ts)
//     client_secret  gemini-cli's embedded public secret, same file; not copied here so secret
//                    scanners stay quiet on a value that is not ours
//     scopes: cloud-platform, userinfo.email, userinfo.profile
//     redirect: loopback http://127.0.0.1:{port}/oauth2callback, or headless paste via
//       https://codeassist.google.com/authcode
//   - API base: https://cloudcode-pa.googleapis.com/v1internal:{method}
//       loadCodeAssist (resolves currentTier/allowedTiers — decides free vs paid serving),
//       onboardUser, generateContent, streamGenerateContent?alt=sse, countTokens
//   - STANDARD/PAID tiers need a GOOGLE_CLOUD_PROJECT; FREE tier uses a Google-managed project.
//   - Standard Google refresh-token semantics: ~1h access tokens, long-lived refresh token.
export type GoogleCodeAssistSkeletonNote = {
  status: "not-implemented";
  reason: string;
};

export function googleCodeAssistStatus(): GoogleCodeAssistSkeletonNote {
  return {
    status: "not-implemented",
    reason: "Deferred per F23 research doc §G: ToS-disallowed for third parties, and consumer "
      + "serving may have been cut ~2026-06-18. Needs a manual live test against "
      + "cloudcode-pa.googleapis.com before this is wired into engine.ts's oauthFlows.",
  };
}
