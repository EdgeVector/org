import { describe, expect, it } from "bun:test";

import { generateOrgKeys } from "../src/crypto.ts";
import { buildInvite, parseInvite, serializeInvite } from "../src/invite.ts";

describe("org invite", () => {
  it("round-trips serialize/parse", () => {
    const keys = generateOrgKeys();
    const invite = buildInvite({
      slug: "edgevector",
      name: "Edge Vector",
      orgHash: keys.orgHash,
      orgPublicKey: keys.orgPublicKey,
      e2eKey: keys.e2eKey,
      createdBy: "user-hash-1",
    });
    const parsed = parseInvite(JSON.parse(serializeInvite(invite)));
    expect(parsed.slug).toBe("edgevector");
    expect(parsed.org_hash).toBe(keys.orgHash);
    expect(parsed.e2e_key).toBe(keys.e2eKey);
  });

  it("rejects tampered org_hash", () => {
    const keys = generateOrgKeys();
    const invite = buildInvite({
      slug: "edgevector",
      name: "Edge Vector",
      orgHash: keys.orgHash,
      orgPublicKey: keys.orgPublicKey,
      e2eKey: keys.e2eKey,
      createdBy: "user-hash-1",
    });
    invite.org_hash = "0".repeat(64);
    expect(() => parseInvite(invite)).toThrow(/org_hash does not match/);
  });
});

import { buildAgentInstructions, buildClaimAgentInstructions } from "../src/invite.ts";

describe("agent invite instructions", () => {
  it("file-path instructions use public install path and never embed e2e material", () => {
    const text = buildAgentInstructions({
      invite: { slug: "friends", name: "Friends" },
      invitePath: "/tmp/friends.invite.json",
    });
    expect(text).toContain("last-stack-install-apps");
    expect(text).toContain("brew services start lastdb");
    expect(text).toContain("github.com/EdgeVector/last-stack");
        expect(text).toContain("lastsecrets init");
    expect(text).toContain("org init");
    expect(text).toContain("org join --from");
    expect(text).toContain("/tmp/friends.invite.json");
    expect(text).not.toContain("e2e_key");
    expect(text).not.toContain("edgevector/tap/lastdb");
  });

  it("claim instructions include claim id only", () => {
    const text = buildClaimAgentInstructions({
      invite: { slug: "friends", name: "Friends" },
      claim: {
        claim_id: "claim-abc",
        recipient_identity: "user-xyz",
      },
    });
    expect(text).toContain("org join --claim claim-abc");
    expect(text).toContain("user-xyz");
    expect(text).toContain("last-stack-install-apps");
    expect(text).not.toContain("e2e_key");
  });
});
