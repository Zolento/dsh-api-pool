#!/usr/bin/env bash
# dsh-api-pool acceptance: unit/integration tests, real composition, and a real
# `dsh web` boot whose relay is probed over HTTP.
#
# The boot uses the installed web profile, so it re-asserts the plugin's
# provider profile in that profile's settings document; the script removes the
# entry again on exit. Set DSH_API_POOL_LIVE=1 to also send one real chat
# completion through the pool (this spends a small amount of the configured
# endpoints' budget).
set -euo pipefail

cd "$(dirname "$0")/.."
PROFILE_FILE="${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"
PORT="${ACCEPTANCE_PORT:-3099}"
LOG="$(mktemp)"
CHILD=""

cleanup() {
  if [ -n "$CHILD" ]; then kill "$CHILD" 2>/dev/null || true; sleep 2; fi
  rm -f "$LOG"
}
trap cleanup EXIT

echo "== 1/4 unit + integration tests =="
node --test test/*.test.js

echo
echo "== 2/4 composed profile entry =="
dsh web --dump-config 2>/dev/null | grep -A 20 '^# == dsh-api-pool' || {
  echo "FAIL: dsh-api-pool is not composed into the web profile" >&2
  exit 1
}

if [ "${ACCEPTANCE_BOOT:-0}" != "1" ]; then
  echo
  echo "== 3/4 real boot skipped (set ACCEPTANCE_BOOT=1) =="
  echo "   Booting re-asserts the shared provider profile in this profile's"
  echo "   settings document, so it is opt-in while another dsh instance may"
  echo "   be serving the same \$DSH_HOME."
  echo
  echo "== 4/4 live completion skipped =="
  echo
  echo "PASS: dsh-api-pool acceptance (offline)"
  exit 0
fi

echo
echo "== 3/4 real boot: relay reachable with the configured endpoints =="
dsh web --port "$PORT" --no-open >"$LOG" 2>&1 &
CHILD=$!

RELAY=""
for _ in $(seq 1 60); do
  for candidate in $(ss -ltnp 2>/dev/null | grep "pid=$CHILD," | grep -oP '127\.0\.0\.1:\K[0-9]+' | grep -v "^${PORT}$" || true); do
    if curl -sf -m 2 "http://127.0.0.1:${candidate}/healthz" | grep -q '"provider":"dsh-api-pool"'; then
      RELAY="$candidate"
      break
    fi
  done
  [ -n "$RELAY" ] && break
  sleep 0.5
done
[ -n "$RELAY" ] || { echo "FAIL: the API pool relay never came up; log:" >&2; cat "$LOG" >&2; exit 1; }
echo "relay: http://127.0.0.1:${RELAY}/v1"
curl -s "http://127.0.0.1:${RELAY}/healthz" | node -e '
let raw = ""; process.stdin.on("data", d => { raw += d }).on("end", () => {
  const health = JSON.parse(raw)
  console.log("endpoints:", health.endpoints.map(e => `${e.name}(${e.state})`).join(", "))
  if (health.endpoints.length === 0) { console.error("FAIL: no endpoints configured"); process.exit(1) }
})'

TOKEN="$(cat "${DSH_HOME:-$HOME/.dsh}/api-pool/relay-token")"

if [ "${DSH_API_POOL_LIVE:-0}" = "1" ]; then
  echo
  echo "== 4/4 live completion through the pool =="
  curl -s -m 180 "http://127.0.0.1:${RELAY}/v1/chat/completions" \
    -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
    -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"Reply with exactly: POOL_OK"}],"max_tokens":16,"temperature":0,"stream":false}' \
    | node -e 'let raw="";process.stdin.on("data",d=>raw+=d).on("end",()=>{const j=JSON.parse(raw);const text=j.choices?.[0]?.message?.content??"";console.log("reply:", JSON.stringify(text));if(!/POOL_OK/.test(text)){console.error("FAIL: unexpected reply");process.exit(1)}})'
else
  echo
  echo "== 4/4 live completion skipped (set DSH_API_POOL_LIVE=1 to enable) =="
fi

echo
echo "PASS: dsh-api-pool acceptance"
# Leave the profile clean: drop the injected provider entry while the plugin is
# stopped (a graceful shutdown normally does this; the probe's SIGTERM may not).
node -e '
const fs = require("fs")
const file = process.argv[1]
if (!fs.existsSync(file)) process.exit(0)
let text = fs.readFileSync(file, "utf8")
const start = text.indexOf("\n      deepseek-pool:\n")
if (start < 0) process.exit(0)
const end = text.indexOf("\n- id:", start + 1)
fs.writeFileSync(file, text.slice(0, start) + (end >= 0 ? text.slice(end) : "\n"))
console.log("profile: removed the injected deepseek-pool entry")
' "$PROFILE_FILE"
