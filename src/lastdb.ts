import { homedir } from "node:os";
import { join } from "node:path";

import {
  LastDbClient as SdkLastDbClient,
  TransportError,
  UnexpectedResponseError,
  capabilityStoreKey,
  udsTransport,
  type CapabilityStore,
  type JsonValue,
  type QueryRow as SdkQueryRow,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";

import { OWNER_APP_ID, type SchemaDefinition } from "./schema.ts";
import { queryKnownKeys } from "./key-batch.ts";

export type QueryRow = {
  fields: Record<string, unknown>;
  key: { hash: string | null; range: string | null };
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

export type LoadSchemasResult = {
  availableSchemasLoaded: number;
  schemasLoadedToDb: number;
  failedSchemas: string[];
};

export type LastDbClient = {
  autoIdentity(): Promise<{ userHash: string }>;
  /**
   * Live Mini user_hash from GET /api/status. Falls back to auto-identity.
   * Returns undefined when the node has no identity yet.
   */
  nodeUserHash(): Promise<string | undefined>;
  declareAppSchema(
    appId: string,
    schema: SchemaDefinition,
  ): Promise<{ canonical: string; schemaName: string }>;
  /** Fail closed if any required schema identity is missing on Schema Service. */
  verifyDistributionReady(
    appId: string,
    schemaIdentities: string[],
  ): Promise<VerifyDistributionReadyResult>;
  /** Load only the requested published schemas into this Mini. */
  loadSchemas?(schemaNames: string[]): Promise<LoadSchemasResult>;
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
  queryByKeys(opts: { schemaHash: string; keyHashes: string[]; fields: string[] }): Promise<QueryRow[]>;
  queryAll(opts: { schemaHash: string; fields: string[]; allowFullScan?: boolean }): Promise<QueryRow[]>;
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
const DEFAULT_NODE_URL = "http://127.0.0.1";
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
  for (const name of ["ORG_SOCKET_PATH", "LASTDB_SOCKET_PATH", "FOLDDB_SOCKET_PATH"]) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  const lastdbHome = process.env.LASTDB_HOME ?? join(homedir(), ".lastdb");
  return join(lastdbHome, "data", SOCKET_FILE_NAME);
}

export function newLastDbClient(opts: {
  nodeUrl?: string;
  socketPath?: string;
  /** Optional DB locator sent on data-path requests. */
  dbLocator?: string;
  fetchImpl?: FetchLike;
} = {}): LastDbClient {
  const socketPath = resolveSocketPath(opts.socketPath);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const defaultHeaders: Record<string, string> = { [LASTDB_CLIENT_HEADER]: OWNER_APP_ID };
  if (opts.dbLocator) defaultHeaders["X-LastDB-Db"] = opts.dbLocator;
  const sdkTransport: SdkTransport = udsTransport(socketPath, defaultHeaders);
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
      throw mapSdkError(err, socketPath);
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
    let requestBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    const url = `http://localhost${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        unix: socketPath,
      });
    } catch (err) {
      throw new OrgError(
        "service_unreachable",
        `LastDB is not reachable over its Unix socket ${socketPath}.`,
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

  const autoIdentityFn = async (): Promise<{ userHash: string }> => {
    const body = await callJson("/api/system/auto-identity", "GET");
    const userHash = objectString(body, "user_hash");
    if (!userHash) {
      throw new OrgError(
        "auto_identity_bad_response",
        "LastDB auto-identity response did not include user_hash.",
      );
    }
    return { userHash };
  };

  return {
    autoIdentity: autoIdentityFn,
    async nodeUserHash() {
      try {
        const body = await callJson("/api/status", "GET");
        return userHashFromStatusBody(body);
      } catch {
        return undefined;
      }
    },
    async declareAppSchema(appId, schema) {
      const body = await callJson("/api/apps/declare-schema", "POST", {
        app_id: appId,
        schema,
      });
      const canonical = declareCanonical(body);
      const schemaName = declareSchemaName(body, appId, schema.name);
      if (!canonical) {
        throw new OrgError(
          "schema_declare_bad_response",
          `LastDB did not return a canonical hash for ${appId}/${schema.name}.`,
        );
      }
      // Fail closed when Mini reports the catalog identity is not bindable yet.
      if (
        typeof body === "object" &&
        body !== null &&
        "bind_eligible" in body &&
        (body as { bind_eligible?: unknown }).bind_eligible === false
      ) {
        throw new OrgError(
          "schema_not_bind_eligible",
          `LastDB refused to bind ${appId}/${schema.name} (bind_eligible=false; canonical=${canonical}).`,
        );
      }
      return { canonical, schemaName };
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
    async loadSchemas(schemaNames) {
      const requested = [...new Set(schemaNames.map((name) => name.trim()).filter(Boolean))];
      if (requested.length === 0) {
        return { availableSchemasLoaded: 0, schemasLoadedToDb: 0, failedSchemas: [] };
      }
      const body = await callJson("/api/schemas/load", "POST", { schemas: requested });
      const data = unwrapData(body);
      return {
        availableSchemasLoaded: objectNumber(data, "available_schemas_loaded"),
        schemasLoadedToDb: objectNumber(data, "schemas_loaded_to_db"),
        failedSchemas: objectStringArray(data, "failed_schemas"),
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
    async queryByKeys({ schemaHash, keyHashes, fields }) {
      return queryKnownKeys(keyHashes, async (batch) => {
        const result = await sdkDataPath((client) => client.query(schemaHash, {
          fields, filter: { HashRangeKeys: batch.map((hash) => [hash, ""]) }, limit: batch.length, offset: 0,
        }));
        return result.rows.map(sdkRowToQueryRow);
      });
    },
    async queryAll({ schemaHash, fields, allowFullScan }) {
      const result = await sdkDataPath((client) =>
        client.queryAll(
          schemaHash,
          { fields },
          {
            pageSize: QUERY_PAGE_SIZE,
            ...(allowFullScan === true ? { allowFullScan: true } : {}),
          } as { pageSize: number; allowFullScan?: boolean },
        ),
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

function mapSdkError(err: unknown, socketPath: string): Error {
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
      `LastDB is not reachable over its Unix socket ${socketPath}.`,
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

export function isLoopbackNodeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
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

function objectNumber(value: Record<string, unknown>, key: string): number {
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function objectStringArray(value: Record<string, unknown>, key: string): string[] {
  const raw = value[key];
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
}

/** Pull Mini user_hash from GET /api/status (top-level or nested under status). */
function userHashFromStatusBody(body: unknown): string | undefined {
  const top = objectString(body, "user_hash");
  if (top) return top;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const nested = (body as Record<string, unknown>).status;
  const fromNested = objectString(nested, "user_hash");
  return fromNested || undefined;
}

function unwrapData(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const rec = body as Record<string, unknown>;
  if (typeof rec.data === "object" && rec.data !== null && !Array.isArray(rec.data)) {
    return rec.data as Record<string, unknown>;
  }
  return rec;
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
