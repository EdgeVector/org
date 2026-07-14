#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { defaultConfigPath, readConfig, writeConfig, type Config } from "./config.ts";
import { generateOrgKeys } from "./crypto.ts";
import { buildInvite, parseInvite, serializeInvite } from "./invite.ts";
import { defaultNodeUrl, newLastDbClient, resolveSocketPath } from "./lastdb.ts";
import { newLastSecretsCli, type LastSecretsCli } from "./lastsecrets.ts";
import {
  ALL_SCHEMAS,
  OWNER_APP_ID,
  assertSlug,
  e2eKeyRef,
  e2eSecretSlug,
  organizationSchema,
  orgDatabaseSchema,
} from "./schema.ts";
import {
  formatDb,
  formatOrg,
  getOrgDatabase,
  getOrganization,
  listOrgDatabases,
  listOrganizations,
  putOrgDatabase,
  putOrganization,
} from "./storage.ts";

type Io = {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
  stdinText: () => Promise<string>;
};

const defaultIo: Io = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdinText: () => Bun.stdin.text(),
};

export type CliDeps = {
  lastSecrets?: LastSecretsCli;
  newClient?: typeof newLastDbClient;
};

export async function run(
  argv = process.argv.slice(2),
  io: Io = defaultIo,
  deps: CliDeps = {},
): Promise<number> {
  const [command, arg, ...rest] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout.write(usage());
      return 0;
    }

    if (command === "schema-json") {
      io.stdout.write(`${JSON.stringify(ALL_SCHEMAS.map((s) => s.schema), null, 2)}\n`);
      return 0;
    }

    if (command === "init") {
      return await cmdInit(parseOptions([arg, ...rest].filter(Boolean) as string[]), io, deps);
    }

    if (command === "create" && arg) {
      return await cmdCreate(arg, parseOptions(rest), io, deps);
    }

    if (command === "list") {
      return await cmdList(parseOptions([arg, ...rest].filter(Boolean) as string[]), io, deps);
    }

    if (command === "show" && arg) {
      return await cmdShow(arg, parseOptions(rest), io, deps);
    }

    if (command === "invite" && arg) {
      return await cmdInvite(arg, parseOptions(rest), io, deps);
    }

    if (command === "join") {
      return await cmdJoin(parseOptions([arg, ...rest].filter(Boolean) as string[]), io, deps);
    }

    if (command === "db") {
      return await cmdDb(arg, rest, io, deps);
    }

    io.stderr.write(`unknown command: ${command ?? "(none)"}\n`);
    io.stderr.write(usage());
    return 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

async function cmdInit(
  opts: Options,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const nodeUrl = opts.nodeUrl ?? defaultNodeUrl();
  const socketPath = resolveSocketPath(opts.socketPath);
  const newClient = deps.newClient ?? newLastDbClient;
  const preflight = newClient({ nodeUrl, socketPath });
  const { userHash } = await preflight.autoIdentity();
  const client = newClient({ nodeUrl, socketPath, userHash });

  const schemas: Config["schemas"] = {
    Organization: { schemaHash: "", schemaName: "org/Organization" },
    OrgDatabase: { schemaHash: "", schemaName: "org/OrgDatabase" },
  };

  for (const def of ALL_SCHEMAS) {
    const { canonical, schemaName } = await client.declareAppSchema(OWNER_APP_ID, def.schema);
    const kind = def.schema.name as keyof Config["schemas"];
    schemas[kind] = { schemaHash: canonical, schemaName };
    io.stdout.write(`declared ${schemaName} hash=${canonical}\n`);
  }

  const configPath = opts.config ?? defaultConfigPath();
  writeConfig(
    {
      configVersion: 1,
      nodeUrl,
      userHash,
      schemas,
      nodeSocketPath: socketPath,
    },
    configPath,
  );
  io.stdout.write(`initialized org config at ${configPath}\n`);
  io.stdout.write(
    `solo mode: schemas are local-only on this node. Shared org DBs cohabit your LastDB node; E2E keys live in LastSecrets.\n`,
  );
  return 0;
}

