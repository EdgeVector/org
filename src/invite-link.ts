import { randomUUID } from "node:crypto";

import { assertSlug } from "./schema.ts";
import { orgHashFromPublicKey } from "./crypto.ts";
import { parseMemberPubkey } from "./member-identity.ts";

export const ORG_INVITE_LINK_VERSION = 1 as const;
export const DEFAULT_ORG_INVITE_LINK_BASE = "https://thelastdb.com/join";

export type OrgInviteLinkIntent = {
  version: typeof ORG_INVITE_LINK_VERSION;
  kind: "org-intent";
  correlation_id: string;
  org_slug: string;
  org_name: string;
  org_hash: string;
  sender_identity: string;
  sender_public_key: string;
  issued_at: string;
  expires_at: string;
  install_url: string;
};

export type OrgInviteLinkResponse = {
  version: typeof ORG_INVITE_LINK_VERSION;
  kind: "org-intent-response";
  correlation_id: string;
  org_hash: string;
  sender_identity: string;
  recipient_public_key: string;
  recipient_fingerprint: string;
  created_at: string;
};

function encodeJson(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new Error("org invite link is not valid base64url JSON");
  }
}

function normalizeBase(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("org invite link base must not be empty");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("org invite link base must use http:// or https://");
  }
  return trimmed;
}

function assertIntent(value: unknown): OrgInviteLinkIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("org invite link must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of [
    "correlation_id",
    "org_slug",
    "org_name",
    "org_hash",
    "sender_identity",
    "sender_public_key",
    "issued_at",
    "expires_at",
    "install_url",
  ] as const) {
    if (typeof raw[key] !== "string" || raw[key].length === 0) {
      throw new Error(`org invite link missing field: ${key}`);
    }
  }
  if (raw.version !== ORG_INVITE_LINK_VERSION || raw.kind !== "org-intent") {
    throw new Error("unsupported org invite link version or kind");
  }
  const orgSlug = assertSlug(raw.org_slug as string, "org slug");
  const senderPublicKey = raw.sender_public_key as string;
  if (orgHashFromPublicKey(senderPublicKey) !== raw.org_hash) {
    throw new Error("org invite link org_hash does not match sender_public_key");
  }
  normalizeBase(raw.install_url as string);
  return {
    version: ORG_INVITE_LINK_VERSION,
    kind: "org-intent",
    correlation_id: raw.correlation_id as string,
    org_slug: orgSlug,
    org_name: raw.org_name as string,
    org_hash: raw.org_hash as string,
    sender_identity: raw.sender_identity as string,
    sender_public_key: senderPublicKey,
    issued_at: raw.issued_at as string,
    expires_at: raw.expires_at as string,
    install_url: raw.install_url as string,
  };
}

export function buildOrgInviteLink(input: {
  orgSlug: string;
  orgName: string;
  orgHash: string;
  senderIdentity: string;
  senderPublicKey: string;
  ttlMs?: number;
  linkBase?: string;
  installUrl?: string;
  now?: Date;
}): { intent: OrgInviteLinkIntent; url: string } {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 72 * 60 * 60 * 1000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("org invite link ttl must be a positive duration");
  }
  const orgSlug = assertSlug(input.orgSlug, "org slug");
  if (orgHashFromPublicKey(input.senderPublicKey) !== input.orgHash) {
    throw new Error("org invite link org_hash does not match sender_public_key");
  }
  const linkBase = normalizeBase(input.linkBase ?? DEFAULT_ORG_INVITE_LINK_BASE);
  const intent: OrgInviteLinkIntent = {
    version: ORG_INVITE_LINK_VERSION,
    kind: "org-intent",
    correlation_id: `org-intent-${randomUUID()}`,
    org_slug: orgSlug,
    org_name: input.orgName,
    org_hash: input.orgHash,
    sender_identity: input.senderIdentity,
    sender_public_key: input.senderPublicKey,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    install_url: input.installUrl ?? "https://thelastdb.com/llms.txt",
  };
  return { intent, url: `${linkBase}/${encodeJson(intent)}` };
}

export function parseOrgInviteLink(value: string): OrgInviteLinkIntent {
  const trimmed = value.trim();
  const token = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  return assertIntent(decodeJson(token));
}

export function orgInviteLinkExpired(intent: OrgInviteLinkIntent, now = new Date()): boolean {
  const expires = Date.parse(intent.expires_at);
  return Number.isNaN(expires) || now.getTime() > expires;
}

export function buildOrgInviteLinkResponse(
  intent: OrgInviteLinkIntent,
  recipientPublicKey: string,
  now = new Date(),
): { response: OrgInviteLinkResponse; token: string } {
  const recipient = parseMemberPubkey(recipientPublicKey);
  const response: OrgInviteLinkResponse = {
    version: ORG_INVITE_LINK_VERSION,
    kind: "org-intent-response",
    correlation_id: intent.correlation_id,
    org_hash: intent.org_hash,
    sender_identity: intent.sender_identity,
    recipient_public_key: recipient.encoded,
    recipient_fingerprint: recipient.fingerprint,
    created_at: now.toISOString(),
  };
  return { response, token: `orgreply1:${encodeJson(response)}` };
}

export function buildHumanInviteLinkInstructions(input: {
  intent: OrgInviteLinkIntent;
  url: string;
}): string {
  const { intent, url } = input;
  return `# Join ${intent.org_name} on LastDB

Open this link to send a one-click org sharing request to ${intent.sender_identity}:

${url}

The link contains public bootstrap data only. It does not contain the org E2E key.
After you share your information, the sender's node sends the encrypted invite
through the connection mailbox. The Org app then stores the key in LastSecrets
and joins the organization.

If the link does not open automatically, install LastDB and Org from:
${intent.install_url}
Then run:

\`\`\`bash
org link accept '${url}'
\`\`\`

Link expires: ${intent.expires_at}
`;
}
