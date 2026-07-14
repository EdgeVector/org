# Invite a friend to your LastDB org

## You (inviter) — already have LastDB

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# once
lastsecrets init
org init

# create (or reuse) an org
org create friends --name "Friends"

# recommended: secret file + pasteable agent instructions
org invite friends --agent --out ~/Desktop/friends.invite.json
```

Then:

1. **Copy the text printed to stdout** into email/chat (safe — no encryption key).
2. **Send `friends.invite.json` separately** (AirDrop, Signal, 1Password). Treat it like a password.
3. After they join, both of you can delete the invite file.

### Alternative (CLI-only friend)

```bash
org invite friends --out ~/Desktop/friends.invite.json
# hand them the file + docs/INVITE.md “Friend” section
```

### Sealed claim (no invite JSON file)

```bash
org invite friends --to mailto:friend@example.com --agent
```

Prints pasteable agent instructions that include a **portable sealed claim
token** (not the raw e2e key). Friend (or their agent) runs:

```bash
org join --claim '<paste-token-exactly>'
```

The token is a secret bearer — send only to the intended person (email/Signal
OK; do not post publicly). Cryptography is AES-256-GCM; Exemem messaging can
replace the transport later without changing this CLI.

---

## Friend (invitee)

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# full cold install
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/EdgeVector/last-stack ~/.last-stack
~/.last-stack/setup
~/.last-stack/bin/last-stack-install-apps
brew services start lastdb

lastsecrets init
org init

# after you receive the invite file
org join --from ~/Downloads/friends.invite.json
org list
org show friends

# delete the invite file
rm ~/Downloads/friends.invite.json
```

Optional shared project root (if inviter told you a db name):

```bash
org bind friends company --root ~/code/shared-project
cd ~/code/shared-project
org kanban list
```

---

## What works today vs not yet

| Works | Not yet (post–1.0 multiplayer) |
|-------|--------------------------------|
| Create org + LastSecrets keys | Multi-writer cloud sync of org data |
| Secret-file invite + join | Always-on Exemem sealed invite |
| Pasteable `--agent` instructions | Browser one-click join |
| Folder bind + `org kanban …` | Full product membership UI / revoke |

---

## Security

- Never paste invite JSON into email, Slack, Brain, or Kanban.
- Prefer `--out` (mode `0600`) over printing the invite to stdout.
- Agents must not run `lastsecrets get` on org keys unless the human explicitly
  asks for a recovery workflow.

## Dogfood (developers)

Isolated inviter → friend join (two throwaway `lastdbd` homes, primary node untouched):

```bash
# from org checkout; lastsecrets source next door or set LS_CLI=
LS_CLI=~/lastdb-apps/lastsecrets/src/cli.ts \
  scripts/invite-e2e-dogfood.sh
# expect: VERDICT: GREEN
```
