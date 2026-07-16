import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listOrgCloudSyncTargets, registerOrgCloudSync } from "../src/org-sync.ts";

describe("org cloud-sync client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("soft-skips when socket path is missing", async () => {
    const result = await registerOrgCloudSync({
      orgHash: "a".repeat(64),
      e2eKeyB64: Buffer.alloc(32, 1).toString("base64"),
      slug: "friends",
      socketPath: "/tmp/org-sync-no-such-socket.sock",
    });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBeTruthy();
  });

  it("list soft-skips missing socket", async () => {
    const listed = await listOrgCloudSyncTargets({
      socketPath: "/tmp/org-sync-no-such-socket.sock",
    });
    expect(listed.targets).toEqual([]);
    expect(listed.skipped).toBeTruthy();
  });

  it("labels register requests with the org LastDB client header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-sync-test-"));
    const socketPath = join(dir, "folddb.sock");
    closeSync(openSync(socketPath, "w"));
    let capturedHeaders: Headers;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await registerOrgCloudSync({
        orgHash: "a".repeat(64),
        e2eKeyB64: Buffer.alloc(32, 1).toString("base64"),
        slug: "friends",
        socketPath,
      });

      expect(result.ok).toBe(true);
      expect(capturedHeaders!.get("X-LastDB-Client")).toBe("org");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("labels list requests with the org LastDB client header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "org-sync-test-"));
    const socketPath = join(dir, "folddb.sock");
    closeSync(openSync(socketPath, "w"));
    let capturedHeaders: Headers;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ targets: [], sync_enabled: true, target_prefixes: [] }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const result = await listOrgCloudSyncTargets({ socketPath });

      expect(result.sync_enabled).toBe(true);
      expect(capturedHeaders!.get("X-LastDB-Client")).toBe("org");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
