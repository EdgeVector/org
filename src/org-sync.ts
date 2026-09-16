/**
 * Arm org cloud-sync on the local Mini node after `org db create`.
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
  dbLocator?: string,
): Promise<{ status: number; json: unknown }> {
  if (!existsSync(socketPath)) {
    throw new Error(`node socket not found: ${socketPath}`);
  }
  const headers: Record<string, string> = {
    Host: "localhost",
    "X-LastDB-Client": OWNER_APP_ID,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (dbLocator && dbLocator.length > 0) {
    headers["X-LastDB-Db"] = dbLocator;
  }
  const res = await fetch(`http://localhost${path}`, {
    method,
    unix: socketPath,
    headers,
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
  /** Named org DB locator. Mini rejects personal context. */
  dbLocator: string;
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
      input.dbLocator,
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

/** Owner grants another Exemem principal live cloud access to the org head. */
export async function grantOrgCloudMember(input: {
  orgHash: string;
  targetUserHash: string;
  role?: string;
  socketPath?: string;
}): Promise<{ ok: boolean; error?: string; role?: string; principal_hash?: string }> {
  try {
    const { status, json } = await udsJson(
      "POST",
      "/api/org/sync/grant-member",
      {
        org_hash: input.orgHash,
        target_user_hash: input.targetUserHash,
        role: input.role ?? "writer",
      },
      input.socketPath,
    );
    if (status === 404) {
      return {
        ok: false,
        error:
          "node does not support /api/org/sync/grant-member yet (upgrade lastdbd)",
      };
    }
    const data = unwrapEnvelope(json);
    if (status >= 400 || data.ok === false) {
      return {
        ok: false,
        error: String(data.error ?? data.message ?? `HTTP ${status}`),
      };
    }
    return {
      ok: true,
      role: typeof data.role === "string" ? data.role : undefined,
      principal_hash:
        typeof data.principal_hash === "string" ? data.principal_hash : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Owner kicks target, or omit target / pass self to leave. */
export async function revokeOrgCloudMember(input: {
  orgHash: string;
  targetUserHash?: string;
  socketPath?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: Record<string, string> = { org_hash: input.orgHash };
    if (input.targetUserHash) body.target_user_hash = input.targetUserHash;
    const { status, json } = await udsJson(
      "POST",
      "/api/org/sync/revoke-member",
      body,
      input.socketPath,
    );
    if (status === 404) {
      return {
        ok: false,
        error:
          "node does not support /api/org/sync/revoke-member yet (upgrade lastdbd)",
      };
    }
    const data = unwrapEnvelope(json);
    if (status >= 400 || data.ok === false) {
      return {
        ok: false,
        error: String(data.error ?? data.message ?? `HTTP ${status}`),
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
