import { describe, expect, it } from "bun:test";

import { generateOrgKeys } from "../src/crypto.ts";
import {
  buildEpochPayload,
  canonicalChain,
  memberAddedEpoch,
  parseEpoch,
  resolveCanonicalChain,
  selectCanonicalEpoch,
  signEpochPayload,
  verifyEpoch,
  verifyEpochChain,
  type EpochMember,
  type OrgEpoch,
} from "../src/epoch.ts";
import { generateMemberSealIdentity, memberPubkeyLine } from "../src/member-identity.ts";

function fixtureMember(name: string, roles: string[] = ["member"]): EpochMember {
  const id = generateMemberSealIdentity();
  return {
    member_id: `${name}-id`,
    name,
    sign_pk: id.signing_public_key,
    seal_pk: memberPubkeyLine(id),
    roles,
    status: "active",
  };
}

function chainFixture() {
  const keys = generateOrgKeys();
  const owner = fixtureMember("owner", ["owner"]);
  const genesis = signEpochPayload(
    buildEpochPayload({
      orgHash: keys.orgHash,
      epochNo: 0,
      prevEpoch: "",
      members: [owner],
    }),
    keys.orgPrivateKey,
  );
  return { keys, owner, genesis };
}

describe("org epoch chain", () => {
  it("genesis roundtrips through canonical bytes and verifies", () => {
    const { keys, owner, genesis } = chainFixture();
    expect(genesis.payload.epoch_no).toBe(0);
    expect(genesis.payload.prev_epoch).toBe("");
    expect(verifyEpoch(genesis, keys.orgPublicKey)).toEqual({ ok: true });

    const reparsed = parseEpoch(genesis.payload_jcs, genesis.sig);
    expect(reparsed.epoch_hash).toBe(genesis.epoch_hash);
    expect(reparsed.payload.members[0]!.member_id).toBe(owner.member_id);
    expect(verifyEpoch(reparsed, keys.orgPublicKey)).toEqual({ ok: true });

    const resolved = resolveCanonicalChain([reparsed], {
      orgHash: keys.orgHash,
      orgPublicKeyB64: keys.orgPublicKey,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.tip?.epoch_hash).toBe(genesis.epoch_hash);
  });

  it("rejects a tampered signature and a wrong org key", () => {
    const { keys, genesis } = chainFixture();
    const tampered: OrgEpoch = {
      ...genesis,
      sig: `${genesis.sig.slice(0, -2)}${genesis.sig.endsWith("AA") ? "BB" : "AA"}`,
    };
    const bad = verifyEpoch(tampered, keys.orgPublicKey);
    expect(bad.ok).toBe(false);

    const otherOrg = generateOrgKeys();
    const wrongKey = verifyEpoch(genesis, otherOrg.orgPublicKey);
    expect(wrongKey.ok).toBe(false);

    const resolved = resolveCanonicalChain([genesis, tampered], {
      orgHash: keys.orgHash,
      orgPublicKeyB64: keys.orgPublicKey,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.tip?.epoch_hash).toBe(genesis.epoch_hash);
    expect(resolved.invalid.length).toBe(1);
  });

  it("fails chain resolution on a broken prev link", () => {
    const { keys, owner, genesis } = chainFixture();
    const orphan = signEpochPayload(
      buildEpochPayload({
        orgHash: keys.orgHash,
        epochNo: 2,
        prevEpoch: "f".repeat(64),
        members: [owner],
      }),
      keys.orgPrivateKey,
    );
    const resolved = resolveCanonicalChain([genesis, orphan], {
      orgHash: keys.orgHash,
      orgPublicKeyB64: keys.orgPublicKey,
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.error).toContain("does not reach genesis");
  });

  it("rejects non-contiguous epoch numbers in a linked chain", () => {
    const { keys, owner, genesis } = chainFixture();
    const skipped = signEpochPayload(
      buildEpochPayload({
        orgHash: keys.orgHash,
        epochNo: 2, // links to genesis but skips epoch_no 1
        prevEpoch: genesis.epoch_hash,
        members: [owner],
      }),
      keys.orgPrivateKey,
    );
    const walked = canonicalChain([genesis, skipped]);
    expect(walked.complete).toBe(true);
    const structure = verifyEpochChain(walked.chain, {
      orgHash: keys.orgHash,
      orgPublicKeyB64: keys.orgPublicKey,
    });
    expect(structure.ok).toBe(false);
  });

  it("breaks fork ties deterministically (smaller epoch_hash wins, any input order)", () => {
    const { keys, owner, genesis } = chainFixture();
    const friend = fixtureMember("friend");
    const forkA = signEpochPayload(
      buildEpochPayload({
        orgHash: keys.orgHash,
        epochNo: 1,
        prevEpoch: genesis.epoch_hash,
        members: [owner, friend],
        nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      keys.orgPrivateKey,
    );
    const forkB = signEpochPayload(
      buildEpochPayload({
        orgHash: keys.orgHash,
        epochNo: 1,
        prevEpoch: genesis.epoch_hash,
        members: [owner],
        nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
      keys.orgPrivateKey,
    );
    expect(forkA.epoch_hash).not.toBe(forkB.epoch_hash);
    const expected = forkA.epoch_hash < forkB.epoch_hash ? forkA : forkB;

    // Run selection repeatedly with both input orders: identical winner.
    for (const epochs of [
      [genesis, forkA, forkB],
      [forkB, genesis, forkA],
    ]) {
      const tip = selectCanonicalEpoch(epochs);
      expect(tip?.epoch_hash).toBe(expected.epoch_hash);
      const resolved = resolveCanonicalChain(epochs, {
        orgHash: keys.orgHash,
        orgPublicKeyB64: keys.orgPublicKey,
      });
      expect(resolved.ok).toBe(true);
      expect(resolved.tip?.epoch_hash).toBe(expected.epoch_hash);
      expect(resolved.chain.map((e) => e.payload.epoch_no)).toEqual([0, 1]);
    }

    // Higher epoch_no still beats a smaller hash at a lower height.
    const extended = signEpochPayload(
      buildEpochPayload({
        orgHash: keys.orgHash,
        epochNo: 2,
        prevEpoch: expected.epoch_hash,
        members: [owner, friend],
      }),
      keys.orgPrivateKey,
    );
    const tip = selectCanonicalEpoch([extended, forkA, forkB, genesis]);
    expect(tip?.epoch_hash).toBe(extended.epoch_hash);
  });

  it("tracks member provenance across the chain", () => {
    const { keys, owner, genesis } = chainFixture();
    const friend = fixtureMember("friend");
    const epoch1 = signEpochPayload(
      buildEpochPayload({
        orgHash: keys.orgHash,
        epochNo: 1,
        prevEpoch: genesis.epoch_hash,
        members: [owner, friend],
      }),
      keys.orgPrivateKey,
    );
    const resolved = resolveCanonicalChain([epoch1, genesis], {
      orgHash: keys.orgHash,
      orgPublicKeyB64: keys.orgPublicKey,
    });
    expect(resolved.ok).toBe(true);
    expect(memberAddedEpoch(resolved.chain, owner.member_id)).toBe(0);
    expect(memberAddedEpoch(resolved.chain, friend.member_id)).toBe(1);
    expect(memberAddedEpoch(resolved.chain, "nobody")).toBeNull();
  });

  it("rejects payloads that are not canonical JCS bytes or malformed", () => {
    const { genesis } = chainFixture();
    const pretty = JSON.stringify(JSON.parse(genesis.payload_jcs), null, 2);
    expect(() => parseEpoch(pretty, genesis.sig)).toThrow(/canonical/);
    expect(() => parseEpoch("{not json", genesis.sig)).toThrow(/valid JSON/);

    const dupMember = JSON.parse(genesis.payload_jcs) as {
      members: EpochMember[];
    };
    dupMember.members.push({ ...dupMember.members[0]! });
    expect(() =>
      buildEpochPayload({
        orgHash: "x".repeat(8),
        epochNo: 0,
        prevEpoch: "",
        members: dupMember.members,
      }),
    ).toThrow(/duplicate member_id/);

    expect(() =>
      buildEpochPayload({
        orgHash: "x".repeat(8),
        epochNo: 1,
        prevEpoch: "",
        members: [fixtureMember("a")],
      }),
    ).toThrow(/prev_epoch/);
  });
});
