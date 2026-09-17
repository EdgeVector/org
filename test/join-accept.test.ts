import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";

import { generateOrgKeys } from "../src/crypto.ts";
import { buildInvite, inviteExpired, parseInvite } from "../src/invite.ts";
import {
  buildJoinAccept,
  isJoinAcceptToken,
  joinAcceptExpired,
  normalizeMiniUserHash,
  sealJoinAccept,
  unsealJoinAccept,
} from "../src/join-accept.ts";
import {
  generateMemberSealIdentity,
  memberFingerprint,
} from "../src/member-identity.ts";

function inviteFixture(ttlMs = 60_000) {
  const keys = generateOrgKeys();
  return {
    keys,
    invite: buildInvite({
      slug: "friends",
      name: "Friends",
      orgHash: keys.orgHash,
      orgPublicKey: keys.orgPublicKey,
      e2eKey: keys.e2eKey,
      createdBy: "owner-1",
      ttlMs,
    }),
  };
}

describe("invite expiry + claim nonce", () => {
  it("new invites carry expires_at and claim_nonce and round-trip parse", () => {
    const { invite } = inviteFixture();
    expect(invite.expires_at).toBeTruthy();
    expect(invite.claim_nonce).toMatch(/^[0-9a-f]{32}$/);
    const reparsed = parseInvite(JSON.parse(JSON.stringify(invite)));
    expect(reparsed.expires_at).toBe(invite.expires_at!);
    expect(reparsed.claim_nonce).toBe(invite.claim_nonce!);
    expect(inviteExpired(reparsed)).toBe(false);
  });

  it("expiry is enforced and unparseable expiry fails closed", () => {
    const { invite } = inviteFixture(1);
    expect(inviteExpired(invite, new Date(Date.now() + 5_000))).toBe(true);
    expect(inviteExpired({ ...invite, expires_at: "not-a-date" })).toBe(true);
    // Legacy invite without expiry never expires (join still works locally).
    const { expires_at: _e, claim_nonce: _c, ...legacy } = invite;
    const reparsed = parseInvite(JSON.parse(JSON.stringify(legacy)));
    expect(reparsed.expires_at).toBeUndefined();
    expect(reparsed.claim_nonce).toBeUndefined();
    expect(inviteExpired(reparsed)).toBe(false);
  });

  it("rejects a non-positive ttl", () => {
    const keys = generateOrgKeys();
    expect(() =>
      buildInvite({
        slug: "friends",
        name: "Friends",
        orgHash: keys.orgHash,
        orgPublicKey: keys.orgPublicKey,
        e2eKey: keys.e2eKey,
        createdBy: "owner-1",
        ttlMs: 0,
      }),
    ).toThrow(/positive/);
  });
});

describe("join acceptance", () => {
  it("build → seal → unseal round-trips and verifies the member signature", () => {
    const { invite } = inviteFixture();
    const identity = generateMemberSealIdentity();
    const accept = buildJoinAccept({ invite, identity, memberName: "Friend One" });
    expect(accept.payload.claim_nonce).toBe(invite.claim_nonce!);
    expect(accept.payload.expires_at).toBe(invite.expires_at!);
    expect(accept.payload.member.member_id).toBe(memberFingerprint(identity));
    expect(accept.payload.member.sign_pk).toBe(identity.signing_public_key);

    const token = sealJoinAccept(accept, invite.e2e_key);
    expect(isJoinAcceptToken(token)).toBe(true);
    const opened = unsealJoinAccept(token, invite.e2e_key);
    expect(opened.payload).toEqual(accept.payload);
    expect(joinAcceptExpired(opened)).toBe(false);
  });

  it("defaults the member name from the fingerprint", () => {
    const { invite } = inviteFixture();
    const identity = generateMemberSealIdentity();
    const accept = buildJoinAccept({ invite, identity });
    expect(accept.payload.member.name).toBe(
      `member-${memberFingerprint(identity).slice(0, 8)}`,
    );
  });

  it("wrong e2e key cannot open the acceptance", () => {
    const { invite } = inviteFixture();
    const identity = generateMemberSealIdentity();
    const token = sealJoinAccept(buildJoinAccept({ invite, identity }), invite.e2e_key);
    const wrongKey = randomBytes(32).toString("base64");
    expect(() => unsealJoinAccept(token, wrongKey)).toThrow(/failed to open acceptance/);
  });

  it("tampered token or forged org_hash prefix is rejected", () => {
    const { invite } = inviteFixture();
    const identity = generateMemberSealIdentity();
    const token = sealJoinAccept(buildJoinAccept({ invite, identity }), invite.e2e_key);

    // Flip a ciphertext character → GCM tag failure.
    const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    expect(() => unsealJoinAccept(tampered, invite.e2e_key)).toThrow(
      /failed to open acceptance/,
    );

    // Swap the clear org_hash prefix → AAD mismatch.
    const dot = token.indexOf(".");
    const forgedPrefix = `orgaccept1:${"0".repeat(64)}${token.slice(dot)}`;
    expect(() => unsealJoinAccept(forgedPrefix, invite.e2e_key)).toThrow(
      /failed to open acceptance/,
    );
  });

  it("expired acceptance is detected (owner-side gate)", () => {
    const { invite } = inviteFixture(1);
    const identity = generateMemberSealIdentity();
    const accept = buildJoinAccept({ invite, identity });
    expect(joinAcceptExpired(accept, new Date(Date.now() + 5_000))).toBe(true);
    // Unparseable expiry fails closed.
    accept.payload.expires_at = "garbage";
    expect(joinAcceptExpired(accept)).toBe(true);
  });

  it("refuses to build an acceptance from a legacy invite without claim_nonce", () => {
    const { invite } = inviteFixture();
    const { claim_nonce: _c, ...legacy } = invite;
    const identity = generateMemberSealIdentity();
    expect(() =>
      buildJoinAccept({ invite: legacy as typeof invite, identity }),
    ).toThrow(/claim_nonce/);
  });

  it("round-trips optional Mini user_hash and omits it when absent", () => {
    const { invite } = inviteFixture();
    const identity = generateMemberSealIdentity();
    const withHash = buildJoinAccept({
      invite,
      identity,
      userHash: "74f4c062f1277268e287f078e072af83",
    });
    expect(withHash.payload.user_hash).toBe("74f4c062f1277268e287f078e072af83");
    const opened = unsealJoinAccept(sealJoinAccept(withHash, invite.e2e_key), invite.e2e_key);
    expect(opened.payload.user_hash).toBe("74f4c062f1277268e287f078e072af83");

    const without = buildJoinAccept({ invite, identity });
    expect(without.payload.user_hash).toBeUndefined();
    const openedWithout = unsealJoinAccept(
      sealJoinAccept(without, invite.e2e_key),
      invite.e2e_key,
    );
    expect(openedWithout.payload.user_hash).toBeUndefined();
  });

  it("normalizeMiniUserHash drops empty, whitespace, and over-long values", () => {
    expect(normalizeMiniUserHash("  abcdef12  ")).toBe("abcdef12");
    expect(normalizeMiniUserHash("")).toBeUndefined();
    expect(normalizeMiniUserHash("has space")).toBeUndefined();
    expect(normalizeMiniUserHash("x".repeat(129))).toBeUndefined();
    expect(normalizeMiniUserHash(undefined)).toBeUndefined();
  });
});
