import {
  currentCloudPrincipal,
  enrolledCloudAuthority,
  publishCloudAuthority,
  verifiedAuthorityChain,
  type AuthorityContext,
} from "./cloud-authority.ts";
import type { EpochMember, OrgEpoch } from "./epoch.ts";
import type { EpochMutationResult } from "./epoch-mutation.ts";
import {
  defaultMemberIdentityPath,
  loadMemberIdentity,
  memberFingerprint,
  memberPubkeyLine,
} from "./member-identity.ts";

export type EpochMutation = (members: EpochMember[], tip: OrgEpoch) => {
  members: EpochMember[];
  repoAdmins?: Record<string, string[]>;
};

export type MintEpoch = (mutation: EpochMutation) => Promise<EpochMutationResult>;

export async function changeMemberRole(context: AuthorityContext, memberId: string, role: string,
  mint: MintEpoch) {
  if (!memberId || !["owner", "admin", "member"].includes(role)) {
    throw new Error("usage: org member set-role <slug> <member_id> --role owner|admin|member");
  }
  const chain = await verifiedAuthorityChain(context);
  const member = chain[chain.length - 1]!.payload.members.find((item) => item.member_id === memberId);
  if (!member || member.status !== "active") throw new Error("role changes require an active signed member");
  if (!member.cloud_user_hash) throw new Error("the member has no signed cloud principal; use a normal member acceptance first");
  if (member.roles.length !== 1 || member.roles[0] !== role) {
    const result = await mint((members) => {
      members.find((item) => item.member_id === memberId)!.roles = [role];
      return { members };
    });
    return result.cloudReceipt ?? localReceipt(context, result);
  }
  return await enrolledCloudAuthority(context, chain) ? publishCloudAuthority(context)
    : localReceipt(context, chain[chain.length - 1]!);
}

function localReceipt(context: AuthorityContext, epoch: OrgEpoch) {
  return { ok: true, local_only: true, account: { kind: "org", id: context.org.orgHash },
    epoch_hash: epoch.epoch_hash, epoch_no: epoch.payload.epoch_no };
}

export async function bindOriginalOwner(context: AuthorityContext, mint: MintEpoch) {
  const chain = await verifiedAuthorityChain(context);
  const genesis = chain[0]!;
  const tip = chain[chain.length - 1]!;
  const identity = loadMemberIdentity(context.identityPath ?? defaultMemberIdentityPath());
  const owner = genesis.payload.members.find((member) => member.status === "active"
    && member.roles.includes("owner") && member.member_id === memberFingerprint(identity)
    && member.sign_pk === identity.signing_public_key && member.seal_pk === memberPubkeyLine(identity));
  if (!owner) throw new Error("legacy enrollment requires the unchanged original owner member identity");
  const current = tip.payload.members.find((member) => member.member_id === owner.member_id);
  if (!current || current.status !== "active" || !current.roles.includes("owner")
    || current.sign_pk !== owner.sign_pk || current.seal_pk !== owner.seal_pk) {
    throw new Error("the original owner is not an unchanged active owner at the current signed tip");
  }
  const principal = await currentCloudPrincipal(context.client);
  if ((owner.cloud_user_hash && owner.cloud_user_hash !== principal)
    || (current.cloud_user_hash && current.cloud_user_hash !== principal)) {
    throw new Error("the original owner is bound to a different cloud principal");
  }
  if (current.cloud_user_hash !== principal) {
    await mint((members) => {
      members.find((member) => member.member_id === owner.member_id)!.cloud_user_hash = principal;
      return { members };
    });
  }
  return publishCloudAuthority(context);
}
