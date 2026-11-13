#!/usr/bin/env bash
# Checks that the live Vercel demo is up and that the testnet accounts it
# depends on still have enough NEAR to keep running. Exits non-zero if
# anything looks unhealthy, so it works as a CI / cron gate as well as a
# manual check. Needs nothing but curl + python3 — no repo secrets, no
# near-cli-rs, no npm install.
#
# Usage: ./scripts/check-deploy-health.sh [live-url]
set -uo pipefail

LIVE_URL="${1:-https://meridian-zeta-murex.vercel.app}"
RPC_URL="${NEAR_RPC_URL:-https://rpc.testnet.fastnear.com}"
OWNER="${OWNER_ACCOUNT_ID:-vivek-meridian.testnet}"

# yoctoNEAR thresholds below which we warn (NEAR * 1e24)
VAULT_MIN_SPENDABLE_NEAR=2
BREAK_AGENT_MIN_NEAR=1
DEMO_OWNER_MIN_NEAR=1

status=0
warn() { echo "WARN: $1"; status=1; }
ok() { echo "OK:   $1"; }

echo "== Live site: $LIVE_URL =="

home_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$LIVE_URL/")
if [ "$home_code" = "200" ]; then ok "home page -> 200"; else warn "home page -> $home_code"; fi

break_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$LIVE_URL/break")
if [ "$break_code" = "200" ]; then ok "/break page -> 200"; else warn "/break page -> $break_code"; fi

break_api=$(curl -s --max-time 15 "$LIVE_URL/api/break")
enabled=$(echo "$break_api" | python3 -c "import json,sys; print(json.load(sys.stdin).get('enabled'))" 2>/dev/null)
if [ "$enabled" = "True" ]; then
  ok "/api/break -> enabled"
else
  warn "/api/break not enabled or unreachable (got: $break_api)"
fi

echo
echo "== Testnet balances (RPC: $RPC_URL) =="

balance_yocto() {
  curl -s --max-time 15 "$RPC_URL" -X POST -H "content-type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | python3 -c "import json,sys
try:
    d=json.load(sys.stdin)
    print(d['result']['amount'] + ' ' + str(d['result']['storage_usage']))
except Exception:
    print('0 0')"
}

check_min() {
  local account="$1" min_near="$2" is_vault="$3"
  read -r amount_yocto storage_bytes <<< "$(balance_yocto "$account")"
  near=$(python3 -c "print(round(int('$amount_yocto') / 1e24, 4))")
  if [ "$is_vault" = "1" ]; then
    locked=$(python3 -c "print(round(int('$storage_bytes') * 1e19 / 1e24, 4))")
    spendable=$(python3 -c "print(round($near - $locked, 4))")
    echo "$account: $near NEAR total, ~$locked NEAR locked for storage ($storage_bytes bytes), ~$spendable NEAR spendable"
    if python3 -c "exit(0 if $spendable < $min_near else 1)"; then
      warn "$account has only ~$spendable NEAR of storage headroom (< $min_near)"
    else
      ok "$account storage headroom ~$spendable NEAR"
    fi
  else
    echo "$account: $near NEAR"
    if python3 -c "exit(0 if $near < $min_near else 1)"; then
      warn "$account balance ~$near NEAR (< $min_near)"
    else
      ok "$account balance ~$near NEAR"
    fi
  fi
}

check_min "vault.$OWNER" "$VAULT_MIN_SPENDABLE_NEAR" 1
check_min "break-agent.$OWNER" "$BREAK_AGENT_MIN_NEAR" 0
check_min "demo-owner.$OWNER" "$DEMO_OWNER_MIN_NEAR" 0

echo
if [ "$status" = "0" ]; then
  echo "All checks passed."
else
  echo "One or more checks failed — see WARN lines above."
fi
exit $status
