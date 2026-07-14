#!/usr/bin/env bash
# Isolated inviter -> friend org invite dogfood.
# Boots two throwaway lastdbd homes; never touches the primary ~/.lastdb node.
#
# Usage:
#   scripts/invite-e2e-dogfood.sh
#   ORG_CLI=path/to/org/src/cli.ts LS_CLI=path/to/lastsecrets/src/cli.ts scripts/invite-e2e-dogfood.sh
#
# Exit 0 = GREEN, 1 = RED.
set -euo pipefail

export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"
unset LASTDB_DB || true

BUN="${BUN:-$(command -v bun)}"
LASTDBD="${LASTDBD:-$(command -v lastdbd)}"
ROOT_REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
ORG_CLI="${ORG_CLI:-$ROOT_REPO/src/cli.ts}"
# Prefer sibling lastsecrets checkout, else PATH lastsecrets via bun
if [ -z "${LS_CLI:-}" ]; then
  if [ -f "$ROOT_REPO/../lastsecrets/src/cli.ts" ]; then
    LS_CLI="$ROOT_REPO/../lastsecrets/src/cli.ts"
  elif [ -f "$HOME/lastdb-apps/lastsecrets/src/cli.ts" ]; then
    LS_CLI="$HOME/lastdb-apps/lastsecrets/src/cli.ts"
  else
    echo "set LS_CLI=path/to/lastsecrets/src/cli.ts" >&2
    exit 2
  fi
fi

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 127; }; }
need bun
need lastdbd
need curl
need python3
[ -f "$ORG_CLI" ] || { echo "missing ORG_CLI=$ORG_CLI" >&2; exit 2; }
[ -f "$LS_CLI" ] || { echo "missing LS_CLI=$LS_CLI" >&2; exit 2; }
export ORG_LASTSECRETS_BIN="${ORG_LASTSECRETS_BIN:-$LS_CLI}"

org_cmd() { "$BUN" "$ORG_CLI" "$@"; }
ls_cmd() { "$BUN" "$LS_CLI" "$@"; }

ROOT="$(mktemp -d /tmp/org-invite-dogfood.XXXXXX)"
INVITER_HOME="$ROOT/inviter"
FRIEND_HOME="$ROOT/friend"
mkdir -p "$INVITER_HOME" "$FRIEND_HOME"
SEALED_FILE="$ROOT/friends.sealed.txt"
FAILS=0
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
ok() { echo "OK $*"; }

PRIMARY_SOCK="${PRIMARY_SOCK:-$HOME/.lastdb/data/folddb.sock}"
if [ -S "$PRIMARY_SOCK" ]; then
  echo "primary health: $(curl -s --unix-socket "$PRIMARY_SOCK" http://localhost/health || echo unreachable)"
fi
echo "dogfood root: $ROOT"

start_node() {
  local home="$1" name="$2"
  export LASTDB_HOME="$home/.lastdb"
  mkdir -p "$LASTDB_HOME"
  "$LASTDBD" --data-dir "$LASTDB_HOME" >"$home/lastdbd.out" 2>"$home/lastdbd.err" &
  echo $! >"$home/lastdbd.pid"
  local sock="$LASTDB_HOME/data/folddb.sock"
  local i
  for i in $(seq 1 40); do
    if [ -S "$sock" ]; then
      ok "$name socket (${i})"
      return 0
    fi
    sleep 0.25
  done
  fail "$name no socket"
  tail -20 "$home/lastdbd.err" || true
  return 1
}

stop_node() {
  local home="$1"
  if [ -f "$home/lastdbd.pid" ]; then
    kill "$(cat "$home/lastdbd.pid")" 2>/dev/null || true
    wait "$(cat "$home/lastdbd.pid")" 2>/dev/null || true
  fi
}

cleanup() {
  stop_node "$INVITER_HOME" || true
  stop_node "$FRIEND_HOME" || true
}
trap cleanup EXIT

# --- inviter: create the org ---
start_node "$INVITER_HOME" inviter
export HOME="$INVITER_HOME"
export LASTDB_HOME="$INVITER_HOME/.lastdb"
SOCK_I="$LASTDB_HOME/data/folddb.sock"

ls_cmd init --socket "$SOCK_I"
org_cmd init --socket "$SOCK_I"
org_cmd create friends --name "Friends Dogfood" --socket "$SOCK_I"

# --- friend: install/init/register local receive identity ---
start_node "$FRIEND_HOME" friend
export HOME="$FRIEND_HOME"
export LASTDB_HOME="$FRIEND_HOME/.lastdb"
SOCK_F="$LASTDB_HOME/data/folddb.sock"

