import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeJcs,
  encodeMemberPubkey,
  fingerprintFromRawPublic,
  generateMemberSealIdentity,
  loadOrCreateMemberIdentity,
  loadMemberIdentity,
  memberFingerprint,
  memberPubkeyLine,
  parseMemberPubkey,
  x25519RawPublic,
  memberPublicKeyObject,
  memberSigningPublicKeyObject,
  signMemberPayload,
  verifyMemberPayload,
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
      expect(a.signing_public_key).toBe(b.signing_public_key);
      expect(a.signing_private_key).toBe(b.signing_private_key);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates v1 identities once while preserving their seal identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "org-mem-v1-"));
    const path = join(dir, "member-seal.json");
    try {
      const generated = generateMemberSealIdentity();
      const legacy = {
        version: 1,
        public_key: generated.public_key,
        private_key: generated.private_key,
        created_at: generated.created_at,
      } as const;
      writeFileSync(path, `${JSON.stringify(legacy)}\n`, { mode: 0o644 });

      const migrated = loadMemberIdentity(path);
      const reloaded = loadMemberIdentity(path);
      const persisted = JSON.parse(readFileSync(path, "utf8")) as {
        version: number;
        signing_public_key: string;
      };

      expect(migrated.version).toBe(2);
      expect(migrated.public_key).toBe(legacy.public_key);
      expect(migrated.private_key).toBe(legacy.private_key);
      expect(reloaded.signing_public_key).toBe(migrated.signing_public_key);
      expect(persisted.version).toBe(2);
      expect(persisted.signing_public_key).toBe(migrated.signing_public_key);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("signs canonical payloads with a migrated identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "org-mem-sign-"));
    const path = join(dir, "member-seal.json");
    try {
      const generated = generateMemberSealIdentity();
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          public_key: generated.public_key,
          private_key: generated.private_key,
          created_at: generated.created_at,
        }),
      );
      const migrated = loadMemberIdentity(path);
      const payload = { z: [true, null, 3], a: "member" };
      const signature = signMemberPayload(migrated, payload);

      expect(canonicalizeJcs(payload)).toBe('{"a":"member","z":[true,null,3]}');
      expect(
        verifyMemberPayload(migrated.signing_public_key, payload, signature),
      ).toBe(true);
      expect(
        verifyMemberPayload(
          migrated.signing_public_key,
          { a: "member", z: [true, null, 3] },
          signature,
        ),
      ).toBe(true);
      expect(
        verifyMemberPayload(memberSigningPublicKeyObject(migrated), payload, signature),
      ).toBe(true);
      expect(
        verifyMemberPayload(migrated.signing_public_key, { ...payload, a: "other" }, signature),
      ).toBe(false);
      expect(
        verifyMemberPayload(migrated.signing_public_key, payload, "not-a-signature"),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects values outside the JCS JSON data model", () => {
    expect(() => canonicalizeJcs({ value: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalizeJcs({ value: undefined })).toThrow(/undefined/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJcs(cyclic)).toThrow(/cycles/);
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
