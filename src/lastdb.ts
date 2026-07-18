import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  LastDbClient as SdkLastDbClient,
  TransportError,
  UnexpectedResponseError,
  capabilityStoreKey,
  httpTransport,
  udsTransport,
  type CapabilityStore,
  type JsonValue,
  type QueryRow as SdkQueryRow,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";

import { OWNER_APP_ID, type SchemaDefinition } from "./schema.ts";

export type QueryRow = {
  fields: Record<string, unknown>;
  key: { hash: string | null; range: string | null };
};

export type DistributionRegisterItem = {
  app_id: string;
  schema_name: string;
  identity_hash: string;
  status: "registered" | "already_exists" | "error";
  error?: string;
};

export type RegisterForDistributionResult = {
  app_id: string;
  items: DistributionRegisterItem[];
  ok: boolean;
};

export type DistributionReadyItem = {
  identity: string;
  status: "present" | "missing" | "error";
  error?: string;
};

export type VerifyDistributionReadyResult = {
  app_id: string;
  items: DistributionReadyItem[];
  ready: boolean;
};

export type LastDbClient = {
  autoIdentity(): Promise<{ userHash: string }>;
  declareAppSchema(
    appId: string,
    schema: SchemaDefinition,
  ): Promise<{ canonical: string; schemaName: string }>;
  /**
   * Promote app schemas to Schema Service so other people can install/depend
   * on this app. Solo local declare does not require this.
   */
  registerForDistribution(
    appId: string,
    schemas: SchemaDefinition[],
  ): Promise<RegisterForDistributionResult>;
  /** Fail closed if any required schema identity is missing on Schema Service. */
  verifyDistributionReady(
    appId: string,
    schemaIdentities: string[],
  ): Promise<VerifyDistributionReadyResult>;
  createRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  updateRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  queryByKey(opts: {
    schemaHash: string;
    keyHash: string;
    fields: string[];
  }): Promise<QueryRow | null>;
  queryAll(opts: { schemaHash: string; fields: string[] }): Promise<QueryRow[]>;
};

export class OrgError extends Error {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "OrgError";
    this.code = code;
    this.cause = cause;
  }
}

type FetchInit = RequestInit & { unix?: string };
type FetchLike = (url: string, init?: FetchInit) => Promise<Response>;

const QUERY_PAGE_SIZE = 1000;
const SOCKET_FILE_NAME = "folddb.sock";
const DEFAULT_NODE_URL = "http://localhost:9001";
const LASTDB_CLIENT_HEADER = "X-LastDB-Client";
const noopCapabilityStore: CapabilityStore = {
  async store() {},
  async load() {
    return null;
  },
  async remove() {},
};

export function defaultNodeUrl(): string {
  return process.env.ORG_NODE_URL ?? process.env.LASTDB_NODE_URL ?? DEFAULT_NODE_URL;
}

export function resolveSocketPath(override?: string): string {
  if (override && override.length > 0) return override;
  for (const name of [
    "ORG_SOCKET_PATH",
    "LASTDB_SOCKET_PATH",
    "FOLDDB_SOCKET_PATH",
    "FOLDDB_SOCK",
    "FBRAIN_FOLDDB_SOCKET",
  ]) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  const lastdbHome = process.env.LASTDB_HOME ?? join(homedir(), ".lastdb");
  const folddbHome = process.env.FOLDDB_HOME ?? join(homedir(), ".folddb");
  const lastdbSocket = join(lastdbHome, "data", SOCKET_FILE_NAME);
  const folddbSocket = join(folddbHome, "data", SOCKET_FILE_NAME);
  if (existsSync(lastdbSocket)) return lastdbSocket;
  return folddbSocket;
}

