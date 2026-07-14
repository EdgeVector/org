# Invite a friend to your LastDB org

**Preferred path:** friend installs LastDB → shows their public key → you seal
the org key to that key → they join. The sealed package may travel on any clear
channel (email/Slack). Friend does **not** need an Exemem account.

Only the org admin needs Exemem for cloud-admin features. Identity for invite is
just a **public key** (`orgpk1:…`).

---

## Handshake (both need LastDB + org)

### 1) You → friend: public install link

```text
Install LastDB + apps (includes org):
  see https://thelastdb.com/llms.txt  or  last-stack-install-apps
No Exemem account needed.
```

### 2) Friend: ready for invite

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
lastsecrets init
org init
org receive
```

Friend copies the `orgpk1:…` line (and optional fingerprint) back to you.

### 3) You: seal to their public key

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
# once: lastsecrets init && org init && org create friends --name "Friends"

org invite friends --to 'orgpk1:PASTE_THEIR_KEY' --agent
```

Copy the printed agent text / `orgseal1:…` package to the friend over any channel.

### 4) Friend: join

```bash
org join --sealed 'orgseal1:PASTE_PACKAGE'
# or: org receive --sealed 'orgseal1:…'
org show friends
```

Must use the **same machine** that ran `org receive` (same local private key).

---

## Fallback: secret invite file

When you cannot do the pubkey handshake (AirGap USB, etc.):

```bash
org invite friends --out ~/Desktop/friends.invite.json --agent
# hand the file OOB — it contains the raw e2e key
# friend:
org join --from ~/Downloads/friends.invite.json
```

Never paste invite JSON into email/chat.

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

## Dogfood (developers)

```bash
LS_CLI=~/lastdb-apps/lastsecrets/src/cli.ts \
  scripts/invite-e2e-dogfood.sh
# expect: VERDICT: GREEN
```
