import { describe, expect, it } from "bun:test";

import { listOrgCloudSyncTargets, registerOrgCloudSync } from "../src/org-sync.ts";

describe("org cloud-sync client", () => {
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
});
