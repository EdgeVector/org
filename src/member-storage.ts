import { normalizeMiniUserHash } from "./join-accept.ts";
import { grantOrgCloudMember } from "./org-sync.ts";
import type { Config } from "./config.ts";
import type { LastDbClient } from "./lastdb.ts";
import { putConsumedInviteClaim, type ConsumedInviteClaim } from "./storage.ts";

export function consumeJoinClaim(client: LastDbClient, config: Config,
  claim: ConsumedInviteClaim, principal: string | undefined) {
  return async (enrolled: boolean): Promise<void> => {
    if (enrolled && !normalizeMiniUserHash(principal)) {
      throw new Error("an enrolled member addition requires the member's signed Mini account hash; the claim remains unused");
    }
    // Strict chain, cloud-tip and size admission precede this call. Consumption
    // still precedes the epoch write to preserve one-time replay refusal.
    await putConsumedInviteClaim(client, config, claim);
  };
}

/** Finish the separate storage grant only after signed authority publication. */
export async function grantJoinAcceptPrincipal(input: {
  slug: string;
  orgHash: string;
  userHash: string | undefined;
  socketPath?: string;
  io: { stdout: Pick<typeof process.stdout, "write">; stderr: Pick<typeof process.stderr, "write"> };
  deps: { grantOrgCloudMember?: typeof grantOrgCloudMember };
  requireCloudGrant: boolean;
  recoveryCommand: string;
}): Promise<void> {
  const userHash = normalizeMiniUserHash(input.userHash);
  if (!userHash) {
    const message = `acceptance carried no Mini account hash; next: ${input.recoveryCommand}`;
    if (input.requireCloudGrant) throw new Error(message);
    input.io.stderr.write(`note: ${message}\n`);
    return;
  }
  const grant = input.deps.grantOrgCloudMember ?? grantOrgCloudMember;
  const result = await grant({
    orgHash: input.orgHash, targetUserHash: userHash, role: "writer", socketPath: input.socketPath,
  });
  if (result.ok) {
    input.io.stdout.write(`granted cloud access org=${input.slug} principal=${result.principal_hash ?? userHash} role=${result.role ?? "writer"}\n`);
    return;
  }
  const message = `storage grant failed: ${result.error ?? "unknown"}; next: ${input.recoveryCommand}`;
  if (input.requireCloudGrant) throw new Error(`the signed cloud authority updated, but ${message}`);
  input.io.stderr.write(`${message}\n`);
}
