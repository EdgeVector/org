import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run, type CliDeps } from "../src/cli.ts";
import { readConfig } from "../src/config.ts";
import { buildEpochPayload, signEpochPayload } from "../src/epoch.ts";
import type { InviteTransport } from "../src/invite-transport.ts";
import { buildInviteClaim, type InviteClaim, type OrgInvite } from "../src/invite.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";
import type { LastSecretsCli } from "../src/lastsecrets.ts";
import { buildJoinAccept, sealJoinAccept } from "../src/join-accept.ts";
import { unsealAnyInvite } from "../src/invite-seal.ts";
import {
  generateMemberSealIdentity,
  loadMemberIdentity,
  memberPrivateKeyObject,
  memberPubkeyLine,
  signMemberPayload,
  verifyMemberPayload,
} from "../src/member-identity.ts";
import { listOrgEpochs, putOrgEpoch } from "../src/storage.ts";

function captureIo(stdin = "") {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    },
    stdinText: async () => stdin,
    out: () => stdout,
    err: () => stderr,
  };
}

function memoryClient(userHash = "user-1"): LastDbClient & {
  store: Map<string, QueryRow>;
  declared: string[];
} {
  const store = new Map<string, QueryRow>();
  const declared: string[] = [];
  const k = (schemaHash: string, keyHash: string) => `${schemaHash}::${keyHash}`;
  let schemaCounter = 0;
  return {
    store,
    declared,
    async autoIdentity() {
      return { userHash };
    },
    async declareAppSchema(_appId, schema) {
      schemaCounter += 1;
      const canonical = `hash-${schema.name}-${schemaCounter}`;
      declared.push(schema.name);
      return { canonical, schemaName: `org/${schema.name}` };
    },
    async registerForDistribution() {
      return { app_id: "org", items: [], ok: true };
    },
    async verifyDistributionReady() {
      return { app_id: "org", items: [], ready: true };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      store.set(k(schemaHash, keyHash), {
        fields: { ...fields },
        key: { hash: keyHash, range: null },
      });
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      store.set(k(schemaHash, keyHash), {
        fields: { ...fields },
        key: { hash: keyHash, range: null },
      });
    },
    async queryByKey({ schemaHash, keyHash }) {
      return store.get(k(schemaHash, keyHash)) ?? null;
    },
    async queryAll({ schemaHash }) {
      const prefix = `${schemaHash}::`;
      return [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, v]) => v);
    },
  };
}

function memorySecrets(): LastSecretsCli & { bag: Map<string, string> } {
  const bag = new Map<string, string>();
  return {
    bag,
    put({ slug, value }) {
      bag.set(slug, value);
    },
    get(slug) {
      const v = bag.get(slug);
      if (v === undefined) throw new Error(`secret not found: ${slug}`);
      return v;
    },
    ref(slug) {
      return `lastsecrets://${slug}`;
    },
  };
}

function memoryInviteTransport(): InviteTransport & {
  claims: Map<string, OrgInvite>;
  claimMetadata: Map<string, InviteClaim>;
  recipients: Map<string, string>;
} {
  const claims = new Map<string, OrgInvite>();
  const claimMetadata = new Map<string, InviteClaim>();
  const recipients = new Map<string, string>();
  return {
    claims,
    claimMetadata,
    recipients,
    async deliver({ recipientIdentity, claimId, invite }) {
      const claim = buildInviteClaim({
        invite,
        claimId,
        recipientIdentity,
        sealedBlob: `mock-sealed:${claimId}`,
      });
      claims.set(claim.claim_id, invite);
      claimMetadata.set(claim.claim_id, claim);
      recipients.set(claim.claim_id, recipientIdentity);
      return claim;
    },
    async claim({ claimId }) {
      const invite = claims.get(claimId);
      if (!invite) throw new Error(`claim not found: ${claimId}`);
      return invite;
    },
  };
}

