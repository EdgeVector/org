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
      "default_db",
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
      default_db: "String",
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
      default_db: "default named db slug when resolving lastdb://org/<slug> without a db segment",
      created_by: "user_hash of the creator on this node",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {
      name: ["word"],
      org_hash: ["word"],
      role: ["word"],
      default_db: ["word"],
      e2e_key_ref: ["no_index"],
    },
    field_data_classifications: {
      slug: PUBLIC,
      name: PUBLIC,
      org_hash: PUBLIC,
      org_public_key: PUBLIC,
      e2e_key_ref: { sensitivity_level: 2, data_domain: "secret" },
      role: PUBLIC,
      default_db: PUBLIC,
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

/**
 * Path root → org/db binding for place-based resolve (cwd under root ⇒ this DB).
 * Keyed by a stable hash of the absolute root path.
 */
export const pathBindingSchema: AddSchemaRequest = {
  schema: {
    name: "PathBinding",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Path Binding",
    purpose_statement:
      "Maps a filesystem root to an org named database for write-target resolution",
    schema_type: "Hash",
    key: { hash_field: "binding_id" },
    fields: [
      "binding_id",
      "root",
      "org_slug",
      "db_slug",
      "org_hash",
      "created_at",
      "updated_at",
    ],
    field_types: {
      binding_id: "String",
      root: "String",
      org_slug: "String",
      db_slug: "String",
      org_hash: "String",
      created_at: "String",
      updated_at: "String",
    },
    field_descriptions: {
      binding_id: "stable id (sha256 of normalized absolute root)",
      root: "absolute filesystem path that places work in this org db",
      org_slug: "organization slug",
      db_slug: "named database under the org",
      org_hash: "org identity hash for routing",
      created_at: "RFC 3339 timestamp",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {
      root: ["word"],
      org_slug: ["word"],
      db_slug: ["word"],
      org_hash: ["word"],
    },
    field_data_classifications: {
      binding_id: PUBLIC,
      root: PUBLIC,
      org_slug: PUBLIC,
      db_slug: PUBLIC,
      org_hash: PUBLIC,
      created_at: PUBLIC,
      updated_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

/**
 * Thin list-view index over local Organization records (single row per node).
 * Lets `org list` / admin-slice point-read a slug set instead of scanning
 * every Organization row (design: design-lastdb-scan-deprecation-path).
 */
export const orgIndexSchema: AddSchemaRequest = {
  schema: {
    name: "OrgIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Organization Index",
    purpose_statement:
      "Point-read list view of every Organization slug known to this node, maintained on write",
    schema_type: "Hash",
    key: { hash_field: "scope" },
    fields: ["scope", "org_slugs", "updated_at"],
    field_types: {
      scope: "String",
      org_slugs: { Array: "String" },
      updated_at: "String",
    },
    field_descriptions: {
      scope: 'constant local-node scope key ("local")',
      org_slugs: "every organization slug known to this node",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {},
    field_data_classifications: {
      scope: PUBLIC,
      org_slugs: PUBLIC,
      updated_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

/**
 * Thin list-view index over OrgDatabase records, partitioned by org_slug.
 * Point-reading this by org_slug replaces a full OrgDatabase scan filtered
 * client-side.
 */
export const orgDbIndexSchema: AddSchemaRequest = {
  schema: {
    name: "OrgDbIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Org Database Index",
    purpose_statement:
      "Point-read list view of OrgDatabase slugs per organization, maintained on write",
    schema_type: "Hash",
    key: { hash_field: "org_slug" },
    fields: ["org_slug", "db_slugs", "updated_at"],
    field_types: {
      org_slug: "String",
      db_slugs: { Array: "String" },
      updated_at: "String",
    },
    field_descriptions: {
      org_slug: "parent organization slug (partition key)",
      db_slugs: "every database slug under this org known to this node",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {},
    field_data_classifications: {
      org_slug: PUBLIC,
      db_slugs: PUBLIC,
      updated_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

/**
 * Thin list-view index over local PathBinding records (single row per node).
 * `resolveHandle` runs on every `org run`/`org kanban …` dispatch, so this is
 * the hottest of the three scans this design replaces.
 */
export const pathBindingIndexSchema: AddSchemaRequest = {
  schema: {
    name: "PathBindingIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Path Binding Index",
    purpose_statement:
      "Point-read list view of every PathBinding id known to this node, maintained on write",
    schema_type: "Hash",
    key: { hash_field: "scope" },
    fields: ["scope", "binding_ids", "updated_at"],
    field_types: {
      scope: "String",
      binding_ids: { Array: "String" },
      updated_at: "String",
    },
    field_descriptions: {
      scope: 'constant local-node scope key ("local")',
      binding_ids: "every path binding id known to this node",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {},
    field_data_classifications: {
      scope: PUBLIC,
      binding_ids: PUBLIC,
      updated_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

/**
 * Owner-signed, hash-chained membership epoch. The epoch chain IS the member
 * registry (decision-2026-08-18-lastgit-collaborator-trust-epochs); there are
 * no mutable member rows. Point-get by epoch_hash; per-org enumeration goes
 * through OrgEpochIndex (no scans).
 */
export const orgEpochSchema: AddSchemaRequest = {
  schema: {
    name: "OrgEpoch",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Org Membership Epoch",
    purpose_statement:
      "Owner-signed hash-chained membership snapshot; the epoch chain is the org member registry",
    schema_type: "Hash",
    key: { hash_field: "epoch_hash" },
    fields: [
      "epoch_hash",
      "org_hash",
      "epoch_no",
      "prev_epoch",
      "payload",
      "sig",
      "created_at",
    ],
    field_types: {
      epoch_hash: "String",
      org_hash: "String",
      epoch_no: "String",
      prev_epoch: "String",
      payload: "String",
      sig: "String",
      created_at: "String",
    },
    field_descriptions: {
      epoch_hash: "sha256 hex of the JCS canonical payload (primary key)",
      org_hash: "org identity hash this epoch belongs to",
      epoch_no: "epoch sequence number as decimal string (genesis 0)",
      prev_epoch: 'sha256 hex of the predecessor payload ("" at genesis)',
      payload: "exact JCS canonical payload bytes (the signed content)",
      sig: "base64url Ed25519 signature by the org root key over payload",
      created_at: "RFC 3339 timestamp of the local write (informational)",
    },
    field_classifications: {
      org_hash: ["word"],
      epoch_no: ["word"],
      prev_epoch: ["word"],
      payload: ["no_index"],
      sig: ["no_index"],
    },
    field_data_classifications: {
      epoch_hash: PUBLIC,
      org_hash: PUBLIC,
      epoch_no: PUBLIC,
      prev_epoch: PUBLIC,
      payload: PUBLIC,
      sig: PUBLIC,
      created_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

/**
 * Thin list-view index over OrgEpoch records, partitioned by org_hash.
 * Point-reading this replaces any scan when enumerating an org's epochs
 * (canonical-chain selection loads the listed hashes individually).
 */
export const orgEpochIndexSchema: AddSchemaRequest = {
  schema: {
    name: "OrgEpochIndex",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Org Epoch Index",
    purpose_statement:
      "Point-read list view of OrgEpoch hashes per organization, maintained on write",
    schema_type: "Hash",
    key: { hash_field: "org_hash" },
    fields: ["org_hash", "epoch_hashes", "updated_at"],
    field_types: {
      org_hash: "String",
      epoch_hashes: { Array: "String" },
      updated_at: "String",
    },
    field_descriptions: {
      org_hash: "organization identity hash (partition key)",
      epoch_hashes: "every OrgEpoch hash known to this node for the org",
      updated_at: "RFC 3339 timestamp",
    },
    field_classifications: {},
    field_data_classifications: {
      org_hash: PUBLIC,
      epoch_hashes: PUBLIC,
      updated_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

/**
 * Consumed invite-claim marker: one row per claim_nonce, written when the
 * owner mints the membership epoch for that claim. Point-get by nonce is the
 * replay check — a nonce with a row is spent. No enumeration, so no index
 * companion.
 */
export const orgInviteClaimSchema: AddSchemaRequest = {
  schema: {
    name: "OrgInviteClaim",
    owner_app_id: OWNER_APP_ID,
    descriptive_name: "Org Invite Claim",
    purpose_statement:
      "One-time invite claim consumption marker; presence of a nonce row rejects replayed acceptances",
    schema_type: "Hash",
    key: { hash_field: "claim_nonce" },
    fields: ["claim_nonce", "org_hash", "member_id", "epoch_hash", "consumed_at"],
    field_types: {
      claim_nonce: "String",
      org_hash: "String",
      member_id: "String",
      epoch_hash: "String",
      consumed_at: "String",
    },
    field_descriptions: {
      claim_nonce: "one-time invite claim nonce (primary key)",
      org_hash: "organization the claim belonged to",
      member_id: "member the claim admitted",
      epoch_hash: "membership epoch minted for this claim",
      consumed_at: "RFC 3339 timestamp the owner accepted the claim",
    },
    field_classifications: {
      org_hash: ["word"],
      member_id: ["word"],
    },
    field_data_classifications: {
      claim_nonce: PUBLIC,
      org_hash: PUBLIC,
      member_id: PUBLIC,
      epoch_hash: PUBLIC,
      consumed_at: PUBLIC,
    },
  },
  mutation_mappers: {},
};

export const ALL_SCHEMAS: AddSchemaRequest[] = [
  organizationSchema,
  orgDatabaseSchema,
  pathBindingSchema,
  orgIndexSchema,
  orgDbIndexSchema,
  pathBindingIndexSchema,
  orgEpochSchema,
  orgEpochIndexSchema,
  orgInviteClaimSchema,
];

export type SchemaKind =
  | "Organization"
  | "OrgDatabase"
  | "PathBinding"
  | "OrgIndex"
  | "OrgDbIndex"
  | "PathBindingIndex"
  | "OrgEpoch"
  | "OrgEpochIndex"
  | "OrgInviteClaim";

/** Constant hash key for the single-row per-node indexes (OrgIndex, PathBindingIndex). */
export const INDEX_SCOPE = "local";

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
