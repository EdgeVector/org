import { describe, expect, it } from "bun:test";

import type { Config } from "../src/config.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";
import {
  buildAdminOrgSlice,
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
});
