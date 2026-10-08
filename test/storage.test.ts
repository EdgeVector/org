import { describe, expect, it } from "bun:test";

import type { Config } from "../src/config.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";
import { INDEX_SCOPE } from "../src/schema.ts";
import {
  buildAdminOrgSlice,
  formatOrg,
  listOrgDatabases,
  listOrganizations,
  listPathBindings,
  putOrgDatabase,
  putOrgDatabases,
  putOrganization,
  putPathBindings,
} from "../src/storage.ts";

function memoryClient(): LastDbClient & { store: Map<string, QueryRow> } {
  const store = new Map<string, QueryRow>();
  const key = (schemaHash: string, keyHash: string) => `${schemaHash}::${keyHash}`;
  return {
    store,
    async autoIdentity() {
      return { userHash: "u1" };
    },
    async nodeUserHash() {
      return "u1";
    },
    async declareAppSchema() {
      return { canonical: "c", schemaName: "x" };
    },
    async registerForDistribution() {
      return { app_id: "org", items: [], ok: true };
    },
    async verifyDistributionReady() {
      return { app_id: "org", items: [], ready: true };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      store.set(key(schemaHash, keyHash), {
        fields: { ...fields },
        key: { hash: keyHash, range: null },
      });
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      store.set(key(schemaHash, keyHash), {
        fields: { ...fields },
        key: { hash: keyHash, range: null },
      });
    },
    async queryByKey({ schemaHash, keyHash }) {
      return store.get(key(schemaHash, keyHash)) ?? null;
    },
    async queryByKeys({ schemaHash, keyHashes }) {
      return keyHashes.flatMap((keyHash) => {
        const row = store.get(key(schemaHash, keyHash));
        return row ? [row] : [];
      });
    },
    async queryAll({ schemaHash }) {
      const prefix = `${schemaHash}::`;
      return [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
  };
}

const config: Config = {
  configVersion: 1,
  nodeUrl: "http://localhost:9001",
  userHash: "u1",
  schemas: {
    // Data path prefers catalog schemaHash (identity) over namespaced app name.
    Organization: { schemaHash: "hash-org", schemaName: "org/Organization" },
    OrgDatabase: { schemaHash: "hash-db", schemaName: "org/OrgDatabase" },
  },
};

const indexedConfig: Config = {
  configVersion: 1,
  nodeUrl: "http://localhost:9001",
  userHash: "u1",
  schemas: {
    Organization: { schemaHash: "hash-org", schemaName: "org/Organization" },
    OrgDatabase: { schemaHash: "hash-db", schemaName: "org/OrgDatabase" },
    OrgIndex: { schemaHash: "hash-org-index", schemaName: "org/OrgIndex" },
    OrgDbIndex: { schemaHash: "hash-db-index", schemaName: "org/OrgDbIndex" },
    PathBinding: { schemaHash: "hash-bind", schemaName: "org/PathBinding" },
    PathBindingIndex: { schemaHash: "hash-bind-index", schemaName: "org/PathBindingIndex" },
  },
};

function recordingClient() {
  const client = memoryClient();
  const hashKey: { schemaHash: string; keyHash: string }[] = [];
  const hashKeys: { schemaHash: string; keyHashes: string[] }[] = [];
  const byKey = client.queryByKey.bind(client);
  const byKeys = client.queryByKeys.bind(client);
  client.queryByKey = async (opts) => {
    hashKey.push({ schemaHash: opts.schemaHash, keyHash: opts.keyHash });
    return byKey(opts);
  };
  client.queryByKeys = async (opts) => {
    hashKeys.push({ schemaHash: opts.schemaHash, keyHashes: [...opts.keyHashes] });
    return byKeys(opts);
  };
  const clear = () => {
    hashKey.length = 0;
    hashKeys.length = 0;
  };
  return { client, hashKey, hashKeys, clear };
}

describe("org storage", () => {
  it("creates org + shared db that cohabit the same client store", async () => {
    const client = memoryClient();
    const org = await putOrganization(client, config, {
      slug: "edgevector",
      name: "Edge Vector",
      orgHash: "abc123",
      orgPublicKey: "pub",
      role: "owner",
      defaultDb: "company",
      createdBy: "u1",
    });
    expect(org.e2eKeyRef).toBe("lastsecrets://org-edgevector-e2e");
    expect(formatOrg(org)).toContain("slug=edgevector");

    const db = await putOrgDatabase(client, config, {
      orgSlug: "edgevector",
      dbSlug: "company",
      name: "Company",
      description: "shared",
      orgHash: "abc123",
      createdBy: "u1",
    });
    expect(db.dbId).toBe("edgevector/company");

    const orgs = await listOrganizations(client, config);
    expect(orgs.map((o) => o.slug)).toEqual(["edgevector"]);
    const dbs = await listOrgDatabases(client, config, "edgevector");
    expect(dbs.map((d) => d.dbSlug)).toEqual(["company"]);
  });

  it("falls back when an older org schema rejects default_db", async () => {
    const client = memoryClient();
    const createRecord = client.createRecord.bind(client);
    client.createRecord = async (opts) => {
      if ("default_db" in opts.fields) throw new Error("unknown_fields");
      await createRecord(opts);
    };

    const org = await putOrganization(client, config, {
      slug: "legacy",
      name: "Legacy",
      orgHash: "abc123",
      orgPublicKey: "pub",
      role: "owner",
      defaultDb: "company",
      createdBy: "u1",
    });

    expect(org.defaultDb).toBe("company");
    const stored = client.store.get("hash-org::legacy");
    expect(stored?.fields.default_db).toBeUndefined();
  });

  it("explains the personal registry when a named catalog rejects OrgDatabase", async () => {
    const client = memoryClient();
    client.queryByKey = async () => {
      throw new Error("catalog_membership_denied: org/OrgDatabase");
    };

    await expect(
      putOrgDatabase(client, config, {
        orgSlug: "edgevector",
        dbSlug: "company",
        name: "Company",
        description: "shared",
        orgHash: "abc123",
        createdBy: "u1",
      }),
    ).rejects.toThrow(
      "use the personal registry (lastdb://personal) for org db create, or use org db share-schema / declare-in-DB",
    );
  });

  it("builds a metadata-only admin slice for delivery", async () => {
    const client = memoryClient();
    await putOrganization(client, config, {
      slug: "edgevector",
      name: "Edge Vector",
      orgHash: "secret-routing-hash",
      orgPublicKey: "public-key-material",
      e2eKeyRef: "lastsecrets://org-edgevector-e2e",
      role: "owner",
      defaultDb: "company",
      createdBy: "u1",
    });
    await putOrgDatabase(client, config, {
      orgSlug: "edgevector",
      dbSlug: "company",
      name: "Company",
      description: "shared workspace",
      orgHash: "secret-routing-hash",
      createdBy: "u1",
    });

    const slice = buildAdminOrgSlice(
      await listOrganizations(client, config),
      await listOrgDatabases(client, config),
      "2026-07-15T09:00:00.000Z",
    );
    const encoded = JSON.stringify(slice);

    expect(slice).toEqual({
      app_id: "org",
      schema: "org.admin.slice.v1",
      captured_at: "2026-07-15T09:00:00.000Z",
      total_orgs: 1,
      total_databases: 1,
      orgs: [
        {
          slug: "edgevector",
          name: "Edge Vector",
          role: "owner",
          default_db: "company",
          default_db_locator: "lastdb://org/edgevector/company",
          invite_status: "can_invite",
          updated_at: expect.any(String),
        },
      ],
      databases: [
        {
          org_slug: "edgevector",
          db_slug: "company",
          locator: "lastdb://org/edgevector/company",
          name: "Company",
          description: "shared workspace",
          updated_at: expect.any(String),
        },
      ],
    });
    expect(encoded).not.toContain("secret-routing-hash");
    expect(encoded).not.toContain("public-key-material");
    expect(encoded).not.toContain("lastsecrets://");
    expect(encoded).not.toContain("e2e_key_ref");
    expect(encoded).not.toContain("org_public_key");
    expect(encoded).not.toContain("org_hash");
    expect(encoded).not.toContain("orgseal1:");
  });

  it("hydrates N indexed org slugs with one HashKeys query and zero per-key HashKey calls", async () => {
    const { client, hashKey, hashKeys, clear } = recordingClient();
    const slugs = ["alpha", "bravo", "charlie", "delta", "echo"];
    for (const slug of slugs) {
      await putOrganization(client, indexedConfig, {
        slug,
        name: slug,
        orgHash: `hash-${slug}`,
        orgPublicKey: "pub",
        role: "owner",
        createdBy: "u1",
      });
    }
    const indexRow = client.store.get(`hash-org-index::${INDEX_SCOPE}`);
    expect(indexRow).toBeDefined();
    (indexRow!.fields.org_slugs as string[]).push("ghost");

    clear();
    const listed = await listOrganizations(client, indexedConfig);

    expect(listed.map((org) => org.slug)).toEqual(slugs);
    expect(hashKeys).toEqual([
      { schemaHash: "hash-org", keyHashes: [...slugs, "ghost"] },
    ]);
    expect(hashKey.filter((call) => call.schemaHash === "hash-org")).toEqual([]);
    expect(hashKey.filter((call) => call.schemaHash === "hash-org-index")).toEqual([
      { schemaHash: "hash-org-index", keyHash: INDEX_SCOPE },
    ]);
  });

  it("lists databases for many orgs with one OrgDbIndex HashKeys query and one OrgDatabase HashKeys query", async () => {
    const { client, hashKey, hashKeys, clear } = recordingClient();
    for (const slug of ["acme", "beta"]) {
      await putOrganization(client, indexedConfig, {
        slug,
        name: slug,
        orgHash: `hash-${slug}`,
        orgPublicKey: "pub",
        role: "owner",
        createdBy: "u1",
      });
      await putOrgDatabase(client, indexedConfig, {
        orgSlug: slug,
        dbSlug: "main",
        name: "Main",
        description: "",
        orgHash: `hash-${slug}`,
        createdBy: "u1",
      });
      await putOrgDatabase(client, indexedConfig, {
        orgSlug: slug,
        dbSlug: "notes",
        name: "Notes",
        description: "",
        orgHash: `hash-${slug}`,
        createdBy: "u1",
      });
    }

    clear();
    const dbs = await listOrgDatabases(client, indexedConfig);
    expect(dbs.map((db) => db.dbId).sort()).toEqual([
      "acme/main",
      "acme/notes",
      "beta/main",
      "beta/notes",
    ]);
    expect(hashKeys.filter((call) => call.schemaHash === "hash-db-index")).toEqual([
      { schemaHash: "hash-db-index", keyHashes: ["acme", "beta"] },
    ]);
    expect(hashKeys.filter((call) => call.schemaHash === "hash-db")).toEqual([
      {
        schemaHash: "hash-db",
        keyHashes: ["acme/main", "acme/notes", "beta/main", "beta/notes"],
      },
    ]);
    expect(hashKey.filter((call) => call.schemaHash === "hash-db")).toEqual([]);
    expect(hashKey.filter((call) => call.schemaHash === "hash-db-index")).toEqual([]);
  });

  it("writes invite databases and bindings with one HashKeys existence check per schema", async () => {
    const { client, hashKey, hashKeys, clear } = recordingClient();
    await putOrganization(client, indexedConfig, {
      slug: "acme",
      name: "Acme",
      orgHash: "hash-acme",
      orgPublicKey: "pub",
      role: "member",
      createdBy: "u1",
    });
    clear();

    await putOrgDatabases(client, indexedConfig, [
      {
        orgSlug: "acme",
        dbSlug: "main",
        name: "Main",
        description: "",
        orgHash: "hash-acme",
        createdBy: "u1",
      },
      {
        orgSlug: "acme",
        dbSlug: "notes",
        name: "Notes",
        description: "",
        orgHash: "hash-acme",
        createdBy: "u1",
      },
    ]);
    await putPathBindings(client, indexedConfig, [
      { root: "/tmp/acme-main", orgSlug: "acme", dbSlug: "main", orgHash: "hash-acme" },
      { root: "/tmp/acme-notes", orgSlug: "acme", dbSlug: "notes", orgHash: "hash-acme" },
    ]);

    expect(hashKeys.filter((call) => call.schemaHash === "hash-db")).toEqual([
      { schemaHash: "hash-db", keyHashes: ["acme/main", "acme/notes"] },
    ]);
    expect(hashKeys.filter((call) => call.schemaHash === "hash-bind")).toHaveLength(1);
    expect(hashKey.filter((call) => call.schemaHash === "hash-db")).toEqual([]);
    expect(hashKey.filter((call) => call.schemaHash === "hash-bind")).toEqual([]);
    expect(hashKey.filter((call) => call.schemaHash === "hash-db-index")).toEqual([
      { schemaHash: "hash-db-index", keyHash: "acme" },
    ]);
    expect(hashKey.filter((call) => call.schemaHash === "hash-bind-index")).toEqual([
      { schemaHash: "hash-bind-index", keyHash: INDEX_SCOPE },
    ]);

    const dbs = await listOrgDatabases(client, indexedConfig, "acme");
    expect(dbs.map((db) => db.dbSlug).sort()).toEqual(["main", "notes"]);
    const bindings = await listPathBindings(client, indexedConfig);
    expect(bindings.map((b) => b.dbSlug).sort()).toEqual(["main", "notes"]);
  });
});
