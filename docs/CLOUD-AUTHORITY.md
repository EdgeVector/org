# Signed org cloud authority

The cloud service uses the current signed owner or admin role for an org purge. A storage writer or reader role does not permit a purge.

The org root signs the member records. Each signed epoch references its predecessor. The node uses its own cloud account credentials for publication.

The Org app sends only the public root and signed epochs to the owner socket. The private root key and org encryption key stay in LastSecrets.

Authority commands use one selected local owner socket. They refuse a remote node URL before a local authority change.

## New org

Use a Mini version with both org authority routes. Select the correct node socket and Org config for each command.

```sh
org init --config <config> --socket <socket>
org create <slug> --config <config> --socket <socket> --identity <member-identity>
org epoch publish <slug> --config <config> --socket <socket> --identity <member-identity>
```

The new owner genesis contains the current node account hash. Publication requires a connected cloud account. It does not enable cloud sync or purge data.

## Original org owner

An older signed genesis can lack the cloud account hash. Keep that genesis and the original keys.

```sh
org epoch bind-owner <slug> --config <config> --socket <socket> --identity <original-member-identity>
```

This command requires the unchanged original owner identity. The original owner must remain an active owner at the current signed tip.

The command signs a new epoch with the current node account hash. The original member key also signs the exact cloud enrollment proof.

The service verifies both signatures before first enrollment. A different member or a missing original key cannot claim the original owner.

## Member changes

Use the normal encrypted invite and acceptance commands to add a member. An acceptance records the member's own node account hash.

```sh
org member add <slug> --accept <encrypted-acceptance> --role member --config <config> --socket <socket>
org member set-role <slug> <member-id> --role admin --config <config> --socket <socket>
org member set-role <slug> <member-id> --role member --config <config> --socket <socket>
org kick <slug> <member-id> --config <config> --socket <socket>
```

For an enrolled org, each signed change checks the cloud tip and the authenticated principal's current owner or admin role before the local write.

The command then publishes the new authority. The node returns its actual signed account hash for this check.

Every epoch change refuses malformed or invalid signed records. An enrolled member addition also requires the member's signed node account hash.

The service checks the current stored owner or admin role before an authority advance. The command cannot report cloud success before that ack.

The storage grant follows an accepted member addition. The storage revoke follows an accepted member revocation. A failed storage change reports an incomplete command.

An unconfigured node or an org with no cloud authority keeps local-only signed member changes. First publication remains an explicit command.

The role command returns `local_only: true` for these local changes. It does not report a cloud role change.

## Partial state and retry

The local signed epoch can exist after a cloud request fails or its reply is lost. The command reports the failure and does not undo the signed epoch.

```sh
org epoch publish <slug> --config <config> --socket <socket> --identity <member-identity>
```

Publication verifies the full local chain and reads the exact current cloud tip. An exact accepted-tip retry returns success. A different cloud tip refuses the update.

After publication, retry an incomplete storage grant or revoke through its normal command:

```sh
org member grant <slug> <member-account-hash> --role writer --config <config> --socket <socket>
org member revoke <slug> <member-account-hash> --config <config> --socket <socket>
```

The error gives both commands with the selected config, node URL, socket, and explicit member identity. Keep that node selection for each retry.

The grant and revoke routes work with Cloud Off. They use the normal account authority and do not start cloud sync.

After an org purge, use the actual home and owner socket with that org configured. The node must hold the current org adoption receipt.

The grant or revoke route refuses a personal node without that org authority. It does not replace the required org adoption.

The one-time invite claim becomes used after the chain, cloud-tip, and size checks. The local epoch write follows that claim write.

A crash can leave a used claim without its epoch. That claim stays refused. Use a new normal invite after review of the signed member state.

A publication failure can leave a local member epoch without its storage grant or revoke. Do not repeat the member addition or kick.

Publish that exact local chain first. Then use the exact storage grant or revoke command. Neither command reports full cloud success before its required ack.

A repeated `set-role` with the same single role retries publication without another signed epoch. The active-owner rule prevents removal of the last owner.

The owner route accepts at most 1MiB and 1000 signed epochs. The terminal cloud authority accepts at most 350KiB.

An enrolled change checks all three limits before the claim or local epoch write. The original owner enrollment checks these limits before its new epoch.

## Purge authority

CAUTION: A purge deletes the selected account's cloud data. Use the intended home and org account.

```sh
LASTDB_HOME=<home> lastdb cloud purge-resync begin --org <org-hash> --request-id <uuid> --json
```

The service permits a current owner or admin. It refuses a member. Personal purge authority uses the personal account and does not use an org role.

The service also requires the deployment floor, provider cutoff, exact account scope, and external-reference evidence. Role publication does not establish those facts.
