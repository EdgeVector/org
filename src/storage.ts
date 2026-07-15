import { createHash } from "node:crypto";

import type { Config } from "./config.ts";
import { schemaBinding } from "./config.ts";
import type { LastDbClient, QueryRow } from "./lastdb.ts";
import type { PathBinding } from "./resolve.ts";
import { normalizePath } from "./resolve.ts";
import {
  assertSlug,
  dbId,
  e2eKeyRef,
  organizationSchema,
  orgDatabaseSchema,
  pathBindingSchema,
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
  defaultDb: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredPathBinding = PathBinding & {
  bindingId: string;
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

export type AdminOrgSummary = {
  slug: string;
  name: string;
  role: string;
  default_db: string;
  default_db_locator: string;
  invite_status: string;
  updated_at: string;
};

export type AdminOrgDatabaseSummary = {
  org_slug: string;
  db_slug: string;
  locator: string;
  name: string;
  description: string;
  updated_at: string;
};

export type AdminOrgSlice = {
  app_id: "org";
  schema: "org.admin.slice.v1";
  captured_at: string;
  total_orgs: number;
  total_databases: number;
  orgs: AdminOrgSummary[];
  databases: AdminOrgDatabaseSummary[];
};

const ORG_FIELDS = organizationSchema.schema.fields.slice();
const DB_FIELDS = orgDatabaseSchema.schema.fields.slice();
const BIND_FIELDS = pathBindingSchema.schema.fields.slice();

export async function putOrganization(
  client: LastDbClient,
  config: Config,
  input: Omit<Organization, "createdAt" | "updatedAt" | "e2eKeyRef" | "defaultDb"> & {
    e2eKeyRef?: string;
    defaultDb?: string;
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
  const prev = existing ? rowToOrg(existing) : null;
  const createdAt = prev?.createdAt ?? now;
  const record: Organization = {
    slug: input.slug,
    name: input.name,
    orgHash: input.orgHash,
    orgPublicKey: input.orgPublicKey,
    e2eKeyRef: input.e2eKeyRef ?? e2eKeyRef(input.slug),
    role: input.role,
    defaultDb: input.defaultDb ?? prev?.defaultDb ?? "",
    createdBy: input.createdBy,
    createdAt,
    updatedAt: now,
  };
  const fields = orgToFields(record);
  await writeRecordWithLegacyFallback(client, {
    schemaHash: sid,
    keyHash: input.slug,
    fields,
    legacyFields: withoutKeys(fields, ["default_db"]),
    update: Boolean(existing),
  });
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

export function bindingIdForRoot(root: string): string {
  return createHash("sha256").update(normalizePath(root)).digest("hex");
}

export async function putPathBinding(
  client: LastDbClient,
  config: Config,
  input: {
    root: string;
    orgSlug: string;
    dbSlug: string;
    orgHash: string;
  },
): Promise<StoredPathBinding> {
  assertSlug(input.orgSlug, "org slug");
  assertSlug(input.dbSlug, "db slug");
  const root = normalizePath(input.root);
  const bindingId = bindingIdForRoot(root);
  const sid = schemaId(config, "PathBinding");
  const existing = await client.queryByKey({
    schemaHash: sid,
    keyHash: bindingId,
    fields: BIND_FIELDS,
  });
  const now = new Date().toISOString();
  const createdAt = existing ? rowToBinding(existing).createdAt : now;
  const record: StoredPathBinding = {
    bindingId,
    root,
    orgSlug: input.orgSlug,
    dbSlug: input.dbSlug,
    orgHash: input.orgHash,
    createdAt,
    updatedAt: now,
  };
  const fields = {
    binding_id: record.bindingId,
    root: record.root,
    org_slug: record.orgSlug,
    db_slug: record.dbSlug,
    org_hash: record.orgHash,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
  if (existing) {
    await client.updateRecord({ schemaHash: sid, keyHash: bindingId, fields });
  } else {
    await client.createRecord({ schemaHash: sid, keyHash: bindingId, fields });
  }
  return record;
}

export async function listPathBindings(
  client: LastDbClient,
  config: Config,
): Promise<StoredPathBinding[]> {
  if (!config.schemas.PathBinding?.schemaHash && !config.schemas.PathBinding?.schemaName) {
    return [];
  }
  try {
    const sid = schemaId(config, "PathBinding");
    const rows = await client.queryAll({ schemaHash: sid, fields: BIND_FIELDS });
    return rows.map(rowToBinding).sort((a, b) => a.root.localeCompare(b.root));
  } catch {
    return [];
  }
}

export async function removePathBinding(
  client: LastDbClient,
  config: Config,
  root: string,
): Promise<boolean> {
  const bindingId = bindingIdForRoot(root);
  const sid = schemaId(config, "PathBinding");
  const existing = await client.queryByKey({
    schemaHash: sid,
    keyHash: bindingId,
    fields: BIND_FIELDS,
  });
  if (!existing) return false;
  // Soft-delete: overwrite with empty org markers is not ideal; Mini may lack
  // delete. Tombstone by updating db_slug to empty is worse. For v1 we only
  // support list+put; unbind removes by writing a sentinel or we document
  // re-bind. Prefer createRecord overwrite with deleted flag if we add field.
  // Use update to clear org_slug so resolve skips empty bindings.
  await client.updateRecord({
    schemaHash: sid,
    keyHash: bindingId,
    fields: {
      binding_id: bindingId,
      root: normalizePath(root),
      org_slug: "",
      db_slug: "",
      org_hash: "",
      created_at: rowToBinding(existing).createdAt,
      updated_at: new Date().toISOString(),
    },
  });
  return true;
}

export function toResolveBindings(stored: StoredPathBinding[]): PathBinding[] {
  return stored
    .filter((b) => b.orgSlug.length > 0 && b.dbSlug.length > 0)
    .map((b) => ({
      root: b.root,
      orgSlug: b.orgSlug,
      dbSlug: b.dbSlug,
      orgHash: b.orgHash || undefined,
    }));
}

export function buildAdminOrgSlice(
  orgs: Organization[],
  databases: OrgDatabase[],
  capturedAt = new Date().toISOString(),
): AdminOrgSlice {
  const dbsByOrg = new Map<string, OrgDatabase[]>();
  for (const db of databases) {
    const list = dbsByOrg.get(db.orgSlug) ?? [];
    list.push(db);
    dbsByOrg.set(db.orgSlug, list);
  }

  const slimOrgs = orgs
    .map((org) => {
      const fallbackDb = dbsByOrg.get(org.slug)?.[0]?.dbSlug ?? "";
      const defaultDb = org.defaultDb || fallbackDb;
      return {
        slug: org.slug,
        name: org.name,
        role: org.role,
        default_db: defaultDb,
        default_db_locator: defaultDb ? orgDbLocator(org.slug, defaultDb) : "",
        invite_status: inviteStatusForRole(org.role),
        updated_at: org.updatedAt,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const slimDatabases = databases
    .map((db) => ({
      org_slug: db.orgSlug,
      db_slug: db.dbSlug,
      locator: orgDbLocator(db.orgSlug, db.dbSlug),
      name: db.name,
      description: db.description,
      updated_at: db.updatedAt,
    }))
    .sort((a, b) => a.locator.localeCompare(b.locator));

  return {
    app_id: "org",
    schema: "org.admin.slice.v1",
    captured_at: capturedAt,
    total_orgs: slimOrgs.length,
    total_databases: slimDatabases.length,
    orgs: slimOrgs,
    databases: slimDatabases,
  };
}

function orgDbLocator(orgSlug: string, dbSlug: string): string {
  return `lastdb://org/${orgSlug}/${dbSlug}`;
}

function inviteStatusForRole(role: string): string {
  return role === "owner" || role === "admin" ? "can_invite" : "member";
}

function orgToFields(org: Organization): Record<string, unknown> {
  return {
    slug: org.slug,
    name: org.name,
    org_hash: org.orgHash,
    org_public_key: org.orgPublicKey,
    e2e_key_ref: org.e2eKeyRef,
    role: org.role,
    default_db: org.defaultDb,
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
    defaultDb: str(f.default_db),
    createdBy: str(f.created_by),
    createdAt: str(f.created_at),
    updatedAt: str(f.updated_at),
  };
}

function rowToBinding(row: QueryRow): StoredPathBinding {
  const f = row.fields;
  return {
    bindingId: str(f.binding_id),
    root: str(f.root),
    orgSlug: str(f.org_slug),
    dbSlug: str(f.db_slug),
    orgHash: str(f.org_hash),
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

async function writeRecordWithLegacyFallback(
  client: LastDbClient,
  opts: {
    schemaHash: string;
    keyHash: string;
    fields: Record<string, unknown>;
    legacyFields: Record<string, unknown>;
    update: boolean;
  },
): Promise<void> {
  const write = (fields: Record<string, unknown>) =>
    opts.update
      ? client.updateRecord({ schemaHash: opts.schemaHash, keyHash: opts.keyHash, fields })
      : client.createRecord({ schemaHash: opts.schemaHash, keyHash: opts.keyHash, fields });
  try {
    await write(opts.fields);
  } catch (err) {
    if (!isUnknownFieldsError(err)) throw err;
    await write(opts.legacyFields);
  }
}

function withoutKeys(
  fields: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const copy = { ...fields };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
}

function isUnknownFieldsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("unknown_fields");
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
    org.defaultDb ? `default_db=${org.defaultDb}` : "",
    `e2e_key_ref=${org.e2eKeyRef}`,
    `created_by=${org.createdBy}`,
    `created_at=${org.createdAt}`,
  ]
    .filter(Boolean)
    .join(" ");
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
