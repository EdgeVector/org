/**
 * Arm org cloud-sync on the local Mini node after create/join.
 *
 * Doctrine: an org DB always has a cloud backup; local writes append to the
 * org log encrypted with the org E2E key. Registration POSTs to
 * `/api/org/sync/register` on the owner socket.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { OWNER_APP_ID } from "./schema.ts";

export type OrgSyncRegisterResult = {
  ok: boolean;
  org_hash?: string;
  slug?: string;
  sync_enabled?: boolean;
  target_prefixes?: string[];
  note?: string;
  /** Soft-failure reason when the node is unreachable or pre-feature. */
  skipped?: string;
  error?: string;
};

export type OrgSyncTargetsResult = {
  targets: Array<{
    org_hash: string;
    slug: string;
    active: boolean;
    registered_at: string;
  }>;
  sync_enabled: boolean;
  target_prefixes: string[];
  skipped?: string;
  error?: string;
};

function defaultSocketPath(): string {
  if (process.env.ORG_NODE_SOCKET && process.env.ORG_NODE_SOCKET.length > 0) {
    return process.env.ORG_NODE_SOCKET;
  }
  if (process.env.LASTDB_SOCKET && process.env.LASTDB_SOCKET.length > 0) {
    return process.env.LASTDB_SOCKET;
  }
  return join(homedir(), ".lastdb", "data", "folddb.sock");
}

async function udsJson(
  method: string,
  path: string,
  body?: unknown,
  socketPath = defaultSocketPath(),
): Promise<{ status: number; json: unknown }> {
  if (!existsSync(socketPath)) {
    throw new Error(`node socket not found: ${socketPath}`);
  }
  const res = await fetch(`http://localhost${path}`, {
    method,
    unix: socketPath,
    headers: {
      Host: "localhost",
      "X-LastDB-Client": OWNER_APP_ID,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  } as RequestInit & { unix: string });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function unwrapEnvelope(json: unknown): Record<string, unknown> {
  if (typeof json !== "object" || json === null) return {};
  const o = json as Record<string, unknown>;
  // Mini may wrap as { data: {...} } or return body directly.
  if (typeof o.data === "object" && o.data !== null) {
    return o.data as Record<string, unknown>;
  }
  if (typeof o.result === "object" && o.result !== null) {
    return o.result as Record<string, unknown>;
  }
  return o;
}

/**
 * Register org_hash + e2e key with the local node so cloud sync can append/pull
 * the org log. Soft-fails when the node is old or offline (org still works local).
 */
export async function registerOrgCloudSync(input: {
  orgHash: string;
  e2eKeyB64: string;
  slug: string;
  socketPath?: string;
}): Promise<OrgSyncRegisterResult> {
  try {
    const { status, json } = await udsJson(
      "POST",
      "/api/org/sync/register",
      {
        org_hash: input.orgHash,
        e2e_key_b64: input.e2eKeyB64,
        slug: input.slug,
      },
      input.socketPath,
    );
    if (status === 404) {
      return {
        ok: false,
        skipped:
          "node does not support /api/org/sync/register yet (upgrade lastdbd / fold)",
      };
    }
    if (status >= 400) {
      const data = unwrapEnvelope(json);
      return {
        ok: false,
        error: String(data.error ?? data.message ?? `HTTP ${status}`),
      };
    }
    const data = unwrapEnvelope(json);
    return {
      ok: data.ok === true || status < 300,
      org_hash: typeof data.org_hash === "string" ? data.org_hash : input.orgHash,
      slug: typeof data.slug === "string" ? data.slug : input.slug,
      sync_enabled: Boolean(data.sync_enabled),
      target_prefixes: Array.isArray(data.target_prefixes)
        ? (data.target_prefixes as string[])
        : undefined,
      note: typeof data.note === "string" ? data.note : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, skipped: msg };
  }
}

export async function listOrgCloudSyncTargets(opts?: {
  socketPath?: string;
}): Promise<OrgSyncTargetsResult> {
  try {
    const { status, json } = await udsJson(
      "GET",
      "/api/org/sync/targets",
      undefined,
      opts?.socketPath,
    );
    if (status === 404) {
      return {
        targets: [],
        sync_enabled: false,
        target_prefixes: [],
        skipped: "node does not support /api/org/sync/targets yet",
      };
    }
    if (status >= 400) {
      const data = unwrapEnvelope(json);
      return {
        targets: [],
        sync_enabled: false,
        target_prefixes: [],
        error: String(data.error ?? data.message ?? `HTTP ${status}`),
      };
    }
    const data = unwrapEnvelope(json);
    return {
      targets: Array.isArray(data.targets)
        ? (data.targets as OrgSyncTargetsResult["targets"])
        : [],
      sync_enabled: Boolean(data.sync_enabled),
      target_prefixes: Array.isArray(data.target_prefixes)
        ? (data.target_prefixes as string[])
        : [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      targets: [],
      sync_enabled: false,
      target_prefixes: [],
      skipped: msg,
    };
  }
}