export function newLastDbClient(opts: {
  nodeUrl?: string;
  userHash?: string;
  socketPath?: string;
  fetchImpl?: FetchLike;
} = {}): LastDbClient {
  const nodeUrl = stripTrailingSlash(opts.nodeUrl ?? defaultNodeUrl());
  const socketPath = resolveSocketPath(opts.socketPath);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const defaultHeaders: Record<string, string> = { [LASTDB_CLIENT_HEADER]: OWNER_APP_ID };
  if (opts.userHash) defaultHeaders["X-User-Hash"] = opts.userHash;
  const sdkTransport: SdkTransport = isLoopbackNodeUrl(nodeUrl)
    ? udsTransport(socketPath, defaultHeaders)
    : httpTransport(nodeUrl, defaultHeaders);
  const sdkStoreKey = capabilityStoreKey(OWNER_APP_ID, sdkTransport.target);
  let sdkClient: SdkLastDbClient | null = null;
  const dataClient = (): SdkLastDbClient => {
    sdkClient ??= new SdkLastDbClient(
      OWNER_APP_ID,
      sdkTransport,
      noopCapabilityStore,
      null,
      sdkStoreKey,
      sdkTransport.target,
    );
    return sdkClient;
  };

  const sdkDataPath = async <T>(fn: (client: SdkLastDbClient) => Promise<T>): Promise<T> => {
    try {
      return await fn(dataClient());
    } catch (err) {
      throw mapSdkError(err, nodeUrl, socketPath);
    }
  };

  // Owner setup still uses node-specific endpoints that the app data SDK does
  // not expose: auto-identity and schema declaration.
  const callJson = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> => {
    const headers: Record<string, string> = { [LASTDB_CLIENT_HEADER]: OWNER_APP_ID };
    if (opts.userHash) headers["X-User-Hash"] = opts.userHash;
    let requestBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    const socket = isLoopbackNodeUrl(nodeUrl) ? routeSocketPathFor(method, path, socketPath) : null;
    const url = socket ? `http://localhost${path}` : `${nodeUrl}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        ...(socket ? { unix: socket } : {}),
      });
    } catch (err) {
      throw new OrgError(
        "service_unreachable",
        socket
          ? `LastDB is not reachable over its Unix socket ${socket}.`
          : `LastDB is not reachable at ${nodeUrl}.`,
        err,
      );
    }

    const text = await response.text();
    const parsed = parseBody(text);
    if (!response.ok) {
      throw new OrgError(
        `node_http_${response.status}`,
        `LastDB ${method} ${path} returned HTTP ${response.status}${safeBodyMessage(parsed)}`,
      );
    }
    return parsed;
  };

  return {
    async autoIdentity() {
      const body = await callJson("/api/system/auto-identity", "GET");
      const userHash = objectString(body, "user_hash");
      if (!userHash) {
        throw new OrgError(
          "auto_identity_bad_response",
          "LastDB auto-identity response did not include user_hash.",
        );
      }
      return { userHash };
    },
    async declareAppSchema(appId, schema) {
      let body: unknown;
      try {
        body = await callJson("/api/schemas/declare", "POST", {
          namespace: appId,
          schema,
        });
      } catch (err) {
        if (!(err instanceof OrgError) || err.code !== "node_http_404") {
          throw err;
        }
        body = await callJson("/api/apps/declare-schema", "POST", {
          app_id: appId,
          schema,
        });
      }
      const canonical = declareCanonical(body);
      const schemaName = declareSchemaName(body, appId, schema.name);
      if (!canonical) {
        throw new OrgError(
          "schema_declare_bad_response",
          `LastDB did not return a canonical hash for ${appId}/${schema.name}.`,
        );
      }
      return { canonical, schemaName };
    },
    async registerForDistribution(appId, schemas) {
      const body = await callJson("/api/apps/register-for-distribution", "POST", {
        app_id: appId,
        schemas,
      });
      const data = unwrapData(body);
      const items = Array.isArray(data.items)
        ? (data.items as Record<string, unknown>[]).map(parseRegisterItem)
        : [];
      const ok =
        typeof data.ok === "boolean"
          ? data.ok
          : items.length > 0 &&
            items.every((i) => i.status === "registered" || i.status === "already_exists");
      if (items.length === 0) {
        throw new OrgError(
          "distribution_register_bad_response",
          "LastDB register-for-distribution returned no items.",
        );
      }
      return {
        app_id: typeof data.app_id === "string" ? data.app_id : appId,
        items,
        ok,
      };
    },
    async verifyDistributionReady(appId, schemaIdentities) {
      const body = await callJson("/api/apps/verify-distribution-ready", "POST", {
        app_id: appId,
        schema_identities: schemaIdentities,
      });
      const data = unwrapData(body);
      const items = Array.isArray(data.items)
        ? (data.items as Record<string, unknown>[]).map(parseReadyItem)
        : [];
      const ready =
        typeof data.ready === "boolean"
          ? data.ready
          : items.length > 0 && items.every((i) => i.status === "present");
      return {
        app_id: typeof data.app_id === "string" ? data.app_id : appId,
        items,
        ready,
      };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      await sdkDataPath((client) =>
        client.mutate(schemaHash, {
          mutationType: "create",
          fields: fields as Record<string, JsonValue>,
          key: { hash: keyHash, range: null },
        }),
      );
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      await sdkDataPath((client) =>
        client.mutate(schemaHash, {
          mutationType: "update",
          fields: fields as Record<string, JsonValue>,
          key: { hash: keyHash, range: null },
        }),
      );
    },
    async queryByKey({ schemaHash, keyHash, fields }) {
      const result = await sdkDataPath((client) =>
        client.query(schemaHash, {
          fields,
          filter: { HashKey: keyHash },
          limit: QUERY_PAGE_SIZE,
          offset: 0,
        }),
      );
      const rows = result.rows.map(sdkRowToQueryRow);
      return rows.find((row) => row.key.hash === keyHash) ?? null;
    },
    async queryAll({ schemaHash, fields }) {
      const result = await sdkDataPath((client) =>
        client.queryAll(schemaHash, { fields }, { pageSize: QUERY_PAGE_SIZE, allowFullScan: true }),
      );
      return result.rows.map(sdkRowToQueryRow);
    },
  };
}

function sdkRowToQueryRow(row: SdkQueryRow): QueryRow {
  return {
    fields: row.fields,
    key: row.keyValue ?? renderedKeyToHashKey(row.key),
  };
}

function renderedKeyToHashKey(key: string): { hash: string | null; range: string | null } {
  return { hash: key.length > 0 ? key : null, range: null };
}

function mapSdkError(err: unknown, nodeUrl: string, socketPath: string): Error {
  if (err instanceof TransportError) {
    const detail = err.message ?? String(err);
    // SDK classifies non-JSON error bodies as TransportError; those are still
    // reachable-node protocol errors, not "socket down".
    if (/non-JSON response|ECONNREFUSED|ENOENT|connect/i.test(detail) === false) {
      return new OrgError("transport_error", detail, err);
    }
    if (/non-JSON response/i.test(detail)) {
      return new OrgError(
        "node_bad_response",
        `LastDB data path error: ${detail}`,
        err,
      );
    }
    return new OrgError(
      "service_unreachable",
      isLoopbackNodeUrl(nodeUrl)
        ? `LastDB is not reachable over its Unix socket ${socketPath}.`
        : `LastDB is not reachable at ${nodeUrl}.`,
      err,
    );
  }
  if (err instanceof UnexpectedResponseError) {
    return new OrgError(
      `node_http_${err.status}`,
      `LastDB data path returned HTTP ${err.status}${safeBodyMessage(err.body)}`,
      err,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLoopbackNodeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function isFullSurfaceSocket(socketPath: string): boolean {
  return basename(socketPath) === "folddb-full.sock";
}

function routeSocketPathFor(method: string, path: string, socketPath: string): string {
  if (isFullSurfaceSocket(socketPath)) return socketPath;
  if (
    (method === "POST" && (path === "/api/query" || path === "/api/mutation")) ||
    (method === "POST" && path === "/api/schemas/declare") ||
    (method === "POST" && path === "/api/apps/declare-schema") ||
    (method === "POST" && path === "/api/apps/register-for-distribution") ||
    (method === "POST" && path === "/api/apps/verify-distribution-ready") ||
    (method === "GET" && (path === "/api/schemas" || path === "/api/system/auto-identity"))
  ) {
    return socketPath;
  }
  const full = join(dirname(socketPath), "folddb-full.sock");
  return existsSync(full) ? full : socketPath;
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function safeBodyMessage(body: unknown): string {
  const message = objectString(body, "message") || objectString(body, "error");
  return message ? `: ${redactKnownSecretWords(message)}` : "";
}

function objectString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

function unwrapData(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const rec = body as Record<string, unknown>;
  if (typeof rec.data === "object" && rec.data !== null && !Array.isArray(rec.data)) {
    return rec.data as Record<string, unknown>;
  }
  return rec;
}

function parseRegisterItem(raw: Record<string, unknown>): DistributionRegisterItem {
  const statusRaw = typeof raw.status === "string" ? raw.status : "error";
  const status =
    statusRaw === "registered" || statusRaw === "already_exists" || statusRaw === "error"
      ? statusRaw
      : "error";
  return {
    app_id: typeof raw.app_id === "string" ? raw.app_id : "",
    schema_name: typeof raw.schema_name === "string" ? raw.schema_name : "",
    identity_hash: typeof raw.identity_hash === "string" ? raw.identity_hash : "",
    status,
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

function parseReadyItem(raw: Record<string, unknown>): DistributionReadyItem {
  const statusRaw = typeof raw.status === "string" ? raw.status : "error";
  const status =
    statusRaw === "present" || statusRaw === "missing" || statusRaw === "error"
      ? statusRaw
      : "error";
  return {
    identity: typeof raw.identity === "string" ? raw.identity : "",
    status,
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

function declareCanonical(body: unknown): string {
  const direct = objectString(body, "canonical") || objectString(body, "identity_hash");
  if (direct) return direct;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "";
  const data = (body as Record<string, unknown>).data;
  return objectString(data, "canonical") || objectString(data, "identity_hash");
}

function declareSchemaName(body: unknown, appId: string, localName: string): string {
  const direct = objectString(body, "schema") || objectString(body, "schema_name");
  if (direct) return direct.includes("/") ? direct : `${appId}/${direct}`;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const data = (body as Record<string, unknown>).data;
    const nested = objectString(data, "schema") || objectString(data, "schema_name");
    if (nested) return nested.includes("/") ? nested : `${appId}/${nested}`;
  }
  return `${appId}/${localName}`;
}

export function redactKnownSecretWords(value: string): string {
  return value.replace(/(secret_value|value|token|password|credential)=\S+/gi, "$1=<redacted>");
}
