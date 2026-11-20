#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_URL="${API_URL:-http://localhost:3000}"

request_json() {
  local method="$1"
  local url="$2"
  local buyer="${3:-}"
  local body="${4:-}"

  local args=(-sS -X "$method" "$url" -w '\n%{http_code}')
  if [[ -n "$buyer" ]]; then
    args+=(-H "X-Buyer-Id: $buyer")
  fi
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi

  local out
  out="$(curl "${args[@]}")"
  HTTP_CODE="$(printf '%s\n' "$out" | tail -n1)"
  HTTP_BODY="$(printf '%s\n' "$out" | sed '$d')"
}

json_get() {
  local json="$1"
  local expr="$2"
  node -e "const d = JSON.parse(process.argv[1]); console.log($expr);" "$json"
}

echo "1. Health check ($API_URL/healthz)"
request_json GET "$API_URL/healthz"
[[ "$HTTP_CODE" == "200" ]] || { echo "Health failed: $HTTP_CODE $HTTP_BODY"; exit 1; }
echo "   OK -> $HTTP_BODY"

echo "2. Create event (REGULER=10 @ 150000, VIP=5 @ 350000)"
request_json POST "$API_URL/api/events" "" '{
  "title": "Campus Acoustic Night",
  "description": "End-of-semester showcase",
  "venue": "Auditorium UPNVJ",
  "event_date": "2026-12-15T19:00:00+07:00",
  "ticket_types": [
    { "category": "REGULER", "price": 150000, "quota": 10 },
    { "category": "VIP", "price": 350000, "quota": 5 }
  ]
}'
[[ "$HTTP_CODE" == "201" ]] || { echo "Create event failed: $HTTP_CODE $HTTP_BODY"; exit 1; }
EVENT_ID="$(json_get "$HTTP_BODY" "d.id")"
REGULER_ID="$(json_get "$HTTP_BODY" "d.ticket_types.find(t => t.category === 'REGULER').id")"
VIP_ID="$(json_get "$HTTP_BODY" "d.ticket_types.find(t => t.category === 'VIP').id")"
echo "   Event ID: $EVENT_ID"

echo "3. Check remaining quotas"
request_json GET "$API_URL/api/events/$EVENT_ID"
[[ "$HTTP_CODE" == "200" ]] || exit 1
REG_AVAIL="$(json_get "$HTTP_BODY" "d.ticket_types.find(t => t.category === 'REGULER').available_quota")"
VIP_AVAIL="$(json_get "$HTTP_BODY" "d.ticket_types.find(t => t.category === 'VIP').available_quota")"
echo "   REGULER=$REG_AVAIL, VIP=$VIP_AVAIL"

echo "4. Book 2 REGULER tickets (buyer-demo-1)"
request_json POST "$API_URL/api/orders" "buyer-demo-1" "{\"ticket_type_id\":\"$REGULER_ID\",\"quantity\":2}"
[[ "$HTTP_CODE" == "201" ]] || { echo "Book REGULER failed: $HTTP_CODE $HTTP_BODY"; exit 1; }
REG_ORDER_ID="$(json_get "$HTTP_BODY" "d.id")"
request_json GET "$API_URL/api/events/$EVENT_ID"
REG_AVAIL="$(json_get "$HTTP_BODY" "d.ticket_types.find(t => t.category === 'REGULER').available_quota")"
[[ "$REG_AVAIL" == "8" ]] || { echo "Expected REGULER=8, got $REG_AVAIL"; exit 1; }
echo "   Reserved $REG_ORDER_ID -> REGULER left: $REG_AVAIL"

echo "5. Book 2 VIP tickets, then hit 4-ticket buyer limit"
request_json POST "$API_URL/api/orders" "buyer-demo-1" "{\"ticket_type_id\":\"$VIP_ID\",\"quantity\":2}"
[[ "$HTTP_CODE" == "201" ]] || exit 1
VIP_ORDER_ID="$(json_get "$HTTP_BODY" "d.id")"

