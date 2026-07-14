import { describe, expect, it } from "bun:test";

import { generateOrgKeys } from "../src/crypto.ts";
import { buildInvite } from "../src/invite.ts";
import {
  decodePortableClaim,
  encodePortableClaim,
  sealInvite,
  unsealInvite,
} from "../src/invite-seal.ts";
import { PortableSealedInviteTransport } from "../src/invite-transport.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sampleInvite() {
  const keys = generateOrgKeys();
  return buildInvite({
    slug: "friends",
    name: "Friends",
    orgHash: keys.orgHash,
    orgPublicKey: keys.orgPublicKey,
    e2eKey: keys.e2eKey,
    createdBy: "user-1",
  });
}

describe("invite seal", () => {
  it("round-trips seal/unseal without exposing e2e in envelope string", () => {
    const invite = sampleInvite();
    const sealed = sealInvite(invite);
    expect(sealed).not.toContain(invite.e2e_key);
    const opened = unsealInvite(sealed);
    expect(opened.e2e_key).toBe(invite.e2e_key);
    expect(opened.slug).toBe("friends");
  });

  it("portable claim encode/decode", () => {
    const id = "org-claim-11111111-1111-1111-1111-111111111111";
    const sealed = sealInvite(sampleInvite());
    const token = encodePortableClaim(id, sealed);
    const { claimId, sealedBlob } = decodePortableClaim(token);
    expect(claimId).toBe(id);
    expect(unsealInvite(sealedBlob).slug).toBe("friends");
  });
});

describe("PortableSealedInviteTransport", () => {
  it("deliver + claim with portable token works across processes (no shared memory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-claims-"));
    const prev = process.env.ORG_CLAIM_STORE_DIR;
    process.env.ORG_CLAIM_STORE_DIR = dir;
    try {
      const transport = new PortableSealedInviteTransport();
      const invite = sampleInvite();
      const claim = await transport.deliver({
        recipientIdentity: "mailto:friend@example.com",
        claimId: "org-claim-22222222-2222-2222-2222-222222222222",
        invite,
      });
      expect(claim.sealed_blob.startsWith("org-claim-")).toBe(true);
      expect(claim.sealed_blob).toContain(".");
      expect(claim.sealed_blob).not.toContain(invite.e2e_key);

      // Simulate friend machine: only has the portable token string
      const transport2 = new PortableSealedInviteTransport();
      const opened = await transport2.claim({ claimId: claim.sealed_blob });
      expect(opened.e2e_key).toBe(invite.e2e_key);
      expect(opened.slug).toBe("friends");
    } finally {
      if (prev === undefined) delete process.env.ORG_CLAIM_STORE_DIR;
      else process.env.ORG_CLAIM_STORE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
