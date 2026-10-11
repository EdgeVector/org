import { sign } from "node:crypto";
import { existsSync } from "node:fs";

import { defaultConfigPath, type Config } from "./config.ts";
import { resolveCanonicalChain, type OrgEpoch } from "./epoch.ts";
import { normalizeMiniUserHash } from "./join-accept.ts";
import { isLoopbackNodeUrl, resolveSocketPath, type LastDbClient } from "./lastdb.ts";
import {
  canonicalizeJcs,
  defaultMemberIdentityPath,
  loadMemberIdentity,
  memberFingerprint,
  memberPubkeyLine,
  memberSigningPrivateKeyObject,
} from "./member-identity.ts";
import { udsJson } from "./org-sync.ts";
import { listOrgEpochs, type Organization } from "./storage.ts";

export type AuthorityContext = {
  client: LastDbClient;
  config: Config;
  org: Organization;
  socketPath?: string;
  identityPath?: string;
  storageRecovery?: { action: "grant" | "revoke"; principal: string };
};

export type AuthorityReceipt = {
  ok: true;
  account: { kind: "org"; id: string };
  epoch_hash: string;
  epoch_no: number;
};

export const MAX_ORG_AUTHORITY_JSON_BYTES = 350 * 1024;

export async function enrolledCloudAuthority(context: AuthorityContext, chain: OrgEpoch[], requireAdmin = false) {
  assertOwnerSocket(context.config);
  const { status, json } = await udsJson("POST", "/api/org/authority/status", {
    account: { kind: "org", id: context.org.orgHash },
  }, context.socketPath ?? context.config.nodeSocketPath);
  const receipt = unwrap(json);
  if (status >= 400 || receipt.ok !== true) {
    throw new Error(`cannot check org cloud enrollment: ${safeError(receipt, status)}; no new epoch was signed`);
  }
  const account = receipt.account as Record<string, unknown> | undefined;
  if (account?.kind !== "org" || account.id !== context.org.orgHash
    || typeof receipt.configured !== "boolean" || typeof receipt.absent !== "boolean") {
    throw new Error("org cloud enrollment returned a different account or invalid metadata");
  }
  if (receipt.configured === false || receipt.absent === true) return false;
  const acceptedTip = chain.find((epoch) => epoch.epoch_hash === receipt.epoch_hash
    && epoch.payload.epoch_no === receipt.epoch_no);
  if (!acceptedTip) {
    throw new Error("the cloud authority tip is absent from the verified local chain; no new epoch was signed");
  }
  const principal = normalizeMiniUserHash(receipt.user_hash);
  const actor = acceptedTip.payload.members.some((member) => member.status === "active"
    && member.cloud_user_hash === principal
    && (!requireAdmin || member.roles.some((role) => role === "owner" || role === "admin")));
  if (!principal || !actor) {
    throw new Error("the authenticated cloud principal lacks the required current signed org role; no new epoch was signed");
  }
  return true;
}

export async function currentCloudPrincipal(client: LastDbClient): Promise<string> {
  const principal = normalizeMiniUserHash(await client.nodeUserHash());
  if (!principal) {
    throw new Error("the current node has no valid cloud principal; no org authority was signed");
  }
  return principal;
}

export async function verifiedAuthorityChain(context: AuthorityContext): Promise<OrgEpoch[]> {
  assertOwnerSocket(context.config);
  const listing = await listOrgEpochs(context.client, context.config, context.org.orgHash);
  const resolved = resolveCanonicalChain(listing.epochs, {
    orgHash: context.org.orgHash,
    orgPublicKeyB64: context.org.orgPublicKey,
  });
  if (listing.malformed.length || resolved.invalid.length || !resolved.ok || !resolved.tip) {
    throw new Error(`refusing cloud authority publication: ${resolved.error ?? "invalid signed epoch records"}`);
  }
  return resolved.chain;
}