async function cmdCreate(
  slug: string,
  opts: Options,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  assertSlug(slug, "org slug");
  const name = opts.name ?? slug;
  const { client, config } = await loadSession(opts, deps);
  const secrets = deps.lastSecrets ?? newLastSecretsCli();

  const existing = await client
    .queryByKey({
      schemaHash: config.schemas.Organization.schemaHash,
      keyHash: slug,
      fields: organizationSchema.schema.fields,
    })
    .catch(() => null);
  if (existing) {
    throw new Error(`organization already exists: ${slug}`);
  }

  const keys = generateOrgKeys();
  const secretSlug = e2eSecretSlug(slug);
  secrets.put({
    slug: secretSlug,
    value: keys.e2eKey,
    label: `Org E2E key for ${name}`,
    provider: "org",
    purpose: "org-e2e-key",
    environment: "local",
  });

  // Also store the org private key for future invite signing / ownership proofs.
  secrets.put({
    slug: `org-${slug}-private`,
    value: keys.orgPrivateKey,
    label: `Org private key for ${name}`,
    provider: "org",
    purpose: "org-signing-key",
    environment: "local",
  });

  const org = await putOrganization(client, config, {
    slug,
    name,
    orgHash: keys.orgHash,
    orgPublicKey: keys.orgPublicKey,
    e2eKeyRef: e2eKeyRef(slug),
    role: "owner",
    createdBy: config.userHash,
  });

  io.stdout.write(`created organization ${formatOrg(org)}\n`);
  io.stdout.write(`e2e key stored as lastsecrets://${secretSlug}\n`);
  io.stdout.write(
    `tip: create a shared db with \`org db create ${slug} <db-slug> --name "..."\`\n`,
  );
  return 0;
}

async function cmdList(opts: Options, io: Io, deps: CliDeps): Promise<number> {
  const { client, config } = await loadSession(opts, deps);
  const orgs = await listOrganizations(client, config);
  if (orgs.length === 0) {
    io.stdout.write("(no organizations)\n");
    return 0;
  }
  for (const org of orgs) {
    io.stdout.write(`${formatOrg(org)}\n`);
  }
  return 0;
}

async function cmdShow(
  slug: string,
  opts: Options,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const { client, config } = await loadSession(opts, deps);
  const org = await getOrganization(client, config, slug);
  io.stdout.write(`${formatOrg(org)}\n`);
  const dbs = await listOrgDatabases(client, config, slug);
  if (dbs.length === 0) {
    io.stdout.write("databases: (none)\n");
  } else {
    io.stdout.write(`databases (${dbs.length}):\n`);
    for (const db of dbs) {
      io.stdout.write(`  ${formatDb(db)}\n`);
    }
  }
  return 0;
}

async function cmdInvite(
  slug: string,
  opts: Options,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const { client, config } = await loadSession(opts, deps);
  const secrets = deps.lastSecrets ?? newLastSecretsCli();
  const org = await getOrganization(client, config, slug);
  const e2eKey = secrets.get(e2eSecretSlug(slug));
  const invite = buildInvite({
    slug: org.slug,
    name: org.name,
    orgHash: org.orgHash,
    orgPublicKey: org.orgPublicKey,
    e2eKey,
    createdBy: config.userHash,
  });
  const body = serializeInvite(invite);
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true, mode: 0o700 });
    writeFileSync(opts.out, body, { encoding: "utf8", mode: 0o600 });
    io.stdout.write(`wrote invite to ${opts.out} (contains raw e2e key — treat as secret)\n`);
  } else {
    io.stdout.write(body);
    io.stderr.write(
      "warning: invite printed to stdout and contains the raw e2e key; prefer --out <file>\n",
    );
  }
  return 0;
}

async function cmdJoin(opts: Options, io: Io, deps: CliDeps): Promise<number> {
  if (!opts.from) {
    throw new Error("join requires --from <invite.json>");
  }
  const raw = JSON.parse(readFileSync(opts.from, "utf8"));
  const invite = parseInvite(raw);
  const { client, config } = await loadSession(opts, deps);
  const secrets = deps.lastSecrets ?? newLastSecretsCli();

  const secretSlug = e2eSecretSlug(invite.slug);
  secrets.put({
    slug: secretSlug,
    value: invite.e2e_key,
    label: `Org E2E key for ${invite.name}`,
    provider: "org",
    purpose: "org-e2e-key",
    environment: "local",
  });

  const org = await putOrganization(client, config, {
    slug: invite.slug,
    name: invite.name,
    orgHash: invite.org_hash,
    orgPublicKey: invite.org_public_key,
    e2eKeyRef: e2eKeyRef(invite.slug),
    role: "member",
    createdBy: invite.created_by,
  });

  io.stdout.write(`joined organization ${formatOrg(org)}\n`);
  io.stdout.write(`e2e key stored as lastsecrets://${secretSlug}\n`);
  return 0;
}

