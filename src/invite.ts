import { randomUUID } from "node:crypto";

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

export type InviteClaim = {
  version: 1;
  claim_id: string;
  slug: string;
  org_hash: string;
  inviter_identity: string;
  recipient_identity: string;
  /** Transport label: portable sealed token today; "exemem" reserved for cloud messaging. */
  transport: "exemem" | "portable";
  /**
   * Opaque sealed payload. For the portable transport this is the full
   * `org-claim-<uuid>.<base64url-envelope>` token for `org join --claim`.
   */
  sealed_blob: string;
  issued_at: string;
};

export function newInviteClaimId(): string {
  return `org-claim-${randomUUID()}`;
}

export function buildInviteClaim(input: {
  invite: Pick<OrgInvite, "slug" | "org_hash" | "created_by">;
  claimId: string;
  recipientIdentity: string;
  sealedBlob: string;
}): InviteClaim {
  assertSlug(input.invite.slug, "org slug");
  if (!input.claimId.startsWith("org-claim-")) {
    throw new Error("invite claim id must start with org-claim-");
  }
  if (!input.recipientIdentity.trim()) {
    throw new Error("recipient identity is required");
  }
  if (!input.sealedBlob.trim()) {
    throw new Error("sealed invite blob is required");
  }
  return {
    version: 1,
    claim_id: input.claimId,
    slug: input.invite.slug,
    org_hash: input.invite.org_hash,
    inviter_identity: input.invite.created_by,
    recipient_identity: input.recipientIdentity,
    transport: "portable",
    sealed_blob: input.sealedBlob,
    issued_at: new Date().toISOString(),
  };
}

export function buildAgentInstructions(input: {
  invite: Pick<OrgInvite, "slug" | "name">;
  /** Path where the inviter wrote the secret file (for their transfer notes only). */
  invitePath?: string;
}): string {
  const slug = input.invite.slug;
  const name = input.invite.name;
  const inviterPath = input.invitePath ?? `./org-${slug}-invite.json`;
  const friendHint = `~/Downloads/${slug}.invite.json`;
  return `# LastDB org invite — agent instructions

You are helping a human join the LastDB organization **${name}** (\`${slug}\`).

## Security (do not skip)

- The inviter sends a **secret invite file** out-of-band (AirDrop, Signal,
  1Password, USB). That file is a password — never paste its JSON into email,
  chat, Brain, Kanban, git, or logs.
- Ask the human for the path to the invite file **on this machine** after they
  receive it. Inviter wrote it as: \`${inviterPath}\` (their machine; friend path
  may be e.g. \`${friendHint}\`).
- After a successful join, delete the invite file.

## 1) Install (macOS Apple Silicon; skip steps already done)

\`\`\`bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

git clone https://github.com/EdgeVector/last-stack ~/.last-stack
~/.last-stack/setup
~/.last-stack/bin/last-stack-install-apps

brew services start lastdb
curl -s --unix-socket ~/.lastdb/data/folddb.sock http://localhost/health
# expect: {"status":"ok"}
\`\`\`

## 2) One-time app setup

\`\`\`bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
lastsecrets init
org init
# recommended:
brain init --grant-consent
kanban init
\`\`\`

## 3) Join

Ask the human for the invite file path, then:

\`\`\`bash
org join --from /path/the/human/gives/you.invite.json
org list
org show ${slug}
\`\`\`

Delete the invite file after success.

## 4) Optional shared work root

If the inviter named a project folder and db slug:

\`\`\`bash
org bind ${slug} <db-slug> --root ~/path/to/project
cd ~/path/to/project && org resolve && org kanban list
\`\`\`

## Done when

- \`org show ${slug}\` succeeds
- Invite file removed from disk
- You never printed the invite JSON or ran \`lastsecrets get\` on org keys
`;
}

