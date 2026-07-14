import { describe, expect, it } from "bun:test";

import { personalDb } from "../src/db-handle.ts";
import { injectDbFlag, isMetaCommand, wrapApp } from "../src/wrapper.ts";

describe("wrapper", () => {
  it("injects --db unless already present", () => {
    expect(injectDbFlag(["list"], "lastdb://personal")).toEqual([
      "--db",
      "lastdb://personal",
      "list",
    ]);
    expect(injectDbFlag(["--db", "x", "list"], "lastdb://personal")).toEqual([
      "--db",
      "x",
      "list",
    ]);
  });

  it("classifies meta vs app commands", () => {
    expect(isMetaCommand("init")).toBe(true);
    expect(isMetaCommand("bind")).toBe(true);
    expect(isMetaCommand("kanban")).toBe(false);
    expect(isMetaCommand("brain")).toBe(false);
  });

  it("dry-run wrap does not spawn", () => {
    const r = wrapApp("kanban", ["list"], personalDb(), { dryRun: true });
    expect(r.status).toBe(0);
  });
});