async function cmdDb(
  sub: string | undefined,
  rest: string[],
  io: Io,
  deps: CliDeps,
): Promise<number> {
  if (!sub || sub === "help") {
    io.stdout.write(dbUsage());
    return 0;
  }

  if (sub === "create") {
    const [orgSlug, dbSlug, ...more] = rest;
    if (!orgSlug || !dbSlug) {
      throw new Error("usage: org db create <org-slug> <db-slug> [--name N] [--description D]");
    }
    const opts = parseOptions(more);
    const { client, config } = await loadSession(opts, deps);
    const org = await getOrganization(client, config, orgSlug);
    const name = opts.name ?? dbSlug;
    const description = opts.description ?? "";
    const db = await putOrgDatabase(client, config, {
      orgSlug: org.slug,
      dbSlug,
      name,
      description,
      orgHash: org.orgHash,
      createdBy: config.userHash,
    });
    io.stdout.write(`created shared db ${formatDb(db)}\n`);
    io.stdout.write(
      `cohabits this LastDB node under org_hash=${org.orgHash}; key material is lastsecrets only\n`,
    );
    return 0;
  }

  if (sub === "list") {
    const [orgSlug, ...more] = rest;
    const opts = parseOptions(more);
    const { client, config } = await loadSession(opts, deps);
    const dbs = await listOrgDatabases(client, config, orgSlug);
    if (dbs.length === 0) {
      io.stdout.write("(no shared databases)\n");
      return 0;
    }
    for (const db of dbs) {
      io.stdout.write(`${formatDb(db)}\n`);
    }
    return 0;
  }

  if (sub === "show") {
    const [orgSlug, dbSlug, ...more] = rest;
    if (!orgSlug || !dbSlug) {
      throw new Error("usage: org db show <org-slug> <db-slug>");
    }
    const opts = parseOptions(more);
    const { client, config } = await loadSession(opts, deps);
    const db = await getOrgDatabase(client, config, orgSlug, dbSlug);
    io.stdout.write(`${formatDb(db)}\n`);
    return 0;
  }

  throw new Error(`unknown db subcommand: ${sub}\n${dbUsage()}`);
}

async function loadSession(
  opts: Options,
  deps: CliDeps,
): Promise<{ client: ReturnType<typeof newLastDbClient>; config: Config }> {
  const configPath = opts.config ?? defaultConfigPath();
  const config = readConfig(configPath);
  const nodeUrl = opts.nodeUrl ?? config.nodeUrl;
  const socketPath = resolveSocketPath(opts.socketPath ?? config.nodeSocketPath);
  const newClient = deps.newClient ?? newLastDbClient;
  const client = newClient({ nodeUrl, socketPath, userHash: config.userHash });
  return { client, config };
}

type Options = {
  config?: string;
  nodeUrl?: string;
  socketPath?: string;
  name?: string;
  description?: string;
  out?: string;
  from?: string;
};

function parseOptions(args: string[]): Options {
  const opts: Options = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--config":
        opts.config = next();
        break;
      case "--node-url":
        opts.nodeUrl = next();
        break;
      case "--socket":
      case "--socket-path":
        opts.socketPath = next();
        break;
      case "--name":
        opts.name = next();
        break;
      case "--description":
        opts.description = next();
        break;
      case "--out":
        opts.out = next();
        break;
      case "--from":
        opts.from = next();
        break;
      case undefined:
        break;
      default:
        if (a.startsWith("-")) {
          throw new Error(`unknown option: ${a}`);
        }
        break;
    }
  }
  return opts;
}

function usage(): string {
  return `org — shared organization databases cohabiting your LastDB node

Uses LastSecrets for org E2E keys (lastsecrets://org-<slug>-e2e). Org metadata
and named shared DBs live as org/* schemas on the same Mini node as brain/kanban.

Commands:
  org init
  org create <slug> --name "My Org"
  org list
  org show <slug>
  org invite <slug> --out invite.json
  org join --from invite.json
  org db create <org-slug> <db-slug> [--name N] [--description D]
  org db list [org-slug]
  org db show <org-slug> <db-slug>
  org schema-json
  org help

Options:
  --config PATH       config file (default ~/.org/config.json)
  --socket PATH       LastDB owner socket
  --node-url URL      legacy TCP fallback (prefer socket)
  --name STR          human name
  --description STR   db description
  --out PATH          write invite file
  --from PATH         read invite file
`;
}

function dbUsage(): string {
  return `org db subcommands:
  org db create <org-slug> <db-slug> [--name N] [--description D]
  org db list [org-slug]
  org db show <org-slug> <db-slug>
`;
}

// silence unused import when tree-shaken poorly
void orgDatabaseSchema;

if (import.meta.main) {
  const code = await run();
  process.exit(code);
}
