/**
 * OrgEpoch: owner-signed, hash-chained membership snapshots.
 *
 * The epoch chain IS the member registry
 * (decision-2026-08-18-lastgit-collaborator-trust-epochs) — there are no
 * mutable member rows. Every epoch carries the full members[] snapshot, links
 * to its predecessor by payload hash, and is signed by the org root Ed25519
 * key over the RFC 8785 (JCS) canonical payload bytes.
 *
 * Canonical-chain rule: highest epoch_no wins; at a tie, the lexicographically
 * smaller epoch_hash wins. `issued_at`/`nonce` are informational and never
 * used for ordering.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

import { canonicalizeJcs } from "./member-identity.ts";

export const EPOCH_VERSION = 1;

export type EpochMemberStatus = "active" | "revoked";

export type EpochMember = {
  /** Stable app-level member id (seal-key fingerprint by convention). */
  member_id: string;
  /** Human-readable label; not an identity. */
  name: string;
  /** Base64 SPKI DER Ed25519 signing public key. */
  sign_pk: string;
  /** orgpk1:… X25519 seal public key (invite recipient key). */
  seal_pk: string;
  roles: string[];
  status: EpochMemberStatus;
};

export type OrgEpochPayload = {
  v: number;
  org_hash: string;
  epoch_no: number;
  /** sha256 hex of the predecessor's JCS payload; "" at genesis. */
  prev_epoch: string;
  members: EpochMember[];
  /** Optional per-repo admin override: repo slug → member_ids. */
  repo_admins?: Record<string, string[]>;
  /** Informational only — never used for ordering. */
  issued_at: string;
  /** Informational entropy so re-signing the same membership forks visibly. */
  nonce: string;
};

export type OrgEpoch = {
  payload: OrgEpochPayload;
  /** Exact JCS canonical payload string — the signed/hashed bytes. */
  payload_jcs: string;
  /** base64url Ed25519(org root key, payload_jcs). */
  sig: string;
  /** sha256 hex of payload_jcs. */
  epoch_hash: string;
};

export type EpochVerifyResult = { ok: true } | { ok: false; error: string };

export type CanonicalChainResult = {
  /** Canonical tip (highest epoch_no, smaller-hash tie-break), or null when empty. */
  tip: OrgEpoch | null;
  /** Chain ordered genesis → tip, as far back as prev links resolve. */
  chain: OrgEpoch[];
  /** True when the walk reached a genesis epoch (epoch_no 0, prev_epoch ""). */
  complete: boolean;
  /** prev_epoch hash the walk could not resolve, when incomplete. */
  missing?: string;
};

export type ResolvedChain = {
  ok: boolean;
  error?: string;
  /** Verified chain genesis → tip (empty when not ok). */
  chain: OrgEpoch[];
  tip: OrgEpoch | null;
  /** Epochs excluded because their own hash/signature did not verify. */
  invalid: { epoch_hash: string; error: string }[];
};

export function newEpochNonce(): string {
  return randomBytes(16).toString("hex");
}

export function epochPayloadHash(payloadJcs: string): string {
  return createHash("sha256").update(Buffer.from(payloadJcs, "utf8")).digest("hex");
}

export function signPkFingerprint(signPkB64: string): string {
  return createHash("sha256")
    .update(Buffer.from(signPkB64, "base64"))
    .digest("hex")
    .slice(0, 16);
}

