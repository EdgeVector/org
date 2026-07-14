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
git clone https://github.com/EdgeVector/org.git && cd org
# EdgeVector contributors may also use: lastdb:///org
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

# Friend installs LastDB, then:
#   org receive                    → sends you orgpk1:…
# You seal to their public key (clear-channel safe):
org invite edgevector --to 'orgpk1:…' --agent
# Friend:
org join --sealed 'orgseal1:…'
```

## Invite a person

**Preferred:** pubkey handshake (no Exemem account for the friend).

1. Friend installs LastDB + org, runs `org receive`, pastes `orgpk1:…` to you.
2. You run `org invite <slug> --to 'orgpk1:…' --agent` and paste the
   `orgseal1:…` package back (email/Slack OK — encrypted to their key).
3. Friend runs `org join --sealed 'orgseal1:…'` (same machine as `org receive`).

Fallback: secret invite file (raw E2E key — transfer out of band only):

```sh
org invite edgevector --out /tmp/edgevector.invite.json --agent
org join --from /tmp/edgevector.invite.json
```

Full write-up: [docs/INVITE.md](docs/INVITE.md).

## Commands

| Command | Purpose |
|---------|---------|
| `org init` | Declare org schemas (Organization, OrgDatabase, PathBinding) |
| `org create <slug>` | New org + LastSecrets E2E/private keys |
| `org list` / `org show <slug>` | Metadata only (no raw keys) |
| `org receive` | Print local `orgpk1:…` public key (ready for invite) |
| `org invite <slug> --to orgpk1:… [--agent]` | Encrypt invite to friend pubkey (clear-channel OK) |
| `org invite <slug> --out FILE [--agent]` | Secret-file fallback plus optional safe recipient instructions |
| `org join --sealed orgseal1:…` | Decrypt pubkey-sealed package; store E2E via LastSecrets |
| `org join --from FILE` | Import fallback invite file; store E2E key via LastSecrets |
| `org join --claim TOKEN` | Legacy portable bearer claim |
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

## Install sources

- **Public download (invitees / cold install):**
  `https://github.com/EdgeVector/org` — clone with normal `git`; no LastDB
  node and no LastGit helper required to *get* the CLI source.
- **EdgeVector contributor review venue:** LastGit `lastdb:///org`
  (`.last-stack/pr-venue` = `lastgit`, gate `.lastgit/ci.sh`).

GitHub is the public install mirror so someone can receive an invite and run
`org join` after `last-stack-install-apps`. LastGit remains the internal CR
path for EdgeVector contributors.
