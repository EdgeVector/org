import { describe, expect, it } from "bun:test";

import { generateOrgKeys, orgHashFromPublicKey } from "../src/crypto.ts";

describe("org crypto", () => {
  it("generates stable org_hash from the public key", () => {
    const keys = generateOrgKeys();
    expect(keys.orgHash).toMatch(/^[0-9a-f]{64}$/);
    expect(orgHashFromPublicKey(keys.orgPublicKey)).toBe(keys.orgHash);
    expect(keys.e2eKey.length).toBeGreaterThan(20);
    expect(keys.orgPrivateKey.length).toBeGreaterThan(20);
  });

  it("produces unique orgs", () => {
    const a = generateOrgKeys();
    const b = generateOrgKeys();
    expect(a.orgHash).not.toBe(b.orgHash);
    expect(a.e2eKey).not.toBe(b.e2eKey);
  });
});
