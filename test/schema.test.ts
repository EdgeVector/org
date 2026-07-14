import { describe, expect, it } from "bun:test";

import {
  assertSlug,
  dbId,
  e2eKeyRef,
  e2eSecretSlug,
  organizationSchema,
  orgDatabaseSchema,
} from "../src/schema.ts";

describe("org schema", () => {
  it("keeps e2e_key_ref out of word index", () => {
    expect(organizationSchema.schema.field_classifications.e2e_key_ref).toContain(
      "no_index",
    );
    expect(organizationSchema.schema.field_classifications.e2e_key_ref).not.toContain(
      "word",
    );
  });

  it("namespaces under owner_app_id org", () => {
    expect(organizationSchema.schema.owner_app_id).toBe("org");
    expect(orgDatabaseSchema.schema.owner_app_id).toBe("org");
  });

  it("formats lastsecrets refs for org e2e keys", () => {
    expect(e2eSecretSlug("edgevector")).toBe("org-edgevector-e2e");
    expect(e2eKeyRef("edgevector")).toBe("lastsecrets://org-edgevector-e2e");
  });

  it("composes db ids", () => {
    expect(dbId("edgevector", "company")).toBe("edgevector/company");
  });

  it("rejects bad slugs", () => {
    expect(() => assertSlug("../bad")).toThrow();
    expect(() => assertSlug("Has Capitals")).toThrow();
    expect(assertSlug("ok-slug_1")).toBe("ok-slug_1");
  });
});
