#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";

import { defaultConfigPath, readConfig, writeConfig, type Config } from "./config.ts";
import { generateOrgKeys } from "./crypto.ts";
import {
  formatDbLocator,
  LASTDB_DB_ENV,
  parseDbLocator,
  personalDb,
  type DbHandle,
} from "./db-handle.ts";
import {
  buildAgentInstructions,
  buildClaimAgentInstructions,
  buildInvite,
  newInviteClaimId,
  parseInvite,
  serializeInvite,
} from "./invite.ts";
import { newInviteTransport, type InviteTransport } from "./invite-transport.ts";
import { defaultNodeUrl, newLastDbClient, resolveSocketPath } from "./lastdb.ts";
import { newLastSecretsCli, type LastSecretsCli } from "./lastsecrets.ts";
import { ResolveError, resolveWriteTarget } from "./resolve.ts";
import {
  ALL_SCHEMAS,
  OWNER_APP_ID,
  assertSlug,
  e2eKeyRef,
  e2eSecretSlug,
  organizationSchema,
} from "./schema.ts";
import {
  clearSessionPin,
  defaultSessionPath,
  readSessionPin,
  writeSessionPin,
} from "./session.ts";
import {
  formatDb,
  formatOrg,
  getOrgDatabase,
  getOrganization,
  listOrgDatabases,
  listOrganizations,
  listPathBindings,
  putOrganization,
  putOrgDatabase,
  putPathBinding,
  removePathBinding,
  toResolveBindings,
} from "./storage.ts";
import { isMetaCommand, usageWrapperLine, wrapApp } from "./wrapper.ts";

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
  inviteTransport?: InviteTransport;
  newClient?: typeof newLastDbClient;
  /** Override wrapApp for tests. */
  wrapApp?: typeof wrapApp;
  /** Override cwd for resolve (tests). */
  cwd?: string;
};

export async function run(
  argv = process.argv.slice(2),
  io: Io = defaultIo,
  deps: CliDeps = {},
): Promise<number> {
  try {
    // Global resolve flags may appear before the verb: org --db X kanban list
    const { resolveOpts, rest } = peelResolveFlags(argv);
    const [command, arg, ...tail] = rest;

    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout.write(usage());
      return 0;
    }

    if (command === "schema-json") {
      io.stdout.write(`${JSON.stringify(ALL_SCHEMAS.map((s) => s.schema), null, 2)}\n`);
      return 0;
    }

    if (command === "init") {
      return await cmdInit(parseOptions([arg, ...tail].filter(Boolean) as string[]), io, deps);
    }

    if (command === "create" && arg) {
      return await cmdCreate(arg, parseOptions(tail), io, deps);
    }

    if (command === "list") {
      return await cmdList(parseOptions([arg, ...tail].filter(Boolean) as string[]), io, deps);
    }

    if (command === "show" && arg) {
      return await cmdShow(arg, parseOptions(tail), io, deps);
    }

    if (command === "invite" && arg) {
      return await cmdInvite(arg, parseOptions(tail), io, deps);
    }

    if (command === "join") {
      return await cmdJoin(parseOptions([arg, ...tail].filter(Boolean) as string[]), io, deps);
    }

    if (command === "db") {
      return await cmdDb(arg, tail, io, deps);
    }

    if (command === "bind") {
      return await cmdBind(arg, tail, io, deps);
    }

    if (command === "unbind") {
      return await cmdUnbind(parseOptions([arg, ...tail].filter(Boolean) as string[]), io, deps);
    }

    if (command === "bindings") {
      return await cmdBindings(parseOptions([arg, ...tail].filter(Boolean) as string[]), io, deps);
    }

    if (command === "resolve") {
      return await cmdResolve(resolveOpts, parseOptions([arg, ...tail].filter(Boolean) as string[]), io, deps);
    }

    if (command === "use" && arg) {
      return cmdUse(arg, io);
    }

    if (command === "unuse") {
      clearSessionPin();
      io.stdout.write("cleared session pin\n");
      return 0;
    }

    if (command === "current") {
      return await cmdCurrent(resolveOpts, io, deps);
    }

    // Explicit wrapper: org run kanban …
    if (command === "run") {
      if (!arg) {
        throw new Error("usage: org run <app> [args…]");
      }
      return await cmdWrap(arg, tail, resolveOpts, io, deps);
    }

    // Implicit wrapper: org kanban … (anything that is not a meta command)
    if (!isMetaCommand(command)) {
      return await cmdWrap(command, [arg, ...tail].filter((x): x is string => x !== undefined), resolveOpts, io, deps);
    }

    io.stderr.write(`unknown command: ${command}\n`);
    io.stderr.write(usage());
    return 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr.write(`${message}\n`);
    if (err instanceof ResolveError && err.code === "ambiguous") {
      return 2;
    }
    return 1;
  }
}

