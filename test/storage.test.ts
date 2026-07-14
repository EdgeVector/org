import { describe, expect, it } from "bun:test";

import type { Config } from "../src/config.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";
import {
  formatOrg,
  listOrgDatabases,
  listOrganizations,
  putOrgDatabase,
  putOrganization,
} from "../src/storage.ts";

function memoryClient(): LastDbClient & { store: Map<string, QueryRow> } {
  const store = new Map<string, QueryRow>();
  const key = (schemaHash: string, keyHash: string) => `${schemaHash}::${keyHash}`;
  return {
    store,
    async autoIdentity() {
      return { userHash: "u1" };
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
    // Data path uses schemaName (namespaced) when present.
    Organization: { schemaHash: "hash-org", schemaName: "org/Organization" },
    OrgDatabase: { schemaHash: "hash-db", schemaName: "org/OrgDatabase" },
  },
};

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
    const stored = client.store.get("org/Organization::legacy");
    expect(stored?.fields.default_db).toBeUndefined();
  });
});
