// CAPABILITY-BLOCK-DRIFT: this file moved to @chimera/protocol/engine-help so that
// @chimera/core (which cannot depend on @chimera/mcp — mcp -> client -> core is
// already a cycle) can reach the same catalog. This re-export keeps the "./engine-help"
// subpath and its existing consumers (server.ts, @chimera/app) working
// unchanged — nothing outside this package needs to know the catalog moved.
export * from "@chimera/protocol/engine-help";
