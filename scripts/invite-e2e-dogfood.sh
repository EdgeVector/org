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
# Debug lastdbd UDS workers overflow the default stack on schema declare.
export RUST_MIN_STACK="${RUST_MIN_STACK:-33554432}"

BUN="${BUN:-$(command -v bun)}"
LASTDBD="${LASTDBD:-$(command -v lastdbd)}"
ROOT_REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
ORG_CLI="${ORG_CLI:-$ROOT_REPO/src/cli.ts}"
# LS_CLI is resolved below (ts source or PATH lastsecrets).

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 127; }; }
need bun
need lastdbd
need curl
need jq
[ -f "$ORG_CLI" ] || { echo "missing ORG_CLI=$ORG_CLI" >&2; exit 2; }
if [ -z "${LS_CLI:-}" ]; then
  if [ -f "$ROOT_REPO/../lastsecrets/src/cli.ts" ]; then
    LS_CLI="$ROOT_REPO/../lastsecrets/src/cli.ts"
  elif [ -f "$HOME/lastdb-apps/lastsecrets/src/cli.ts" ]; then
    LS_CLI="$HOME/lastdb-apps/lastsecrets/src/cli.ts"
  elif command -v lastsecrets >/dev/null; then
    LS_CLI="$(command -v lastsecrets)"
  else
    echo "set LS_CLI=path/to/lastsecrets/src/cli.ts or install lastsecrets" >&2
    exit 2
  fi
fi
export ORG_LASTSECRETS_BIN="${ORG_LASTSECRETS_BIN:-$LS_CLI}"

org_cmd() { "$BUN" "$ORG_CLI" "$@"; }
ls_cmd() {
  if [[ "$LS_CLI" == *.ts ]]; then
    "$BUN" "$LS_CLI" "$@"
  else
    "$LS_CLI" "$@"
  fi
}

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
org_cmd create friends --name "Friends Dogfood" --socket "$SOCK_I" \
  >"$ROOT/create.out" 2>"$ROOT/create.err" || fail "org create"
grep -q "HTTP 400" "$ROOT/create.err" && fail "create printed HTTP 400" || ok "create has no HTTP 400"
org_cmd db create friends shared --name "Shared DB" --socket "$SOCK_I" \
  >"$ROOT/db-create.out" 2>"$ROOT/db-create.err" || fail "org db create"
grep -q "shared" "$ROOT/db-create.out" && ok "named db friends/shared" || fail "named db create"

# --- friend: install/init/register local receive identity ---
start_node "$FRIEND_HOME" friend
export HOME="$FRIEND_HOME"
export LASTDB_HOME="$FRIEND_HOME/.lastdb"
SOCK_F="$LASTDB_HOME/data/folddb.sock"

ls_cmd init --socket "$SOCK_F"
org_cmd init --socket "$SOCK_F"
org_cmd receive --json --socket "$SOCK_F" >"$ROOT/friend-receive.json"
FRIEND_PUBKEY="$(jq -r .public_key "$ROOT/friend-receive.json")"
FRIEND_FINGERPRINT="$(jq -r .fingerprint "$ROOT/friend-receive.json")"
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
org_cmd join --sealed "$SEALED" --socket "$SOCK_F" \
  >"$ROOT/join.out" 2>"$ROOT/join.err" || fail "org join"
grep -q "HTTP 400" "$ROOT/join.err" && fail "join printed HTTP 400" || ok "join has no HTTP 400"
cat "$ROOT/join.out"
org_cmd db create friends shared --name "Shared DB" --socket "$SOCK_F" \
  >"$ROOT/friend-db-create.out" 2>"$ROOT/friend-db-create.err" || fail "friend db create"
org_cmd list --socket "$SOCK_F" | tee "$ROOT/friend-list.txt"
org_cmd show friends --socket "$SOCK_F" | tee "$ROOT/friend-show.txt"

grep -q 'friends' "$ROOT/friend-list.txt" && ok "friend lists org" || fail "friend list"
grep -Eq 'member|Friends' "$ROOT/friend-show.txt" && ok "friend show org" || fail "friend show"
ls_cmd list --socket "$SOCK_F" | tee "$ROOT/friend-secrets.txt"
grep -q 'org-friends-e2e' "$ROOT/friend-secrets.txt" && ok "friend lastsecrets metadata" || fail "friend secret"

