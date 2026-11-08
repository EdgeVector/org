import type { Config } from "./config.ts";
import { buildEpochPayload, resolveCanonicalChain, signEpochPayload, type OrgEpoch } from "./epoch.ts";
import { isLoopbackNodeUrl, type LastDbClient } from "./lastdb.ts";
import { newLastSecretsCli, type LastSecretsCli } from "./lastsecrets.ts";
import type { EpochMutation } from "./member-roles.ts";
import { listOrgEpochs, putOrgEpoch, type Organization } from "./storage.ts";

export type AuthorityContext = {
  client: LastDbClient;
  config: Config;
  org: Organization;
  socketPath?: string;
  identityPath?: string;
};

export type EpochMutationResult = OrgEpoch;

export function assertOwnerSocket(config: Config): void {
  if (!isLoopbackNodeUrl(config.nodeUrl)) {
    throw new Error("org epoch changes require one selected local owner socket");
  }
}

export async function verifiedAuthorityChain(context: AuthorityContext): Promise<OrgEpoch[]> {
  assertOwnerSocket(context.config);
  const listing = await listOrgEpochs(context.client, context.config, context.org.orgHash);
  const resolved = resolveCanonicalChain(listing.epochs, {
    orgHash: context.org.orgHash,
    orgPublicKeyB64: context.org.orgPublicKey,
  });
  if (listing.malformed.length || resolved.invalid.length || !resolved.ok || !resolved.tip) {
    throw new Error(`refusing local epoch change: ${resolved.error ?? "invalid signed epoch records"}`);
  }
  return resolved.chain;
}

export async function mintNextEpoch(input: AuthorityContext & {
  io: unknown;
  deps: { lastSecrets?: LastSecretsCli };
  apply: EpochMutation;
  beforeStore?: () => Promise<void>;
}): Promise<EpochMutationResult> {
  const chain = await verifiedAuthorityChain(input);
  const tip = chain[chain.length - 1]!;
  const working = tip.payload.members.map((member) => ({ ...member, roles: member.roles.slice() }));
  const applied = input.apply(working, tip);
  const repoAdmins = applied.repoAdmins ?? tip.payload.repo_admins;
  if (!applied.members.some((member) => member.status === "active" && member.roles.includes("owner"))) {
    throw new Error("refusing to sign an epoch with no active owner");
  }
  const keyClient = input.deps.lastSecrets ?? newLastSecretsCli();
  const epoch = signEpochPayload(buildEpochPayload({
    orgHash: input.org.orgHash,
    epochNo: tip.payload.epoch_no + 1,
    prevEpoch: tip.epoch_hash,
    members: applied.members,
    ...(repoAdmins !== undefined ? { repoAdmins } : {}),
  }), keyClient.get(`org-${input.org.slug}-private`));
  if (input.beforeStore) await input.beforeStore();
  await putOrgEpoch(input.client, input.config, epoch);
  return epoch;
}
