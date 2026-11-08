import { randomBytes } from "node:crypto";

import { assertSlug } from "./schema.ts";
import { orgHashFromPublicKey } from "./crypto.ts";

export const INVITE_VERSION = 1 as const;

/** Default invite lifetime when `--expires-in` is not given. */
export const DEFAULT_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/** Non-secret named database metadata carried in a join invite. */
export type OrgInviteDatabase = {
  db_slug: string;
  name: string;
  description: string;
  created_by: string;
};

/** Non-secret folder mapping carried in a join invite. */
export type OrgInvitePathBinding = {
  root: string;
  db_slug: string;
};

/**
 * One-time join bundle. Contains the raw e2e_key so a peer can join without
 * sharing LastSecrets. After join, the key is stored via lastsecrets put and
 * only lastsecrets:// refs remain in org records.
 *
 * `expires_at` and `claim_nonce` power the epoch-chain accept flow: the joiner
 * echoes them in its sealed acceptance, and the owner enforces expiry and
 * one-time claim before minting the membership epoch.
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
  /** Default named database from the inviter's local organization record. */
  default_db?: string;
  /** Named databases that existed when the inviter issued the invite. */
  databases?: OrgInviteDatabase[];
  /** Shared schema identities that the friend must load before querying restored data. */
  schema_names?: string[];
  /** Folder mappings that existed for this organization when issued. */
  path_bindings?: OrgInvitePathBinding[];
  /** RFC 3339 expiry; join and accept both reject after this instant. */
  expires_at: string;
  /** One-time claim nonce (hex); consumed by the owner at accept. */
  claim_nonce: string;
};

export function newInviteClaimNonce(): string {
  return randomBytes(16).toString("hex");
}

export function buildInvite(input: {
  slug: string;
  name: string;
  orgHash: string;
  orgPublicKey: string;
  e2eKey: string;
  createdBy: string;
  defaultDb?: string;
  databases?: OrgInviteDatabase[];
  schemaNames?: string[];
  pathBindings?: OrgInvitePathBinding[];
  /** Milliseconds until expiry; defaults to DEFAULT_INVITE_TTL_MS. */
  ttlMs?: number;
  now?: Date;
}): OrgInvite {
  assertSlug(input.slug, "org slug");
  if (!input.e2eKey || input.e2eKey.length < 16) {
    throw new Error("invite e2e_key is missing or too short");
  }
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_INVITE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("invite ttl must be a positive duration");
  }
  return {
    version: INVITE_VERSION,
    slug: input.slug,
    name: input.name,
    org_hash: input.orgHash,
    org_public_key: input.orgPublicKey,
    e2e_key: input.e2eKey,
    created_by: input.createdBy,
    issued_at: now.toISOString(),
    ...(input.defaultDb ? { default_db: assertSlug(input.defaultDb, "default db slug") } : {}),
    ...(input.databases ? { databases: input.databases.map((db) => ({ ...db })) } : {}),
    ...(input.schemaNames && input.schemaNames.length > 0
      ? { schema_names: [...new Set(input.schemaNames.map((name) => name.trim()).filter(Boolean))] }
      : {}),
    ...(input.pathBindings
      ? { path_bindings: input.pathBindings.map((binding) => ({ ...binding })) }
      : {}),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    claim_nonce: newInviteClaimNonce(),
  };
}

/** True when the invite expiry has passed. Unparseable expiry fails closed. */
export function inviteExpired(invite: OrgInvite, now = new Date()): boolean {
  const expires = Date.parse(invite.expires_at);
  if (Number.isNaN(expires)) return true;
  return now.getTime() > expires;
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
    "expires_at",
    "claim_nonce",
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
  if (r.default_db !== undefined && typeof r.default_db !== "string") {
    throw new Error("invite default_db must be a string when present");
  }
  let databases: OrgInviteDatabase[] | undefined;
  if (r.databases !== undefined) {
    if (!Array.isArray(r.databases)) {
      throw new Error("invite databases must be an array when present");
    }
    databases = r.databases.map((rawDb, index) => {
      if (typeof rawDb !== "object" || rawDb === null || Array.isArray(rawDb)) {
        throw new Error(`invite databases[${index}] must be an object`);
      }
      const db = rawDb as Record<string, unknown>;
      for (const key of ["db_slug", "name", "description", "created_by"] as const) {
        if (typeof db[key] !== "string") {
          throw new Error(`invite databases[${index}] missing string field: ${key}`);
        }
      }
      return {
        db_slug: assertSlug(db.db_slug as string, "db slug"),
        name: db.name as string,
        description: db.description as string,
        created_by: db.created_by as string,
      };
    });
  }
  let schemaNames: string[] | undefined;
  if (r.schema_names !== undefined) {
    if (!Array.isArray(r.schema_names)) {
      throw new Error("invite schema_names must be an array when present");
    }
    schemaNames = r.schema_names.map((name, index) => {
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error(`invite schema_names[${index}] must be a non-empty string`);
      }
      return name.trim();
    });
  }
  let pathBindings: OrgInvitePathBinding[] | undefined;
  if (r.path_bindings !== undefined) {
    if (!Array.isArray(r.path_bindings)) {
      throw new Error("invite path_bindings must be an array when present");
    }
    pathBindings = r.path_bindings.map((rawBinding, index) => {
      if (
        typeof rawBinding !== "object" ||
        rawBinding === null ||
        Array.isArray(rawBinding)
      ) {
        throw new Error(`invite path_bindings[${index}] must be an object`);
      }
      const binding = rawBinding as Record<string, unknown>;
      if (typeof binding.root !== "string" || binding.root.length === 0) {
        throw new Error(`invite path_bindings[${index}] missing string field: root`);
      }
      if (typeof binding.db_slug !== "string") {
        throw new Error(`invite path_bindings[${index}] missing string field: db_slug`);
      }
      return {
        root: binding.root,
        db_slug: assertSlug(binding.db_slug, "db slug"),
      };
    });
  }
  const invite: OrgInvite = {
    version: INVITE_VERSION,
    slug,
    name: r.name as string,
    org_hash: r.org_hash as string,
    org_public_key: r.org_public_key as string,
    e2e_key: r.e2e_key as string,
    created_by: r.created_by as string,
    issued_at: r.issued_at as string,
    ...(typeof r.default_db === "string" && r.default_db.length > 0
      ? { default_db: assertSlug(r.default_db, "default db slug") }
      : {}),
    ...(databases ? { databases } : {}),
    ...(schemaNames ? { schema_names: [...new Set(schemaNames)] } : {}),
    ...(pathBindings ? { path_bindings: pathBindings } : {}),
    expires_at: r.expires_at as string,
    claim_nonce: r.claim_nonce as string,
  };
  return invite;
}

export function serializeInvite(invite: OrgInvite): string {
  return JSON.stringify(invite, null, 2) + "\n";
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
brain init
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

/**
 * Agent instructions for the clear-channel path: package is
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
# Public docs: https://github.com/EdgeVector/org/blob/main/docs/INVITE.md
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

## 4) Send the acceptance back

\`org join\` prints a line starting with \`acceptance=orgaccept1:…\`. Send that
full token back to the org admin over any channel (it contains no secrets).
The admin runs \`org member add ${slug} --accept '<token>'\` to add you to the
signed member registry.
You are not in the registry until they do.

## Done when

- \`org show ${slug}\` succeeds
- The \`acceptance=orgaccept1:…\` line was sent back to the admin
- You never printed raw invite JSON or ran \`lastsecrets get\` on org keys
`;
}