A_HASH="$(jq -r .userHash "$INVITER_HOME/.org/config.json")"
B_HASH="$(jq -r .userHash "$FRIEND_HOME/.org/config.json")"
if [ -n "$A_HASH" ] && [ "$A_HASH" != "$B_HASH" ]; then
  ok "distinct identities ${A_HASH:0:12} ${B_HASH:0:12}"
else
  fail "identities not isolated"
fi

LOCATOR="lastdb://org/friends/shared"
PROBE_SCHEMA='{
  "namespace": "dogfoodprobe",
  "schema": {
    "name": "DogfoodProbeMarker",
    "descriptive_name": "DogfoodProbeMarker",
    "purpose_statement": "Named-locator isolation probe unique 20260916",
    "schema_type": "Hash",
    "key": { "hash_field": "probe_id" },
    "fields": ["probe_id", "probe_body"],
    "field_types": { "probe_id": "String", "probe_body": "String" },
    "field_descriptions": { "probe_id": "marker id", "probe_body": "payload" },
    "field_classifications": { "probe_body": ["word"] },
    "field_data_classifications": {
      "probe_id": { "sensitivity_level": 0, "data_domain": "metadata" },
      "probe_body": { "sensitivity_level": 0, "data_domain": "metadata" }
    }
  }
}'
curl -sS --unix-socket "$SOCK_I" \
  -H "Content-Type: application/json" \
  -H "X-LastDB-Client: org-two-node-dogfood" \
  -H "X-LastDB-Db: $LOCATOR" \
  -d "$PROBE_SCHEMA" \
  http://localhost/api/schemas/declare >"$ROOT/declare.json" || true
SCHEMA_NAME="$(jq -r '.schema_name // .schema // .local_schema // empty' "$ROOT/declare.json")"
[ -z "$SCHEMA_NAME" ] && SCHEMA_NAME="dogfoodprobe/DogfoodProbeMarker"
# Owner catalog put is the producer for membership even if declare composed.
curl -sS --unix-socket "$SOCK_I" \
  -H "Content-Type: application/json" \
  -H "X-LastDB-Client: org-two-node-dogfood" \
  -d "{\"db_locator\":\"$LOCATOR\",\"schema_name\":\"$SCHEMA_NAME\"}" \
  http://localhost/api/db/catalog >"$ROOT/catalog-put.json" || true
if grep -q "$SCHEMA_NAME\|db_locator" "$ROOT/catalog-put.json"; then
  ok "catalog put $SCHEMA_NAME"
else
  fail "catalog put (body=$(head -c 240 "$ROOT/catalog-put.json"))"
fi

MUTATE="$(jq -nc --arg s "$SCHEMA_NAME" '{type:"mutation",schema:$s,mutation_type:"create",key_value:{hash:"M",range:null},fields_and_values:{probe_id:"M",probe_body:"org-only-payload"}}')"
QUERY="$(jq -nc --arg s "$SCHEMA_NAME" '{schema_name:$s,fields:["probe_body","probe_id"],filter:{HashKey:"M"},limit:10,offset:0}')"
curl -sS --unix-socket "$SOCK_I" -H "Content-Type: application/json" \
  -H "X-LastDB-Client: org-two-node-dogfood" -H "X-LastDB-Db: $LOCATOR" \
  -d "$MUTATE" http://localhost/api/mutation >"$ROOT/mutate-org.json" || true
curl -sS --unix-socket "$SOCK_I" -H "Content-Type: application/json" \
  -H "X-LastDB-Client: org-two-node-dogfood" \
  -d "$QUERY" http://localhost/api/query >"$ROOT/query-personal.json" || true
curl -sS --unix-socket "$SOCK_I" -H "Content-Type: application/json" \
  -H "X-LastDB-Client: org-two-node-dogfood" -H "X-LastDB-Db: $LOCATOR" \
  -d "$QUERY" http://localhost/api/query >"$ROOT/query-org.json" || true
grep -q "org-only-payload" "$ROOT/query-org.json" && ok "C: org-handle read sees marker M" \
  || fail "C: org-handle missed M ($(head -c 200 "$ROOT/query-org.json"))"
if grep -q "org-only-payload" "$ROOT/query-personal.json"; then
  fail "B: personal read leaked org marker M"
else
  ok "B: personal read does not see org marker M"
fi
grep -q "catalog_membership_denied" "$ROOT/query-personal.json" \
  && ok "personal query fail-closed or empty for org marker" || true

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
