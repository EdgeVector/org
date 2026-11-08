#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";

import { defaultConfigPath, readConfig, writeConfig, type Config } from "./config.ts";
import { assertOwnerSocket, mintNextEpoch } from "./epoch-mutation.ts";
import { changeMemberRole } from "./member-roles.ts";
import { consumeJoinClaim } from "./member-storage.ts";
import { generateOrgKeys } from "./crypto.ts";
import {
  buildEpochPayload,
  formatEpochSummary,
  memberAddedEpoch,
  resolveCanonicalChain,
  signEpochPayload,
  signPkFingerprint,
  type EpochMember,
  type OrgEpoch,
  type ResolvedChain,
} from "./epoch.ts";
import {
  formatDbLocator,
  LASTDB_DB_ENV,
  orgDb,
  parseDbLocator,
  personalDb,
  type DbHandle,
} from "./db-handle.ts";
import {
  buildAgentInstructions,
  buildInvite,
  buildPubkeySealedAgentInstructions,
  inviteExpired,
  parseInvite,
  serializeInvite,
  type OrgInvite,
} from "./invite.ts";
import {
  buildHumanInviteLinkInstructions,
  buildOrgInviteLink,
  buildOrgInviteLinkResponse,
  orgInviteLinkExpired,
  parseOrgInviteLink,
} from "./invite-link.ts";
import {
  buildJoinAccept,
  joinAcceptExpired,
  normalizeMiniUserHash,
  sealJoinAccept,
  unsealJoinAccept,
} from "./join-accept.ts";
import { sealInviteToPubkey, unsealInviteWithMemberKey } from "./invite-seal.ts";
import {
  defaultNodeUrl,
  newLastDbClient,
  resolveSocketPath,
} from "./lastdb.ts";
import { newLastSecretsCli, type LastSecretsCli } from "./lastsecrets.ts";
import {
  defaultMemberIdentityPath,
  formatReceiveBanner,
  loadOrCreateMemberIdentity,
  memberFingerprint,
  memberPrivateKeyObject,
  memberPubkeyLine,
  parseMemberPubkey,
} from "./member-identity.ts";
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
  buildAdminOrgSlice,
  formatDb,
  formatOrg,
  getConsumedInviteClaim,
  getOrgDatabase,
  getOrgEpoch,
  getOrganization,
  listOrgDatabases,
  listOrgEpochs,
  listOrganizations,
  listPathBindings,
  putOrgEpoch,
  putOrganization,
  putOrgDatabase,
  putPathBinding,
  removePathBinding,
  requireEpochBindings,
  requireInviteClaimBinding,
  toResolveBindings,
  updateConsumedInviteClaim,
  type Organization,
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
  newClient?: typeof newLastDbClient;
  /** Override the app launcher. */
  wrapApp?: typeof wrapApp;
  /** Selected working directory for database resolution. */
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

    if (command === "admin-slice") {
      const opts = parseOptions([arg, ...tail].filter(Boolean) as string[]);
      const { client, config } = await loadSession(opts, deps);
      const slice = buildAdminOrgSlice(
        await listOrganizations(client, config),
        await listOrgDatabases(client, config),
      );
      io.stdout.write(`${JSON.stringify(slice, null, 2)}\n`);
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

    if (command === "receive") {
      return await cmdReceive(parseOptions([arg, ...tail].filter(Boolean) as string[]), io, deps);
    }

    if (command === "link") {
      return await cmdLink(arg, tail, io, deps);
    }

    if (command === "join") {
      return await cmdJoin(parseOptions([arg, ...tail].filter(Boolean) as string[]), io, deps);
    }

    if (command === "member") {
      return await cmdMember(arg, tail, io, deps);
    }

    if (command === "epoch") {
      return await cmdEpoch(arg, tail, io, deps);
    }

    if (command === "kick") {
      return await cmdKick(arg, tail, io, deps);
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
      const opts = parseOptions([arg, ...tail].filter(Boolean) as string[]);
      return await cmdResolve(
        { ...resolveOpts, ...(opts.db ? { db: opts.db } : {}) },
        opts,
        io,
        deps,
      );
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
  const client = newClient({ nodeUrl, socketPath });
  const { userHash } = await client.autoIdentity();

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
  assertOwnerSocket(config);
  // Fail closed before any key material is minted: the epoch chain IS the
  // member registry, so an org without a signed genesis is not an org.
  requireEpochBindings(config);
  const secrets = deps.lastSecrets ?? newLastSecretsCli();

  // Prefer catalog identity hash — same rule as storage.schemaId (app names
  // often 404 "not loaded" on a freshly declared ephemeral Mini).
  const orgSchemaId =
    config.schemas.Organization.schemaHash ||
    config.schemas.Organization.schemaName;
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

  // Genesis epoch 0: the owner entry with its v2 signing identity, signed by
  // the org root key. The chain starts here; `org member list` reads it.
  const identity = loadOrCreateMemberIdentity(
    opts.identityPath ?? defaultMemberIdentityPath(),
  );
  const owner: EpochMember = {
    member_id: memberFingerprint(identity),
    name: opts.ownerName ?? "owner",
    sign_pk: identity.signing_public_key,
    seal_pk: memberPubkeyLine(identity),
    roles: ["owner"],
    status: "active",
  };
  const genesis = signEpochPayload(
    buildEpochPayload({
      orgHash: keys.orgHash,
      epochNo: 0,
      prevEpoch: "",
      members: [owner],
    }),
    keys.orgPrivateKey,
  );
  await putOrgEpoch(client, config, genesis);
  io.stdout.write(`signed genesis ${formatEpochSummary(genesis)}\n`);
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
  const databases = await listOrgDatabases(client, config, org.slug);
  const pathBindings = (await listPathBindings(client, config))
    .filter((binding) => binding.orgSlug === org.slug)
    .map((binding) => ({ root: binding.root, db_slug: binding.dbSlug }));
  const e2eKey = secrets.get(e2eSecretSlug(slug));
  const invite = buildInvite({
    slug: org.slug,
    name: org.name,
    orgHash: org.orgHash,
    orgPublicKey: org.orgPublicKey,
    e2eKey,
    createdBy: config.userHash,
    defaultDb: org.defaultDb || undefined,
    databases: databases.map((db) => ({
      db_slug: db.dbSlug,
      name: db.name,
      description: db.description,
      created_by: db.createdBy,
    })),
    pathBindings,
    ...(opts.expiresIn !== undefined ? { ttlMs: parseDurationMs(opts.expiresIn) } : {}),
  });
  io.stderr.write(
    `invite expires_at=${invite.expires_at} (one-time claim; admin accepts with org member add)\n`,
  );
  if (opts.to && opts.out) {
    throw new Error("invite --to cannot be combined with --out; use one delivery path");
  }

  if (opts.link) {
    if (opts.to || opts.out || opts.outSealed) {
      throw new Error("invite --link cannot be combined with --to, --out, or --out-sealed");
    }
    const { intent, url } = buildOrgInviteLink({
      orgSlug: org.slug,
      orgName: org.name,
      orgHash: org.orgHash,
      senderIdentity: config.userHash,
      senderPublicKey: org.orgPublicKey,
      ...(opts.expiresIn !== undefined ? { ttlMs: parseDurationMs(opts.expiresIn) } : {}),
      linkBase: opts.linkBase,
    });
    if (opts.json) {
      io.stdout.write(`${JSON.stringify({ intent, url }, null, 2)}\n`);
    } else {
      io.stdout.write(buildHumanInviteLinkInstructions({ intent, url }));
    }
    io.stderr.write(
      `org-intent correlation=${intent.correlation_id} expires_at=${intent.expires_at}; no E2E key is present in the link\n`,
    );
    return 0;
  }

  if (opts.to) {
    const recipient = parseMemberPubkey(opts.to);
    const orgPrivateKey = secrets.get(`org-${slug}-private`);
    const sealed = sealInviteToPubkey({
      invite,
      recipientPubkey: recipient.encoded,
      orgPrivateKeyB64: orgPrivateKey,
      orgPublicKeyB64: org.orgPublicKey,
    });
    if (opts.outSealed) {
      mkdirSync(dirname(opts.outSealed), { recursive: true, mode: 0o700 });
      writeFileSync(opts.outSealed, `${sealed}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      io.stderr.write(`wrote sealed package to ${opts.outSealed}\n`);
    }
    if (opts.agent) {
      io.stdout.write(
        buildPubkeySealedAgentInstructions({
          invite,
          recipientPubkey: recipient.encoded,
          recipientFingerprint: recipient.fingerprint,
          sealedPackage: sealed,
        }),
      );
    } else {
      io.stdout.write(`sealed org invite for fingerprint ${recipient.fingerprint}\n`);
      io.stdout.write(`recipient=${recipient.encoded}\n`);
      io.stdout.write(`sealed_package=${sealed}\n`);
      io.stdout.write(
        "friend runs: org join --sealed '<sealed_package>'  (or org receive --sealed …)\n",
      );
      io.stderr.write(
        "note: package is encrypted to their public key — safe on any clear channel\n",
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

async function cmdReceive(opts: Options, io: Io, deps: CliDeps): Promise<number> {
  const idPath = opts.identityPath ?? defaultMemberIdentityPath();
  // Accept sealed package: join path without a separate `join` verb.
  if (opts.sealed) {
    return await cmdJoin({ ...opts, sealed: opts.sealed }, io, deps);
  }
  if (opts.from) {
    // Allow `org receive --from sealed.txt` for a file containing orgseal1:…
    const token = readFileSync(opts.from, "utf8").trim();
    return await cmdJoin({ ...opts, sealed: token, from: undefined }, io, deps);
  }

  const id = loadOrCreateMemberIdentity(idPath);
  if (opts.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          public_key: memberPubkeyLine(id),
          fingerprint: memberFingerprint(id),
          path: idPath,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout.write(formatReceiveBanner(id));
  }
  return 0;
}

async function cmdLink(
  sub: string | undefined,
  rest: string[],
  io: Io,
  _deps: CliDeps,
): Promise<number> {
  if (!sub || sub === "help" || sub === "--help") {
    io.stdout.write(
      "org link accept <URL> [--json]  # consent to a non-secret org sharing link\n",
    );
    return 0;
  }
  if (sub !== "accept") {
    throw new Error(`unknown link subcommand: ${sub}`);
  }
  const link = rest[0];
  if (!link || link.startsWith("-")) {
    throw new Error("usage: org link accept <URL> [--json]");
  }
  const opts = parseOptions(rest.slice(1));
  const intent = parseOrgInviteLink(link);
  if (orgInviteLinkExpired(intent)) {
    throw new Error(
      `org invite link for ${intent.org_slug} expired at ${intent.expires_at}; ask the sender for a fresh link`,
    );
  }
  const identity = loadOrCreateMemberIdentity(opts.identityPath ?? defaultMemberIdentityPath());
  const { response, token } = buildOrgInviteLinkResponse(intent, memberPubkeyLine(identity));
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ intent, response, token }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(
    `org sharing request from ${intent.sender_identity} for ${JSON.stringify(intent.org_name)}\n`,
  );
  io.stdout.write(
    "Share your information to let the sender send the encrypted invite through the connection mailbox.\n",
  );
  io.stdout.write(`response=${token}\n`);
  io.stdout.write("Send this response to the sender's connection service.\n");
  return 0;
}

async function cmdJoin(opts: Options, io: Io, deps: CliDeps): Promise<number> {
  const modes = [opts.from, opts.sealed].filter(Boolean);
  if (modes.length === 0) {
    throw new Error("join requires --from <invite.json> or --sealed <orgseal1:…>");
  }
  if (modes.length > 1) {
    throw new Error("join accepts only one of --from or --sealed");
  }

  let invite: OrgInvite;
  if (opts.sealed) {
    const id = loadOrCreateMemberIdentity(opts.identityPath ?? defaultMemberIdentityPath());
    invite = unsealInviteWithMemberKey(opts.sealed, memberPrivateKeyObject(id));
  } else {
    invite = parseInvite(JSON.parse(readFileSync(opts.from!, "utf8")));
  }

  // Expiry gate BEFORE any local write: an expired invite stores nothing and
  // mints nothing.
  if (inviteExpired(invite)) {
    throw new Error(
      `invite for ${invite.slug} expired at ${invite.expires_at}; ask the admin for a fresh invite`,
    );
  }

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
    ...(invite.default_db ? { defaultDb: invite.default_db } : {}),
    createdBy: invite.created_by,
  });

  for (const database of invite.databases ?? []) {
    await putOrgDatabase(client, config, {
      orgSlug: org.slug,
      dbSlug: database.db_slug,
      name: database.name,
      description: database.description,
      orgHash: org.orgHash,
      createdBy: database.created_by,
    });
  }
  if (invite.path_bindings && invite.path_bindings.length > 0) {
    if (!config.schemas.PathBinding) {
      throw new Error("PathBinding schema not initialized. Re-run `org init`.");
    }
    for (const binding of invite.path_bindings) {
      await putPathBinding(client, config, {
        root: binding.root,
        orgSlug: org.slug,
        dbSlug: binding.db_slug,
        orgHash: org.orgHash,
      });
    }
  }

  io.stdout.write(`joined organization ${formatOrg(org)}\n`);
  if (invite.databases && invite.databases.length > 0) {
    io.stdout.write(`reconstructed named databases=${invite.databases.length}\n`);
  }
  if (invite.path_bindings && invite.path_bindings.length > 0) {
    io.stdout.write(`reconstructed path bindings=${invite.path_bindings.length}\n`);
  }
  io.stdout.write(`e2e key stored as lastsecrets://${secretSlug}\n`);

  const identity = loadOrCreateMemberIdentity(
    opts.identityPath ?? defaultMemberIdentityPath(),
  );
  const userHash = normalizeMiniUserHash(await client.nodeUserHash());
  const accept = buildJoinAccept({
    invite,
    identity,
    ...(opts.memberName !== undefined ? { memberName: opts.memberName } : {}),
    ...(userHash ? { userHash } : {}),
  });
  const token = sealJoinAccept(accept, invite.e2e_key);
  io.stdout.write(
    `\nSend this acceptance back to the org admin over any channel (it contains no secrets):\n`,
  );
  io.stdout.write(`acceptance=${token}\n`);
  io.stdout.write(
    `next: org member add ${invite.slug} --accept '<paste acceptance=>'\n`,
  );
  if (userHash) {
    io.stdout.write(`joiner Mini user_hash=${userHash}\n`);
  }
  return 0;
}

async function cmdMember(
  sub: string | undefined,
  rest: string[],
  io: Io,
  deps: CliDeps,
): Promise<number> {
  if (!sub || sub === "help" || sub === "--help") {
    io.stdout.write(
      "org member list <slug> [--json]        # registry from the canonical signed epoch\n" +
        "org member set-role <slug> <member_id> --role owner|admin|member\n" +
        "org member add <slug> --accept 'orgaccept1:…' [--role R] [--name N]\n",
    );
    return 0;
  }
  if (sub === "set-role") {
    return cmdSetMemberRole(rest, io, deps);
  }
  if (sub === "add") {
    const slug = rest[0];
    if (!slug) {
      throw new Error(
        "usage: org member add <slug> --accept 'orgaccept1:…' [--role R] [--name N]",
      );
    }
    const addOpts = parseOptions(rest.slice(1));
    if (!addOpts.accept) {
      throw new Error(
        "member add requires --accept 'orgaccept1:…' (printed by the joiner's `org join`)",
      );
    }
    const { client, config } = await loadSession(addOpts, deps);
    const org = await getOrganization(client, config, slug);
    requireInviteClaimBinding(config);
    const secrets = deps.lastSecrets ?? newLastSecretsCli();
    const e2eKey = secrets.get(e2eSecretSlug(slug));
    const accept = unsealJoinAccept(addOpts.accept, e2eKey);
    if (accept.payload.org_hash !== org.orgHash) {
      throw new Error("acceptance rejected: org_hash mismatch (token is for a different org)");
    }
    // Policy gates, in order — each rejects WITHOUT minting an epoch.
    if (joinAcceptExpired(accept)) {
      throw new Error(
        `acceptance rejected: invite expired at ${accept.payload.expires_at}; no epoch minted`,
      );
    }
    const spent = await getConsumedInviteClaim(client, config, accept.payload.claim_nonce);
    if (spent) {
      throw new Error(
        `acceptance rejected: claim already consumed at ${spent.consumedAt} for member ${spent.memberId}; no epoch minted (replay)`,
      );
    }
    const sealParsed = parseMemberPubkey(accept.payload.member.seal_pk);
    const member: EpochMember = {
      member_id: accept.payload.member.member_id,
      name: addOpts.name ?? accept.payload.member.name,
      sign_pk: accept.payload.member.sign_pk,
      seal_pk: sealParsed.encoded,
      ...(accept.payload.user_hash ? { cloud_user_hash: accept.payload.user_hash } : {}),
      roles: [addOpts.role ?? "member"],
      status: "active",
    };
    const consumedAt = new Date().toISOString();
    const epoch = await mintNextEpoch({
      client,
      config,
      org,
      io,
      deps,
      identityPath: addOpts.identityPath,
      beforeStore: consumeJoinClaim(client, config, { claimNonce: accept.payload.claim_nonce,
        orgHash: org.orgHash, memberId: member.member_id, epochHash: "", consumedAt }),
      apply: (members) => {
        appendNewMember(members, member);
        return { members };
      },
    });
    try {
      await updateConsumedInviteClaim(client, config, {
        claimNonce: accept.payload.claim_nonce, orgHash: org.orgHash,
        memberId: member.member_id, epochHash: epoch.epoch_hash, consumedAt,
      });
    } catch {
      throw new Error("the claim epoch stamp failed after the signed epoch write");
    }
    io.stdout.write(
      `added ${member.member_id} name=${JSON.stringify(member.name)} role=${member.roles[0]} — signed ${formatEpochSummary(epoch)}\n`,
    );
    return 0;
  }
  if (sub === "list") {
    const slug = rest[0];
    if (!slug) throw new Error("usage: org member list <slug> [--json]");
    const listOpts = parseOptions(rest.slice(1));
    const { client, config } = await loadSession(listOpts, deps);
    const org = await getOrganization(client, config, slug);
    const resolved = await loadEpochChain(client, config, org, io);
    if (!resolved.ok || !resolved.tip) {
      throw new Error(`member registry unavailable: ${resolved.error ?? "no canonical epoch"}`);
    }
    const tip = resolved.tip;
    if (listOpts.json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            org: org.slug,
            epoch_no: tip.payload.epoch_no,
            epoch_hash: tip.epoch_hash,
            members: tip.payload.members.map((m) => ({
              ...m,
              added_epoch: memberAddedEpoch(resolved.chain, m.member_id),
            })),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    io.stdout.write(
      `registry org=${org.slug} epoch=${tip.payload.epoch_no} epoch_hash=${tip.epoch_hash}\n`,
    );
    for (const member of tip.payload.members) {
      io.stdout.write(`${formatEpochMember(member, resolved.chain)}\n`);
    }
    return 0;
  }
  throw new Error(`unknown member subcommand: ${sub}`);
}

async function cmdSetMemberRole(rest: string[], io: Io, deps: CliDeps): Promise<number> {
  const slug = rest[0], memberId = rest[1];
  const opts = parseOptions(rest.slice(2));
  if (!slug || !memberId || !opts.role) throw new Error("usage: org member set-role <slug> <member_id> --role owner|admin|member");
  const { client, config } = await loadSession(opts, deps);
  const org = await getOrganization(client, config, slug);
  const context = { client, config, org, socketPath: opts.socketPath, identityPath: opts.identityPath };
  const receipt = await changeMemberRole(context, memberId, opts.role,
    (apply) => mintNextEpoch({ ...context, io, deps, apply }));
  io.stdout.write(`${JSON.stringify(receipt)}\n`);
  return 0;
}

/**
 * Membership epoch chain (the registry itself).
 *
 *   org epoch sign <slug> [--add-member SPEC] [--revoke MEMBER_ID] [--repo-admins JSON]
 *   org epoch show <slug> [EPOCH_HASH] [--json]
 *   org epoch verify <slug> [--json]
 *   org epoch log <slug>
 */
async function cmdEpoch(
  sub: string | undefined,
  rest: string[],
  io: Io,
  deps: CliDeps,
): Promise<number> {
  if (!sub || sub === "help" || sub === "--help") {
    io.stdout.write(epochUsage());
    return 0;
  }
  const slug = rest[0];
  if (!slug) throw new Error(`usage: org epoch ${sub} <slug> …\n${epochUsage()}`);
  const opts = parseOptions(rest.slice(1));
  const { client, config } = await loadSession(opts, deps);
  const org = await getOrganization(client, config, slug);

  if (sub === "sign") {
    const epoch = await mintNextEpoch({
      client,
      config,
      org,
      io,
      deps,
      identityPath: opts.identityPath,
      apply: (members, tip) => {
        let changed = false;
        if (opts.addMember) {
          appendNewMember(members, parseMemberSpec(opts.addMember));
          changed = true;
        }
        if (opts.revoke) {
          revokeMember(members, opts.revoke);
          changed = true;
        }
        let repoAdmins = tip.payload.repo_admins;
        if (opts.repoAdmins) {
          repoAdmins = parseRepoAdmins(opts.repoAdmins);
          changed = true;
        }
        if (!changed && !opts.force) {
          throw new Error(
            "no membership changes requested (use --add-member/--revoke/--repo-admins, or --force to re-sign as-is)",
          );
        }
        return { members, repoAdmins };
      },
    });
    io.stdout.write(`signed ${formatEpochSummary(epoch)}\n`);
    return 0;
  }

  if (sub === "show") {
    const explicitHash = rest[1] && !rest[1].startsWith("-") ? rest[1] : undefined;
    let epoch: OrgEpoch | null;
    let chain: OrgEpoch[] = [];
    if (explicitHash) {
      epoch = await getOrgEpoch(client, config, explicitHash);
      if (!epoch) throw new Error(`epoch not found: ${explicitHash}`);
    } else {
      const resolved = await loadEpochChain(client, config, org, io);
      if (!resolved.ok || !resolved.tip) {
        throw new Error(`no canonical epoch: ${resolved.error ?? "chain unresolved"}`);
      }
      epoch = resolved.tip;
      chain = resolved.chain;
    }
    if (opts.json) {
      io.stdout.write(
        `${JSON.stringify(
          { epoch_hash: epoch.epoch_hash, sig: epoch.sig, payload: epoch.payload },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    io.stdout.write(`${formatEpochSummary(epoch)}\n`);
    io.stdout.write(`prev_epoch=${epoch.payload.prev_epoch || "(genesis)"}\n`);
    io.stdout.write(`sig=${epoch.sig}\n`);
    for (const member of epoch.payload.members) {
      io.stdout.write(`${formatEpochMember(member, chain)}\n`);
    }
    if (epoch.payload.repo_admins) {
      for (const [repo, admins] of Object.entries(epoch.payload.repo_admins)) {
        io.stdout.write(`repo_admins ${repo}=${admins.join(",")}\n`);
      }
    }
    return 0;
  }

  if (sub === "verify") {
    const listing = await listOrgEpochs(client, config, org.orgHash);
    const resolved = resolveCanonicalChain(listing.epochs, {
      orgHash: org.orgHash,
      orgPublicKeyB64: org.orgPublicKey,
    });
    const problems = [
      ...listing.malformed.map((m) => `malformed ${m.epoch_hash}: ${m.error}`),
      ...resolved.invalid.map((m) => `invalid ${m.epoch_hash}: ${m.error}`),
    ];
    const ok = resolved.ok && problems.length === 0;
    if (opts.json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            ok,
            error: resolved.error ?? null,
            problems,
            epochs: resolved.chain.length,
            tip: resolved.tip
              ? { epoch_no: resolved.tip.payload.epoch_no, epoch_hash: resolved.tip.epoch_hash }
              : null,
          },
          null,
          2,
        )}\n`,
      );
      return ok ? 0 : 1;
    }
    for (const problem of problems) io.stderr.write(`${problem}\n`);
    if (!ok) {
      io.stderr.write(`epoch chain INVALID: ${resolved.error ?? "records failed verification"}\n`);
      return 1;
    }
    io.stdout.write(
      `epoch chain ok: epochs=${resolved.chain.length} tip=${formatEpochSummary(resolved.tip!)}\n`,
    );
    return 0;
  }

  if (sub === "log") {
    const resolved = await loadEpochChain(client, config, org, io);
    if (!resolved.ok) {
      throw new Error(`cannot log epoch chain: ${resolved.error ?? "chain unresolved"}`);
    }
    for (const epoch of resolved.chain) {
      io.stdout.write(`${formatEpochSummary(epoch)}\n`);
    }
    return 0;
  }

  throw new Error(`unknown epoch subcommand: ${sub}\n${epochUsage()}`);
}

function appendNewMember(members: EpochMember[], added: EpochMember): void {
  const clash = members.find((m) => m.member_id === added.member_id);
  if (clash) {
    throw new Error(
      `member_id already present in the registry: ${added.member_id} (status=${clash.status})`,
    );
  }
  members.push(added);
}

function revokeMember(members: EpochMember[], memberId: string): void {
  const target = members.find((m) => m.member_id === memberId);
  if (!target) throw new Error(`member not found in registry: ${memberId}`);
  if (target.status === "revoked") {
    throw new Error(`member already revoked: ${memberId}`);
  }
  target.status = "revoked";
}

/**
 * Registry kick: mint a revocation epoch (status revoked, non-retroactive —
 * events authorized by earlier epochs stay valid).
 */
async function cmdKick(
  slug: string | undefined,
  rest: string[],
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const memberId = rest[0];
  if (!slug || !memberId) {
    throw new Error("usage: org kick <org-slug> <member_id>");
  }
  const opts = parseOptions(rest.slice(1));
  const { client, config } = await loadSession(opts, deps);
  const org = await getOrganization(client, config, slug);
  const resolved = await loadEpochChain(client, config, org, io);
  if (!resolved.ok || !resolved.tip) {
    throw new Error(
      `refusing to kick from an unverifiable chain: ${resolved.error ?? "no canonical epoch"}`,
    );
  }
  const target = resolved.tip.payload.members.find((member) => member.member_id === memberId);
  if (!target) throw new Error(`member not found in registry: ${memberId}`);
  if (target.status === "revoked") {
    throw new Error(`member already revoked: ${memberId}`);
  }
  const epoch = await mintNextEpoch({
    client,
    config,
    org,
    io,
    deps,
    identityPath: opts.identityPath,
    apply: (members) => {
      revokeMember(members, memberId);
      return { members };
    },
  });
  io.stdout.write(
    `kicked ${memberId} from the ${org.slug} registry — signed ${formatEpochSummary(epoch)}\n`,
  );
  return 0;
}

/** Load, filter, and verify the canonical chain; warn (stderr) on bad records. */
async function loadEpochChain(
  client: ReturnType<typeof newLastDbClient>,
  config: Config,
  org: Organization,
  io: Io,
): Promise<ResolvedChain> {
  const listing = await listOrgEpochs(client, config, org.orgHash);
  for (const bad of listing.malformed) {
    io.stderr.write(`warning: ignoring malformed epoch ${bad.epoch_hash}: ${bad.error}\n`);
  }
  const resolved = resolveCanonicalChain(listing.epochs, {
    orgHash: org.orgHash,
    orgPublicKeyB64: org.orgPublicKey,
  });
  for (const bad of resolved.invalid) {
    io.stderr.write(`warning: ignoring invalid epoch ${bad.epoch_hash}: ${bad.error}\n`);
  }
  return resolved;
}

function formatEpochMember(member: EpochMember, chain: OrgEpoch[]): string {
  const added = memberAddedEpoch(chain, member.member_id);
  return [
    `member_id=${member.member_id}`,
    `name=${JSON.stringify(member.name)}`,
    `roles=${member.roles.join(",")}`,
    `status=${member.status}`,
    added !== null ? `added_epoch=${added}` : "",
    `sign_pk_fp=${signPkFingerprint(member.sign_pk)}`,
    `sign_pk=${member.sign_pk}`,
    `seal_pk=${member.seal_pk}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Member spec for `epoch sign --add-member`: inline JSON or @file.json. */
function parseMemberSpec(spec: string): EpochMember {
  const text = spec.startsWith("@") ? readFileSync(spec.slice(1), "utf8") : spec;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `--add-member must be JSON or @file.json ({name, sign_pk, seal_pk, [member_id], [roles]}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("--add-member JSON must be an object");
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : "";
  const signPk = typeof r.sign_pk === "string" ? r.sign_pk : "";
  const sealPk = typeof r.seal_pk === "string" ? r.seal_pk : "";
  if (!name || !signPk || !sealPk) {
    throw new Error("--add-member requires name, sign_pk (base64 Ed25519 SPKI), seal_pk (orgpk1:…)");
  }
  const sealParsed = parseMemberPubkey(sealPk);
  const memberId =
    typeof r.member_id === "string" && r.member_id.length > 0
      ? r.member_id
      : sealParsed.fingerprint;
  const roles = Array.isArray(r.roles)
    ? r.roles.filter((x): x is string => typeof x === "string" && x.length > 0)
    : ["member"];
  if (roles.length === 0) roles.push("member");
  return {
    member_id: memberId,
    name,
    sign_pk: signPk,
    seal_pk: sealParsed.encoded,
    roles,
    status: "active",
  };
}

function parseRepoAdmins(spec: string): Record<string, string[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(spec);
  } catch (err) {
    throw new Error(
      `--repo-admins must be JSON ({"repo": ["member_id", …]}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("--repo-admins JSON must be an object map");
  }
  const out: Record<string, string[]> = {};
  for (const [repo, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || x.length === 0)) {
      throw new Error(`--repo-admins ${repo} must map to an array of member_ids`);
    }
    out[repo] = ids as string[];
  }
  return out;
}

function epochUsage(): string {
  return `org epoch subcommands (owner-signed membership chain — the registry):
  org epoch sign <slug> [--add-member JSON|@file] [--revoke MEMBER_ID]
                        [--repo-admins JSON] [--force]
  org epoch show <slug> [EPOCH_HASH] [--json]
  org epoch verify <slug> [--json]
  org epoch log <slug>
`;
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
    // OrgDatabase is registry metadata. Keep it in the personal registry even
    // when the caller currently works inside a named org DB.
    const { client, config } = await loadSession(opts, deps, formatDbLocator(personalDb()));
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
    io.stdout.write("registry: org metadata stays in lastdb://personal\n");
    return 0;
  }

  if (sub === "list") {
    const [orgSlug, ...more] = rest;
    const opts = parseOptions(more);
    const { client, config } = await loadSession(opts, deps, formatDbLocator(personalDb()));
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
    const { client, config } = await loadSession(opts, deps, formatDbLocator(personalDb()));
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
  const { client, config } = await loadSession(opts, deps, formatDbLocator(personalDb()));
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
  dbLocator?: string,
): Promise<{ client: ReturnType<typeof newLastDbClient>; config: Config }> {
  const configPath = opts.config ?? defaultConfigPath();
  const config = readConfig(configPath);
  const nodeUrl = opts.nodeUrl ?? config.nodeUrl;
  const socketPath = resolveSocketPath(opts.socketPath ?? config.nodeSocketPath);
  const newClient = deps.newClient ?? newLastDbClient;
  const client = newClient({ nodeUrl, socketPath, dbLocator });
  return { client, config: { ...config, nodeUrl, nodeSocketPath: socketPath } };
}

type Options = {
  config?: string;
  nodeUrl?: string;
  socketPath?: string;
  db?: string;
  name?: string;
  description?: string;
  out?: string;
  /** Optional path to write orgseal1: package when inviting with --to orgpk1:… */
  outSealed?: string;
  agent?: boolean;
  from?: string;
  to?: string;
  sealed?: string;
  identityPath?: string;
  root?: string;
  cwd?: string;
  defaultDb?: string;
  json?: boolean;
  /** Signed registry role for `org member add` and `org member set-role`. */
  role?: string;
  /** Owner display name for the genesis epoch member entry. */
  ownerName?: string;
  /** Member spec (JSON or @file) for `epoch sign --add-member`. */
  addMember?: string;
  /** member_id to revoke for `epoch sign --revoke`. */
  revoke?: string;
  /** repo_admins override map (JSON) for `epoch sign --repo-admins`. */
  repoAdmins?: string;
  /** Allow `epoch sign` with no membership changes (re-sign as-is). */
  force?: boolean;
  /** Invite lifetime like 30s/15m/72h/14d for `org invite --expires-in`. */
  expiresIn?: string;
  /** Mint a non-secret org-intent link for human or connection-service onboarding. */
  link?: boolean;
  /** Base URL for the non-secret org-intent link. */
  linkBase?: string;
  /** Display name the joiner proposes for itself (`org join --member-name`). */
  memberName?: string;
  /** orgaccept1:… token for `org member add --accept`. */
  accept?: string;
};

/** Parse 30s / 15m / 72h / 14d, or milliseconds, into milliseconds. */
function parseDurationMs(spec: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(spec.trim());
  if (!m) {
    throw new Error(`--expires-in must look like 30s, 15m, 72h, or 14d (got ${spec})`);
  }
  const n = Number(m[1]);
  const mult =
    m[2] === "ms" ? 1 : m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

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
      case "--db":
        opts.db = next();
        break;
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
      case "--sealed":
        opts.sealed = next();
        break;
      case "--out-sealed":
        opts.outSealed = next();
        break;
      case "--identity":
      case "--identity-path":
        opts.identityPath = next();
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
      case "--role":
        opts.role = next();
        break;
      case "--owner-name":
        opts.ownerName = next();
        break;
      case "--add-member":
        opts.addMember = next();
        break;
      case "--revoke":
        opts.revoke = next();
        break;
      case "--repo-admins":
        opts.repoAdmins = next();
        break;
      case "--force":
        opts.force = true;
        break;
      case "--expires-in":
        opts.expiresIn = next();
        break;
      case "--link":
        opts.link = true;
        break;
      case "--link-base":
        opts.linkBase = next();
        break;
      case "--member-name":
        opts.memberName = next();
        break;
      case "--accept":
        opts.accept = next();
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
  org receive                                  # print my orgpk1:… public key (ready for invite)
  org receive --sealed orgseal1:…              # accept pubkey-sealed package
  org link accept <URL> [--json]              # consent to a non-secret sharing link
  org invite <slug> --to orgpk1:… [--agent]    # encrypt invite to friend pubkey (clear-channel OK)
  org invite <slug> --link [--link-base URL]    # mint a non-secret human sharing link
  org invite <slug> --out invite.json          # secret file fallback (raw e2e; transfer OOB)
  org invite <slug> --agent [--out path]       # pasteable agent instructions + secret file
  org invite <slug> … --expires-in 72h         # invite lifetime (default 72h; one-time claim)
  org join --sealed orgseal1:… [--member-name N]  # join; prints acceptance=orgaccept1:… to send back
  org join --from invite.json
  org member add <slug> --accept 'orgaccept1:…' [--role R]  # OWNER mints epoch N+1
  org kick <slug> <member_id>                  # revoke signed registry membership
  org member list <slug> [--json]              # registry from the canonical signed epoch chain
  org member set-role <slug> <member_id> --role owner|admin|member
  org epoch sign <slug> [--add-member JSON|@file] [--revoke MEMBER_ID]
  org epoch show|verify|log <slug>             # owner-signed membership epochs (see org epoch help)
  org admin-slice                              # metadata-only JSON for admin delivery
  org schema-json
  org help

Invite humans: see docs/INVITE.md

Env: ${LASTDB_DB_ENV} is set when wrapping apps (and --db is injected).
`;
}

function dbUsage(): string {
  return `org db subcommands:
  org db create <org-slug> <db-slug> [--name N] [--description D]
    # writes org metadata to lastdb://personal
  org db list [org-slug]
  org db show <org-slug> <db-slug>
`;
}

if (import.meta.main) {
  const code = await run();
  process.exit(code);
}
