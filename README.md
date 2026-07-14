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

# hand off to a teammate (file contains the raw e2e key — secret!)
org invite edgevector --out /tmp/edgevector.invite.json
# teammate:
org join --from /tmp/edgevector.invite.json
```

## Commands

| Command | Purpose |
|---------|---------|
| `org init` | Declare `org/Organization` + `org/OrgDatabase` on the local node |
| `org create <slug>` | New org + LastSecrets E2E/private keys |
| `org list` / `org show <slug>` | Metadata only (no raw keys) |
| `org invite <slug> --out FILE` | One-time join bundle (sensitive) |
| `org join --from FILE` | Import invite; store E2E key via LastSecrets |
| `org db create/list/show` | Named shared DBs under an org |

## Security notes

- **Invite files are secrets.** They embed the raw E2E key so a peer can join
  without sharing your LastSecrets store. Prefer `--out` (mode 0600) over
  printing to stdout; delete after join.
- Org records store only `lastsecrets://…` locators, never raw key material.
- Agents must never paste E2E keys into Brain, Kanban, chat, or PRs.

## Scope (v0.1)

| In | Out (later) |
|----|-------------|
| Local create/join/list | Multi-writer cloud sync (B2/R2 org prefix) |
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