ls_cmd init --socket "$SOCK_F"
org_cmd init --socket "$SOCK_F"
org_cmd receive --json --socket "$SOCK_F" >"$ROOT/friend-receive.json"
FRIEND_PUBKEY="$(python3 -c "import json; print(json.load(open('$ROOT/friend-receive.json'))['public_key'])")"
FRIEND_FINGERPRINT="$(python3 -c "import json; print(json.load(open('$ROOT/friend-receive.json'))['fingerprint'])")"
case "$FRIEND_PUBKEY" in
  orgpk1:*) ok "friend receive public key fingerprint=$FRIEND_FINGERPRINT" ;;
  *) fail "friend receive did not produce orgpk1 public key" ;;
esac

# --- inviter: seal to friend's public key and copy agent instructions ---
export HOME="$INVITER_HOME"
export LASTDB_HOME="$INVITER_HOME/.lastdb"
org_cmd invite friends --to "$FRIEND_PUBKEY" --agent --out-sealed "$SEALED_FILE" --socket "$SOCK_I" \
  >"$ROOT/agent-instructions.txt" 2>"$ROOT/agent-stderr.txt" || fail "invite --to orgpk1 --agent"
cat "$ROOT/agent-stderr.txt" || true

[ -f "$SEALED_FILE" ] && ok "sealed package file mode=$(stat -f %Lp "$SEALED_FILE" 2>/dev/null || stat -c %a "$SEALED_FILE")" || fail "sealed package file missing"
grep -q 'e2e_key' "$ROOT/agent-instructions.txt" && fail "instructions contain e2e_key" || ok "no e2e_key in instructions"
grep -q 'orgseal1:' "$ROOT/agent-instructions.txt" && ok "sealed package present in instructions" || fail "missing sealed package"
grep -q 'org join --sealed' "$ROOT/agent-instructions.txt" && ok "sealed join command present" || fail "missing sealed join command"
grep -q 'last-stack-install-apps' "$ROOT/agent-instructions.txt" && ok "public install path present" || fail "missing install path"
grep -q 'org join --from' "$ROOT/agent-instructions.txt" && fail "instructions point to secret-file fallback" || ok "no secret-file join path in preferred instructions"
SEALED="$(grep -Eo 'orgseal1:[A-Za-z0-9_-]+' "$ROOT/agent-instructions.txt" | head -1 || true)"
[ -n "$SEALED" ] && ok "sealed package extracted" || fail "sealed package extraction"
if [ -s "$SEALED_FILE" ]; then
  FILE_SEALED="$(tr -d '\n\r\t ' <"$SEALED_FILE")"
  [ "$FILE_SEALED" = "$SEALED" ] && ok "sealed file matches instructions" || fail "sealed file mismatch"
fi

# --- friend: join with sealed package on the same receive identity ---
export HOME="$FRIEND_HOME"
export LASTDB_HOME="$FRIEND_HOME/.lastdb"
org_cmd join --sealed "$SEALED" --socket "$SOCK_F"
org_cmd list --socket "$SOCK_F" | tee "$ROOT/friend-list.txt"
org_cmd show friends --socket "$SOCK_F" | tee "$ROOT/friend-show.txt"

grep -q 'friends' "$ROOT/friend-list.txt" && ok "friend lists org" || fail "friend list"
grep -Eq 'member|Friends' "$ROOT/friend-show.txt" && ok "friend show org" || fail "friend show"
ls_cmd list --socket "$SOCK_F" | tee "$ROOT/friend-secrets.txt"
grep -q 'org-friends-e2e' "$ROOT/friend-secrets.txt" && ok "friend lastsecrets metadata" || fail "friend secret"

python3 - <<PY
import json
inv = json.load(open("$INVITER_HOME/.org/config.json"))
fr = json.load(open("$FRIEND_HOME/.org/config.json"))
assert inv["userHash"] != fr["userHash"], "identities not isolated"
print("OK distinct identities", inv["userHash"][:12], fr["userHash"][:12])
PY

if [ -S "$PRIMARY_SOCK" ]; then
  echo "primary health: $(curl -s --unix-socket "$PRIMARY_SOCK" http://localhost/health || echo unreachable)"
fi

echo "FAILS=$FAILS artifacts=$ROOT"
if [ "$FAILS" -eq 0 ]; then
  echo "VERDICT: GREEN"
  exit 0
fi
echo "VERDICT: RED"
exit 1
