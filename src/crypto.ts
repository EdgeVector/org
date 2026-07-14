import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

export type OrgKeyMaterial = {
  /** Hex sha256 of the org public key — stable org identity / routing prefix. */
  orgHash: string;
  /** Base64 Ed25519 public key. */
  orgPublicKey: string;
  /** Base64 Ed25519 private key (seed). Only needed for invite signing later. */
  orgPrivateKey: string;
  /** Base64 32-byte AES-256 shared secret for org E2E. */
  e2eKey: string;
};

export function generateOrgKeys(): OrgKeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const orgHash = createHash("sha256").update(pubDer).digest("hex");
  return {
    orgHash,
    orgPublicKey: pubDer.toString("base64"),
    orgPrivateKey: privDer.toString("base64"),
    e2eKey: randomBytes(32).toString("base64"),
  };
}

/** Build an org_hash from an already-known public key (join path). */
export function orgHashFromPublicKey(orgPublicKeyB64: string): string {
  const pubDer = Buffer.from(orgPublicKeyB64, "base64");
  return createHash("sha256").update(pubDer).digest("hex");
}
