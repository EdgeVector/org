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
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MEMBER_PUBKEY_PREFIX = "orgpk1:" as const;

export type MemberSealIdentityV1 = {
  version: 1;
  /** Base64 SPKI DER (X25519). */
  public_key: string;
  /** Base64 PKCS8 DER (X25519). */
  private_key: string;
  created_at: string;
};

export type MemberSealIdentity = {
  version: 2;
  /** Base64 SPKI DER (X25519). */
  public_key: string;
  /** Base64 PKCS8 DER (X25519). */
  private_key: string;
  /** Base64 SPKI DER (Ed25519). */
  signing_public_key: string;
  /** Base64 PKCS8 DER (Ed25519). */
  signing_private_key: string;
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
  const seal = generateKeyPairSync("x25519");
  const signing = generateKeyPairSync("ed25519");
  return {
    version: 2,
    public_key: seal.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    private_key: seal.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
    signing_public_key: signing.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    signing_private_key: signing.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
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
  const raw = JSON.parse(readFileSync(path, "utf8")) as
    | MemberSealIdentityV1
    | MemberSealIdentity;
  if (!raw.public_key || !raw.private_key || !raw.created_at) {
    throw new Error(`invalid member identity file: ${path}`);
  }
  if (raw.version === 1) {
    const signing = generateKeyPairSync("ed25519");
    const migrated: MemberSealIdentity = {
      version: 2,
      public_key: raw.public_key,
      private_key: raw.private_key,
      signing_public_key: signing.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
      signing_private_key: signing.privateKey
        .export({ type: "pkcs8", format: "der" })
        .toString("base64"),
      created_at: raw.created_at,
    };
    saveMemberIdentity(migrated, path);
    return migrated;
  }
  if (raw.version !== 2 || !raw.signing_public_key || !raw.signing_private_key) {
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
  chmodSync(path, 0o600);
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

export function memberSigningPublicKeyObject(id: MemberSealIdentity): KeyObject {
  return createPublicKey({
    key: Buffer.from(id.signing_public_key, "base64"),
    format: "der",
    type: "spki",
  });
}

export function memberSigningPrivateKeyObject(id: MemberSealIdentity): KeyObject {
  return createPrivateKey({
    key: Buffer.from(id.signing_private_key, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("JCS payload contains an unpaired Unicode surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("JCS payload contains an unpaired Unicode surrogate");
    }
  }
}

/** Canonical JSON following RFC 8785's ECMAScript serialization rules. */
export function canonicalizeJcs(payload: unknown): string {
  const active = new Set<object>();

  const serialize = (value: unknown): string => {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("JCS payload numbers must be finite");
      }
      return JSON.stringify(value);
    }
    if (typeof value === "string") {
      assertUnicodeScalarString(value);
      return JSON.stringify(value);
    }
    if (typeof value !== "object") {
      throw new TypeError(`JCS payload cannot contain ${typeof value}`);
    }
    if (active.has(value)) {
      throw new TypeError("JCS payload cannot contain cycles");
    }

    active.add(value);
    try {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) {
            throw new TypeError("JCS payload arrays cannot contain holes");
          }
          items.push(serialize(value[index]));
        }
        return `[${items.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("JCS payload objects must be plain JSON objects");
      }
      const object = value as Record<string, unknown>;
      const keys = Object.keys(object).sort();
      const fields = keys.map((key) => {
        assertUnicodeScalarString(key);
        return `${JSON.stringify(key)}:${serialize(object[key])}`;
      });
      return `{${fields.join(",")}}`;
    } finally {
      active.delete(value);
    }
  };

  return serialize(payload);
}

export function signMemberPayload(id: MemberSealIdentity, payload: unknown): string {
  const message = Buffer.from(canonicalizeJcs(payload), "utf8");
  return cryptoSign(null, message, memberSigningPrivateKeyObject(id)).toString(
    "base64url",
  );
}

export function verifyMemberPayload(
  signingPublicKey: string | KeyObject,
  payload: unknown,
  signature: string,
): boolean {
  const message = Buffer.from(canonicalizeJcs(payload), "utf8");
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64url");
    if (signatureBytes.length !== 64) return false;
    const publicKey =
      typeof signingPublicKey === "string"
        ? createPublicKey({
            key: Buffer.from(signingPublicKey, "base64"),
            format: "der",
            type: "spki",
          })
        : signingPublicKey;
    return cryptoVerify(null, message, publicKey, signatureBytes);
  } catch {
    return false;
  }
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
