import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodeMemberPubkey,
  fingerprintFromRawPublic,
  generateMemberSealIdentity,
  loadOrCreateMemberIdentity,
  memberFingerprint,
  memberPubkeyLine,
  parseMemberPubkey,
  x25519RawPublic,
  memberPublicKeyObject,
} from "../src/member-identity.ts";

describe("member identity", () => {
  it("generates stable pubkey line and fingerprint", () => {
    const id = generateMemberSealIdentity();
    const line = memberPubkeyLine(id);
    expect(line.startsWith("orgpk1:")).toBe(true);
    const parsed = parseMemberPubkey(line);
    expect(parsed.fingerprint).toBe(memberFingerprint(id));
    expect(parsed.encoded).toBe(line);
  });

  it("loadOrCreate is idempotent on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "org-mem-"));
    const path = join(dir, "member-seal.json");
    try {
      const a = loadOrCreateMemberIdentity(path);
      const b = loadOrCreateMemberIdentity(path);
      expect(memberPubkeyLine(a)).toBe(memberPubkeyLine(b));
      expect(a.private_key).toBe(b.private_key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects garbage pubkey", () => {
    expect(() => parseMemberPubkey("mailto:bob@example.com")).toThrow(/org public key/);
  });

  it("accepts bare base64url raw key", () => {
    const id = generateMemberSealIdentity();
    const raw = x25519RawPublic(memberPublicKeyObject(id));
    const bare = raw.toString("base64url");
    const parsed = parseMemberPubkey(bare);
    expect(parsed.raw.equals(raw)).toBe(true);
    expect(fingerprintFromRawPublic(raw)).toBe(parsed.fingerprint);
    expect(encodeMemberPubkey(raw)).toBe(parsed.encoded);
  });
});
