// Generated from the deployed Codex app-server TypeScript schema.

// Regenerate with scripts/codex-protocol-subset.mjs; do not edit types by hand.

export type ClientInfo = { name: string, title: string | null, version: string, };

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;

/**
 * Client-declared capabilities negotiated during initialize.
 */
export type InitializeCapabilities = {
/**
 * Use explicit gateway OAuth login instead of automatic browser authorization.
 * Applies to this app-server's gateway runtime; later connections cannot undo it.
 */
explicitGatewayOauth?: boolean,
/**
 * Opt into receiving experimental API methods and fields.
 */
experimentalApi: boolean,
/**
 * Opt into `attestation/generate` requests for upstream `x-oai-attestation`.
 */
requestAttestation: boolean,
/**
 * Legacy opt-in for the `openai/form` MCP extension.
 *
 * New clients should declare `openai/form` in [`Self::extensions`].
 */
mcpServerOpenaiFormElicitation?: boolean,
/**
 * Exact notification method names that should be suppressed for this
 * connection (for example `thread/started`).
 */
optOutNotificationMethods?: Array<string> | null,
/**
 * MCP extension settings declared by the app-server client.
 */
extensions?: { [key in string]?: JsonValue } | null, };

export type InitializeParams = { clientInfo: ClientInfo, capabilities: InitializeCapabilities | null, };

export type ImageDetail = "auto" | "low" | "high" | "original";

export type ByteRange = { start: number, end: number, };

export type TextElement = {
/**
 * Byte range in the parent `text` buffer that this element occupies.
 */
byteRange: ByteRange,
/**
 * Optional human-readable placeholder for the element, displayed in the UI.
 */
placeholder: string | null, };

export type UserInput = { "type": "text", text: string,
/**
 * UI-defined spans within `text` used to render or persist special elements.
 */
text_elements: Array<TextElement>, } | { "type": "image", detail?: ImageDetail, } & ({ url: string, } | { fileId: string, }) | { "type": "localImage", detail?: ImageDetail, path: string, } | { "type": "audio", url: string, } | { "type": "localAudio", path: string, } | { "type": "skill", name: string, path: string, } | { "type": "mention", name: string, path: string, };

export type AskForApproval = "untrusted" | "on-request" | { "granular": { sandbox_approval: boolean, rules: boolean, skill_approval: boolean, request_permissions: boolean, mcp_elicitations: boolean, } } | "never";

/**
 * EXPERIMENTAL. Captures a user's answer to a request_user_input question.
 */
export type ToolRequestUserInputAnswer = { answers: Array<string>, };

/**
 * EXPERIMENTAL. Response payload mapping question ids to answers.
 */
export type ToolRequestUserInputResponse = { answers: { [key in string]?: ToolRequestUserInputAnswer }, };

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export type ThreadGoal = { threadId: string, objective: string, status: ThreadGoalStatus, tokenBudget: number | null, tokensUsed: number, timeUsedSeconds: number, createdAt: number, updatedAt: number, };

export type ThreadGoalGetResponse = { goal: ThreadGoal | null, };

export type ThreadGoalSetParams = { threadId: string, objective?: string | null, status?: ThreadGoalStatus | null, tokenBudget?: number | null, };

export type ThreadGoalSetResponse = { goal: ThreadGoal, };
