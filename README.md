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
| **Review (contributors)** | GitHub `EdgeVector/org` |
| **Depends on** | LastDB Mini (`lastdbd`) + [LastSecrets](https://github.com/EdgeVector/lastsecrets) |
| **Exemem account** | **Not required** for create, invite, or join |

GitHub is the source and review host. Use `gh` for PRs.

---

## Install (new machine)

Needs **macOS Apple Silicon**, [Homebrew](https://brew.sh), and [Bun](https://bun.sh).

CAUTION: Use the required Mini safe upgrade before you install this Org version.

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

`org db create` writes the organization and named-DB records to the personal
registry (`lastdb://personal`).

---

## Invite someone (preferred: public-key seal)

The friend **does not** need an Exemem account. You only need their `orgpk1:…`
public key (from `org receive` on their machine).

For a stranger, mint a non-secret connection-bootstrapping link:

```bash
org invite friends --link --agent
```

The link carries only public organization metadata, a correlation ID, and an
expiry. It never carries the org E2E key. After the recipient installs Org and
consents, the local response is:

```bash
org link accept 'https://thelastdb.com/join/<org-intent-token>'
```

The connection service uses the `orgreply1:…` response to deliver the sealed
invite through its encrypted mailbox. This path avoids a pasted sealed blob.

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
| `org link accept <URL>` | Consent to a non-secret human sharing link |
| `org invite <slug> --to orgpk1:… [--agent]` | Seal invite to friend pubkey (preferred) |
| `org invite <slug> --link [--link-base URL]` | Mint a non-secret human sharing link |
| `org invite <slug> --out FILE [--agent]` | Secret invite file (OOB only) |
| `org join --sealed orgseal1:…` | Join from pubkey-sealed package |
| `org join --from FILE` | Join from secret invite file |
| `org db create/list/show` | Named shared DB metadata in the personal registry |
| `org bind <org> <db> --root PATH` | Map a filesystem root → that DB |
| `org resolve` / `use` / `unuse` / `current` | Write-target resolution |
| `org kanban …` / `org run <app> …` | Resolve DB, then run the app |

---

## What works today vs later

| Works now | Needs more setup / later |
|-----------|---------------------------|
| Create org, invite/join via pubkey seal | Continuous multi-device data sync |
| Membership + E2E key on each friend’s node | Cryptographic member removal (rotate E2E + re-invite remaining members) |
| Named DBs + path bind + app wrapper | Fancy membership UI / People directory |

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
- `org kick` revokes signed membership.
  It keeps the shared org encryption key. A former member can keep prior files.

---

## Development / proof

The tests are deleted (Tom, 2026-10-09). The gate runs the typecheck.

```bash
bun run typecheck
```

Use actual product commands on an owned account for product proof. Do not use a fixture harness.

EdgeVector contributors: use GitHub PRs. See
`.last-stack/pr-venue` and `.lastgit/ci.sh`.

---

## Links

- This app: https://github.com/EdgeVector/org
- LastSecrets: https://github.com/EdgeVector/lastsecrets
- Install / agent brief: https://thelastdb.com/llms.txt
- Invite deep dive: [docs/INVITE.md](docs/INVITE.md)
