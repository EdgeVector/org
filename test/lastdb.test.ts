import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newLastDbClient } from "../src/lastdb.ts";

type NewClientOptions = NonNullable<Parameters<typeof newLastDbClient>[0]>;
type FetchImpl = NonNullable<NewClientOptions["fetchImpl"]>;

describe("LastDB client headers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("labels owner setup calls with the org LastDB client header", async () => {
    let capturedHeaders: Headers;
    const fetchImpl: FetchImpl = async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ user_hash: "user-1" }), { status: 200 });
    };
    const client = newLastDbClient({
      socketPath: "/tmp/org-test.sock",
      userHash: "user-1",
      fetchImpl,
    });

    await client.autoIdentity();

    expect(capturedHeaders!.get("X-LastDB-Client")).toBe("org");
    expect(capturedHeaders!.get("X-User-Hash")).toBe("user-1");
  });

  it("reads Mini user_hash from GET /api/status (nested or top-level)", async () => {
    const nested: FetchImpl = async (url) => {
      expect(String(url)).toContain("/api/status");
      return new Response(
        JSON.stringify({ status: { user_hash: "74f4c062f1277268e287f078e072af83" } }),
        { status: 200 },
      );
    };
    const nestedClient = newLastDbClient({
      socketPath: "/tmp/org-test.sock",
      fetchImpl: nested,
    });
    expect(await nestedClient.nodeUserHash()).toBe("74f4c062f1277268e287f078e072af83");

    const top: FetchImpl = async () =>
      new Response(JSON.stringify({ user_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), {
        status: 200,
      });
    const topClient = newLastDbClient({
      socketPath: "/tmp/org-test.sock",
      fetchImpl: top,
    });
    expect(await topClient.nodeUserHash()).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("falls back to auto-identity when /api/status has no user_hash", async () => {
    const fetchImpl: FetchImpl = async (url) => {
      const path = String(url);
      if (path.includes("/api/status")) {
        return new Response(JSON.stringify({ status: { uptime_s: 1 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ user_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), {
        status: 200,
      });
    };
    const client = newLastDbClient({
      socketPath: "/tmp/org-test.sock",
      fetchImpl,
    });
    expect(await client.nodeUserHash()).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("labels SDK data-path calls with the org LastDB client header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-lastdb-test-"));
    const socketPath = join(dir, "folddb.sock");
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      capturedHeaders = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          schema: "org/Organization",
          rows: [],
          row_count: 0,
          total_count: 0,
          returned_count: 0,
          limit: 1000,
          offset: 0,
          has_more: false,
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const client = newLastDbClient({
        socketPath,
        userHash: "user-1",
      });

      await client.queryAll({
        schemaHash: "org/Organization",
        fields: ["slug"],
        allowFullScan: true,
      });

      expect(capturedHeaders["x-lastdb-client"]).toBe("org");
      expect(capturedHeaders["x-user-hash"]).toBe("user-1");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
