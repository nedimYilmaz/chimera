import type { ContractHandlers } from "@chimera/protocol/contract";
import type { OperatorWeb } from "../operator-web.js";
export class OperatorWebRpc {
  readonly handlers: Pick<ContractHandlers, "operatorweb.operatorStatus" | "operatorweb.status" | "operatorweb.enable" | "operatorweb.disable" | "operatorweb.pairStart" | "operatorweb.sessionList" | "operatorweb.sessionRevoke" | "operatorweb.settingsSet">;
  constructor(web: OperatorWeb) {
    this.handlers = {
      "operatorweb.operatorStatus": () => { const s = web.status(); return { enabled: s.enabled, bundleAvailable: s.bundleAvailable, limitation: s.limitation }; },
      "operatorweb.status": () => web.status(), "operatorweb.enable": () => web.enable(),
      "operatorweb.disable": () => web.disable(), "operatorweb.pairStart": p => web.pairStart(p),
      "operatorweb.sessionList": () => web.sessionList(), "operatorweb.sessionRevoke": p => ({ revoked: web.revoke(p.id) }),
      "operatorweb.settingsSet": p => web.settingsSet(p),
    };
  }
}
