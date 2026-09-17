/**
 * Join acceptance: the sealed return channel of the invite flow.
 *
 * After `org join` unseals an invite, the joiner builds an `orgaccept1:…`
 * package carrying its member identity {member_id, name, sign_pk, seal_pk}
 * plus the invite's claim_nonce and expiry. The payload is signed by the
 * joiner's Ed25519 signing key (proves sign_pk possession) and encrypted with
 * AES-256-GCM under a key derived from the org E2E key (proves the joiner
 * actually opened the invite; safe on clear channels). The OWNER opens it and
 * mints epoch N+1 — membership lands only as a signed epoch
 * (decision-2026-08-18-lastgit-collaborator-trust-epochs).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  canonicalizeJcs,
  memberFingerprint,
  memberPubkeyLine,
  signMemberPayload,
  verifyMemberPayload,
  type MemberSealIdentity,
} from "./member-identity.ts";
import type { OrgInvite } from "./invite.ts";

export const ACCEPT_PREFIX = "orgaccept1:" as const;
const ACCEPT_VERSION = 1;
const ACCEPT_KDF_INFO = Buffer.from("org-join-accept-v1", "utf8");

export type JoinAcceptPayload = {
  v: typeof ACCEPT_VERSION;
  org_hash: string;
  slug: string;
  /** One-time claim nonce copied from the invite; the owner consumes it. */
  claim_nonce: string;
  /** Invite expiry copied verbatim; the owner re-checks at accept time. */
  expires_at: string;
  member: {
    member_id: string;
    name: string;
    /** Base64 SPKI DER Ed25519 signing public key (v2 identity). */
    sign_pk: string;
    /** orgpk1:… X25519 seal public key. */
    seal_pk: string;
  };
  issued_at: string;
  /**
   * Optional Mini `user_hash` from the joiner node (`GET /api/status`).
   * The owner uses this on `org member add` to grant Exemem principal
   * membership on the org head. Absent on older joiners.
   */
  user_hash?: string;
};

export type JoinAccept = {
  payload: JoinAcceptPayload;
  /** base64url Ed25519(member signing key, JCS(payload)). */
  sig: string;
};

function acceptAesKey(e2eKeyB64: string): Buffer {
  const e2e = Buffer.from(e2eKeyB64, "base64");
  if (e2e.length < 16) {
    throw new Error("org e2e key is missing or too short for acceptance sealing");
  }
  return createHash("sha256").update(e2e).update(ACCEPT_KDF_INFO).digest();
}

/**
 * Normalize a Mini user_hash for the join-accept payload.
 * Empty, whitespace, or over-long values are omitted (grant stays fail-closed).
 */