describe("org CLI", () => {
  // Hermetic member identity: `org create` mints the genesis epoch from the
  // local member identity; never touch the real ~/.org/member-seal.json.
  let identityDir = "";
  let savedIdentityPath: string | undefined;
  beforeAll(() => {
    identityDir = mkdtempSync(join(tmpdir(), "org-cli-id-"));
    savedIdentityPath = process.env.ORG_MEMBER_IDENTITY_PATH;
    process.env.ORG_MEMBER_IDENTITY_PATH = join(identityDir, "member-seal.json");
  });
  afterAll(() => {
    if (savedIdentityPath === undefined) delete process.env.ORG_MEMBER_IDENTITY_PATH;
    else process.env.ORG_MEMBER_IDENTITY_PATH = savedIdentityPath;
    rmSync(identityDir, { recursive: true, force: true });
  });

  it("prints help", async () => {
    const io = captureIo();
    const code = await run(["help"], io);
    expect(code).toBe(0);
    expect(io.out()).toContain("org create");
    expect(io.out()).toContain("org kanban");
    expect(io.out()).toContain("LastSecrets");
  });

  it("init → create → db create → invite → join (in-memory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-cli-"));
    const configPath = join(dir, "config.json");
    const invitePath = join(dir, "invite.json");
    const client = memoryClient("owner-1");
    const secrets = memorySecrets();
    const deps: CliDeps = {
      lastSecrets: secrets,
      newClient: () => client,
    };

    try {
      let io = captureIo();
      let code = await run(["init", "--config", configPath], io, deps);
      expect(code).toBe(0);
      expect(client.declared).toEqual([
        "Organization",
        "OrgDatabase",
        "PathBinding",
        "OrgIndex",
        "OrgDbIndex",
        "PathBindingIndex",
        "OrgEpoch",
        "OrgEpochIndex",
        "OrgInviteClaim",
      ]);
      expect(io.out()).toContain("initialized org config");

      io = captureIo();
      code = await run(
        ["create", "edgevector", "--name", "Edge Vector", "--config", configPath],
        io,
        deps,
      );
      expect(code).toBe(0);
      expect(io.out()).toContain("slug=edgevector");
      expect(secrets.bag.has("org-edgevector-e2e")).toBe(true);
      expect(secrets.bag.has("org-edgevector-private")).toBe(true);
      expect(io.err()).not.toContain("HTTP 400");
      expect(io.err()).not.toContain("register failed");

      io = captureIo();
      code = await run(
        [
          "db",
          "create",
          "edgevector",
          "company",
          "--name",
          "Company",
          "--config",
          configPath,
        ],
        io,
        deps,
      );
      expect(code).toBe(0);
      expect(io.out()).toContain("edgevector/company");

      io = captureIo();
      code = await run(
        ["invite", "edgevector", "--out", invitePath, "--config", configPath],
        io,
        deps,
      );
      expect(code).toBe(0);
      const invite = JSON.parse(readFileSync(invitePath, "utf8"));
      expect(invite.slug).toBe("edgevector");
      expect(invite.e2e_key).toBe(secrets.bag.get("org-edgevector-e2e"));

      const agentInvitePath = join(dir, "agent-invite.json");
      io = captureIo();
      code = await run(
        [
          "invite",
          "edgevector",
          "--out",
          agentInvitePath,
          "--agent",
          "--config",
          configPath,
        ],
        io,
        deps,
      );
      expect(code).toBe(0);
      const agentInvite = JSON.parse(readFileSync(agentInvitePath, "utf8"));
      expect(agentInvite.e2e_key).toBe(invite.e2e_key);
      expect(io.out()).toContain("LastDB org invite — agent instructions");
      expect(io.out()).toContain("**Edge Vector**");
      expect(io.out()).toContain("last-stack-install-apps");
      expect(io.out()).toContain(agentInvitePath);
      expect(io.out()).toContain("org join --from");
      expect(io.out()).not.toContain("e2e_key");
      expect(io.out()).not.toContain(invite.e2e_key);
      expect(io.err()).toContain("wrote invite");

      // Join on a second "node" (fresh store + secrets, reusing schema hashes from config)
      const memberClient = memoryClient("member-2");
      // Seed member client with same schema hashes by reusing declare — config already has hashes.
      // Put operations use schema hashes from config file, so empty store is fine.
      const memberSecrets = memorySecrets();
      const memberDeps: CliDeps = {
        lastSecrets: memberSecrets,
        newClient: () => memberClient,
      };
      // Member needs their own config with same schema hashes — copy owner's config path is fine
      // (userHash differs only at runtime from client's autoIdentity; config.userHash is owner's).
      // For join we only need schema bindings; using owner config is OK for this unit test.
      io = captureIo();
      code = await run(
        ["join", "--from", invitePath, "--config", configPath],
        io,
        memberDeps,
      );
      expect(code).toBe(0);
      expect(io.out()).toContain("joined organization");
      expect(io.err()).not.toContain("HTTP 400");
      expect(io.err()).not.toContain("register failed");
      expect(memberSecrets.bag.get("org-edgevector-e2e")).toBe(invite.e2e_key);
      expect(memberClient.store.size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pubkey handshake: receive → invite --to orgpk1 → join --sealed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-pubkey-"));
    const configPath = join(dir, "config.json");
    const friendIdentity = join(dir, "friend-seal.json");
    const client = memoryClient("owner-1");
    const secrets = memorySecrets();
    const deps: CliDeps = {
      lastSecrets: secrets,
      newClient: () => client,
    };

    try {
      let io = captureIo();
      let code = await run(["init", "--config", configPath], io, deps);
      expect(code).toBe(0);

      io = captureIo();
      code = await run(
        ["create", "edgevector", "--name", "Edge Vector", "--config", configPath],
        io,
        deps,
      );
      expect(code).toBe(0);
      const e2eKey = secrets.bag.get("org-edgevector-e2e");
      expect(e2eKey).toBeTruthy();

      // Friend: org receive → public key
      io = captureIo();
      code = await run(
        ["receive", "--identity", friendIdentity, "--json"],
        io,
        deps,
      );
      expect(code).toBe(0);
      const recv = JSON.parse(io.out()) as { public_key: string; fingerprint: string };
      expect(recv.public_key.startsWith("orgpk1:")).toBe(true);

      // Admin: seal to that pubkey
      io = captureIo();
      code = await run(
        [
          "invite",
          "edgevector",
          "--to",
          recv.public_key,
          "--agent",
          "--config",
          configPath,
        ],
        io,
        deps,
      );
      expect(code).toBe(0);
      expect(io.out()).toContain("pubkey-sealed");
      expect(io.out()).toContain("orgseal1:");
      expect(io.out()).toContain(recv.fingerprint);
      expect(io.out()).toContain("org join --sealed");
      expect(io.out()).not.toContain("e2e_key");
      expect(io.out()).not.toContain(e2eKey!);

      const sealMatch = io.out().match(/orgseal1:[A-Za-z0-9_-]+/);
      expect(sealMatch).toBeTruthy();
      const sealed = sealMatch![0]!;

      // Friend joins with sealed package + same identity
      const memberClient = memoryClient("member-2");
      const memberSecrets = memorySecrets();
      const memberDeps: CliDeps = {
        lastSecrets: memberSecrets,
        newClient: () => memberClient,
      };
      io = captureIo();
      code = await run(
        [
          "join",
          "--sealed",
          sealed,
          "--identity",
          friendIdentity,
          "--config",
          configPath,
        ],
        io,
        memberDeps,
      );
      expect(code).toBe(0);
      expect(io.out()).toContain("joined organization");
      expect(memberSecrets.bag.get("org-edgevector-e2e")).toBe(e2eKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacy portable --to non-pubkey still works via transport", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-claim-"));
    const configPath = join(dir, "config.json");
    const client = memoryClient("owner-1");
    const secrets = memorySecrets();
    const transport = memoryInviteTransport();
    const deps: CliDeps = {
      lastSecrets: secrets,
      inviteTransport: transport,
      newClient: () => client,
    };

    try {
      let io = captureIo();
      let code = await run(["init", "--config", configPath], io, deps);
      expect(code).toBe(0);

      io = captureIo();
      code = await run(
        ["create", "edgevector", "--name", "Edge Vector", "--config", configPath],
        io,
        deps,
      );
      expect(code).toBe(0);
      const e2eKey = secrets.bag.get("org-edgevector-e2e");
      expect(e2eKey).toBeTruthy();

      io = captureIo();
      code = await run(
        [
          "invite",
          "edgevector",
          "--to",
          "mailto:teammate@example.com",
          "--agent",
          "--config",
          configPath,
        ],
        io,
        deps,
      );
      expect(code).toBe(0);
      expect(transport.claims.size).toBe(1);
      const claimId = [...transport.claims.keys()][0]!;
      expect(io.out()).toContain(`org join --claim`);
      expect(io.out()).toContain(claimId);
      expect(io.err()).toContain("portable bearer");
      expect(io.out()).not.toContain(e2eKey);

      const memberClient = memoryClient("member-2");
      const memberSecrets = memorySecrets();
      const memberDeps: CliDeps = {
        lastSecrets: memberSecrets,
        inviteTransport: transport,
        newClient: () => memberClient,
      };

      io = captureIo();
      code = await run(["join", "--claim", claimId, "--config", configPath], io, memberDeps);
      expect(code).toBe(0);
      expect(memberSecrets.bag.get("org-edgevector-e2e")).toBe(e2eKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when sealed claim transport is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-claim-closed-"));
    const configPath = join(dir, "config.json");
    const client = memoryClient("owner-1");
    const secrets = memorySecrets();
    const deps: CliDeps = {
      lastSecrets: secrets,
      newClient: () => client,
    };
    const prev = process.env.ORG_INVITE_TRANSPORT;
    process.env.ORG_INVITE_TRANSPORT = "unavailable";

    try {
      let io = captureIo();
      let code = await run(["init", "--config", configPath], io, deps);
      expect(code).toBe(0);

      io = captureIo();
      code = await run(
        ["create", "edgevector", "--name", "Edge Vector", "--config", configPath],
        io,
        deps,
      );
      expect(code).toBe(0);

      io = captureIo();
      code = await run(
        [
          "invite",
          "edgevector",
          "--to",
          "mailto:teammate@example.com",
          "--config",
          configPath,
        ],
        io,
        deps,
      );
      expect(code).toBe(1);
      expect(io.err()).toContain("sealed invite transport unavailable");
    } finally {
      if (prev === undefined) delete process.env.ORG_INVITE_TRANSPORT;
      else process.env.ORG_INVITE_TRANSPORT = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("org epoch CLI", () => {
  let identityDir = "";
  let savedIdentityPath: string | undefined;
  beforeAll(() => {
    identityDir = mkdtempSync(join(tmpdir(), "org-epoch-id-"));
    savedIdentityPath = process.env.ORG_MEMBER_IDENTITY_PATH;
    process.env.ORG_MEMBER_IDENTITY_PATH = join(identityDir, "member-seal.json");
  });
  afterAll(() => {
    if (savedIdentityPath === undefined) delete process.env.ORG_MEMBER_IDENTITY_PATH;
    else process.env.ORG_MEMBER_IDENTITY_PATH = savedIdentityPath;
    rmSync(identityDir, { recursive: true, force: true });
  });

  async function setupOrg() {
    const dir = mkdtempSync(join(tmpdir(), "org-epoch-cli-"));
    const configPath = join(dir, "config.json");
    const client = memoryClient("owner-1");
    const secrets = memorySecrets();
    const deps: CliDeps = { lastSecrets: secrets, newClient: () => client };
    let io = captureIo();
    expect(await run(["init", "--config", configPath], io, deps)).toBe(0);
    io = captureIo();
    expect(
      await run(
        [
          "create",
          "edgevector",
          "--name",
          "Edge Vector",
          "--owner-name",
          "Owner One",
          "--config",
          configPath,
        ],
        io,
        deps,
      ),
    ).toBe(0);
    expect(io.out()).toContain("signed genesis epoch=0");
    return { dir, configPath, client, secrets, deps };
  }

  function friendSpec() {
    const id = generateMemberSealIdentity();
    return JSON.stringify({
      member_id: "friend-1",
      name: "Friend One",
      sign_pk: id.signing_public_key,
      seal_pk: memberPubkeyLine(id),
      roles: ["member"],
    });
  }

  it("genesis roundtrip: create writes a verifiable epoch 0 registry", async () => {
    const { dir, configPath, deps } = await setupOrg();
    try {
      let io = captureIo();
      expect(await run(["epoch", "verify", "edgevector", "--config", configPath], io, deps)).toBe(0);
      expect(io.out()).toContain("epoch chain ok: epochs=1");

      io = captureIo();
      expect(await run(["member", "list", "edgevector", "--config", configPath], io, deps)).toBe(0);
      expect(io.out()).toContain("registry org=edgevector epoch=0");
      expect(io.out()).toContain('name="Owner One"');
      expect(io.out()).toContain("roles=owner");
      expect(io.out()).toContain("status=active");
      expect(io.out()).toContain("sign_pk=");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("epoch sign adds a member; member list shows sign_pk, role, provenance; revoke renders", async () => {
    const { dir, configPath, deps } = await setupOrg();
    try {
      const spec = friendSpec();
      const parsedSpec = JSON.parse(spec) as { sign_pk: string };
      let io = captureIo();
      expect(
        await run(
          ["epoch", "sign", "edgevector", "--add-member", spec, "--config", configPath],
          io,
          deps,
        ),
      ).toBe(0);
      expect(io.out()).toContain("signed epoch=1");

      io = captureIo();
      expect(await run(["member", "list", "edgevector", "--config", configPath], io, deps)).toBe(0);
      expect(io.out()).toContain("registry org=edgevector epoch=1");
      expect(io.out()).toContain("member_id=friend-1");
      expect(io.out()).toContain(`sign_pk=${parsedSpec.sign_pk}`);
      expect(io.out()).toContain("roles=member");
      expect(io.out()).toContain("added_epoch=1");

      // Duplicate add refuses.
      io = captureIo();
      expect(
        await run(
          ["epoch", "sign", "edgevector", "--add-member", spec, "--config", configPath],
          io,
          deps,
        ),
      ).toBe(1);
      expect(io.err()).toContain("already present");

      // Revoke; the registry renders the entry as revoked (non-retroactive).
      io = captureIo();
      expect(
        await run(
          ["epoch", "sign", "edgevector", "--revoke", "friend-1", "--config", configPath],
          io,
          deps,
        ),
      ).toBe(0);
      expect(io.out()).toContain("signed epoch=2");
      expect(io.out()).toContain("(+1 revoked)");

      io = captureIo();
      expect(await run(["member", "list", "edgevector", "--config", configPath], io, deps)).toBe(0);
      expect(io.out()).toContain("registry org=edgevector epoch=2");
      expect(io.out()).toMatch(/member_id=friend-1 .*status=revoked/);

      io = captureIo();
      expect(
        await run(
          ["member", "list", "edgevector", "--json", "--config", configPath],
          io,
          deps,
        ),
      ).toBe(0);
      const listed = JSON.parse(io.out()) as {
        epoch_no: number;
        members: { member_id: string; status: string; added_epoch: number }[];
      };
      expect(listed.epoch_no).toBe(2);
      const friend = listed.members.find((m) => m.member_id === "friend-1");
      expect(friend?.status).toBe("revoked");
      expect(friend?.added_epoch).toBe(1);

      // The sole active owner cannot be revoked.
      const ownerId = listed.members.find((m) => m.member_id !== "friend-1")!.member_id;
      io = captureIo();
      expect(
        await run(
          ["epoch", "sign", "edgevector", "--revoke", ownerId, "--config", configPath],
          io,
          deps,
        ),
      ).toBe(1);
      expect(io.err()).toContain("no active owner");

      // epoch log walks genesis → tip.
      io = captureIo();
      expect(await run(["epoch", "log", "edgevector", "--config", configPath], io, deps)).toBe(0);
      const logLines = io.out().trim().split("\n");
      expect(logLines.length).toBe(3);
      expect(logLines[0]).toContain("epoch=0");
      expect(logLines[2]).toContain("epoch=2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fork tie-break is deterministic: competing epoch 1 resolves to the same winner on repeated runs", async () => {
    const { dir, configPath, client, secrets, deps } = await setupOrg();
    try {
      let io = captureIo();
      expect(
        await run(["epoch", "show", "edgevector", "--json", "--config", configPath], io, deps),
      ).toBe(0);
      const genesis = JSON.parse(io.out()) as {
        epoch_hash: string;
        payload: { org_hash: string; members: unknown[] };
      };

      const orgPrivateKey = secrets.bag.get("org-edgevector-private")!;
      const config = readConfig(configPath);
      const mkFork = (nonce: string) =>
        signEpochPayload(
          buildEpochPayload({
            orgHash: genesis.payload.org_hash,
            epochNo: 1,
            prevEpoch: genesis.epoch_hash,
            members: genesis.payload.members as never,
            nonce,
          }),
          orgPrivateKey,
        );
      const forkA = mkFork("a".repeat(32));
      const forkB = mkFork("b".repeat(32));
      expect(forkA.epoch_hash).not.toBe(forkB.epoch_hash);
      const expected =
        forkA.epoch_hash < forkB.epoch_hash ? forkA.epoch_hash : forkB.epoch_hash;
      await putOrgEpoch(client, config, forkA);
      await putOrgEpoch(client, config, forkB);

      // Repeated runs pick the identical winner.
      for (let round = 0; round < 2; round += 1) {
        io = captureIo();
        expect(
          await run(["epoch", "show", "edgevector", "--json", "--config", configPath], io, deps),
        ).toBe(0);
        const tip = JSON.parse(io.out()) as { epoch_hash: string };
        expect(tip.epoch_hash).toBe(expected);
      }
      io = captureIo();
      expect(await run(["epoch", "verify", "edgevector", "--config", configPath], io, deps)).toBe(0);
      expect(io.out()).toContain("epochs=2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verify fails loudly when a stored epoch's payload bytes are tampered", async () => {
    const { dir, configPath, client, deps } = await setupOrg();
    try {
      const config = readConfig(configPath);
      let orgHash = "";
      for (const row of client.store.values()) {
        if (typeof row.fields.org_hash === "string" && row.fields.org_hash.length > 0) {
          orgHash = row.fields.org_hash;
          break;
        }
      }
      const listing = await listOrgEpochs(client, config, orgHash);
      expect(listing.epochs.length).toBe(1);
      const tipHash = listing.epochs[0]!.epoch_hash;
      for (const [key, row] of client.store.entries()) {
        if (row.fields.epoch_hash === tipHash && typeof row.fields.payload === "string") {
          client.store.set(key, {
            ...row,
            fields: {
              ...row.fields,
              payload: row.fields.payload.replace('"owner"', '"Owner"'),
            },
          });
        }
      }
      const io = captureIo();
      expect(await run(["epoch", "verify", "edgevector", "--config", configPath], io, deps)).toBe(1);
      expect(io.err()).toContain("epoch chain INVALID");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("org sealed invite → epoch-mint journey (two clients)", () => {
  // Safety net: any code path that forgets an explicit --identity must never
  // touch the real ~/.org identity.
  let safetyDir = "";
  let savedIdentityPath: string | undefined;
  beforeAll(() => {
    safetyDir = mkdtempSync(join(tmpdir(), "org-journey-safety-"));
    savedIdentityPath = process.env.ORG_MEMBER_IDENTITY_PATH;
    process.env.ORG_MEMBER_IDENTITY_PATH = join(safetyDir, "member-seal.json");
  });
  afterAll(() => {
    if (savedIdentityPath === undefined) delete process.env.ORG_MEMBER_IDENTITY_PATH;
    else process.env.ORG_MEMBER_IDENTITY_PATH = savedIdentityPath;
    rmSync(safetyDir, { recursive: true, force: true });
  });

  async function setupTwoNodes() {
    const dirA = mkdtempSync(join(tmpdir(), "org-journey-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "org-journey-b-"));
    const configA = join(dirA, "config.json");
    const configB = join(dirB, "config.json");
    const identityA = join(dirA, "member-seal.json");
    const identityB = join(dirB, "member-seal.json");
    const clientA = memoryClient("owner-1");
    const clientB = memoryClient("friend-1");
    const secretsA = memorySecrets();
    const secretsB = memorySecrets();
    const depsA: CliDeps = { lastSecrets: secretsA, newClient: () => clientA };
    const depsB: CliDeps = { lastSecrets: secretsB, newClient: () => clientB };

    let io = captureIo();
    expect(await run(["init", "--config", configA], io, depsA)).toBe(0);
    io = captureIo();
    expect(await run(["init", "--config", configB], io, depsB)).toBe(0);
    io = captureIo();
    expect(
      await run(
        [
          "create",
          "friends",
          "--name",
          "Friends",
          "--owner-name",
          "Owner A",
          "--identity",
          identityA,
          "--config",
          configA,
        ],
        io,
        depsA,
      ),
    ).toBe(0);
    expect(io.out()).toContain("signed genesis epoch=0");

    // B publishes its orgpk1:… receive identity.
    io = captureIo();
    expect(
      await run(["receive", "--json", "--identity", identityB, "--config", configB], io, depsB),
    ).toBe(0);
    const receive = JSON.parse(io.out()) as { public_key: string; fingerprint: string };

    return {
      dirA,
      dirB,
      configA,
      configB,
      identityA,
      identityB,
      clientA,
      clientB,
      secretsA,
      secretsB,
      depsA,
      depsB,
      bPubkey: receive.public_key,
      bMemberId: receive.fingerprint,
    };
  }

  function sealedPackageFrom(out: string): string {
    const match = /sealed_package=(\S+)/.exec(out);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  function acceptanceFrom(out: string): string {
    const match = /acceptance=(orgaccept1:\S+)/.exec(out);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  it("invite → join → accept mints epoch 1; replay and kick behave; signatures verify cross-node", async () => {
    const t = await setupTwoNodes();
    try {
      // A seals an invite to B's public key.
      let io = captureIo();
      expect(
        await run(
          ["invite", "friends", "--to", t.bPubkey, "--config", t.configA],
          io,
          t.depsA,
        ),
      ).toBe(0);
      const sealed = sealedPackageFrom(io.out());
      expect(io.err()).toContain("invite expires_at=");

      // B joins through the sealed channel and gets an acceptance token back.
      io = captureIo();
      expect(
        await run(
          [
            "join",
            "--sealed",
            sealed,
            "--identity",
            t.identityB,
            "--member-name",
            "Friend B",
            "--config",
            t.configB,
          ],
          io,
          t.depsB,
        ),
      ).toBe(0);
      expect(io.out()).toContain("joined organization slug=friends");
      const acceptance = acceptanceFrom(io.out());
      expect(t.secretsB.bag.has("org-friends-e2e")).toBe(true);

      // Registry on A still owner-only: membership is NOT granted by join.
      io = captureIo();
      expect(
        await run(["member", "list", "friends", "--config", t.configA], io, t.depsA),
      ).toBe(0);
      expect(io.out()).toContain("registry org=friends epoch=0");
      expect(io.out()).not.toContain(t.bMemberId);

      // Owner accepts: mints epoch 1 with B.
      io = captureIo();
      expect(
        await run(
          ["member", "add", "friends", "--accept", acceptance, "--config", t.configA],
          io,
          t.depsA,
        ),
      ).toBe(0);
      expect(io.out()).toContain("signed epoch=1");
      expect(io.out()).toContain(t.bMemberId);

      // Member list on A shows B from the canonical epoch with provenance.
      io = captureIo();
      expect(
        await run(
          ["member", "list", "friends", "--json", "--config", t.configA],
          io,
          t.depsA,
        ),
      ).toBe(0);
      const listed = JSON.parse(io.out()) as {
        epoch_no: number;
        members: {
          member_id: string;
          name: string;
          sign_pk: string;
          roles: string[];
          status: string;
          added_epoch: number;
        }[];
      };
      expect(listed.epoch_no).toBe(1);
      const bEntry = listed.members.find((m) => m.member_id === t.bMemberId);
      const bIdentity = loadMemberIdentity(t.identityB);
      expect(bEntry?.name).toBe("Friend B");
      expect(bEntry?.roles).toEqual(["member"]);
      expect(bEntry?.status).toBe("active");
      expect(bEntry?.added_epoch).toBe(1);
      expect(bEntry?.sign_pk).toBe(bIdentity.signing_public_key);

      // Cross-epoch signature verification: B signs; A verifies against the
      // sign_pk published in the canonical epoch.
      const payload = { msg: "ref-event fixture", n: 1 };
      const sig = signMemberPayload(bIdentity, payload);
      expect(verifyMemberPayload(bEntry!.sign_pk, payload, sig)).toBe(true);
      expect(verifyMemberPayload(bEntry!.sign_pk, { ...payload, n: 2 }, sig)).toBe(false);

      // Replay: the same acceptance is rejected and mints nothing.
      io = captureIo();
      expect(
        await run(
          ["member", "add", "friends", "--accept", acceptance, "--config", t.configA],
          io,
          t.depsA,
        ),
      ).toBe(1);
      expect(io.err()).toContain("replay");
      io = captureIo();
      expect(
        await run(["epoch", "verify", "friends", "--config", t.configA], io, t.depsA),
      ).toBe(0);
      expect(io.out()).toContain("epochs=2");

      // Kick: revocation epoch, non-retroactive.
      io = captureIo();
      expect(
        await run(["kick", "friends", t.bMemberId, "--config", t.configA], io, t.depsA),
      ).toBe(0);
      expect(io.out()).toContain("signed epoch=2");
      io = captureIo();
      expect(
        await run(["member", "list", "friends", "--config", t.configA], io, t.depsA),
      ).toBe(0);
      expect(io.out()).toContain("registry org=friends epoch=2");
      expect(io.out()).toMatch(new RegExp(`member_id=${t.bMemberId} .*status=revoked`));

      // Kicking again refuses (already revoked); chain still verifies.
      io = captureIo();
      expect(
        await run(["kick", "friends", t.bMemberId, "--config", t.configA], io, t.depsA),
      ).toBe(1);
      expect(io.err()).toContain("already revoked");
      io = captureIo();
      expect(
        await run(["epoch", "verify", "friends", "--config", t.configA], io, t.depsA),
      ).toBe(0);
      expect(io.out()).toContain("epochs=3");
    } finally {
      rmSync(t.dirA, { recursive: true, force: true });
      rmSync(t.dirB, { recursive: true, force: true });
    }
  });

  it("expired invites are rejected at join and at accept with no epoch minted", async () => {
    const t = await setupTwoNodes();
    try {
      let io = captureIo();
      expect(
        await run(
          [
            "invite",
            "friends",
            "--to",
            t.bPubkey,
            "--expires-in",
            "1ms",
            "--config",
            t.configA,
          ],
          io,
          t.depsA,
        ),
      ).toBe(0);
      const sealed = sealedPackageFrom(io.out());
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Join-side rejection: nothing stored on B.
      io = captureIo();
      expect(
        await run(
          ["join", "--sealed", sealed, "--identity", t.identityB, "--config", t.configB],
          io,
          t.depsB,
        ),
      ).toBe(1);
      expect(io.err()).toContain("expired");
      expect(t.secretsB.bag.has("org-friends-e2e")).toBe(false);

      // Accept-side rejection: craft the acceptance directly from the expired
      // invite (a joiner bypassing its own local check) — the OWNER still
      // refuses and no epoch is minted.
      const bIdentity = loadMemberIdentity(t.identityB);
      const invite = unsealAnyInvite(sealed, memberPrivateKeyObject(bIdentity));
      const forced = sealJoinAccept(
        buildJoinAccept({ invite, identity: bIdentity }),
        invite.e2e_key,
      );
      io = captureIo();
      expect(
        await run(
          ["member", "add", "friends", "--accept", forced, "--config", t.configA],
          io,
          t.depsA,
        ),
      ).toBe(1);
      expect(io.err()).toContain("expired");
      expect(io.err()).toContain("no epoch minted");

      io = captureIo();
      expect(
        await run(["epoch", "verify", "friends", "--config", t.configA], io, t.depsA),
      ).toBe(0);
      expect(io.out()).toContain("epochs=1"); // genesis only — nothing minted
    } finally {
      rmSync(t.dirA, { recursive: true, force: true });
      rmSync(t.dirB, { recursive: true, force: true });
    }
  });
});
