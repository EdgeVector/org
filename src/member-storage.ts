import type { Config } from "./config.ts";
import type { LastDbClient } from "./lastdb.ts";
import { putConsumedInviteClaim, type ConsumedInviteClaim } from "./storage.ts";

export function consumeJoinClaim(client: LastDbClient, config: Config, claim: ConsumedInviteClaim) {
  return async (): Promise<void> => {
    await putConsumedInviteClaim(client, config, claim);
  };
}
