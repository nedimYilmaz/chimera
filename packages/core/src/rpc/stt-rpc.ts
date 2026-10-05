import type { ContractHandlers } from "@chimera/protocol/contract";
import { LocalStt } from "../stt.js";
export class SttRpc {
  readonly handlers: Pick<ContractHandlers, "stt.configure" | "stt.status" | "stt.install" | "stt.installCancel" | "stt.uninstall" | "stt.transcribe" | "stt.transcribeCancel">;
  constructor(stt: LocalStt) {
    this.handlers = {
      "stt.configure": p => stt.configure(p),
      "stt.status": () => stt.status(), "stt.install": () => stt.install(),
      "stt.installCancel": () => stt.cancelInstall(), "stt.uninstall": () => stt.uninstall(),
      "stt.transcribe": p => stt.transcribe(p.requestId, p.language, p.audio.base64),
      "stt.transcribeCancel": p => stt.cancelTranscribe(p.requestId),
    };
  }
}
