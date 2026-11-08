/**
 * Org invite sealing.
 *
 * Encrypt the invite to the friend's X25519 public key (`orgpk1:…`) and sign
 * with the org Ed25519 private key. Ciphertext may travel on any clear
 * channel; only the friend can open it.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import { parseInvite, type OrgInvite, serializeInvite } from "./invite.ts";
import {
  encodeMemberPubkey,
  fingerprintFromRawPublic,
  parseMemberPubkey,
  x25519PublicFromRaw,
  x25519RawPublic,
} from "./member-identity.ts";

const PUBKEY_SEAL_VERSION = 2;
const SEAL_PREFIX = "orgseal1:" as const;
const HKDF_INFO = Buffer.from("org-invite-seal-v2", "utf8");

export type PubkeySealedPackage = {
  v: typeof PUBKEY_SEAL_VERSION;
  alg: "x25519-aes256gcm-ed25519";
  to: string;
  fp: string;
  epk: string;
  nonce: string;
  ct: string;
  org_pk: string;
  sig: string;
};

function deriveAesKey(sharedSecret: Buffer): Buffer {
  // Simple KDF: SHA-256(shared || info) — enough for one-shot invite seal.
  return createHash("sha256")
    .update(sharedSecret)
    .update(HKDF_INFO)
    .digest();
}

/** Derive X25519/Ed25519 public KeyObject from a private KeyObject (TS-safe). */
function publicKeyFromPrivate(priv: KeyObject): KeyObject {
  const jwk = priv.export({ format: "jwk" }) as Record<string, unknown>;
  const { d: _d, ...pubJwk } = jwk;
  return createPublicKey({ key: pubJwk, format: "jwk" });
}

function orgPrivateKeyObject(orgPrivateKeyB64: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(orgPrivateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

function orgPublicKeyObject(orgPublicKeyB64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(orgPublicKeyB64, "base64"),
    format: "der",
    type: "spki",
  });
}

function signPayload(
  orgPrivateKeyB64: string,
  payload: Omit<PubkeySealedPackage, "sig">,
): string {
  const msg = canonicalSealBytes(payload);
  const sig = sign(null, msg, orgPrivateKeyObject(orgPrivateKeyB64));
  return sig.toString("base64url");
}

function verifyPayload(pkg: PubkeySealedPackage): void {
  const { sig, ...rest } = pkg;
  const msg = canonicalSealBytes(rest);
  const ok = verify(
    null,
    msg,
    orgPublicKeyObject(pkg.org_pk),
    Buffer.from(sig, "base64url"),
  );
  if (!ok) {
    throw new Error("sealed invite signature invalid (wrong org key or tampered package)");
  }
}

function canonicalSealBytes(payload: Omit<PubkeySealedPackage, "sig">): Buffer {
  // Fixed field order — not full JCS, but stable and explicit.
  const line = [
    String(payload.v),
    payload.alg,
    payload.to,
    payload.fp,
    payload.epk,
    payload.nonce,
    payload.ct,
    payload.org_pk,
  ].join("\n");
  return Buffer.from(line, "utf8");
}

/**
 * Encrypt invite to recipient X25519 pubkey; sign with org Ed25519 private key.
 * Returns a single-line `orgseal1:…` string safe for clear channels.
 */
export function sealInviteToPubkey(input: {
  invite: OrgInvite;
  recipientPubkey: string;
  orgPrivateKeyB64: string;
  /** Optional override; defaults to invite.org_public_key */
  orgPublicKeyB64?: string;
}): string {
  const recipient = parseMemberPubkey(input.recipientPubkey);
  const recipientPub = x25519PublicFromRaw(recipient.raw);

  const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: recipientPub });
  const aesKey = deriveAesKey(shared);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
  const plaintext = Buffer.from(serializeInvite(input.invite), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ct = Buffer.concat([ciphertext, tag]);

  const orgPk = input.orgPublicKeyB64 ?? input.invite.org_public_key;
  const payload: Omit<PubkeySealedPackage, "sig"> = {
    v: PUBKEY_SEAL_VERSION,
    alg: "x25519-aes256gcm-ed25519",
    to: recipient.encoded,
    fp: recipient.fingerprint,
    epk: x25519RawPublic(ephPub).toString("base64url"),
    nonce: nonce.toString("base64url"),
    ct: ct.toString("base64url"),
    org_pk: orgPk,
  };
  const sig = signPayload(input.orgPrivateKeyB64, payload);
  const full: PubkeySealedPackage = { ...payload, sig };
  return `${SEAL_PREFIX}${Buffer.from(JSON.stringify(full), "utf8").toString("base64url")}`;
}

export function parsePubkeySealedPackage(token: string): PubkeySealedPackage {
  const trimmed = token.trim();
  if (!trimmed.startsWith(SEAL_PREFIX)) {
    throw new Error("sealed package must start with orgseal1:");
  }
  let json: unknown;
  try {
    json = JSON.parse(
      Buffer.from(trimmed.slice(SEAL_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new Error("sealed package is not valid orgseal1 base64url JSON");
  }
  if (typeof json !== "object" || json === null) {
    throw new Error("sealed package must be a JSON object");
  }
  const p = json as Record<string, unknown>;
  if (p.v !== PUBKEY_SEAL_VERSION) {
    throw new Error(`unsupported sealed package version: ${String(p.v)}`);
  }
  for (const key of ["alg", "to", "fp", "epk", "nonce", "ct", "org_pk", "sig"] as const) {
    if (typeof p[key] !== "string" || (p[key] as string).length === 0) {
      throw new Error(`sealed package missing field: ${key}`);
    }
  }
  if (p.alg !== "x25519-aes256gcm-ed25519") {
    throw new Error(`unsupported seal alg: ${String(p.alg)}`);
  }
  return {
    v: PUBKEY_SEAL_VERSION,
    alg: "x25519-aes256gcm-ed25519",
    to: p.to as string,
    fp: p.fp as string,
    epk: p.epk as string,
    nonce: p.nonce as string,
    ct: p.ct as string,
    org_pk: p.org_pk as string,
    sig: p.sig as string,
  };
}

/**
 * Decrypt a pubkey-bound package with the local member X25519 private key.
 */
export function unsealInviteWithMemberKey(
  token: string,
  memberPrivateKey: KeyObject,
): OrgInvite {
  const pkg = parsePubkeySealedPackage(token);
  verifyPayload(pkg);

  const myPubRaw = x25519RawPublic(publicKeyFromPrivate(memberPrivateKey));
  const expected = encodeMemberPubkey(myPubRaw);
  if (pkg.to !== expected) {
    throw new Error(
      `sealed invite is for a different public key (package fp=${pkg.fp}, mine=${fingerprintFromRawPublic(myPubRaw)})`,
    );
  }

  const ephPub = x25519PublicFromRaw(Buffer.from(pkg.epk, "base64url"));
  const shared = diffieHellman({ privateKey: memberPrivateKey, publicKey: ephPub });
  const aesKey = deriveAesKey(shared);
  const nonce = Buffer.from(pkg.nonce, "base64url");
  const ctFull = Buffer.from(pkg.ct, "base64url");
  if (ctFull.length < 17) {
    throw new Error("sealed package ciphertext truncated");
  }
  const tag = ctFull.subarray(ctFull.length - 16);
  const ciphertext = ctFull.subarray(0, ctFull.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("failed to decrypt sealed invite (wrong member key or corrupt package)");
  }
  return parseInvite(JSON.parse(plaintext.toString("utf8")));
}
