import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConfig, writeConfig } from "../src/config.ts";

describe("org config", () => {
  it("round-trips schema bindings", () => {
    const dir = mkdtempSync(join(tmpdir(), "org-config-"));
    const path = join(dir, "config.json");
    try {
      writeConfig(
        {
          configVersion: 1,
          nodeUrl: "http://localhost:9001",
          userHash: "abc",
          nodeSocketPath: "/tmp/folddb.sock",
          schemas: {
            Organization: {
              schemaHash: "hash-org",
              schemaName: "org/Organization",
            },
            OrgDatabase: {
              schemaHash: "hash-db",
              schemaName: "org/OrgDatabase",
            },
          },
        },
        path,
      );
      const loaded = readConfig(path);
      expect(loaded.userHash).toBe("abc");
      expect(loaded.schemas.Organization.schemaHash).toBe("hash-org");
      expect(loaded.schemas.OrgDatabase.schemaHash).toBe("hash-db");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
