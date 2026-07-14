import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run, type CliDeps } from "../src/cli.ts";
import type { LastDbClient, QueryRow } from "../src/lastdb.ts";
import type { LastSecretsCli } from "../src/lastsecrets.ts";
import { writeSessionPin, clearSessionPin } from "../src/session.ts";
import { personalDb } from "../src/db-handle.ts";
import { injectDbFlag } from "../src/wrapper.ts";

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    },
    stdinText: async () => "",
    out: () => stdout,
    err: () => stderr,
  };
}

function memoryClient(): LastDbClient & { store: Map<string, QueryRow> } {
  const store = new Map<string, QueryRow>();
  const k = (schemaHash: string, keyHash: string) => `${schemaHash}::${keyHash}`;
  let n = 0;
  return {
    store,
    async autoIdentity() {
      return { userHash: "u1" };
    },
    async declareAppSchema(_a, schema) {
      n++;
      return { canonical: `hash-${schema.name}-${n}`, schemaName: `org/${schema.name}` };
    },
    async registerForDistribution() {
      return { app_id: "org", items: [], ok: true };
    },
    async verifyDistributionReady() {
      return { app_id: "org", items: [], ready: true };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      store.set(k(schemaHash, keyHash), {
        fields: { ...fields },
        key: { hash: keyHash, range: null },
      });
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      store.set(k(schemaHash, keyHash), {
        fields: { ...fields },
        key: { hash: keyHash, range: null },
      });
    },
    async queryByKey({ schemaHash, keyHash }) {
      return store.get(k(schemaHash, keyHash)) ?? null;
    },
    async queryAll({ schemaHash }) {
      const prefix = `${schemaHash}::`;
      return [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, v]) => v);
    },
  };
}

function memorySecrets(): LastSecretsCli {
  const bag = new Map<string, string>();
  return {
    put({ slug, value }) {
      bag.set(slug, value);
    },
    get(slug) {
      const v = bag.get(slug);
      if (v === undefined) throw new Error(`missing ${slug}`);
      return v;
    },
    ref(slug) {
      return `lastsecrets://${slug}`;
    },
  };
}

describe("org resolve + wrap CLI", () => {
  it("init → create → bind → resolve under root; wrap injects db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-resolve-"));
    const configPath = join(dir, "config.json");
    const root = join(dir, "workspace");
    mkdirSync(root);
    const nested = join(root, "fold");
    mkdirSync(nested);
    const sessionPath = join(dir, "session.json");
    process.env.ORG_SESSION = sessionPath;
    clearSessionPin(sessionPath);

    const client = memoryClient();
    const wrapped: {
      current: { app: string; args: string[]; locator: string } | null;
    } = { current: null };
    const deps: CliDeps = {
      lastSecrets: memorySecrets(),
      newClient: () => client,
      wrapApp: (app, args, handle) => {
        // Real wrapApp injects --db; mock mirrors that contract.
        wrapped.current = {
          app,
          args: injectDbFlag(args, handle.locator),
          locator: handle.locator,
        };
        return { status: 0 };
      },
    };

    try {
      let io = captureIo();
      expect(await run(["init", "--config", configPath], io, deps)).toBe(0);

      io = captureIo();
      expect(
        await run(
          ["create", "edgevector", "--name", "EV", "--config", configPath],
          io,
          deps,
        ),
      ).toBe(0);

      io = captureIo();
      expect(
        await run(
          ["db", "create", "edgevector", "company", "--config", configPath],
          io,
          deps,
        ),
      ).toBe(0);

      io = captureIo();
      expect(
        await run(
          [
            "bind",
            "edgevector",
            "company",
            "--root",
            root,
            "--config",
            configPath,
          ],
          io,
          deps,
        ),
      ).toBe(0);
      expect(io.out()).toContain("bound root=");

      io = captureIo();
      expect(
        await run(
          ["resolve", "--cwd", nested, "--config", configPath],
          io,
          deps,
        ),
      ).toBe(0);
      expect(io.out().trim()).toBe("lastdb://org/edgevector/company");

      io = captureIo();
      expect(
        await run(
          ["--cwd", nested, "--config", configPath, "kanban", "list"],
          io,
          deps,
        ),
      ).toBe(0);
      expect(wrapped.current?.app).toBe("kanban");
      expect(wrapped.current?.locator).toBe("lastdb://org/edgevector/company");
      expect(wrapped.current?.args[0]).toBe("--db");
      expect(wrapped.current?.args[1]).toBe("lastdb://org/edgevector/company");

      io = captureIo();
      expect(
        await run(
          ["resolve", "--cwd", "/tmp", "--config", configPath],
          io,
          deps,
        ),
      ).toBe(0);
      expect(io.out().trim()).toBe("lastdb://personal");

      writeSessionPin(personalDb(), sessionPath);
      // path still wins over pin
      io = captureIo();
      expect(
        await run(
          ["resolve", "--cwd", nested, "--config", configPath],
          io,
          deps,
        ),
      ).toBe(0);
      expect(io.out().trim()).toBe("lastdb://org/edgevector/company");
    } finally {
      delete process.env.ORG_SESSION;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