export function buildClaimAgentInstructions(input: {
  invite: Pick<OrgInvite, "slug" | "name">;
  claim: Pick<InviteClaim, "claim_id" | "recipient_identity" | "sealed_blob">;
}): string {
  const slug = input.invite.slug;
  const name = input.invite.name;
  const recipient = input.claim.recipient_identity;
  // Prefer the full portable token (claim_id.envelope) so join works offline.
  const claimToken = input.claim.sealed_blob.startsWith("org-claim-")
    ? input.claim.sealed_blob
    : input.claim.claim_id;
  return `# LastDB org invite — agent instructions (sealed claim)

You are helping a human join the LastDB organization **${name}** (\`${slug}\`).

These instructions do **not** contain the raw org encryption key. They contain a
**portable sealed claim token** — treat that token like a one-time password
(Signal/email to the right person is OK; do not post publicly). Prefer sealed
claim over a \`.invite.json\` file when the inviter used \`--to\`.

Recipient identity hint: \`${recipient}\`

## 1) Install (macOS Apple Silicon; skip steps already done)

\`\`\`bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

git clone https://github.com/EdgeVector/last-stack ~/.last-stack
~/.last-stack/setup
~/.last-stack/bin/last-stack-install-apps

brew services start lastdb
curl -s --unix-socket ~/.lastdb/data/folddb.sock http://localhost/health
# expect: {"status":"ok"}
\`\`\`

## 2) One-time app setup

\`\`\`bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
lastsecrets init
org init
brain init --grant-consent
kanban init
\`\`\`

## 3) Claim the sealed invite

Copy the claim token **exactly** (one line):

\`\`\`
${claimToken}
\`\`\`

Then:

\`\`\`bash
org join --claim '${claimToken}'
org list
org show ${slug}
\`\`\`

If claim fails, ask the inviter to re-send with the secret-file path:
\`org invite ${slug} --out FILE --agent\`.

## Done when

- \`org show ${slug}\` succeeds
- You never printed raw invite JSON or e2e keys
- Prefer deleting this message from shared logs after join
`;
}

/**
 * Agent instructions for the preferred clear-channel path: package is
 * encrypted to the friend's `orgpk1:…` public key (from `org receive`).
 * The package may be pasted over email/Slack; raw e2e_key is never present.
 */
export function buildPubkeySealedAgentInstructions(input: {
  invite: Pick<OrgInvite, "slug" | "name">;
  recipientPubkey: string;
  recipientFingerprint: string;
  sealedPackage: string;
}): string {
  const slug = input.invite.slug;
  const name = input.invite.name;
  const sealed = input.sealedPackage;
  return `# LastDB org invite — agent instructions (pubkey-sealed)

You are helping a human join the LastDB organization **${name}** (\`${slug}\`).

These instructions do **not** contain the raw org encryption key. They contain a
package **encrypted to this person's public key** (\`orgpk1:…\`). Only their
local private key can open it — safe to paste over email/Slack/Signal.

Recipient public key fingerprint: \`${input.recipientFingerprint}\`
Recipient public key: \`${input.recipientPubkey}\`

## 1) Install (macOS Apple Silicon; skip steps already done)

\`\`\`bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

git clone https://github.com/EdgeVector/last-stack ~/.last-stack
~/.last-stack/setup
~/.last-stack/bin/last-stack-install-apps

brew services start lastdb
curl -s --unix-socket ~/.lastdb/data/folddb.sock http://localhost/health
# expect: {"status":"ok"}
\`\`\`

## 2) One-time app setup + show your public key (if not already done)

\`\`\`bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
lastsecrets init
org init
org receive
# Send the printed orgpk1:… line to the admin, then wait for the sealed package.
\`\`\`

## 3) Join with the sealed package

Copy the package **exactly** (one line, starts with \`orgseal1:\`):

\`\`\`
${sealed}
\`\`\`

Then (must use the **same machine / same** \`org receive\` identity that produced the public key):

\`\`\`bash
org join --sealed '${sealed}'
# equivalent: org receive --sealed '${sealed}'
org list
org show ${slug}
\`\`\`

## Done when

- \`org show ${slug}\` succeeds
- You never printed raw invite JSON or ran \`lastsecrets get\` on org keys
`;
}

