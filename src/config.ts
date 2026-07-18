import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SchemaKind } from "./schema.ts";

export const CONFIG_VERSION = 1;

export type SchemaBinding = {
  schemaHash: string;
  schemaName: string;
};

export type Config = {
  configVersion: number;
  nodeUrl: string;
  userHash: string;
  nodeSocketPath?: string;
  schemas: Partial<Record<SchemaKind, SchemaBinding>> & {
    Organization: SchemaBinding;
    OrgDatabase: SchemaBinding;
  };
};

export class ConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export function defaultConfigPath(): string {
  const override = process.env.ORG_CONFIG;
  if (override && override.length > 0) return override;
  return join(homedir(), ".org", "config.json");
}

export function readConfig(path = defaultConfigPath()): Config {
  if (!existsSync(path)) {
    throw new ConfigError(
      "config_missing",
      `Config not found at ${path}. Run \`org init\` first.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(
      "config_invalid",
      `Config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return assertConfigShape(path, parsed);
}

export function writeConfig(config: Config, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function schemaBinding(config: Config, kind: SchemaKind): SchemaBinding {
  const binding = config.schemas[kind];
  if (!binding?.schemaHash && !binding?.schemaName) {
    throw new ConfigError(
      "config_invalid",
      `Config is missing schema binding for ${kind}. Re-run \`org init\`.`,
    );
  }
  return binding!;
}

function assertConfigShape(path: string, raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config_invalid", `Config at ${path} must be an object.`);
  }
  const r = raw as Record<string, unknown>;
  for (const key of ["nodeUrl", "userHash"] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new ConfigError(
        "config_invalid",
        `Config at ${path} is missing non-empty field "${key}".`,
      );
    }
  }
  if (typeof r.schemas !== "object" || r.schemas === null || Array.isArray(r.schemas)) {
    throw new ConfigError(
      "config_invalid",
      `Config at ${path} is missing schemas bindings. Re-run \`org init\`.`,
    );
  }
  const schemasRaw = r.schemas as Record<string, unknown>;
  const schemas = {} as Config["schemas"];
  const OPTIONAL_KINDS: SchemaKind[] = [
    "PathBinding",
    "OrgIndex",
    "OrgDbIndex",
    "PathBindingIndex",
  ];
  for (const kind of [
    "Organization",
    "OrgDatabase",
    "PathBinding",
    "OrgIndex",
    "OrgDbIndex",
    "PathBindingIndex",
  ] as const) {
    const entry = schemasRaw[kind];
    if (OPTIONAL_KINDS.includes(kind) && (entry === undefined || entry === null)) {
      // Optional until re-init; scan-replacement index reads fall back to
      // empty results, and index-only writes ask to re-run org init.
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(
        "config_invalid",
        `Config at ${path} is missing schemas.${kind}. Re-run \`org init\`.`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.schemaHash !== "string" || e.schemaHash.length === 0) {
      throw new ConfigError(
        "config_invalid",
        `Config at ${path} is missing schemas.${kind}.schemaHash.`,
      );
    }
    schemas[kind] = {
      schemaHash: e.schemaHash,
      schemaName:
        typeof e.schemaName === "string" && e.schemaName.length > 0
          ? e.schemaName
          : `org/${kind}`,
    };
  }

  const config: Config = {
    configVersion: CONFIG_VERSION,
    nodeUrl: r.nodeUrl as string,
    userHash: r.userHash as string,
    schemas,
  };
  if (typeof r.nodeSocketPath === "string" && r.nodeSocketPath.length > 0) {
    config.nodeSocketPath = r.nodeSocketPath;
  }
  return config;
}
