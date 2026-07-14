import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  buildInviteClaim,
  type InviteClaim,
  type OrgInvite,
} from "./invite.ts";
import {
  decodePortableClaim,
  encodePortableClaim,
  sealInvite,
  unsealInvite,
} from "./invite-seal.ts";

export type InviteTransport = {
  deliver(input: {
    recipientIdentity: string;
    claimId: string;
    invite: OrgInvite;
  }): Promise<InviteClaim>;
  claim(input: { claimId: string }): Promise<OrgInvite>;
};

function claimsDir(): string {
  const override = process.env.ORG_CLAIM_STORE_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), ".org", "invite-claims");
}

function claimPath(claimId: string): string {
  // claimId is org-claim-uuid without portable suffix
  const safe = claimId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(claimsDir(), `${safe}.sealed`);
}

/**
 * Default sealed-invite transport (works offline / multi-device without Exemem):
 *
 * - deliver: AES-GCM seal the invite; write envelope to ~/.org/invite-claims/
 *   (inviter-side audit/cache); return InviteClaim whose sealed_blob is the
 *   portable token `org-claim-<uuid>.<envelope>` for `org join --claim`.
 * - claim: accept full portable token (preferred) or short claim id if the
 *   sealed envelope is still in the local claim store.
 *
 * The portable token is a **secret bearer** (like a password). Agent
 * instructions may include it; do not post publicly. Raw e2e_key never appears
 * in cleartext in those instructions.
 */
export class PortableSealedInviteTransport implements InviteTransport {
  async deliver(input: {
    recipientIdentity: string;
    claimId: string;
    invite: OrgInvite;
  }): Promise<InviteClaim> {
    const sealedEnvelope = sealInvite(input.invite);
    const dir = claimsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = claimPath(input.claimId);
    writeFileSync(path, sealedEnvelope, { encoding: "utf8", mode: 0o600 });

    const portable = encodePortableClaim(input.claimId, sealedEnvelope);
    // sealed_blob carries the full portable token so --agent instructions can
    // hand a single string to `org join --claim`.
    return buildInviteClaim({
      invite: input.invite,
      claimId: input.claimId,
      recipientIdentity: input.recipientIdentity,
      sealedBlob: portable,
    });
  }

  async claim(input: { claimId: string }): Promise<OrgInvite> {
    const token = input.claimId.trim();
    const { claimId, sealedBlob } = decodePortableClaim(token);

    let envelope = sealedBlob;
    if (!envelope) {
      const path = claimPath(claimId);
      if (!existsSync(path)) {
        throw new Error(
          `claim not found: ${claimId}. Use the full portable claim token from the invite instructions (org-claim-….<envelope>), or the secret-file path: org join --from FILE`,
        );
      }
      envelope = readFileSync(path, "utf8").trim();
    }

    const invite = unsealInvite(envelope);

    // Best-effort one-time consume of local cache (inviter machine).
    try {
      const path = claimPath(claimId);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // ignore
    }

    return invite;
  }
}

class UnavailableInviteTransport implements InviteTransport {
  async deliver(): Promise<InviteClaim> {
    throw new Error(
      "sealed invite transport unavailable; use `org invite --out FILE` as the secret-file fallback",
    );
  }

  async claim(): Promise<OrgInvite> {
    throw new Error(
      "sealed invite transport unavailable; use `org join --from FILE` as the secret-file fallback",
    );
  }
}

/**
 * Default transport: portable sealed claims (no Exemem required).
 * Set ORG_INVITE_TRANSPORT=unavailable to force fail-closed (tests / lockdown).
 */
export function newInviteTransport(): InviteTransport {
  if (process.env.ORG_INVITE_TRANSPORT === "unavailable") {
    return new UnavailableInviteTransport();
  }
  return new PortableSealedInviteTransport();
}
