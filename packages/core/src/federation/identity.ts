import {
  createPrivateKey, createPublicKey, generateKeyPairSync,
  sign as cryptoSign, verify as cryptoVerify, type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

/** Long-lived per-engine ed25519 identity (spec §15). The PRIVATE key never leaves ${home}. */
export class EngineIdentity {
  private constructor(private privateKey: KeyObject, readonly publicKey: string) {}

  static loadOrCreate(home: string): EngineIdentity {
    mkdirSync(home, { recursive: true });
    const keyFile = join(home, "engine_key");
    const pubFile = join(home, "engine_key.pub");
    if (existsSync(keyFile)) {
      const priv = createPrivateKey(readFileSync(keyFile, "utf8"));
      const pub = createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
      return new EngineIdentity(priv, pub);
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    writeFileSync(pubFile, pub + "\n");
    return new EngineIdentity(privateKey, pub);
  }

  sign(payload: Buffer): string {
    return cryptoSign(null, payload, this.privateKey).toString("base64");
  }
}

export function verifySignature(publicKeyB64: string, payload: Buffer, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return cryptoVerify(null, payload, key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;   // malformed key/signature is an auth failure, not a crash
  }
}
