import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run, type CliDeps } from "../src/cli.ts";
import type { InviteTransport } from "../src/invite-transport.ts";
import { buildInviteClaim, type InviteClaim, type OrgInvite } from "../src/invite.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";
import type { LastSecretsCli } from "../src/lastsecrets.ts";

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
      expect(client.declared).toEqual(["Organization", "OrgDatabase", "PathBinding"]);
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
      expect(memberSecrets.bag.get("org-edgevector-e2e")).toBe(invite.e2e_key);
      expect(memberClient.store.size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invites by sealed claim without putting raw key material in instructions", async () => {
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
      expect(io.out()).toContain("mailto:teammate@example.com");
      expect(io.out()).toContain("sealed claim");
      expect(io.out()).toContain("last-stack-install-apps");
      expect(io.out()).not.toContain("e2e_key");
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
      expect(io.out()).toContain("joined organization");
      expect(memberSecrets.bag.get("org-edgevector-e2e")).toBe(e2eKey);
      expect(memberClient.store.size).toBeGreaterThan(0);
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
