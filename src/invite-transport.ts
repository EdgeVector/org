import type { InviteClaim, OrgInvite } from "./invite.ts";

export type InviteTransport = {
  deliver(input: {
    recipientIdentity: string;
    claimId: string;
    invite: OrgInvite;
  }): Promise<InviteClaim>;
  claim(input: { claimId: string }): Promise<OrgInvite>;
};

class UnavailableInviteTransport implements InviteTransport {
  async deliver(): Promise<InviteClaim> {
    throw new Error(
      "sealed invite transport unavailable; configure Exemem messaging or use `org invite --out FILE` as the secret-file fallback",
    );
  }

  async claim(): Promise<OrgInvite> {
    throw new Error(
      "sealed invite transport unavailable; configure Exemem messaging or use `org join --from FILE` as the secret-file fallback",
    );
  }
}

export function newInviteTransport(): InviteTransport {
  return new UnavailableInviteTransport();
}
