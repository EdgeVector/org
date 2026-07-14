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
