import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run, type CliDeps } from "../src/cli.ts";
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

describe("org CLI", () => {
  it("prints help", async () => {
    const io = captureIo();
    const code = await run(["help"], io);
    expect(code).toBe(0);
    expect(io.out()).toContain("org create");
    expect(io.out()).toContain("lastsecrets");
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
      expect(client.declared).toEqual(["Organization", "OrgDatabase"]);
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
});
