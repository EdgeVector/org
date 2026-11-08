import { verifiedAuthorityChain, type AuthorityContext } from "./epoch-mutation.ts";
import type { EpochMember, OrgEpoch } from "./epoch.ts";
import type { EpochMutationResult } from "./epoch-mutation.ts";

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
  if (member.roles.length !== 1 || member.roles[0] !== role) {
    const result = await mint((members) => {
      members.find((item) => item.member_id === memberId)!.roles = [role];
      return { members };
    });
    return localReceipt(context, result);
  }
  return localReceipt(context, chain[chain.length - 1]!);
}

function localReceipt(context: AuthorityContext, epoch: OrgEpoch) {
  return { ok: true, local_only: true, account: { kind: "org", id: context.org.orgHash },
    epoch_hash: epoch.epoch_hash, epoch_no: epoch.payload.epoch_no };
}
