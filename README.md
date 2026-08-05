# org

**LastDB Org** is a separate app for **shared organization databases** on your
local Mini node. Membership and named DBs live as ordinary `org/*` records next
to Brain and Kanban. Encryption keys live in **LastSecrets** (never in org
records as raw material).

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

No second daemon. No separate data directory. An org is an Ed25519 identity
(`org_hash` = sha256 of the public key) plus a shared AES-256 E2E key stored
only as `lastsecrets://org-<slug>-e2e`.

| | |
|--|--|
| **Public source / clone** | https://github.com/EdgeVector/org |
| **Canonical review (contributors)** | LastGit `lastdb:///org` (`lastgit cr`) |
| **Depends on** | LastDB Mini (`lastdbd`) + [LastSecrets](https://github.com/EdgeVector/lastsecrets) |
| **Exemem account** | **Not required** for create, invite, or join |

GitHub is a **read-only mirror** (browse/clone). Do not open PRs with `gh` there.

---

## Install (new machine)

Needs **macOS Apple Silicon**, [Homebrew](https://brew.sh), and [Bun](https://bun.sh).

### Option A — whole app stack (recommended)

Installs LastDB + brain, kanban, situations, **org**, lastsecrets, …

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

git clone https://github.com/EdgeVector/last-stack ~/.last-stack
~/.last-stack/setup
~/.last-stack/bin/last-stack-install-apps

brew services start lastdb
curl -s --unix-socket ~/.lastdb/data/folddb.sock http://localhost/health
# expect: {"status":"ok"}

lastsecrets init
org init
```

More detail: https://thelastdb.com/llms.txt

### Option B — Org + LastSecrets only

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# LastDB daemon
brew install edgevector/lastdb/lastdb
brew services start lastdb

# LastSecrets (org keys)
git clone https://github.com/EdgeVector/lastsecrets.git
cd lastsecrets && bun install && bun link
lastsecrets init

# Org
git clone https://github.com/EdgeVector/org.git
cd org && bun install && bun link
org init
```

`org init` declares the org schemas on your Mini. Re-run it after upgrading
LastDB if `org create` reports a missing schema binding.

---

## Quickstart — create an org

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

org create friends --name "Friends"
# → e2e key: lastsecrets://org-friends-e2e
# → private key: lastsecrets://org-friends-private

org db create friends company --name "Company DB" \
  --description "shared notes / projects"

org list
org show friends
```

---

## Invite someone (preferred: public-key seal)

The friend **does not** need an Exemem account. You only need their `orgpk1:…`
public key (from `org receive` on their machine).

### 1) Friend — install + show public key

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
# install via Option A or B above if needed
lastsecrets init   # once
org init           # once
org receive
```

They send you the `orgpk1:…` line (and optional fingerprint). Safe on any
channel.

### 2) You — seal the invite to their key

```bash
org invite friends --to 'orgpk1:PASTE_THEIR_KEY' --agent
```

Copy the printed **`orgseal1:…`** package (and the agent instructions if an
assistant is helping them). Safe on email/Slack/Signal — encrypted to their key.

### 3) Friend — join (same machine as `org receive`)

```bash
org join --sealed 'orgseal1:PASTE_PACKAGE'
org show friends
```

Full handshake, fallbacks, and security table: [docs/INVITE.md](docs/INVITE.md).

**Fallback** (AirDrop / USB only — file contains the raw E2E key):

```bash
org invite friends --out ~/Desktop/friends.invite.json --agent
# friend:
org join --from ~/Downloads/friends.invite.json
```

---

## Day-to-day: bind a folder and run apps in the org DB

Apps take an explicit DB handle. Org resolves it from the current directory
(or a session pin) and injects `--db` + `LASTDB_DB`:

```bash
org bind friends company --root ~/code/shared-project

cd ~/code/shared-project
org resolve                 # → lastdb://org/friends/company
org kanban list             # runs kanban against the org DB
org run brain ask "…"       # any app on PATH
org --db personal brain ask "…"   # force personal DB
```

Resolution order: **explicit `--db` → cwd under a bound root (longest prefix)
→ session pin → personal**.

---

## Commands

| Command | Purpose |
|---------|---------|
| `org init` | Declare org schemas on this Mini |
| `org create <slug>` | New org + LastSecrets E2E/private keys |
| `org list` / `org show <slug>` | Metadata only (no raw keys) |
| `org receive` | Print local `orgpk1:…` public key |
| `org invite <slug> --to orgpk1:… [--agent]` | Seal invite to friend pubkey (preferred) |
| `org invite <slug> --out FILE [--agent]` | Secret invite file (OOB only) |
| `org join --sealed orgseal1:…` | Join from pubkey-sealed package |
| `org join --from FILE` | Join from secret invite file |
| `org join --claim TOKEN` | Legacy portable bearer claim |
| `org db create/list/show` | Named shared DBs under an org |
| `org bind <org> <db> --root PATH` | Map a filesystem root → that DB |
| `org resolve` / `use` / `unuse` / `current` | Write-target resolution |
| `org kanban …` / `org run <app> …` | Resolve DB, then run the app |
| `org sync status` / `arm` | Org cloud-sync targets on Mini |

---

## Cloud membership (kick without key rotation)

Live download/upload of an org cloud head is gated by **Exemem principal
membership** (registry on the head id), not by possession of the shared E2E key.

```bash
# after friend joins locally, grant their Mini user_hash live cloud access:
org member grant edgevector <their_user_hash> --role writer

# kick — they keep local data + E2E key, but cloud presigns stop:
org member revoke edgevector <their_user_hash>

# leave yourself:
org member leave edgevector
```

Requires a Mini with cloud sync enabled and a storage_service build that
implements `register_db_member` / `unregister_db_member`. Create/join still
stores the E2E key in LastSecrets either way.

## What works today vs later

| Works now | Needs more setup / later |
|-----------|---------------------------|
| Create org, invite/join via pubkey seal | Continuous multi-device **data** sync (enable Mini cloud sync / `cloud_sync.json`) |
| Membership + E2E key on each friend’s node | Cryptographic member removal (rotate E2E + re-invite remaining members) |
| Named DBs + path bind + app wrapper | Fancy membership UI / People directory |
| Arm org cloud-sync target on create/join | — |

Create/join call Mini `POST /api/org/sync/register` so the node can use an
encrypted org log **when cloud sync is configured**. Without cloud, membership
and local keys still work; remote nodes will not converge on shared rows yet.

---

## Security

| On the wire | OK? |
|-------------|-----|
| Install links, `orgpk1:…` public key | Yes |
| `orgseal1:…` sealed package | Yes (only recipient can open) |
| Invite JSON / raw E2E key | **No** — OOB only, never chat/email |

- Prefer `org invite --to 'orgpk1:…' --agent`. You paste the sealed package
  yourself; nothing secret rides plaintext in the package.
- Org records store only `lastsecrets://…` locators.
- Never paste E2E keys or invite JSON into Brain, Kanban, chat, git, or PRs.
- “Kick” someone = **rotate** the org E2E key and re-invite people you still
  trust (shared-secret model).

---

## Development / proof

```bash
bun test
bun run typecheck

# Two throwaway Minis, distinct identities, pubkey invite → join
# (set LS_CLI to a lastsecrets checkout src/cli.ts)
LS_CLI=~/lastdb-apps/lastsecrets/src/cli.ts \
  scripts/invite-e2e-dogfood.sh
# expect: VERDICT: GREEN
```

EdgeVector contributors: ship via LastGit (`lastgit cr`), not GitHub PRs.
See `.last-stack/pr-venue` and `.lastgit/ci.sh`.

---

## Links

- This app: https://github.com/EdgeVector/org
- LastSecrets: https://github.com/EdgeVector/lastsecrets
- Install / agent brief: https://thelastdb.com/llms.txt
- Invite deep dive: [docs/INVITE.md](docs/INVITE.md)