async function cmdInit(opts: Options, io: Io, deps: CliDeps): Promise<number> {
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
    `solo mode: schemas local-only. Bind folders with \`org bind\`, then \`org kanban …\` to run apps in the resolved DB.\n`,
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

  const orgSchemaId =
    config.schemas.Organization.schemaName?.includes("/")
      ? config.schemas.Organization.schemaName
      : config.schemas.Organization.schemaHash;
  const existing = await client
    .queryByKey({
      schemaHash: orgSchemaId,
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
    defaultDb: opts.defaultDb ?? "",
    createdBy: config.userHash,
  });

  io.stdout.write(`created organization ${formatOrg(org)}\n`);
  io.stdout.write(`e2e key stored as lastsecrets://${secretSlug}\n`);
  io.stdout.write(
    `tip: org db create ${slug} company && org bind ${slug} company --root ~/code/…\n`,
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
  if (org.defaultDb) io.stdout.write(`default_db=${org.defaultDb}\n`);
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
  if (opts.to && opts.out) {
    throw new Error("invite --to cannot be combined with --out; use one delivery path");
  }

  if (opts.to) {
    const transport = deps.inviteTransport ?? newInviteTransport();
    const claim = await transport.deliver({
      recipientIdentity: opts.to,
      claimId: newInviteClaimId(),
      invite,
    });
    if (opts.agent) {
      io.stdout.write(buildClaimAgentInstructions({ invite, claim }));
    } else {
      const token = claim.sealed_blob.startsWith("org-claim-")
        ? claim.sealed_blob
        : claim.claim_id;
      io.stdout.write(`delivered sealed org invite for ${opts.to}\n`);
      io.stdout.write(`claim_id=${claim.claim_id}\n`);
      io.stdout.write(`claim_token=${token}\n`);
      io.stdout.write(`friend runs: org join --claim '<claim_token>'\n`);
      io.stderr.write(
        "warning: claim_token is a secret bearer — send only to the intended recipient\n",
      );
    }
    return 0;
  }

  // File path: --agent implies writing a secret invite file. Default path when
  // --out is omitted so the inviter always has something concrete to transfer.
  const outPath =
    opts.out ??
    (opts.agent ? pathResolve(process.cwd(), `org-${invite.slug}-invite.json`) : undefined);

  const body = serializeInvite(invite);
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
    writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 });
    const status = `wrote invite to ${outPath} (contains raw e2e key — treat as secret)\n`;
    if (opts.agent) io.stderr.write(status);
    else io.stdout.write(status);
  }
  if (opts.agent) {
    io.stdout.write(buildAgentInstructions({ invite, invitePath: outPath }));
  } else if (!outPath) {
    io.stdout.write(body);
    io.stderr.write(
      "warning: invite printed to stdout and contains the raw e2e key; prefer --out <file> or --agent\n",
    );
  }
  return 0;
}

