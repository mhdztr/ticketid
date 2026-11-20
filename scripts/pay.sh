#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <order_id> [normal|duplicate|late|failed]" >&2
  exit 1
fi

ORDER_ID="$1"
MODE="${2:-normal}"
API_URL="${API_URL:-http://localhost:3000}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dev-webhook-secret-change-me}"

if [[ "$MODE" == "late" ]]; then
  curl -sS -X POST "$API_URL/api/payments/simulate" \
    -H "Content-Type: application/json" \
    -d "{\"order_id\":\"$ORDER_ID\",\"mode\":\"late\"}"
  echo
  exit 0
fi

STATUS="PAID"
if [[ "$MODE" == "failed" ]]; then
  STATUS="FAILED"
fi

WEBHOOK_ID="WH-$(date +%s)-$$"
BODY="{\"webhook_id\":\"$WEBHOOK_ID\",\"order_id\":\"$ORDER_ID\",\"status\":\"$STATUS\"}"
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"

curl -sS -X POST "$API_URL/api/webhooks/payments" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $SIG" \
  -d "$BODY"
echo

if [[ "$MODE" == "duplicate" ]]; then
  curl -sS -X POST "$API_URL/api/webhooks/payments" \
    -H "Content-Type: application/json" \
    -H "X-Webhook-Signature: $SIG" \
    -d "$BODY"
  echo
fi
