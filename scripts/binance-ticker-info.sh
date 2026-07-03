#!/bin/bash
# Fetch Binance ticker info (public API) and extract price/amount precision.
#
# Usage: ./scripts/binance-ticker-info.sh BTCUSDT [SPOT|FUTURES]
#
# SPOT:    https://api.binance.com/api/v3/exchangeInfo
# FUTURES: https://fapi.binance.com/fapi/v1/exchangeInfo

set -e

SYMBOL="${1:-BTCUSDT}"
MARKET="${2:-SPOT}"

if [ "$MARKET" = "SPOT" ]; then
  URL="https://api.binance.com/api/v3/exchangeInfo?symbol=$SYMBOL"
elif [ "$MARKET" = "FUTURES" ]; then
  URL="https://fapi.binance.com/fapi/v1/exchangeInfo"
else
  echo "Usage: $0 SYMBOL [SPOT|FUTURES]"
  exit 1
fi

if [ "$MARKET" = "SPOT" ]; then
  curl -s "$URL" | jq --arg sym "$SYMBOL" '
    .symbols[] | select(.symbol == $sym) | {
      symbol,
      status,
      pricePrecision: .quotePrecision,
      amountPrecision: .baseAssetPrecision,
      filters: (.filters | map(select(.filterType == "PRICE_FILTER" or .filterType == "LOT_SIZE")))
    }
  '
else
  curl -s "$URL" | jq --arg sym "$SYMBOL" '
    .symbols[] | select(.symbol == $sym) | {
      symbol,
      status,
      pricePrecision,
      quantityPrecision,
      filters: (.filters | map(select(.filterType == "PRICE_FILTER" or .filterType == "LOT_SIZE")))
    }
  '
fi
