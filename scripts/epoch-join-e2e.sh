#!/usr/bin/env bash
# Two-node membership-epoch journey (card org-member-sealed-invite-join):
#   owner A creates org → friend B receives → A seals invite to B's pubkey →
#   B joins + returns acceptance → A mints epoch 1 → registry lists B →
#   cross-node signature verification → replay rejected → expired invite
#   rejected → kick mints revocation epoch.
# Boots two throwaway lastdbd homes; NEVER touches the primary ~/.lastdb node.
# Exit 0 = GREEN, 1 = RED.
set -euo pipefail

export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"
unset LASTDB_DB || true

BUN="${BUN:-$(command -v bun)}"
LASTDBD="${LASTDBD:-$(command -v lastdbd)}"
ROOT_REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
ORG_CLI="${ORG_CLI:-$ROOT_REPO/src/cli.ts}"
if [ -z "${LS_BIN:-}" ]; then
  LS_BIN="$(command -v lastsecrets || true)"
fi

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 127; }; }
need bun
need lastdbd
need jq
[ -f "$ORG_CLI" ] || { echo "missing ORG_CLI=$ORG_CLI" >&2; exit 2; }
[ -n "$LS_BIN" ] || { echo "lastsecrets CLI not found; set LS_BIN" >&2; exit 2; }
export ORG_LASTSECRETS_BIN="$LS_BIN"

org_cmd() { "$BUN" "$ORG_CLI" "$@"; }

# Short root: unix sockets cap at 103 bytes (sockaddr_un).
ROOT="$(mktemp -d /tmp/org-epoch-e2e.XXXXXX)"
A_HOME="$ROOT/owner"
B_HOME="$ROOT/friend"
mkdir -p "$A_HOME" "$B_HOME"
FAILS=0
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
ok() { echo "OK $*"; }