async function cmdJoin(opts: Options, io: Io, deps: CliDeps): Promise<number> {
  if (!opts.from && !opts.claim) {
    throw new Error("join requires --from <invite.json> or --claim <id>");
  }
  if (opts.from && opts.claim) {
    throw new Error("join accepts only one of --from or --claim");
  }
  const invite = opts.claim
    ? parseInvite(
        await (deps.inviteTransport ?? newInviteTransport()).claim({
          claimId: opts.claim,
        }),
      )
    : parseInvite(JSON.parse(readFileSync(opts.from!, "utf8")));
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
    // First db becomes default_db when unset
    if (!org.defaultDb) {
      await putOrganization(client, config, {
        slug: org.slug,
        name: org.name,
        orgHash: org.orgHash,
        orgPublicKey: org.orgPublicKey,
        e2eKeyRef: org.e2eKeyRef,
        role: org.role,
        defaultDb: dbSlug,
        createdBy: org.createdBy,
      });
      io.stdout.write(`set default_db=${dbSlug} for org ${org.slug}\n`);
    }
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

async function cmdBind(
  orgSlug: string | undefined,
  rest: string[],
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const [dbSlug, ...more] = rest;
  if (!orgSlug || !dbSlug) {
    throw new Error("usage: org bind <org-slug> <db-slug> --root PATH");
  }
  const opts = parseOptions(more);
  if (!opts.root) {
    throw new Error("bind requires --root PATH");
  }
  const { client, config } = await loadSession(opts, deps);
  if (!config.schemas.PathBinding) {
    throw new Error("PathBinding schema not initialized. Re-run `org init`.");
  }
  const org = await getOrganization(client, config, orgSlug);
  // Ensure named db exists (create lightly if missing)
  try {
    await getOrgDatabase(client, config, orgSlug, dbSlug);
  } catch {
    await putOrgDatabase(client, config, {
      orgSlug,
      dbSlug,
      name: dbSlug,
      description: "auto-created on bind",
      orgHash: org.orgHash,
      createdBy: config.userHash,
    });
    io.stdout.write(`created missing db ${orgSlug}/${dbSlug}\n`);
  }

  const root = pathResolve(opts.root);
  const binding = await putPathBinding(client, config, {
    root,
    orgSlug: org.slug,
    dbSlug,
    orgHash: org.orgHash,
  });
  io.stdout.write(
    `bound root=${binding.root} → lastdb://org/${binding.orgSlug}/${binding.dbSlug}\n`,
  );
  return 0;
}

async function cmdUnbind(opts: Options, io: Io, deps: CliDeps): Promise<number> {
  if (!opts.root) {
    throw new Error("usage: org unbind --root PATH");
  }
  const { client, config } = await loadSession(opts, deps);
  if (!config.schemas.PathBinding) {
    throw new Error("PathBinding schema not initialized. Re-run `org init`.");
  }
  const ok = await removePathBinding(client, config, pathResolve(opts.root));
  if (!ok) {
    io.stdout.write(`no binding for ${pathResolve(opts.root)}\n`);
    return 1;
  }
  io.stdout.write(`unbound root=${pathResolve(opts.root)}\n`);
  return 0;
}

async function cmdBindings(opts: Options, io: Io, deps: CliDeps): Promise<number> {
  const { client, config } = await loadSession(opts, deps);
  const list = await listPathBindings(client, config);
  const active = list.filter((b) => b.orgSlug);
  if (active.length === 0) {
    io.stdout.write("(no path bindings)\n");
    return 0;
  }
  for (const b of active) {
    io.stdout.write(
      `root=${b.root} → lastdb://org/${b.orgSlug}/${b.dbSlug} org_hash=${b.orgHash}\n`,
    );
  }
  return 0;
}

async function cmdResolve(
  resolveOpts: ResolveFlags,
  opts: Options,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const handle = await resolveHandle(resolveOpts, opts, deps);
  if (opts.json) {
    io.stdout.write(`${JSON.stringify(handle, null, 2)}\n`);
  } else {
    io.stdout.write(`${formatDbLocator(handle)}\n`);
  }
  return 0;
}

function cmdUse(locator: string, io: Io): number {
  if (locator === "personal" || locator === "clear" || locator === "none") {
    writeSessionPin(personalDb());
    io.stdout.write(`session pin → ${formatDbLocator(personalDb())}\n`);
    return 0;
  }
  const handle = parseDbLocator(locator);
  writeSessionPin(handle);
  io.stdout.write(`session pin → ${formatDbLocator(handle)} (saved ${defaultSessionPath()})\n`);
  return 0;
}

async function cmdCurrent(
  resolveOpts: ResolveFlags,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const pin = readSessionPin();
  io.stdout.write(`pin=${pin ? formatDbLocator(pin) : "(none)"}\n`);
  try {
    const handle = await resolveHandle(resolveOpts, {}, deps);
    io.stdout.write(`resolved=${formatDbLocator(handle)}\n`);
  } catch (err) {
    io.stdout.write(`resolved=(error: ${err instanceof Error ? err.message : String(err)})\n`);
  }
  return 0;
}

async function cmdWrap(
  app: string,
  appArgs: string[],
  resolveOpts: ResolveFlags,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const handle = await resolveHandle(resolveOpts, {}, deps);
  io.stderr.write(`org: ${formatDbLocator(handle)} → ${app}\n`);
  const wrap = deps.wrapApp ?? wrapApp;
  const result = wrap(app, appArgs, handle);
  if (result.missing) {
    io.stderr.write(
      `org: app ${JSON.stringify(app)} not found on PATH (install/link it, or use a full path)\n`,
    );
    return 127;
  }
  return result.status;
}

async function resolveHandle(
  resolveOpts: ResolveFlags,
  opts: Options,
  deps: CliDeps,
): Promise<DbHandle> {
  const cwd = resolveOpts.cwd ?? opts.cwd ?? deps.cwd ?? process.cwd();
  let bindings = [] as ReturnType<typeof toResolveBindings>;
  try {
    const { client, config } = await loadSession(
      { config: resolveOpts.config ?? opts.config },
      deps,
    );
    if (config.schemas.PathBinding) {
      const stored = await listPathBindings(client, config);
      bindings = toResolveBindings(stored);
    }
  } catch {
    // Uninitialized org still allows personal / explicit / pin
    bindings = [];
  }

  const pin = readSessionPin();
  return resolveWriteTarget({
    cwd,
    explicit:
      resolveOpts.db ??
      (resolveOpts.personal ? "lastdb://personal" : undefined),
    sessionPin: pin ? formatDbLocator(pin) : undefined,
    bindings,
    defaultPersonal: true,
  });
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
  agent?: boolean;
  from?: string;
  to?: string;
  claim?: string;
  root?: string;
  cwd?: string;
  defaultDb?: string;
  json?: boolean;
};

type ResolveFlags = {
  db?: string;
  personal?: boolean;
  cwd?: string;
  config?: string;
};

/** Peel org-level resolve flags from anywhere before the first non-flag verb. */
function peelResolveFlags(argv: string[]): { resolveOpts: ResolveFlags; rest: string[] } {
  const resolveOpts: ResolveFlags = {};
  const rest: string[] = [];
  let i = 0;
  // Only peel leading global flags; once we hit a non-flag or known pattern stop peeling
  // actually peel all leading --db/--cwd/--personal/--config then leave the rest
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--db" && argv[i + 1]) {
      resolveOpts.db = argv[++i];
      i++;
      continue;
    }
    if (a.startsWith("--db=")) {
      resolveOpts.db = a.slice(5);
      i++;
      continue;
    }
    if (a === "--personal") {
      resolveOpts.personal = true;
      i++;
      continue;
    }
    if ((a === "--cwd" || a === "--at") && argv[i + 1]) {
      resolveOpts.cwd = argv[++i];
      i++;
      continue;
    }
    if (a === "--config" && argv[i + 1] && rest.length === 0) {
      // only peel --config when still in global prefix
      resolveOpts.config = argv[++i];
      i++;
      continue;
    }
    break;
  }
  rest.push(...argv.slice(i));
  return { resolveOpts, rest };
}

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
      case "--agent":
        opts.agent = true;
        break;
      case "--from":
        opts.from = next();
        break;
      case "--to":
        opts.to = next();
        break;
      case "--claim":
        opts.claim = next();
        break;
      case "--root":
        opts.root = next();
        break;
      case "--cwd":
      case "--at":
        opts.cwd = next();
        break;
      case "--default-db":
        opts.defaultDb = next();
        break;
      case "--json":
        opts.json = true;
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
  return `org — shared org DBs cohabiting LastDB; context wrapper for apps

Uses LastSecrets for org E2E keys. Metadata lives as org/* on the Mini node.

Setup:
  org init
  org create <slug> --name "My Org"
  org db create <slug> company
  org bind <slug> company --root ~/code/my-company

Context:
  org resolve [--cwd PATH] [--db LOCATOR] [--json]
  org use <locator>          session pin (e.g. edgevector/company or personal)
  org unuse
  org current
  org bindings
  org unbind --root PATH

${usageWrapperLine()}
  # examples:
  #   cd ~/code/edgevector && org kanban list
  #   org --db personal brain ask "…"
  #   org run kanban add my-card --title "…"

Other:
  org list | show <slug>
  org invite <slug> --out invite.json          # secret file (transfer OOB)
  org invite <slug> --agent [--out path]       # pasteable agent instructions + secret file
  org invite <slug> --to identity [--agent]    # sealed claim (Exemem; when transport configured)
  org join --from invite.json
  org join --claim CLAIM_ID
  org schema-json
  org help

Invite humans: see docs/INVITE.md

Env: ${LASTDB_DB_ENV} is set when wrapping apps (and --db is injected).
`;
}

function dbUsage(): string {
  return `org db subcommands:
  org db create <org-slug> <db-slug> [--name N] [--description D]
  org db list [org-slug]
  org db show <org-slug> <db-slug>
`;
}

if (import.meta.main) {
  const code = await run();
  process.exit(code);
}
