#!/usr/bin/env bash
# dsh-loop acceptance:
#   1. unit + integration tests (node --test, fake/manual clocks);
#   2. bundle composition in an isolated DSH_HOME profile (no --patch needed);
#   3. a REAL `dsh` boot whose probe reports, from inside the running process,
#      that the `dsh-loop` row is active, the `loop` service is provided, and
#      `/loop` is registered in the command registry.
#
# Everything runs against a throwaway DSH_HOME and an alternate port, so a
# developer's own harness (and its relay ports) is never touched.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PORT="${ACCEPTANCE_PORT:-3099}"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-loop-accept-XXXXXX")"
REPORT="$HOME_DIR/probe.json"
LOG="$HOME_DIR/boot.log"
CHILD=""

cleanup() {
  if [ -n "$CHILD" ]; then
    kill "$CHILD" 2>/dev/null || true
    sleep 1
    kill -9 "$CHILD" 2>/dev/null || true
  fi
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

echo "== 1/3 unit + integration tests =="
if [ ! -d node_modules/@deepseek-ai/dsh-tools ]; then
  node scripts/link-dsh.mjs
fi
node --test test/*.test.js

echo
echo "== 2/3 composed profile layer =="
DSH_HOME="$HOME_DIR" dsh plugin --profile web add "$ROOT" >"$LOG" 2>&1
DSH_HOME="$HOME_DIR" dsh --profile web --dump-config 2>/dev/null | grep -A 2 '^# == dsh-loop' || {
  echo "FAIL: dsh-loop is not composed into the profile" >&2
  exit 1
}

echo
echo "== 3/3 real boot: active row, provided service, registered command =="
cat > "$HOME_DIR/accept.patch.yml" <<EOF
- insert:
    - id: loop-acceptance-probe
      name: '$ROOT/test/acceptance-probe.js'
      config:
        reportPath: '$REPORT'
EOF
DSH_HOME="$HOME_DIR" dsh --profile web --patch "$HOME_DIR/accept.patch.yml" \
  --port "$PORT" --no-open >"$LOG" 2>&1 &
CHILD=$!

for _ in $(seq 1 60); do
  [ -f "$REPORT" ] && break
  sleep 1
done

if [ ! -f "$REPORT" ]; then
  echo "FAIL: the acceptance probe never reported; boot log:" >&2
  grep -v '?token=' "$LOG" >&2 || true
  exit 1
fi

node -e '
const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
console.log(JSON.stringify(report, null, 2))
if (!report.ok) {
  console.error("FAIL: the loop plugin is not fully live in the booted profile")
  process.exit(1)
}
' "$REPORT"

echo
echo "PASS: dsh-loop acceptance"
