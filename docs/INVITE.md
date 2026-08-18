# Invite a friend to your LastDB org

**Preferred path:** friend installs LastDB + Org → shows a public key → you seal
the org key to that key → they join. The sealed package may travel on any clear
channel (email/Slack/Signal). Friend does **not** need an Exemem account.

Only optional cloud/admin features need an Exemem account later. Invite identity
is just a **public key** (`orgpk1:…`).

---

## Prerequisites (both machines)

| Need | How |
|------|-----|
| macOS Apple Silicon | — |
| Bun | https://bun.sh |
| LastDB Mini running | `brew install edgevector/lastdb/lastdb` + `brew services start lastdb` |
| LastSecrets | https://github.com/EdgeVector/lastsecrets — `bun link` + `lastsecrets init` |
| Org | https://github.com/EdgeVector/org — `bun link` + `org init` |

**Recommended one-shot** (installs org + lastsecrets + other apps):

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
git clone https://github.com/EdgeVector/last-stack ~/.last-stack
~/.last-stack/setup
~/.last-stack/bin/last-stack-install-apps
brew services start lastdb
lastsecrets init
org init
```

Health check (path is `/health`, not `/api/health`):

```bash
curl -s --unix-socket ~/.lastdb/data/folddb.sock http://localhost/health
# expect: {"status":"ok"}
```

---

## Preferred handshake

### 1) You → friend: install pointer

```text
Install LastDB + apps (includes org):
  https://thelastdb.com/llms.txt
  or: last-stack-install-apps from https://github.com/EdgeVector/last-stack
No Exemem account needed.
```

### 2) Friend: ready for invite

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
lastsecrets init   # once per machine
org init           # once per machine
org receive
```

Friend copies the **`orgpk1:…`** line (and optional fingerprint) back to you.
Safe on any channel.

### 3) You: create org (once) + seal to their key

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
# once:
#   lastsecrets init && org init
#   org create friends --name "Friends"

org invite friends --to 'orgpk1:PASTE_THEIR_KEY' --agent
```

Copy the printed **`orgseal1:…`** package (and agent instructions if helpful)
to the friend over any channel. Clear-channel safe — encrypted to their key.

### 4) Friend: join

```bash
org join --sealed 'orgseal1:PASTE_PACKAGE' [--member-name "Your Name"]
# or: org receive --sealed 'orgseal1:…'
org show friends
```

**Must use the same machine** that ran `org receive` (same local private key
under `~/.org/`).

Invites expire (default 72h; admin sets `--expires-in 30m|72h|14d`). An
expired invite is rejected at join with nothing stored — ask for a fresh one.

### 5) Friend → admin: send back the acceptance

`org join` prints a line starting with `acceptance=orgaccept1:…`. Send that
full token back to the admin over any channel — it contains no secrets (it is
encrypted with the org key and self-signed by your member identity).

### 6) Admin: mint the membership epoch

```bash
org member add friends --accept 'orgaccept1:PASTE_TOKEN' [--role member]
org member list friends
```

Membership lands **only** as an owner-signed epoch in the org's registry
chain — there is no mutable member row. Each acceptance is one-time: a
replayed token is rejected and no epoch is minted. To remove someone from the
registry later:

```bash
org kick friends <member_id>       # revocation epoch (non-retroactive)
org member revoke friends <hash>   # separate lever: stop their live cloud sync
```

---

## Fallback: secret invite file

When you cannot do the pubkey handshake (AirGap USB, etc.):

```bash
org invite friends --out ~/Desktop/friends.invite.json --agent
# hand the file OOB — it contains the raw e2e key
# friend:
org join --from ~/Downloads/friends.invite.json
```

Never paste invite JSON into email/chat. Delete the file after join.

---

## Legacy: portable bearer `--claim`

`org invite --to mailto:…` still issues a portable token (AES envelope with
embedded key). Treat that token like a password. Prefer `orgpk1:` sealing.

---

## Security

| On the wire | OK? |
|-------------|-----|
| Install link | Yes |
| Friend `orgpk1:…` public key | Yes |
| `orgseal1:…` package | Yes (encrypted to friend) |
| Raw org E2E key / invite JSON | **No** |

- Kick someone: **rotate** the org E2E key and re-invite remaining pubkeys
  (shared-secret model — deleting a name does nothing if they still have the key).
- Names/People mapping is out of band (or a future People app), not required here.
- Continuous multi-device **data** sync is separate: membership hands out keys;
  Mini cloud sync (`cloud_sync.json` / `lastdb connect`) is what converges
  encrypted org logs across machines.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `command not found: org` | `export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"`; re-run install / `bun link` in the org checkout |
| `App schema not loaded` / missing schema | Re-run `org init` on a current Mini (`brew upgrade lastdb` / Last Stack install) |
| `join --sealed` fails after `receive` on another laptop | Sealed packages bind to the **receive** keypair; re-run `org receive` on the join machine and re-invite |
| `org show` works but friend never sees your writes | Cloud sync not enabled on both nodes — membership alone is local; see Mini cloud sync docs |
| Health check fails | `brew services start lastdb`; socket `~/.lastdb/data/folddb.sock` |

---

## Dogfood (developers)

Boots two throwaway Mini homes and proves the preferred public-key path:
friend `org receive` → admin `org invite --to orgpk1:… --agent` → friend
`org join --sealed` → `org show`.

```bash
# from an org checkout
LS_CLI=~/lastdb-apps/lastsecrets/src/cli.ts \
  # or: LS_CLI=~/.host-track/apps/lastsecrets/current/src/cli.ts
  scripts/invite-e2e-dogfood.sh
# expect: VERDICT: GREEN
```

Never points either home at the primary `~/.lastdb` brain.