/** Sign a payload with the org root Ed25519 private key (base64 PKCS8 DER). */
export function signEpochPayload(
  payload: OrgEpochPayload,
  orgPrivateKeyB64: string,
): OrgEpoch {
  assertPayloadShape(payload);
  const payloadJcs = canonicalizeJcs(payload);
  const key = createPrivateKey({
    key: Buffer.from(orgPrivateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const sig = cryptoSign(null, Buffer.from(payloadJcs, "utf8"), key).toString(
    "base64url",
  );
  return {
    payload,
    payload_jcs: payloadJcs,
    sig,
    epoch_hash: epochPayloadHash(payloadJcs),
  };
}

/** Rebuild an OrgEpoch from stored canonical payload bytes + signature. */
export function parseEpoch(payloadJcs: string, sig: string): OrgEpoch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJcs);
  } catch (err) {
    throw new Error(
      `epoch payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (canonicalizeJcs(parsed) !== payloadJcs) {
    throw new Error("epoch payload is not in JCS canonical form");
  }
  const payload = parsed as OrgEpochPayload;
  assertPayloadShape(payload);
  return {
    payload,
    payload_jcs: payloadJcs,
    sig,
    epoch_hash: epochPayloadHash(payloadJcs),
  };
}

/** Verify one epoch record in isolation: canonical bytes + org-root signature. */
export function verifyEpoch(
  epoch: OrgEpoch,
  orgPublicKeyB64: string,
): EpochVerifyResult {
  if (epochPayloadHash(epoch.payload_jcs) !== epoch.epoch_hash) {
    return { ok: false, error: "epoch_hash does not match payload bytes" };
  }
  if (canonicalizeJcs(epoch.payload) !== epoch.payload_jcs) {
    return { ok: false, error: "payload does not match canonical payload bytes" };
  }
  let sigOk = false;
  try {
    const sigBytes = Buffer.from(epoch.sig, "base64url");
    if (sigBytes.length === 64) {
      const publicKey = createPublicKey({
        key: Buffer.from(orgPublicKeyB64, "base64"),
        format: "der",
        type: "spki",
      });
      sigOk = cryptoVerify(
        null,
        Buffer.from(epoch.payload_jcs, "utf8"),
        publicKey,
        sigBytes,
      );
    }
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, error: "org root signature invalid (wrong key or tampered epoch)" };
  }
  return { ok: true };
}

/**
 * Canonical tip among any set of epochs: highest epoch_no wins; at a tie the
 * lexicographically smaller epoch_hash wins. Pure and signature-agnostic —
 * callers filter to verified epochs first (see resolveCanonicalChain).
 */
export function selectCanonicalEpoch(epochs: OrgEpoch[]): OrgEpoch | null {
  let winner: OrgEpoch | null = null;
  for (const epoch of epochs) {
    if (
      winner === null ||
      epoch.payload.epoch_no > winner.payload.epoch_no ||
      (epoch.payload.epoch_no === winner.payload.epoch_no &&
        epoch.epoch_hash < winner.epoch_hash)
    ) {
      winner = epoch;
    }
  }
  return winner;
}

/**
 * Walk prev_epoch links back from the canonical tip. Returns the chain in
 * genesis → tip order plus whether the walk reached genesis.
 */
export function canonicalChain(epochs: OrgEpoch[]): CanonicalChainResult {
  const byHash = new Map<string, OrgEpoch>();
  for (const epoch of epochs) byHash.set(epoch.epoch_hash, epoch);
  const tip = selectCanonicalEpoch([...byHash.values()]);
  if (!tip) return { tip: null, chain: [], complete: false };

  const reversed: OrgEpoch[] = [tip];
  const seen = new Set<string>([tip.epoch_hash]);
  let current = tip;
  while (current.payload.prev_epoch !== "") {
    const prev = byHash.get(current.payload.prev_epoch);
    if (!prev || seen.has(prev.epoch_hash)) {
      return {
        tip,
        chain: reversed.slice().reverse(),
        complete: false,
        missing: current.payload.prev_epoch,
      };
    }
    reversed.push(prev);
    seen.add(prev.epoch_hash);
    current = prev;
  }
  const complete = current.payload.epoch_no === 0;
  return { tip, chain: reversed.slice().reverse(), complete };
}

/** Verify chain structure genesis → tip: contiguous epoch_no + prev links. */
export function verifyEpochChain(
  chain: OrgEpoch[],
  opts: { orgHash: string; orgPublicKeyB64: string },
): EpochVerifyResult {
  if (chain.length === 0) return { ok: false, error: "epoch chain is empty" };
  for (let i = 0; i < chain.length; i += 1) {
    const epoch = chain[i]!;
    const label = `epoch ${epoch.payload.epoch_no} (${epoch.epoch_hash.slice(0, 12)}…)`;
    const own = verifyEpoch(epoch, opts.orgPublicKeyB64);
    if (!own.ok) return { ok: false, error: `${label}: ${own.error}` };
    if (epoch.payload.org_hash !== opts.orgHash) {
      return { ok: false, error: `${label}: org_hash mismatch` };
    }
    if (epoch.payload.epoch_no !== i) {
      return {
        ok: false,
        error: `${label}: expected epoch_no ${i} at chain position ${i}`,
      };
    }
    if (i === 0) {
      if (epoch.payload.prev_epoch !== "") {
        return { ok: false, error: `${label}: genesis prev_epoch must be ""` };
      }
    } else if (epoch.payload.prev_epoch !== chain[i - 1]!.epoch_hash) {
      return { ok: false, error: `${label}: prev_epoch does not link to predecessor` };
    }
  }
  return { ok: true };
}

/**
 * The full canonical-chain resolution lastgit reuses: filter to individually
 * verified epochs for this org, pick the canonical tip, walk back to genesis,
 * and verify the chain structure. Invalid records are reported, not silently
 * dropped.
 */
export function resolveCanonicalChain(
  epochs: OrgEpoch[],
  opts: { orgHash: string; orgPublicKeyB64: string },
): ResolvedChain {
  const invalid: ResolvedChain["invalid"] = [];
  const valid: OrgEpoch[] = [];
  for (const epoch of epochs) {
    const own = verifyEpoch(epoch, opts.orgPublicKeyB64);
    if (!own.ok) {
      invalid.push({ epoch_hash: epoch.epoch_hash, error: own.error });
      continue;
    }
    if (epoch.payload.org_hash !== opts.orgHash) {
      invalid.push({ epoch_hash: epoch.epoch_hash, error: "org_hash mismatch" });
      continue;
    }
    valid.push(epoch);
  }
  if (valid.length === 0) {
    return {
      ok: false,
      error: epochs.length === 0 ? "no epochs found" : "no verifiable epochs found",
      chain: [],
      tip: null,
      invalid,
    };
  }
  const walked = canonicalChain(valid);
  if (!walked.complete) {
    return {
      ok: false,
      error: `epoch chain does not reach genesis (missing ${walked.missing ?? "link"})`,
      chain: [],
      tip: walked.tip,
      invalid,
    };
  }
  const structure = verifyEpochChain(walked.chain, opts);
  if (!structure.ok) {
    return { ok: false, error: structure.error, chain: [], tip: walked.tip, invalid };
  }
  return { ok: true, chain: walked.chain, tip: walked.tip, invalid };
}

export function buildEpochPayload(input: {
  orgHash: string;
  epochNo: number;
  prevEpoch: string;
  members: EpochMember[];
  repoAdmins?: Record<string, string[]>;
  issuedAt?: string;
  nonce?: string;
}): OrgEpochPayload {
  const payload: OrgEpochPayload = {
    v: EPOCH_VERSION,
    org_hash: input.orgHash,
    epoch_no: input.epochNo,
    prev_epoch: input.prevEpoch,
    members: input.members,
    issued_at: input.issuedAt ?? new Date().toISOString(),
    nonce: input.nonce ?? newEpochNonce(),
  };
  if (input.repoAdmins !== undefined) payload.repo_admins = input.repoAdmins;
  assertPayloadShape(payload);
  return payload;
}

/** The epoch a member first appears in (provenance for `org member list`). */
export function memberAddedEpoch(chain: OrgEpoch[], memberId: string): number | null {
  for (const epoch of chain) {
    if (epoch.payload.members.some((m) => m.member_id === memberId)) {
      return epoch.payload.epoch_no;
    }
  }
  return null;
}

function assertPayloadShape(payload: OrgEpochPayload): void {
  if (typeof payload.v !== "number" || payload.v !== EPOCH_VERSION) {
    throw new Error(`unsupported epoch version: ${String(payload.v)}`);
  }
  if (typeof payload.org_hash !== "string" || payload.org_hash.length === 0) {
    throw new Error("epoch org_hash must be a non-empty string");
  }
  if (
    typeof payload.epoch_no !== "number" ||
    !Number.isInteger(payload.epoch_no) ||
    payload.epoch_no < 0
  ) {
    throw new Error("epoch_no must be a non-negative integer");
  }
  if (typeof payload.prev_epoch !== "string") {
    throw new Error("prev_epoch must be a string");
  }
  if (payload.epoch_no === 0 && payload.prev_epoch !== "") {
    throw new Error('genesis epoch (epoch_no 0) must have prev_epoch ""');
  }
  if (payload.epoch_no > 0 && !/^[0-9a-f]{64}$/.test(payload.prev_epoch)) {
    throw new Error("non-genesis prev_epoch must be a sha256 hex hash");
  }
  if (!Array.isArray(payload.members) || payload.members.length === 0) {
    throw new Error("epoch members must be a non-empty array");
  }
  const ids = new Set<string>();
  for (const member of payload.members) {
    for (const key of ["member_id", "name", "sign_pk", "seal_pk"] as const) {
      if (typeof member[key] !== "string" || member[key].length === 0) {
        throw new Error(`epoch member ${key} must be a non-empty string`);
      }
    }
    if (
      !Array.isArray(member.roles) ||
      member.roles.some((r) => typeof r !== "string" || r.length === 0)
    ) {
      throw new Error(`epoch member ${member.member_id} roles must be strings`);
    }
    if (member.status !== "active" && member.status !== "revoked") {
      throw new Error(
        `epoch member ${member.member_id} status must be active|revoked`,
      );
    }
    if (ids.has(member.member_id)) {
      throw new Error(`duplicate member_id in epoch: ${member.member_id}`);
    }
    ids.add(member.member_id);
  }
  if (payload.repo_admins !== undefined) {
    if (
      typeof payload.repo_admins !== "object" ||
      payload.repo_admins === null ||
      Array.isArray(payload.repo_admins)
    ) {
      throw new Error("repo_admins must be a map of repo → member_ids");
    }
    for (const [repo, adminIds] of Object.entries(payload.repo_admins)) {
      if (
        !Array.isArray(adminIds) ||
        adminIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw new Error(`repo_admins[${repo}] must be an array of member_ids`);
      }
    }
  }
  if (typeof payload.issued_at !== "string" || payload.issued_at.length === 0) {
    throw new Error("issued_at must be a non-empty string");
  }
  if (typeof payload.nonce !== "string" || payload.nonce.length === 0) {
    throw new Error("nonce must be a non-empty string");
  }
}

export function formatEpochSummary(epoch: OrgEpoch): string {
  const active = epoch.payload.members.filter((m) => m.status === "active").length;
  const revoked = epoch.payload.members.length - active;
  return [
    `epoch=${epoch.payload.epoch_no}`,
    `epoch_hash=${epoch.epoch_hash}`,
    `members=${active}${revoked > 0 ? ` (+${revoked} revoked)` : ""}`,
    `issued_at=${epoch.payload.issued_at}`,
  ].join(" ");
}