export function normalizeMiniUserHash(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/** Build and self-sign the acceptance from an unsealed invite + local identity. */
export function buildJoinAccept(input: {
  invite: OrgInvite;
  identity: MemberSealIdentity;
  memberName?: string;
  /** Joiner Mini user_hash (`GET /api/status`); omitted when unknown. */
  userHash?: string;
}): JoinAccept {
  if (!input.invite.claim_nonce) {
    throw new Error(
      "invite has no claim_nonce (issued by an older org CLI); ask the admin for a fresh invite to be added to the member registry",
    );
  }
  const fingerprint = memberFingerprint(input.identity);
  const userHash = normalizeMiniUserHash(input.userHash);
  const payload: JoinAcceptPayload = {
    v: ACCEPT_VERSION,
    org_hash: input.invite.org_hash,
    slug: input.invite.slug,
    claim_nonce: input.invite.claim_nonce,
    expires_at: input.invite.expires_at ?? "",
    member: {
      member_id: fingerprint,
      name: input.memberName ?? `member-${fingerprint.slice(0, 8)}`,
      sign_pk: input.identity.signing_public_key,
      seal_pk: memberPubkeyLine(input.identity),
    },
    issued_at: new Date().toISOString(),
    ...(userHash ? { user_hash: userHash } : {}),
  };
  return { payload, sig: signMemberPayload(input.identity, payload) };
}

/** Seal the acceptance for the clear channel back to the org admin. */
export function sealJoinAccept(accept: JoinAccept, e2eKeyB64: string): string {
  const aesKey = acceptAesKey(e2eKeyB64);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
  cipher.setAAD(Buffer.from(accept.payload.org_hash, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(accept), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  // org_hash travels in the clear prefix and is bound via AAD, not ciphertext.
  const packed = Buffer.concat([
    Buffer.from([ACCEPT_VERSION]),
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]);
  return `${ACCEPT_PREFIX}${accept.payload.org_hash}.${packed.toString("base64url")}`;
}

export function isJoinAcceptToken(token: string): boolean {
  return token.trim().startsWith(ACCEPT_PREFIX);
}

/**
 * Open and validate an acceptance with the org E2E key. Verifies the AES-GCM
 * tag (e2e possession + integrity) and the member self-signature over the JCS
 * payload (sign_pk possession). Expiry/claim-nonce policy is the caller's —
 * this only proves the package is authentic.
 */
export function unsealJoinAccept(token: string, e2eKeyB64: string): JoinAccept {
  const trimmed = token.trim();
  if (!trimmed.startsWith(ACCEPT_PREFIX)) {
    throw new Error("acceptance must start with orgaccept1:");
  }
  const rest = trimmed.slice(ACCEPT_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) {
    throw new Error("acceptance token is malformed (expected orgaccept1:<org_hash>.<sealed>)");
  }
  const orgHash = rest.slice(0, dot);
  let packed: Buffer;
  try {
    packed = Buffer.from(rest.slice(dot + 1), "base64url");
  } catch {
    throw new Error("acceptance token is not valid base64url");
  }
  if (packed.length < 1 + 12 + 16 + 2) {
    throw new Error("acceptance token is truncated");
  }
  if (packed[0] !== ACCEPT_VERSION) {
    throw new Error(`unsupported acceptance version: ${packed[0]}`);
  }
  const nonce = packed.subarray(1, 13);
  const tag = packed.subarray(13, 29);
  const ciphertext = packed.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", acceptAesKey(e2eKeyB64), nonce);
  decipher.setAAD(Buffer.from(orgHash, "utf8"));
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      "failed to open acceptance (wrong org e2e key or corrupt/tampered token)",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("acceptance plaintext is not valid JSON");
  }
  const accept = assertAcceptShape(parsed);
  if (accept.payload.org_hash !== orgHash) {
    throw new Error("acceptance org_hash does not match its sealed envelope");
  }
  if (!verifyMemberPayload(accept.payload.member.sign_pk, accept.payload, accept.sig)) {
    throw new Error(
      "acceptance member signature invalid (tampered payload or wrong signing key)",
    );
  }
  return accept;
}

/** True when the acceptance's copied invite expiry is in the past. */
export function joinAcceptExpired(accept: JoinAccept, now = new Date()): boolean {
  if (!accept.payload.expires_at) return false;
  const expires = Date.parse(accept.payload.expires_at);
  if (Number.isNaN(expires)) return true; // unparseable expiry fails closed
  return now.getTime() > expires;
}

function assertAcceptShape(raw: unknown): JoinAccept {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("acceptance must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.sig !== "string" || r.sig.length === 0) {
    throw new Error("acceptance missing sig");
  }
  const p = r.payload;
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    throw new Error("acceptance missing payload");
  }
  const payload = p as Record<string, unknown>;
  if (payload.v !== ACCEPT_VERSION) {
    throw new Error(`unsupported acceptance payload version: ${String(payload.v)}`);
  }
  for (const key of ["org_hash", "slug", "claim_nonce", "issued_at"] as const) {
    if (typeof payload[key] !== "string" || (payload[key] as string).length === 0) {
      throw new Error(`acceptance missing field: ${key}`);
    }
  }
  if (typeof payload.expires_at !== "string") {
    throw new Error("acceptance expires_at must be a string");
  }
  const member = payload.member;
  if (typeof member !== "object" || member === null || Array.isArray(member)) {
    throw new Error("acceptance missing member");
  }
  const m = member as Record<string, unknown>;
  for (const key of ["member_id", "name", "sign_pk", "seal_pk"] as const) {
    if (typeof m[key] !== "string" || (m[key] as string).length === 0) {
      throw new Error(`acceptance member missing field: ${key}`);
    }
  }
  let userHash: string | undefined;
  if (Object.prototype.hasOwnProperty.call(payload, "user_hash")) {
    if (typeof payload.user_hash !== "string" || payload.user_hash.length === 0) {
      throw new Error("acceptance user_hash must be a non-empty string when present");
    }
    userHash = payload.user_hash;
  }
  // Round-trip through JCS to guarantee the signature target is well-formed.
  canonicalizeJcs(payload);
  return {
    payload: {
      v: ACCEPT_VERSION,
      org_hash: payload.org_hash as string,
      slug: payload.slug as string,
      claim_nonce: payload.claim_nonce as string,
      expires_at: payload.expires_at as string,
      member: {
        member_id: m.member_id as string,
        name: m.name as string,
        sign_pk: m.sign_pk as string,
        seal_pk: m.seal_pk as string,
      },
      issued_at: payload.issued_at as string,
      ...(userHash ? { user_hash: userHash } : {}),
    },
    sig: r.sig as string,
  };
}