export async function publishCloudAuthority(context: AuthorityContext): Promise<AuthorityReceipt> {
  try {
    const chain = await verifiedAuthorityChain(context);
    const tip = chain[chain.length - 1]!;
    const request = admitCloudAuthorityRequest(context, chain);
    const { status, json } = await udsJson("POST", "/api/org/authority/publish", request,
      context.socketPath ?? context.config.nodeSocketPath);
    const receipt = unwrap(json);
    if (status >= 400 || receipt.ok !== true) {
      throw new Error(`cloud authority publication failed: ${safeError(receipt, status)}`);
    }
    const account = receipt.account as Record<string, unknown> | undefined;
    if (account?.kind !== "org" || account.id !== context.org.orgHash
      || receipt.epoch_hash !== tip.epoch_hash || receipt.epoch_no !== tip.payload.epoch_no) {
      throw new Error("cloud authority publication returned a different account or signed epoch");
    }
    return receipt as AuthorityReceipt;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "cloud authority publication failed"}; ${authorityRecovery(context)}`);
  }
}

export function admitCloudAuthorityRequest(context: AuthorityContext, chain: OrgEpoch[]) {
  assertOwnerSocket(context.config);
  if (!chain.length || chain.length > 1000) {
    throw new Error("cloud authority publication requires 1..1000 signed epochs");
  }
  const tip = chain[chain.length - 1]!;
  const storedAuthority = {
    account: { kind: "org", id: context.org.orgHash },
    epoch_no: tip.payload.epoch_no,
    epoch_hash: tip.epoch_hash,
    org_root_spki_base64: context.org.orgPublicKey,
    epoch: tip.payload,
  };
  if (Buffer.byteLength(canonicalizeJcs(storedAuthority)) > MAX_ORG_AUTHORITY_JSON_BYTES) {
    throw new Error("cloud_org_authority_item_too_large: the terminal authority exceeds the 350KiB cloud cap");
  }
  const enrollment = originalOwnerEnrollment(context, chain);
  const request = {
    account: { kind: "org", id: context.org.orgHash },
    org_authority: {
      org_root_spki_base64: context.org.orgPublicKey,
      epochs: chain.map((epoch) => ({
        payload_jcs: epoch.payload_jcs,
        signature_base64url: epoch.sig,
      })),
      ...(enrollment ? { owner_enrollment: enrollment } : {}),
    },
  };
  if (Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024) {
    throw new Error("cloud authority request exceeds the 1MiB owner-route cap");
  }
  return request;
}

export function assertOwnerSocket(config: Config): void {
  if (!isLoopbackNodeUrl(config.nodeUrl)) {
    throw new Error("org cloud authority requires one selected local owner socket; remote node URLs are not supported");
  }
}

export function authorityCommand(context: AuthorityContext, arguments_: string[]): string {
  const args = [...arguments_, "--config", context.config.sourceConfigPath ?? defaultConfigPath(),
    "--node-url", context.config.nodeUrl, "--socket", resolveSocketPath(context.socketPath ?? context.config.nodeSocketPath)];
  if (context.identityPath) args.push("--identity", context.identityPath);
  return `org ${args.map((value) => `'${value.replaceAll("'", "'\"'\"'")}'`).join(" ")}`;
}

export function authorityRecovery(context: AuthorityContext): string {
  const publish = authorityCommand(context, ["epoch", "publish", context.org.slug]);
  const storage = context.storageRecovery;
  const follow = storage ? authorityCommand(context,
    ["member", storage.action, context.org.slug, storage.principal, ...(storage.action === "grant" ? ["--role", "writer"] : [])]) : undefined;
  return `the local signed epoch remains; next: ${publish}${follow ? `; then: ${follow}` : ""}`;
}

function originalOwnerEnrollment(context: AuthorityContext, chain: OrgEpoch[]) {
  const genesis = chain[0]!;
  const tip = chain[chain.length - 1]!;
  const path = context.identityPath ?? defaultMemberIdentityPath();
  if (!existsSync(path)) return undefined;
  const identity = loadMemberIdentity(path);
  const original = genesis.payload.members.find((member) => member.status === "active"
    && member.roles.includes("owner") && member.member_id === memberFingerprint(identity)
    && member.sign_pk === identity.signing_public_key && member.seal_pk === memberPubkeyLine(identity));
  if (!original || original.cloud_user_hash) return undefined;
  const current = tip.payload.members.find((member) => member.member_id === original.member_id);
  if (!current || current.status !== "active" || !current.roles.includes("owner")
    || current.sign_pk !== original.sign_pk || current.seal_pk !== original.seal_pk
    || !normalizeMiniUserHash(current.cloud_user_hash)) return undefined;
  const payload_jcs = canonicalizeJcs({
    v: 1,
    purpose: "org-cloud-owner-enrollment",
    org_hash: context.org.orgHash,
    member_id: original.member_id,
    cloud_user_hash: current.cloud_user_hash,
    epoch_hash: tip.epoch_hash,
  });
  return {
    payload_jcs,
    signature_base64url: sign(null, Buffer.from(payload_jcs), memberSigningPrivateKeyObject(identity)).toString("base64url"),
  };
}

function unwrap(json: unknown): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const envelope = json as Record<string, unknown>;
  const body = envelope.data ?? envelope.result ?? envelope;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const receipt = body as Record<string, unknown>;
  if (envelope.user_hash !== undefined && receipt.user_hash !== undefined
    && envelope.user_hash !== receipt.user_hash) {
    throw new Error("org authority returned ambiguous authenticated principal metadata");
  }
  return envelope.user_hash === undefined ? receipt : { ...receipt, user_hash: envelope.user_hash };
}

function safeError(receipt: Record<string, unknown>, status: number): string {
  const code = receipt.code ?? receipt.error_code ?? receipt.error;
  const match = typeof code === "string" ? code.match(/\bcloud_[a-z0-9_]+\b/) : null;
  return match ? match[0] : `HTTP ${status}`;
}
