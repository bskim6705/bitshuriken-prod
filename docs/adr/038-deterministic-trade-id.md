# ADR-038: Deterministic trade ids (idempotent re-emission)

## Status
Accepted (2026-06-14)

## Context
Settlement is idempotent against duplicate `TR` messages via a UNIQUE `sourceKey =
tradeId` on `SettlementEvent` (the BE swallows the P2002 and skips the second
settlement). This only works if the **same logical trade always carries the same
tradeId**.

The engine previously built ids as `f"{symbol}-{epoch}-{trade_seq}"`, where
`epoch` was the wall-clock ms captured at book construction (or restored from a
snapshot) and `trade_seq` a per-book counter. The id was therefore deterministic
only *within one boot or across a snapshot-restore*. On a **fresh boot that
re-processes already-consumed input** (e.g. recovery without a snapshot, a topic
recreation, or a consumer offset reset — see ADR-034), the engine re-matched the
same orders and re-emitted the same trades with a **new epoch → new tradeId**,
bypassing the BE dedup and **double-settling**: `executedQty` reached `2×origQty`
and released locks twice, driving `Wallet.locked` negative.

This was observed live: a matched buyer/seller pair both showed `executedQty =
0.2` on `origQty = 0.1`, backed by two `Trade` rows for the same match with
different epoch-based ids.

## Decision
Derive the trade id from the matched orders, not from wall-clock time:

```
tid = f"{maker_order_id}-{taker_order_id}"
```

A taker fills each maker **at most once** per match (a partial maker fill means
the taker is exhausted and the loop ends; a full maker fill removes the maker),
so `(maker_order_id, taker_order_id)` uniquely identifies every trade. Order ids
are BE-assigned UUIDs that are stable across replays, so re-processing the same
input yields **identical** tids — and the BE's `sourceKey` idempotency then
absorbs any re-emission.

The now-unused `epoch` / `trade_seq` / `next_trade_id` machinery (and their
snapshot fields) were removed.

## Rationale
- The fix lives entirely in id generation; the BE idempotency was already
  correct and is unchanged.
- `(maker, taker)` is collision-free without a counter, so no per-order state or
  snapshot field is needed — strictly simpler than the epoch scheme.
- Defends double-settlement regardless of *why* the engine replays, complementing
  (not replacing) the recovery/offset handling in ADR-034.

## Consequences
- Engine restart / replay is now idempotent end-to-end: verified live — repeated
  match-engine restarts add zero new over-fills while trades keep flowing.
- New regression test `test_tid_deterministic_across_fresh_boots` asserts two
  fresh books produce identical tids for the same input.
- One-time migration cost: trades settled under the old `symbol-epoch-seq` scheme
  have ids that don't match their new-scheme re-emission, so a restart crossing
  the format change can double-settle those specific older trades once. Pre-fix
  corrupt rows are historical and must be reconciled out of band.
- tradeId is no longer human-time-sortable; ordering uses `Trade.seq`
  (autoincrement) and `executedAt`, which already existed.
