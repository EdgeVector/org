import { describe, expect, it } from "bun:test";

import { generateOrgKeys } from "../src/crypto.ts";
import {
  buildHumanInviteLinkInstructions,
  buildOrgInviteLink,
  buildOrgInviteLinkResponse,
  orgInviteLinkExpired,
  parseOrgInviteLink,
} from "../src/invite-link.ts";
import {
  generateMemberSealIdentity,
  memberPubkeyLine,
} from "../src/member-identity.ts";

describe("human org invite links", () => {
  it("contains only public bootstrap data and round-trips from a URL", () => {
    const keys = generateOrgKeys();
    const { intent, url } = buildOrgInviteLink({
      orgSlug: "friends",
      orgName: "Friends",
      orgHash: keys.orgHash,
      senderIdentity: "sender-user-hash",
      senderPublicKey: keys.orgPublicKey,
      linkBase: "https://example.test/join/",
    });

    expect(url.startsWith("https://example.test/join/")).toBe(true);
    expect(url).not.toContain(keys.e2eKey);
    expect(parseOrgInviteLink(url)).toEqual(intent);
    expect(intent.kind).toBe("org-intent");
    expect(intent.correlation_id).toMatch(/^org-intent-/);
    expect(orgInviteLinkExpired(intent)).toBe(false);
  });

  it("builds a public recipient response for the connection mailbox", () => {
    const keys = generateOrgKeys();
    const { intent } = buildOrgInviteLink({
      orgSlug: "friends",
      orgName: "Friends",
      orgHash: keys.orgHash,
      senderIdentity: "sender-user-hash",
      senderPublicKey: keys.orgPublicKey,
    });
    const recipient = generateMemberSealIdentity();
    const { response, token } = buildOrgInviteLinkResponse(intent, memberPubkeyLine(recipient));

    expect(token.startsWith("orgreply1:")).toBe(true);
    expect(token).not.toContain(keys.e2eKey);
    expect(response.correlation_id).toBe(intent.correlation_id);
    expect(response.recipient_public_key).toBe(memberPubkeyLine(recipient));
    expect(response.recipient_fingerprint).toHaveLength(16);
  });

  it("does not put a key in human instructions", () => {
    const keys = generateOrgKeys();
    const { intent, url } = buildOrgInviteLink({
      orgSlug: "friends",
      orgName: "Friends",
      orgHash: keys.orgHash,
      senderIdentity: "sender-user-hash",
      senderPublicKey: keys.orgPublicKey,
    });
    const instructions = buildHumanInviteLinkInstructions({ intent, url });

    expect(instructions).toContain("org link accept");
    expect(instructions).toContain("does not contain the org E2E key");
    expect(instructions).not.toContain(keys.e2eKey);
  });

  it("rejects a link with a mismatched sender key", () => {
    const keys = generateOrgKeys();
    const other = generateOrgKeys();
    const { url } = buildOrgInviteLink({
      orgSlug: "friends",
      orgName: "Friends",
      orgHash: keys.orgHash,
      senderIdentity: "sender-user-hash",
      senderPublicKey: keys.orgPublicKey,
    });
    const token = url.slice(url.lastIndexOf("/") + 1);
    const raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    raw.sender_public_key = other.orgPublicKey;
    const tampered = `${url.slice(0, url.lastIndexOf("/") + 1)}${Buffer.from(JSON.stringify(raw)).toString("base64url")}`;
    expect(() => parseOrgInviteLink(tampered)).toThrow(/org_hash does not match/);
  });
});
