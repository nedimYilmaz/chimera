// Must be the FIRST import of marketing.tsx: ES imports evaluate in order, and the app store reads
// the RPC seam while it is being imported, so the mock has to be installed before it loads.
import { marketingRpc } from "./marketing-data";
import { MISS, computerNative, featureRpc } from "./marketing-features";

// Feature screens (MCP store, schedules, ...) answer first; everything else is the base fixture.
const rpc = (method: string, params?: Record<string, unknown>) => {
  const answer = featureRpc(method, params);
  return answer === MISS ? marketingRpc(method, params) : answer;
};

const seam = window as unknown as Record<string, unknown>;
seam.__MARKETING_RPC__ = rpc;
seam.__CHIMERA_MOCK__ = { rpc: async (method: string, params?: Record<string, unknown>) => rpc(method, params) };
seam.__MARKETING_COMPUTER__ = computerNative;
