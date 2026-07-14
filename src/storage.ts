import type { Config } from "./config.ts";
import { schemaBinding } from "./config.ts";
import type { LastDbClient, QueryRow } from "./lastdb.ts";
import {
  assertSlug,
  dbId,
  e2eKeyRef,
  organizationSchema,
  orgDatabaseSchema,
  type SchemaKind,
} from "./schema.ts";

/**
 * Mini's data path resolves app schemas by namespaced name (`org/Organization`),
 * not by identity_hash alone (unlike some dual-registered hashes that also
 * appear as `name`). Prefer schemaName for mutate/query.
 */
function schemaId(config: Config, kind: SchemaKind): string {
  const binding = schemaBinding(config, kind);
  if (binding.schemaName && binding.schemaName.includes("/")) {
    return binding.schemaName;
  }
  return binding.schemaHash;
}

export type Organization = {
  slug: string;
  name: string;
  orgHash: string;
  orgPublicKey: string;
  e2eKeyRef: string;
  role: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type OrgDatabase = {
  dbId: string;
  orgSlug: string;
  dbSlug: string;
  name: string;
  description: string;
  orgHash: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

const ORG_FIELDS = organizationSchema.schema.fields.slice();
const DB_FIELDS = orgDatabaseSchema.schema.fields.slice();

export async function putOrganization(
  client: LastDbClient,
  config: Config,
  input: Omit<Organization, "createdAt" | "updatedAt" | "e2eKeyRef"> & {
    e2eKeyRef?: string;
  },
): Promise<Organization> {
  assertSlug(input.slug, "org slug");
  const sid = schemaId(config, "Organization");
  const existing = await client.queryByKey({
    schemaHash: sid,
    keyHash: input.slug,
    fields: ORG_FIELDS,
  });
  const now = new Date().toISOString();
  const createdAt = existing ? rowToOrg(existing).createdAt : now;
  const record: Organization = {
    slug: input.slug,
    name: input.name,
    orgHash: input.orgHash,
    orgPublicKey: input.orgPublicKey,
    e2eKeyRef: input.e2eKeyRef ?? e2eKeyRef(input.slug),
    role: input.role,
    createdBy: input.createdBy,
    createdAt,
    updatedAt: now,
  };
  const fields = orgToFields(record);
  if (existing) {
    await client.updateRecord({
      schemaHash: sid,
      keyHash: input.slug,
      fields,
    });
  } else {
    await client.createRecord({
      schemaHash: sid,
      keyHash: input.slug,
      fields,
    });
  }
  return record;
}

export async function getOrganization(
  client: LastDbClient,
  config: Config,
  slug: string,
): Promise<Organization> {
  assertSlug(slug, "org slug");
  const sid = schemaId(config, "Organization");
  const row = await client.queryByKey({
    schemaHash: sid,
    keyHash: slug,
    fields: ORG_FIELDS,
  });
  if (!row) throw new Error(`organization not found: ${slug}`);
  return rowToOrg(row);
}

export async function listOrganizations(
  client: LastDbClient,
  config: Config,
): Promise<Organization[]> {
  const sid = schemaId(config, "Organization");
  const rows = await client.queryAll({
    schemaHash: sid,
    fields: ORG_FIELDS,
  });
  return rows.map(rowToOrg).sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function putOrgDatabase(
  client: LastDbClient,
  config: Config,
  input: {
    orgSlug: string;
    dbSlug: string;
    name: string;
    description: string;
    orgHash: string;
    createdBy: string;
  },
): Promise<OrgDatabase> {
  const id = dbId(input.orgSlug, input.dbSlug);
  const sid = schemaId(config, "OrgDatabase");
  const existing = await client.queryByKey({
    schemaHash: sid,
    keyHash: id,
    fields: DB_FIELDS,
  });
  const now = new Date().toISOString();
  const createdAt = existing ? rowToDb(existing).createdAt : now;
  const record: OrgDatabase = {
    dbId: id,
    orgSlug: input.orgSlug,
    dbSlug: input.dbSlug,
    name: input.name,
    description: input.description,
    orgHash: input.orgHash,
    createdBy: input.createdBy,
    createdAt,
    updatedAt: now,
  };
  const fields = dbToFields(record);
  if (existing) {
    await client.updateRecord({
      schemaHash: sid,
      keyHash: id,
      fields,
    });
  } else {
    await client.createRecord({
      schemaHash: sid,
      keyHash: id,
      fields,
    });
  }
  return record;
}

export async function listOrgDatabases(
  client: LastDbClient,
  config: Config,
  orgSlug?: string,
): Promise<OrgDatabase[]> {
  const sid = schemaId(config, "OrgDatabase");
  const rows = await client.queryAll({
    schemaHash: sid,
    fields: DB_FIELDS,
  });
  let dbs = rows.map(rowToDb);
  if (orgSlug) {
    assertSlug(orgSlug, "org slug");
    dbs = dbs.filter((d) => d.orgSlug === orgSlug);
  }
  return dbs.sort((a, b) => a.dbId.localeCompare(b.dbId));
}

export async function getOrgDatabase(
  client: LastDbClient,
  config: Config,
  orgSlug: string,
  dbSlug: string,
): Promise<OrgDatabase> {
  const id = dbId(orgSlug, dbSlug);
  const sid = schemaId(config, "OrgDatabase");
  const row = await client.queryByKey({
    schemaHash: sid,
    keyHash: id,
    fields: DB_FIELDS,
  });
  if (!row) throw new Error(`org database not found: ${id}`);
  return rowToDb(row);
}

function orgToFields(org: Organization): Record<string, unknown> {
  return {
    slug: org.slug,
    name: org.name,
    org_hash: org.orgHash,
    org_public_key: org.orgPublicKey,
    e2e_key_ref: org.e2eKeyRef,
    role: org.role,
    created_by: org.createdBy,
    created_at: org.createdAt,
    updated_at: org.updatedAt,
  };
}

function dbToFields(db: OrgDatabase): Record<string, unknown> {
  return {
    db_id: db.dbId,
    org_slug: db.orgSlug,
    db_slug: db.dbSlug,
    name: db.name,
    description: db.description,
    org_hash: db.orgHash,
    created_by: db.createdBy,
    created_at: db.createdAt,
    updated_at: db.updatedAt,
  };
}

function rowToOrg(row: QueryRow): Organization {
  const f = row.fields;
  return {
    slug: str(f.slug),
    name: str(f.name),
    orgHash: str(f.org_hash),
    orgPublicKey: str(f.org_public_key),
    e2eKeyRef: str(f.e2e_key_ref),
    role: str(f.role),
    createdBy: str(f.created_by),
    createdAt: str(f.created_at),
    updatedAt: str(f.updated_at),
  };
}

function rowToDb(row: QueryRow): OrgDatabase {
  const f = row.fields;
  return {
    dbId: str(f.db_id),
    orgSlug: str(f.org_slug),
    dbSlug: str(f.db_slug),
    name: str(f.name),
    description: str(f.description),
    orgHash: str(f.org_hash),
    createdBy: str(f.created_by),
    createdAt: str(f.created_at),
    updatedAt: str(f.updated_at),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function formatOrg(org: Organization): string {
  return [
    `slug=${org.slug}`,
    `name=${JSON.stringify(org.name)}`,
    `org_hash=${org.orgHash}`,
    `role=${org.role}`,
    `e2e_key_ref=${org.e2eKeyRef}`,
    `created_by=${org.createdBy}`,
    `created_at=${org.createdAt}`,
  ].join(" ");
}

export function formatDb(db: OrgDatabase): string {
  return [
    `db_id=${db.dbId}`,
    `name=${JSON.stringify(db.name)}`,
    `org_hash=${db.orgHash}`,
    `description=${JSON.stringify(db.description)}`,
    `created_at=${db.createdAt}`,
  ].join(" ");
}