request_json POST "$API_URL/api/orders" "buyer-demo-1" "{\"ticket_type_id\":\"$REGULER_ID\",\"quantity\":1}"
[[ "$HTTP_CODE" == "409" ]] || { echo "Expected 409 limit, got $HTTP_CODE"; exit 1; }
LIMIT_ERR="$(json_get "$HTTP_BODY" "d.error")"
[[ "$LIMIT_ERR" == "BUYER_LIMIT_EXCEEDED" ]] || exit 1
echo "   5th ticket blocked with 409 ($LIMIT_ERR)"

echo "6. Cancel VIP order and verify immediate quota release"
request_json POST "$API_URL/api/orders/$VIP_ORDER_ID/cancel" "buyer-demo-1"
[[ "$HTTP_CODE" == "200" ]] || exit 1
CANCEL_STATUS="$(json_get "$HTTP_BODY" "d.status")"
[[ "$CANCEL_STATUS" == "CANCELLED" ]] || exit 1
request_json GET "$API_URL/api/events/$EVENT_ID"
VIP_AVAIL="$(json_get "$HTTP_BODY" "d.ticket_types.find(t => t.category === 'VIP').available_quota")"
[[ "$VIP_AVAIL" == "5" ]] || { echo "Expected VIP=5, got $VIP_AVAIL"; exit 1; }
echo "   Cancelled $VIP_ORDER_ID -> VIP left: $VIP_AVAIL"

echo "7. Pay REGULER order via scripts/pay.sh duplicate webhook"
DUP_OUT="$(API_URL="$API_URL" "$SCRIPT_DIR/pay.sh" "$REG_ORDER_ID" duplicate)"
LINE1="$(printf '%s\n' "$DUP_OUT" | sed -n '1p')"
LINE2="$(printf '%s\n' "$DUP_OUT" | sed -n '2p')"
RES1="$(json_get "$LINE1" "d.resolution")"
REPLAY2="$(json_get "$LINE2" "d.idempotent_replay")"
[[ "$RES1" == "PAID_ISSUED" && "$REPLAY2" == "true" ]] || { echo "Unexpected webhook output: $DUP_OUT"; exit 1; }
echo "   1st webhook: $RES1 | 2nd duplicate replay: $REPLAY2"

echo "8. Verify buyer order history & issued tickets"
request_json GET "$API_URL/api/orders" "buyer-demo-1"
[[ "$HTTP_CODE" == "200" ]] || exit 1
request_json GET "$API_URL/api/tickets" "buyer-demo-1"
[[ "$HTTP_CODE" == "200" ]] || exit 1
TKT_COUNT="$(json_get "$HTTP_BODY" "d.tickets.length")"
[[ "$TKT_COUNT" == "2" ]] || { echo "Expected 2 issued tickets, got $TKT_COUNT"; exit 1; }
echo "   Issued tickets for buyer-demo-1: $TKT_COUNT"

echo "9. Simulate late webhook after 15m expiry (buyer-demo-2)"
request_json POST "$API_URL/api/orders" "buyer-demo-2" "{\"ticket_type_id\":\"$VIP_ID\",\"quantity\":1}"
[[ "$HTTP_CODE" == "201" ]] || exit 1
LATE_ORDER_ID="$(json_get "$HTTP_BODY" "d.id")"
LATE_OUT="$(API_URL="$API_URL" "$SCRIPT_DIR/pay.sh" "$LATE_ORDER_ID" late)"
LATE_RES="$(json_get "$LATE_OUT" "d.resolution")"
REFUND_REQ="$(json_get "$LATE_OUT" "d.refund_required")"
[[ "$LATE_RES" == "LATE_EXPIRED_NEEDS_REFUND" && "$REFUND_REQ" == "true" ]] || { echo "Unexpected late output: $LATE_OUT"; exit 1; }
request_json GET "$API_URL/api/events/$EVENT_ID"
VIP_AVAIL="$(json_get "$HTTP_BODY" "d.ticket_types.find(t => t.category === 'VIP').available_quota")"
[[ "$VIP_AVAIL" == "5" ]] || { echo "Expected VIP=5 after late expiry, got $VIP_AVAIL"; exit 1; }
echo "   Late webhook -> $LATE_RES (refund_required=$REFUND_REQ, VIP left=$VIP_AVAIL)"

echo "ALL DEMO FLOW CHECKS PASSED"
