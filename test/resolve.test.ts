import { describe, expect, it } from "bun:test";

import { formatDbLocator, parseDbLocator, personalDb } from "../src/db-handle.ts";
import { isUnderRoot, resolveWriteTarget, ResolveError } from "../src/resolve.ts";

describe("db locators", () => {
  it("parses personal and org forms", () => {
    expect(parseDbLocator("lastdb://personal")).toEqual(personalDb());
    expect(parseDbLocator("personal").locator).toBe("lastdb://personal");
    expect(parseDbLocator("edgevector/company").locator).toBe(
      "lastdb://org/edgevector/company",
    );
    const orgOnly = parseDbLocator("lastdb://org/edgevector");
    expect(orgOnly.scope).toBe("org");
    if (orgOnly.scope === "org") expect(orgOnly.orgSlug).toBe("edgevector");
  });

  it("round-trips format", () => {
    const h = parseDbLocator("edgevector/company");
    expect(formatDbLocator(h)).toBe("lastdb://org/edgevector/company");
  });
});

describe("resolveWriteTarget", () => {
  const bindings = [
    {
      root: "/Users/tom/code/edgevector",
      orgSlug: "edgevector",
      dbSlug: "company",
    },
    {
      root: "/Users/tom/code/hobby",
      orgSlug: "hobby",
      dbSlug: "main",
    },
  ];

  it("prefers explicit over cwd", () => {
    const h = resolveWriteTarget({
      cwd: "/Users/tom/code/edgevector/fold",
      explicit: "personal",
      bindings,
    });
    expect(h.locator).toBe("lastdb://personal");
  });

  it("matches longest path prefix", () => {
    const h = resolveWriteTarget({
      cwd: "/Users/tom/code/edgevector/fold",
      bindings,
    });
    expect(h.locator).toBe("lastdb://org/edgevector/company");
  });

  it("defaults to personal outside roots", () => {
    const h = resolveWriteTarget({
      cwd: "/tmp/scratch",
      bindings,
    });
    expect(h.locator).toBe("lastdb://personal");
  });

  it("uses session pin when no path match", () => {
    const h = resolveWriteTarget({
      cwd: "/tmp/scratch",
      sessionPin: "hobby/main",
      bindings,
    });
    expect(h.locator).toBe("lastdb://org/hobby/main");
  });

  it("path match beats session pin", () => {
    const h = resolveWriteTarget({
      cwd: "/Users/tom/code/edgevector/x",
      sessionPin: "hobby/main",
      bindings,
    });
    expect(h.locator).toBe("lastdb://org/edgevector/company");
  });

  it("refuses true ambiguity (same-length different targets)", () => {
    // two roots that are equal length and both match is rare; simulate equal roots
    // by using two bindings with same root path different targets - last put wins
    // for longest prefix if same length and different target:
    expect(() =>
      resolveWriteTarget({
        cwd: "/Users/tom/code/same",
        bindings: [
          { root: "/Users/tom/code/same", orgSlug: "a", dbSlug: "one" },
          { root: "/Users/tom/code/same", orgSlug: "b", dbSlug: "two" },
        ],
      }),
    ).toThrow(ResolveError);
  });

  it("isUnderRoot", () => {
    expect(isUnderRoot("/a/b/c", "/a/b")).toBe(true);
    expect(isUnderRoot("/a/b", "/a/b")).toBe(true);
    expect(isUnderRoot("/a/be", "/a/b")).toBe(false);
  });
});
