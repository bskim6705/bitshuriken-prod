#!/usr/bin/env bash
# Seed all tickers into prod via the admin API (no repo clone on the server).
# Runs on THIS Mac (reads the local match config) and POSTs to the prod portal.
#
#   ADMIN_API_SECRET=... ./seed-tickers.sh            # create (status=TRADING)
#   ADMIN_API_SECRET=... DRY=1 ./seed-tickers.sh      # print bodies only, no POST
#
# Requires: the X-Admin-Secret must equal ADMIN_API_SECRET in the server .env.prod.
set -euo pipefail

: "${ADMIN_API_SECRET:?set ADMIN_API_SECRET (must match server .env.prod)}"
BASE="${BASE:-https://bitshuriken.com/api}"
CFG="${CFG:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bitshuriken-prod-match/config}"
DRY="${DRY:-0}"
DELAY="${DELAY:-0.15}"   # inter-request pause to avoid rate-limit (429); raise if you see 429s

post_market() { # $1=SPOT|FUTURES  $2=config file
  local mkt="$1" file="$2"
  python3 -c "import json;[print(t['symbol'],t['partition'],t['pricePrecision'],t['qtyPrecision']) for t in json.load(open('$file'))['tickers']]" \
  | while read -r sym part pp qp; do
      base="${sym%USDT}"
      body="{\"market\":\"$mkt\",\"symbol\":\"$sym\",\"baseAsset\":\"$base\",\"quoteAsset\":\"USDT\",\"pricePrecision\":$pp,\"qtyPrecision\":$qp,\"partition\":$part,\"status\":\"TRADING\"}"
      if [ "$DRY" = "1" ]; then echo "$body"; continue; fi
      code=$(curl -s -o /tmp/seed-resp.json -w '%{http_code}' -X POST "$BASE/admin/tickers" \
        -H "X-Admin-Secret: $ADMIN_API_SECRET" -H 'Content-Type: application/json' -d "$body")
      case "$code" in
        200|201) echo "OK    $mkt $sym  p$part" ;;
        409)     echo "EXIST $mkt $sym  (already created)" ;;
        *)       echo "FAIL  $mkt $sym  -> HTTP $code  $(cat /tmp/seed-resp.json)" ;;
      esac
      sleep "$DELAY"
    done
}

post_market SPOT    "$CFG/tickers-spot.json"
post_market FUTURES "$CFG/tickers-futures.json"
echo "done."
