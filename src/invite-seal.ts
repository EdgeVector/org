/**
 * Portable sealed org invites — AES-256-GCM envelope so email/chat never
 * carries the raw e2e_key. Possession of the portable claim token is the
 * capability (treat like a one-time password). Exemem can replace the
 * transport later without changing the join CLI surface.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { parseInvite, type OrgInvite, serializeInvite } from "./invite.ts";

const VERSION = 1;

/** AES-GCM package: version(1) || key(32) || nonce(12) || tag(16) || ciphertext */
export function sealInvite(invite: OrgInvite): string {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(serializeInvite(invite), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([Buffer.from([VERSION]), key, nonce, tag, ciphertext]);
  return packed.toString("base64url");
}

export function unsealInvite(sealedBlob: string): OrgInvite {
  let packed: Buffer;
  try {
    packed = Buffer.from(sealedBlob, "base64url");
  } catch {
    throw new Error("sealed invite blob is not valid base64url");
  }
  if (packed.length < 1 + 32 + 12 + 16 + 1) {
    throw new Error("sealed invite blob is truncated");
  }
  const version = packed[0];
  if (version !== VERSION) {
    throw new Error(`unsupported sealed invite version: ${version}`);
  }
  const key = packed.subarray(1, 33);
  const nonce = packed.subarray(33, 45);
  const tag = packed.subarray(45, 61);
  const ciphertext = packed.subarray(61);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("failed to unseal invite (wrong/corrupt claim token)");
  }
  return parseInvite(JSON.parse(plaintext.toString("utf8")));
}

/**
 * Portable claim token: `org-claim-<uuid>.<base64url-envelope>`
 * Safe to treat as a single secret string for `org join --claim`.
 */
export function encodePortableClaim(claimId: string, sealedBlob: string): string {
  if (!claimId.startsWith("org-claim-")) {
    throw new Error("invite claim id must start with org-claim-");
  }
  if (claimId.includes(".")) {
    throw new Error("claim id must not contain '.'");
  }
  if (!sealedBlob.trim()) {
    throw new Error("sealed invite blob is required");
  }
  return `${claimId}.${sealedBlob}`;
}

export function decodePortableClaim(token: string): { claimId: string; sealedBlob: string } {
  const trimmed = token.trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) {
    // Short claim id only — no sealed payload embedded
    if (!trimmed.startsWith("org-claim-")) {
      throw new Error("claim token must start with org-claim-");
    }
    return { claimId: trimmed, sealedBlob: "" };
  }
  const claimId = trimmed.slice(0, dot);
  const sealedBlob = trimmed.slice(dot + 1);
  if (!claimId.startsWith("org-claim-")) {
    throw new Error("claim token must start with org-claim-");
  }
  return { claimId, sealedBlob };
}

export function isPortableClaimToken(token: string): boolean {
  const t = token.trim();
  return t.startsWith("org-claim-") && t.includes(".");
}
