/**
 * Explicit DB handle + locator forms.
 *
 * Platform-shaped (SDK-bound): no dependency on org product types. Org fills
 * in handles; apps/SDK consume them.
 *
 *   lastdb://personal
 *   lastdb://org/<org-slug>
 *   lastdb://org/<org-slug>/<db-slug>
 */

export type PersonalDbHandle = {
  scope: "personal";
  locator: "lastdb://personal";
};

export type OrgDbHandle = {
  scope: "org";
  orgSlug: string;
  /** Named DB under the org; omitted means org default_db when resolved later. */
  dbSlug?: string;
  orgHash?: string;
  locator: string;
};

export type DbHandle = PersonalDbHandle | OrgDbHandle;

export class DbLocatorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DbLocatorError";
    this.code = code;
  }
}

const ORG_LOCATOR = /^lastdb:\/\/org\/([a-z0-9][a-z0-9_-]{0,62})(?:\/([a-z0-9][a-z0-9_-]{0,62}))?$/i;

export function personalDb(): PersonalDbHandle {
  return { scope: "personal", locator: "lastdb://personal" };
}

export function orgDb(orgSlug: string, dbSlug?: string, orgHash?: string): OrgDbHandle {
  assertSlugPart(orgSlug, "org slug");
  if (dbSlug !== undefined) assertSlugPart(dbSlug, "db slug");
  const locator =
    dbSlug !== undefined
      ? `lastdb://org/${orgSlug}/${dbSlug}`
      : `lastdb://org/${orgSlug}`;
  return {
    scope: "org",
    orgSlug,
    dbSlug,
    orgHash,
    locator,
  };
}

export function formatDbLocator(handle: DbHandle): string {
  return handle.locator;
}

export function parseDbLocator(raw: string): DbHandle {
  const s = raw.trim();
  if (s === "personal" || s === "lastdb://personal") {
    return personalDb();
  }
  // bare org/db shorthand: edgevector/company or edgevector
  if (!s.startsWith("lastdb://")) {
    const parts = s.split("/").filter(Boolean);
    if (parts.length === 1) return orgDb(parts[0]!);
    if (parts.length === 2) return orgDb(parts[0]!, parts[1]!);
    throw new DbLocatorError(
      "locator_invalid",
      `invalid DB locator: ${JSON.stringify(raw)} (use lastdb://personal or lastdb://org/<slug>[/<db>])`,
    );
  }
  if (s === "lastdb://personal") return personalDb();
  const m = s.match(ORG_LOCATOR);
  if (!m) {
    throw new DbLocatorError(
      "locator_invalid",
      `invalid DB locator: ${JSON.stringify(raw)}`,
    );
  }
  return orgDb(m[1]!, m[2], undefined);
}

function assertSlugPart(slug: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(slug)) {
    throw new DbLocatorError(
      "slug_invalid",
      `invalid ${label}: ${JSON.stringify(slug)}`,
    );
  }
}

/** Env var apps should honor when launched via `org <app> …`. */
export const LASTDB_DB_ENV = "LASTDB_DB";
