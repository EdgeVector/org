# org

Create **shared organization databases** that **cohabit** the user's LastDB Mini
node. Encryption material lives in **LastSecrets**; org membership and named DBs
are ordinary `org/*` records on the same node as Brain and Kanban.

```
┌─────────────────────────────────────────────┐
│  lastdbd (one node, one socket)             │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ brain/*  │ │ kanban/* │ │ org/*        │ │
│  │ personal │ │ personal │ │ orgs + dbs   │ │
│  └──────────┘ └──────────┘ └──────────────┘ │
│  lastsecrets/*  ← org-<slug>-e2e keys       │
└─────────────────────────────────────────────┘
```

No second daemon. No separate data dir. Org identity is an Ed25519 keypair
(`org_hash` = sha256 of the public key); the shared AES-256 E2E key is stored
only as `lastsecrets://org-<slug>-e2e`.

## Install

```sh
cd ~/code/edgevector/org   # or clone lastdb:///org
bun install
bun link
```

Requires a running LastDB Mini node (`brew services start lastdb`) and
LastSecrets initialized (`lastsecrets init`).

## Quickstart

```sh
org init

org create edgevector --name "Edge Vector"
# → e2e key stored as lastsecrets://org-edgevector-e2e
# → private key as lastsecrets://org-edgevector-private

org db create edgevector company --name "Company DB" \
  --description "board minutes, projects, finances"

org list
org show edgevector

# hand off to a teammate by sealed messaging claim
org invite edgevector --to mailto:teammate@example.com --agent
# teammate:
org join --claim org-claim-...
```

## Invite a person

Preferred path: send a non-secret claim instruction and let Exemem messaging
carry the sealed org key.

1. Deliver the sealed invite and copy the printed agent instructions:
   ```sh
   org invite edgevector --to mailto:teammate@example.com --agent
   ```
2. Send only the printed instructions by email or chat. They contain only the
   claim id and setup commands.
3. The recipient follows the instructions, runs `org join --claim CLAIM_ID`,
   and verifies with `org show edgevector`.

Fallback when messaging is not available: create a sensitive invite file and
move it out of band.

```sh
org invite edgevector --out /tmp/edgevector.invite.json --agent
org join --from /tmp/edgevector.invite.json
```

The fallback file embeds the raw E2E key. Treat it like a password, never paste
its contents into email or chat, and delete it after joining.

## Commands

| Command | Purpose |
|---------|---------|
| `org init` | Declare org schemas (Organization, OrgDatabase, PathBinding) |
| `org create <slug>` | New org + LastSecrets E2E/private keys |
| `org list` / `org show <slug>` | Metadata only (no raw keys) |
| `org invite <slug> --to IDENTITY [--agent]` | Deliver a sealed invite claim via Exemem messaging |
| `org invite <slug> --out FILE [--agent]` | Secret-file fallback plus optional safe recipient instructions |
| `org join --claim ID` | Claim sealed invite; store E2E key via LastSecrets |
| `org join --from FILE` | Import fallback invite file; store E2E key via LastSecrets |
| `org db create/list/show` | Named shared DBs under an org |
| `org bind <org> <db> --root PATH` | Place work under this tree → that DB |
| `org resolve` | Print `lastdb://…` for cwd (or `--cwd` / `--db`) |
| `org use` / `unuse` / `current` | Session pin override |
| `org kanban …` / `org run <app> …` | **Wrapper:** resolve DB, then run app with `--db` + `LASTDB_DB` |

## Context wrapper (the day-to-day path)

Apps take an **explicit DB handle**. Org **fills it in** from place (folder
roots) or pin, then execs the app:

```sh
org bind edgevector company --root ~/code/edgevector

cd ~/code/edgevector/fold
org resolve                    # → lastdb://org/edgevector/company
org kanban list                # injects --db + LASTDB_DB
org kanban add my-card --title "…"
org --db personal brain ask "…"   # force personal
```

Resolution order: **explicit `--db` → cwd under a bound root (longest
prefix) → session pin → personal**. Same pure algorithm is SDK-shaped (no
SDK→org dependency); org owns the path registry.

Design: brain `design-org-context-resolve-from-cwd`.

## Security notes

- Prefer `org invite --to … --agent`. The email/chat text contains only a
  non-secret claim id; Exemem messaging delivers the sealed org key.
- **Invite files are fallback secrets.** They embed the raw E2E key so a peer can join
  without sharing your LastSecrets store. Prefer `--out` (mode 0600) over
  printing to stdout; delete after join.
- `org invite --agent` prints copy-paste recipient instructions only. The
  invite JSON is still separate secret material and should not be pasted into
  email or chat.
- Org records store only `lastsecrets://…` locators, never raw key material.
- Agents must never paste E2E keys into Brain, Kanban, chat, or PRs.

## Scope (v0.1)

| In | Out (later) |
|----|-------------|
| Local create/join/list | Multi-writer cloud sync (B2/R2 org prefix) |
| Sealed invite claim interface | Production membership/revoke UI |
| LastSecrets key custody | Full OrgSyncEngine in fold |
| Named shared DB registry | Per-field trust domains on org data |
| Cohabit same Mini node | Separate per-org processes |

Cloud multi-member sync still follows the older `org_shared_sync` design; this
app is the local membership + key + named-DB registry that makes that possible
without a second daemon.

## Development

```sh
bun test
bun run typecheck
```

## LastGit

Canonical remote: `lastdb:///org`. Required CI gate: `.lastgit/ci.sh`.
Review venue: `.last-stack/pr-venue` = `lastgit`.