start_node() {
  local home="$1" name="$2"
  mkdir -p "$home/.lastdb"
  "$LASTDBD" --data-dir "$home/.lastdb" >"$home/lastdbd.out" 2>"$home/lastdbd.err" &
  echo $! >"$home/lastdbd.pid"
  local sock="$home/.lastdb/data/folddb.sock"
  local i
  for i in $(seq 1 40); do
    if [ -S "$sock" ]; then
      ok "$name node up"
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
  stop_node "$A_HOME" || true
  stop_node "$B_HOME" || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

start_node "$A_HOME" owner
start_node "$B_HOME" friend
SOCK_A="$A_HOME/.lastdb/data/folddb.sock"
SOCK_B="$B_HOME/.lastdb/data/folddb.sock"

as_owner() {
  HOME="$A_HOME" LASTDB_HOME="$A_HOME/.lastdb" ORG_MEMBER_IDENTITY_PATH="$A_HOME/.org/member-seal.json" "$@"
}
as_friend() {
  HOME="$B_HOME" LASTDB_HOME="$B_HOME/.lastdb" ORG_MEMBER_IDENTITY_PATH="$B_HOME/.org/member-seal.json" "$@"
}

# --- setup ---
as_owner "$LS_BIN" init --socket "$SOCK_A" >/dev/null
as_owner org_cmd init --socket "$SOCK_A" >/dev/null
as_owner org_cmd create friends --name "Friends" --owner-name "Owner A" --socket "$SOCK_A" \
  | grep -q "signed genesis epoch=0" && ok "A created org + genesis" || fail "A create/genesis"

as_friend "$LS_BIN" init --socket "$SOCK_B" >/dev/null
as_friend org_cmd init --socket "$SOCK_B" >/dev/null
as_friend org_cmd receive --json --socket "$SOCK_B" >"$ROOT/receive.json"
B_PUBKEY="$(jq -r .public_key "$ROOT/receive.json")"
B_MEMBER_ID="$(jq -r .fingerprint "$ROOT/receive.json")"
ok "B receive identity ($B_MEMBER_ID)"

# --- invite → join → acceptance ---
as_owner org_cmd invite friends --to "$B_PUBKEY" --socket "$SOCK_A" >"$ROOT/invite.out" 2>"$ROOT/invite.err"
SEALED="$(grep -o 'sealed_package=.*' "$ROOT/invite.out" | cut -d= -f2-)"
[ -n "$SEALED" ] && ok "A sealed invite to B pubkey" || fail "no sealed_package"
grep -q "invite expires_at=" "$ROOT/invite.err" && ok "invite carries expiry" || fail "no expiry line"

as_friend org_cmd join --sealed "$SEALED" --member-name "Friend B" --socket "$SOCK_B" >"$ROOT/join.out"
grep -q "joined organization slug=friends" "$ROOT/join.out" && ok "B joined" || fail "B join"
ACCEPT="$(grep -o 'acceptance=orgaccept1:[^ ]*' "$ROOT/join.out" | cut -d= -f2-)"
[ -n "$ACCEPT" ] && ok "B produced acceptance token" || fail "no acceptance token"

# Registry still owner-only before accept.
as_owner org_cmd member list friends --socket "$SOCK_A" >"$ROOT/list0.out"
grep -q "registry org=friends epoch=0" "$ROOT/list0.out" && ok "registry epoch 0 pre-accept" || fail "pre-accept registry"
grep -q "$B_MEMBER_ID" "$ROOT/list0.out" && fail "B in registry before accept" || ok "B absent before accept"

# --- owner accepts: epoch 1 ---
as_owner org_cmd member add friends --accept "$ACCEPT" --socket "$SOCK_A" >"$ROOT/accept.out"
grep -q "signed epoch=1" "$ROOT/accept.out" && ok "A minted epoch 1" || fail "accept mint"

as_owner org_cmd member list friends --json --socket "$SOCK_A" >"$ROOT/list1.json"
B_SIGN_PK="$(jq -r --arg id "$B_MEMBER_ID" '.members[] | select(.member_id==$id) | .sign_pk' "$ROOT/list1.json")"
B_STATUS="$(jq -r --arg id "$B_MEMBER_ID" '.members[] | select(.member_id==$id) | .status' "$ROOT/list1.json")"
B_ADDED="$(jq -r --arg id "$B_MEMBER_ID" '.members[] | select(.member_id==$id) | .added_epoch' "$ROOT/list1.json")"
[ -n "$B_SIGN_PK" ] && [ "$B_STATUS" = "active" ] && [ "$B_ADDED" = "1" ] \
  && ok "A lists B from epoch 1 (sign_pk present)" || fail "B listing ($B_STATUS/$B_ADDED)"

as_owner org_cmd epoch verify friends --socket "$SOCK_A" | grep -q "epoch chain ok: epochs=2" \
  && ok "chain verifies (epochs=2)" || fail "chain verify post-accept"

# --- cross-node signature verification ---
SIG="$(as_friend "$BUN" "$ROOT_REPO/scripts/e2e-sign-payload.ts" 1)"
as_owner "$BUN" "$ROOT_REPO/scripts/e2e-verify-payload.ts" "$B_SIGN_PK" "$SIG" 1 | grep -q VERIFY_OK \
  && ok "B's signature verifies against epoch sign_pk on A" || fail "cross-node verify"
if as_owner "$BUN" "$ROOT_REPO/scripts/e2e-verify-payload.ts" "$B_SIGN_PK" "$SIG" 2 >/dev/null 2>&1; then
  fail "tampered payload verified (should fail)"
else
  ok "tampered payload rejected"
fi

# --- replay rejection ---
if as_owner org_cmd member add friends --accept "$ACCEPT" --socket "$SOCK_A" >"$ROOT/replay.out" 2>"$ROOT/replay.err"; then
  fail "replayed acceptance was accepted"
else
  grep -q "replay" "$ROOT/replay.err" && ok "replay rejected" || fail "replay error unclear"
fi
as_owner org_cmd epoch verify friends --socket "$SOCK_A" | grep -q "epochs=2" \
  && ok "no epoch minted on replay" || fail "epoch count changed on replay"

# --- expiry rejection (join side; accept side is unit-tested) ---
as_owner org_cmd invite friends --to "$B_PUBKEY" --expires-in 1ms --socket "$SOCK_A" >"$ROOT/exp.out" 2>/dev/null
SEALED_EXPIRED="$(grep -o 'sealed_package=.*' "$ROOT/exp.out" | cut -d= -f2-)"
sleep 0.1
if as_friend org_cmd join --sealed "$SEALED_EXPIRED" --socket "$SOCK_B" >"$ROOT/expjoin.out" 2>"$ROOT/expjoin.err"; then
  fail "expired invite joined"
else
  grep -q "expired" "$ROOT/expjoin.err" && ok "expired invite rejected at join" || fail "expiry error unclear"
fi
as_owner org_cmd epoch verify friends --socket "$SOCK_A" | grep -q "epochs=2" \
  && ok "no epoch minted from expired invite" || fail "epoch count changed on expiry"

# --- kick: revocation epoch ---
as_owner org_cmd kick friends "$B_MEMBER_ID" --socket "$SOCK_A" >"$ROOT/kick.out"
grep -q "signed epoch=2" "$ROOT/kick.out" && ok "kick minted epoch 2" || fail "kick mint"
as_owner org_cmd member list friends --json --socket "$SOCK_A" >"$ROOT/list2.json"
B_STATUS2="$(jq -r --arg id "$B_MEMBER_ID" '.members[] | select(.member_id==$id) | .status' "$ROOT/list2.json")"
[ "$B_STATUS2" = "revoked" ] && ok "B revoked in registry" || fail "B status after kick: $B_STATUS2"
as_owner org_cmd epoch verify friends --socket "$SOCK_A" | grep -q "epochs=3" \
  && ok "chain verifies after kick (epochs=3)" || fail "chain verify post-kick"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "GREEN: epoch-join e2e passed"
  exit 0
fi
echo "RED: $FAILS failure(s)"
exit 1
