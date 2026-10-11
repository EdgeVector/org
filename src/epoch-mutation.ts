import {
  admitCloudAuthorityRequest,
  enrolledCloudAuthority,
  publishCloudAuthority,
  verifiedAuthorityChain,
  type AuthorityContext,
  type AuthorityReceipt,
} from "./cloud-authority.ts";
import { buildEpochPayload, signEpochPayload, type OrgEpoch } from "./epoch.ts";
import { newLastSecretsCli, type LastSecretsCli } from "./lastsecrets.ts";
import type { EpochMutation } from "./member-roles.ts";
import { putOrgEpoch } from "./storage.ts";

export type EpochMutationResult = OrgEpoch & {
  cloudPublished: boolean;
  cloudReceipt?: AuthorityReceipt;
};

export async function mintNextEpoch(input: AuthorityContext & {
  io: unknown;
  deps: { lastSecrets?: LastSecretsCli };
  apply: EpochMutation;
  beforeStore?: (enrolled: boolean) => Promise<void>;
  requirePublication?: boolean;
}): Promise<EpochMutationResult> {
  // All mutation paths use the same strict chain as publication. An invalid
  // indexed record cannot consume a one-time claim or create an unpublishable tip.
  const chain = await verifiedAuthorityChain(input);
  const tip = chain[chain.length - 1]!;
  const enrolled = await enrolledCloudAuthority(input, chain, true);
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
  if (enrolled || input.requirePublication) admitCloudAuthorityRequest(input, [...chain, epoch]);
  if (input.beforeStore) await input.beforeStore(enrolled);
  await putOrgEpoch(input.client, input.config, epoch);
  const cloudReceipt = enrolled ? await publishCloudAuthority(input) : undefined;
  return { ...epoch, cloudPublished: enrolled, ...(cloudReceipt ? { cloudReceipt } : {}) };
}
