// Shared by engine.ts's `handle()` switch AND the packages/core/src/rpc/*.ts domain modules —
// living in its own file (rather than engine.ts, which used to define it locally) avoids an
// import cycle now that domain modules need it too (they're imported BY engine.ts).
export function rpcError(code: string, message: string): { code: string; message: string } {
  return { code, message };
}
