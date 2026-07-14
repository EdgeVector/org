export const OWNER_APP_ID = "org";

export type FieldType =
  | "String"
  | { Array: "String" }
  | { Object: Record<string, FieldType> };

export type SchemaDefinition = {
  name: string;
  owner_app_id: string;
  descriptive_name: string;
  purpose_statement: string;
  schema_type: "Hash";
  key: { hash_field: string };
  fields: string[];
  field_types: Record<string, FieldType>;
  field_descriptions: Record<string, string>;
  field_classifications: Record<string, string[]>;
  field_data_classifications: Record<
    string,
    { sensitivity_level: number; data_domain: string }
  >;
};

export type AddSchemaRequest = {
  schema: SchemaDefinition;
  mutation_mappers: Record<string, string>;
};

const PUBLIC = { sensitivity_level: 0, data_domain: "metadata" };

/** Local membership metadata for an organization cohabiting this node. */
export const organizationSchema: AddSchemaRequest = {
  schema: {
    name: "Organization",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Organization",
    purpose_statement:
      "Local record of a shared organization whose encrypted data cohabits this LastDB node",
    schema_type: "Hash",
    key: { hash_field: "slug" },
    fields: [
      "slug",
      "name",
      "org_hash",
      "org_public_key",
      "e2e_key_ref",
      "role",
      "created_by",
      "created_at",
      "updated_at",
    ],
    field_types: {
      slug: "String",
      name: "String",
      org_hash: "String",
      org_public_key: "String",
      e2e_key_ref: "String",
      role: "String",
      created_by: "String",
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      slug: "stable local org id (also used in lastsecrets://org-<slug>-e2e)",
      name: "human-readable organization name",
      org_hash: "hex identity derived from the org public key",
      org_public_key: "base64 Ed25519 public key for the organization",
      e2e_key_ref: "lastsecrets:// locator for the shared org E2E key (never the raw key)",
      role: "local role for this node: owner | admin | member",
      created_by: "user_hash of the creator on this node",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {
      name: ["word"],
      org_hash: ["word"],
      role: ["word"],
      e2e_key_ref: ["no_index"],
    },
    field_data_classifications: {
      slug: PUBLIC,
      name: PUBLIC,
      org_hash: PUBLIC,
      org_public_key: PUBLIC,
      e2e_key_ref: { sensitivity_level: 2, data_domain: "secret" },
      role: PUBLIC,
      created_by: PUBLIC,
      created_at: PUBLIC,
      updated_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

/**
 * Named shared database living under an org on this node.
 * Cohabits the personal LastDB store as org-namespaced records.
 */
export const orgDatabaseSchema: AddSchemaRequest = {
  schema: {
    name: "OrgDatabase",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Org Database",
    purpose_statement:
      "Named shared database that cohabits the user LastDB node under an organization",
    schema_type: "Hash",
    key: { hash_field: "db_id" },
    fields: [
      "db_id",
      "org_slug",
      "db_slug",
      "name",
      "description",
      "org_hash",
      "created_by",
      "created_at",
      "updated_at",
    ],
    field_types: {
      db_id: "String",
      org_slug: "String",
      db_slug: "String",
      name: "String",
      description: "String",
      org_hash: "String",
      created_by: "String",
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      db_id: "composite key org_slug/db_slug",
      org_slug: "parent organization slug",
      db_slug: "stable database id within the org",
      name: "human-readable database name",
      description: "non-secret purpose / notes",
      org_hash: "parent organization hash (routing key for org-scoped storage)",
      created_by: "user_hash that created the db on this node",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {
      org_slug: ["word"],
      db_slug: ["word"],
      name: ["word"],
      description: ["word"],
      org_hash: ["word"],
    },
    field_data_classifications: {
      db_id: PUBLIC,
      org_slug: PUBLIC,
      db_slug: PUBLIC,
      name: PUBLIC,
      description: PUBLIC,
      org_hash: PUBLIC,
      created_by: PUBLIC,
      created_at: PUBLIC,
      updated_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

export const ALL_SCHEMAS: AddSchemaRequest[] = [organizationSchema, orgDatabaseSchema];

export type SchemaKind = "Organization" | "OrgDatabase";

export function assertSlug(slug: string, label = "slug"): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(slug)) {
    throw new Error(
      `invalid ${label}: must be 1-63 chars, start with a-z0-9, then a-z0-9_-/ only (got ${JSON.stringify(slug)})`,
    );
  }
  return slug;
}

export function e2eSecretSlug(orgSlug: string): string {
  return `org-${assertSlug(orgSlug, "org slug")}-e2e`;
}

export function e2eKeyRef(orgSlug: string): string {
  return `lastsecrets://${e2eSecretSlug(orgSlug)}`;
}

export function dbId(orgSlug: string, dbSlug: string): string {
  return `${assertSlug(orgSlug, "org slug")}/${assertSlug(dbSlug, "db slug")}`;
}
