// TYPED-CLIENT-SDK: compile-time-only regression net for RpcRequestFor/RpcMethod. Nothing here
// runs or is imported by anything else — it exists purely so `tsc -b packages/protocol` fails if
// the contract's type inference ever stops catching a malformed request at compile time. Lives
// under src/ (not test/) deliberately: every package's tsconfig `include` is ["src"] only, so
// test/ is never covered by the `pnpm typecheck` gate — a @ts-expect-error there would silently
// stop being enforced. A stale/no-longer-erroring @ts-expect-error below is ITSELF a compile
// error (TS's default "unused @ts-expect-error directive" check), so this file is self-verifying.
import type { RpcMethod, RpcRequestFor } from "./contract.js";

declare function acceptsQueuePush(req: RpcRequestFor<"queue.push">): void;
acceptsQueuePush({ queue: "q", prompt: "hi" }); // valid — must compile

// @ts-expect-error — "prompt" is required by QueuePushRequestSchema; omitting it must be a
// compile-time rejection, not something that only surfaces once the daemon validates it.
acceptsQueuePush({ queue: "q" });

// @ts-expect-error — "queue" must be a string; a malformed field type must be rejected too.
acceptsQueuePush({ queue: 123, prompt: "hi" });

declare function acceptsMethod(m: RpcMethod): void;
acceptsMethod("queue.push"); // valid — a real RPC_CONTRACT method name

// @ts-expect-error — a typo'd/unknown method name must not be assignable to RpcMethod.
acceptsMethod("qeue.push");
