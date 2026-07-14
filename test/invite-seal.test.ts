import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateOrgKeys } from "../src/crypto.ts";
import { buildInvite } from "../src/invite.ts";
import {
  decodePortableClaim,
  encodePortableClaim,
  isPubkeySealedPackage,
  sealInvite,
  sealInviteToPubkey,
  unsealInvite,
  unsealInviteWithMemberKey,
} from "../src/invite-seal.ts";
import { PortableSealedInviteTransport } from "../src/invite-transport.ts";
import {
  generateMemberSealIdentity,
  memberPrivateKeyObject,
  memberPubkeyLine,
} from "../src/member-identity.ts";

function sampleInvite() {
  const keys = generateOrgKeys();
  return {
    keys,
    invite: buildInvite({
      slug: "friends",
      name: "Friends",
      orgHash: keys.orgHash,
      orgPublicKey: keys.orgPublicKey,
      e2eKey: keys.e2eKey,
      createdBy: "user-1",
    }),
  };
}

describe("invite seal (portable bearer)", () => {
  it("round-trips seal/unseal without exposing e2e in envelope string", () => {
    const { invite } = sampleInvite();
    const sealed = sealInvite(invite);
    expect(sealed).not.toContain(invite.e2e_key);
    const opened = unsealInvite(sealed);
    expect(opened.e2e_key).toBe(invite.e2e_key);
    expect(opened.slug).toBe("friends");
  });

  it("portable claim encode/decode", () => {
    const id = "org-claim-11111111-1111-1111-1111-111111111111";
    const sealed = sealInvite(sampleInvite().invite);
    const token = encodePortableClaim(id, sealed);
    const { claimId, sealedBlob } = decodePortableClaim(token);
    expect(claimId).toBe(id);
    expect(unsealInvite(sealedBlob).slug).toBe("friends");
  });
});

describe("invite seal (pubkey-bound)", () => {
  it("encrypts to recipient; wrong key cannot open; e2e not in package", () => {
    const { keys, invite } = sampleInvite();
    const friend = generateMemberSealIdentity();
    const stranger = generateMemberSealIdentity();
    const sealed = sealInviteToPubkey({
      invite,
      recipientPubkey: memberPubkeyLine(friend),
      orgPrivateKeyB64: keys.orgPrivateKey,
    });
    expect(isPubkeySealedPackage(sealed)).toBe(true);
    expect(sealed).not.toContain(invite.e2e_key);
    expect(sealed.startsWith("orgseal1:")).toBe(true);

    const opened = unsealInviteWithMemberKey(sealed, memberPrivateKeyObject(friend));
    expect(opened.e2e_key).toBe(invite.e2e_key);

    expect(() =>
      unsealInviteWithMemberKey(sealed, memberPrivateKeyObject(stranger)),
    ).toThrow(/different public key|failed to decrypt/);
  });

  it("detects tampered package via signature", () => {
    const { keys, invite } = sampleInvite();
    const friend = generateMemberSealIdentity();
    const sealed = sealInviteToPubkey({
      invite,
      recipientPubkey: memberPubkeyLine(friend),
      orgPrivateKeyB64: keys.orgPrivateKey,
    });
    // Flip a character in the base64 body
    const body = sealed.slice("orgseal1:".length);
    const flipped =
      body.slice(0, 20) + (body[20] === "A" ? "B" : "A") + body.slice(21);
    const tampered = `orgseal1:${flipped}`;
    expect(() =>
      unsealInviteWithMemberKey(tampered, memberPrivateKeyObject(friend)),
    ).toThrow();
  });

  it("member private key object is loadable", () => {
    const friend = generateMemberSealIdentity();
    const priv = memberPrivateKeyObject(friend);
    expect(priv.type).toBe("private");
    expect(priv.asymmetricKeyType).toBe("x25519");
  });
});

describe("PortableSealedInviteTransport", () => {
  it("deliver + claim with portable token works across processes (no shared memory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-claims-"));
    const prev = process.env.ORG_CLAIM_STORE_DIR;
    process.env.ORG_CLAIM_STORE_DIR = dir;
    try {
      const transport = new PortableSealedInviteTransport();
      const { invite } = sampleInvite();
      const claim = await transport.deliver({
        recipientIdentity: "mailto:friend@example.com",
        claimId: "org-claim-22222222-2222-2222-2222-222222222222",
        invite,
      });
      expect(claim.sealed_blob.startsWith("org-claim-")).toBe(true);
      expect(claim.sealed_blob).toContain(".");
      expect(claim.sealed_blob).not.toContain(invite.e2e_key);

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
