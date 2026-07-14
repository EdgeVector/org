import { assertSlug } from "./schema.ts";
import { orgHashFromPublicKey } from "./crypto.ts";

export const INVITE_VERSION = 1 as const;

/**
 * One-time join bundle. Contains the raw e2e_key so a peer can join without
 * sharing LastSecrets. After join, the key is stored via lastsecrets put and
 * only lastsecrets:// refs remain in org records.
 */
export type OrgInvite = {
  version: typeof INVITE_VERSION;
  slug: string;
  name: string;
  org_hash: string;
  org_public_key: string;
  /** Base64 32-byte shared secret — SENSITIVE. */
  e2e_key: string;
  created_by: string;
  issued_at: string;
};

export function buildInvite(input: {
  slug: string;
  name: string;
  orgHash: string;
  orgPublicKey: string;
  e2eKey: string;
  createdBy: string;
}): OrgInvite {
  assertSlug(input.slug, "org slug");
  if (!input.e2eKey || input.e2eKey.length < 16) {
    throw new Error("invite e2e_key is missing or too short");
  }
  return {
    version: INVITE_VERSION,
    slug: input.slug,
    name: input.name,
    org_hash: input.orgHash,
    org_public_key: input.orgPublicKey,
    e2e_key: input.e2eKey,
    created_by: input.createdBy,
    issued_at: new Date().toISOString(),
  };
}

export function parseInvite(raw: unknown): OrgInvite {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invite must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== INVITE_VERSION) {
    throw new Error(`unsupported invite version: ${String(r.version)}`);
  }
  for (const key of [
    "slug",
    "name",
    "org_hash",
    "org_public_key",
    "e2e_key",
    "created_by",
    "issued_at",
  ] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new Error(`invite missing field: ${key}`);
    }
  }
  const slug = assertSlug(r.slug as string, "org slug");
  const expectedHash = orgHashFromPublicKey(r.org_public_key as string);
  if (expectedHash !== r.org_hash) {
    throw new Error(
      `invite org_hash does not match org_public_key (got ${r.org_hash}, expected ${expectedHash})`,
    );
  }
  return {
    version: INVITE_VERSION,
    slug,
    name: r.name as string,
    org_hash: r.org_hash as string,
    org_public_key: r.org_public_key as string,
    e2e_key: r.e2e_key as string,
    created_by: r.created_by as string,
    issued_at: r.issued_at as string,
  };
}

export function serializeInvite(invite: OrgInvite): string {
  return JSON.stringify(invite, null, 2) + "\n";
}

export function buildAgentInstructions(input: {
  invite: Pick<OrgInvite, "slug" | "name">;
  invitePath?: string;
}): string {
  const path = input.invitePath ?? "PATH_TO_INVITE_JSON";
  return [
    `Join instructions for ${input.invite.name} (${input.invite.slug})`,
    "",
    "These instructions are safe to send in email. Do NOT paste the invite JSON into email; the sender will provide that file separately.",
    "",
    "1. Install LastDB:",
    "   brew install edgevector/tap/lastdb",
    "2. Install the LastDB app bundle:",
    "   last-stack-install-apps",
    "   If the bundle is not available yet, clone/install the org and lastsecrets apps from EdgeVector.",
    "3. Initialize local secret storage:",
    "   lastsecrets init",
    "4. Initialize org schemas on your LastDB node:",
    "   org init",
    "5. Save the separately provided invite file on this machine, then join:",
    `   org join --from ${path}`,
    "6. Verify membership:",
    `   org show ${input.invite.slug}`,
    "",
    "Keep the invite file private and delete it after a successful join.",
  ].join("\n") + "\n";
}
