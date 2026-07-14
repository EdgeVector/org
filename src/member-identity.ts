/**
 * Local member seal identity: an X25519 keypair used only to receive
 * org invites. Public half is pasteable (`orgpk1:…`); private half never
 * leaves the machine. Not an Exemem account and not a People-app name.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MEMBER_PUBKEY_PREFIX = "orgpk1:" as const;

export type MemberSealIdentity = {
  version: 1;
  /** Base64 SPKI DER (X25519). */
  public_key: string;
  /** Base64 PKCS8 DER (X25519). */
  private_key: string;
  created_at: string;
};

export function defaultMemberIdentityPath(): string {
  const override = process.env.ORG_MEMBER_IDENTITY_PATH;
  if (override && override.length > 0) return override;
  return join(homedir(), ".org", "member-seal.json");
}

export function x25519RawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("x25519 public key missing jwk.x");
  return Buffer.from(jwk.x, "base64url");
}

export function x25519PublicFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) {
    throw new Error(`x25519 public key must be 32 bytes (got ${raw.length})`);
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export function fingerprintFromRawPublic(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function encodeMemberPubkey(rawPublic: Buffer): string {
  return `${MEMBER_PUBKEY_PREFIX}${rawPublic.toString("base64url")}`;
}

export function parseMemberPubkey(input: string): {
  raw: Buffer;
  encoded: string;
  fingerprint: string;
} {
  const trimmed = input.trim();
  let raw: Buffer;
  if (trimmed.startsWith(MEMBER_PUBKEY_PREFIX)) {
    raw = Buffer.from(trimmed.slice(MEMBER_PUBKEY_PREFIX.length), "base64url");
  } else if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    // bare base64url 32-byte key
    raw = Buffer.from(trimmed, "base64url");
  } else {
    throw new Error(
      `recipient must be an org public key (orgpk1:… from \`org receive\`); got: ${trimmed.slice(0, 48)}`,
    );
  }
  if (raw.length !== 32) {
    throw new Error(`org public key must decode to 32 bytes (got ${raw.length})`);
  }
  const encoded = encodeMemberPubkey(raw);
  return { raw, encoded, fingerprint: fingerprintFromRawPublic(raw) };
}

export function isMemberPubkey(input: string): boolean {
  try {
    parseMemberPubkey(input);
    return true;
  } catch {
    return false;
  }
}

export function generateMemberSealIdentity(): MemberSealIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return {
    version: 1,
    public_key: pubDer.toString("base64"),
    private_key: privDer.toString("base64"),
    created_at: new Date().toISOString(),
  };
}

export function loadOrCreateMemberIdentity(
  path = defaultMemberIdentityPath(),
): MemberSealIdentity {
  if (existsSync(path)) {
    return loadMemberIdentity(path);
  }
  const id = generateMemberSealIdentity();
  saveMemberIdentity(id, path);
  return id;
}

export function loadMemberIdentity(path = defaultMemberIdentityPath()): MemberSealIdentity {
  const raw = JSON.parse(readFileSync(path, "utf8")) as MemberSealIdentity;
  if (raw.version !== 1 || !raw.public_key || !raw.private_key) {
    throw new Error(`invalid member identity file: ${path}`);
  }
  return raw;
}

export function saveMemberIdentity(
  id: MemberSealIdentity,
  path = defaultMemberIdentityPath(),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(id, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function memberPublicKeyObject(id: MemberSealIdentity): KeyObject {
  return createPublicKey({
    key: Buffer.from(id.public_key, "base64"),
    format: "der",
    type: "spki",
  });
}

export function memberPrivateKeyObject(id: MemberSealIdentity): KeyObject {
  return createPrivateKey({
    key: Buffer.from(id.private_key, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

export function memberPubkeyLine(id: MemberSealIdentity): string {
  const raw = x25519RawPublic(memberPublicKeyObject(id));
  return encodeMemberPubkey(raw);
}

export function memberFingerprint(id: MemberSealIdentity): string {
  return fingerprintFromRawPublic(x25519RawPublic(memberPublicKeyObject(id)));
}

/** Human-readable block safe to paste over any clear channel. */
export function formatReceiveBanner(id: MemberSealIdentity): string {
  const line = memberPubkeyLine(id);
  const fp = memberFingerprint(id);
  return [
    "Ready for an org invite (no Exemem account needed).",
    "",
    "Send this public key to the org admin over any channel:",
    line,
    "",
    `fingerprint: ${fp}`,
    "",
    "After they invite you, run:",
    "  org join --sealed '<package they send back>'",
    "  # or: org receive --sealed '<package>'",
    "",
  ].join("\n");
}
