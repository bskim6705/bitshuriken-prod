# ADR-012: 유저 샤딩 고려와 보류 — 거래소 도메인의 cross-user 문제

## Status
Accepted (refines [ADR-001](001-single-db-with-market-type.md))

## Context
[ADR-001](001-single-db-with-market-type.md)에서 단일 DB + MarketType enum 구조를 선택했고, 향후 유저별 샤딩을 염두에 두었다. 이번 라운드에서 매칭 결과를 받아 잔고를 정산하는 흐름을 설계하면서 유저 샤딩의 실현 가능성을 다시 검토했다.

검토 결과: **거래소 도메인에서는 유저별 wallet 샤딩이 본질적으로 어렵다**. cross-user trade가 분산 트랜잭션을 강제하기 때문이다.

## Problem

trade 한 건은 항상 두 명의 유저(maker, taker)의 wallet을 동시에 변경한다.

```
Trade BTC/USDT:
  Alice (BUY):  +0.1 BTC, -5,000 USDT
  Bob   (SELL): -0.1 BTC, +5,000 USDT
```

만약 Alice와 Bob이 서로 다른 wallet shard에 속한다면, 이 trade의 settlement는 **분산 트랜잭션**이 된다. 거래소는 어떤 두 유저든 매칭될 수 있으므로, cross-shard trade는 일반적이고 빈번하다.

## Considered Options

### Option 1: 2PC (Two-Phase Commit)
분산 트랜잭션 코디네이터로 두 shard에 commit/abort 결정. ACID 보장.
- ❌ 느림 (네트워크 라운드트립)
- ❌ 코디네이터 단일 장애점
- ❌ 거래소 처리량에 부적합. 거의 안 씀.

### Option 2: Saga + 보상 트랜잭션
A 차감 → B 증가 → 실패 시 A 롤백.
- ❌ 일관성 윈도우 동안 잔고가 이상하게 보임
- ❌ 보상 로직 복잡, 실패 케이스가 폭발
- ❌ 사용자 신뢰 문제 ("내 잔고가 잠깐 사라졌다 돌아왔다")

### Option 3: Outbox + 비동기 propagation
한 쪽 트랜잭션 안에서 outbox 테이블에 기록 → 워커가 다른 shard로 전파. 최종 일관성.
- ❌ 사용자가 일시적 잔고 불일치를 봄
- ❌ 거래소에서 잔고는 즉시성이 생명. 부적합.

### Option 4: 분산 SQL (Spanner / CockroachDB / TiDB / FoundationDB)
DB 레이어에서 cross-shard ACID 보장.
- ✅ 진짜 ACID 유지
- ⚠️ 운영 비용 큼
- ⚠️ 일부는 lock 경합으로 throughput 제약
- 일부 글로벌 거래소가 사용

### Option 5: Wallet 샤딩 자체를 안 함 — vertical scale + (필요 시) 분산 SQL 마이그레이션
- ✅ Cross-shard 문제 자체가 없어짐
- ✅ 가장 단순
- ⚠️ DB 단일 인스턴스의 한계까지만 동작
- ✅ 한계 도달 시 분산 SQL로 마이그레이션하면 됨 (Aurora → CockroachDB 같은 경로)
- 대부분의 중소형 거래소가 이 길

## Decision

**Wallet은 샤딩하지 않는다.** 단일 DB로 운영하고, 병목이 오면 vertical scale → 그래도 부족하면 분산 SQL로 마이그레이션한다.

매칭엔진은 ticker별로 partition/instance 샤딩을 유지한다 ([ADR-011](011-ticker-partition-strategy.md)). 이는 cross-user 문제와 무관하다 (매칭은 각 ticker 안에서만 일어남).

## Rationale

- **거래소 wallet은 cross-user 트랜잭션이 본질**: 어떤 두 유저든 매칭될 수 있어 sharding으로 격리할 수 없다.
- **즉시 일관성 요구**: 사용자가 잔고를 실시간으로 신뢰해야 함. 최종 일관성 모델은 부적합.
- **vertical scale의 여유가 큼**: 현대 PostgreSQL/Aurora는 수만 TPS까지 처리. 톱티어 거래소가 아니면 단일 DB로 충분.
- **분산 SQL 옵션의 존재**: 진짜 한계가 오면 마이그레이션 경로가 있음. 미리 샤딩의 복잡도를 떠안을 이유가 없음.
- **다른 차원의 수평 확장은 유효**: 매칭엔진(ticker), API gateway(stateless), market data(read-only), 사용자 인증(read-heavy) 등은 자유롭게 수평 확장 가능.

## Consequences

### 즉각적 영향 (없음)
- 현재 단일 DB 구조 그대로 유지
- 코드/스키마 변경 없음
- ADR-001은 superseding 하지 않고 refine — "유저 샤딩 고려"는 검토 후 보류로 결론

### 장기 영향
- DB 병목 시 대응 순서:
  1. Vertical scale (인스턴스 사양 ↑)
  2. Read replica 분리 (조회 트래픽 분산)
  3. 일부 데이터 분리 (예: trade history는 별도 DB로)
  4. 분산 SQL (CockroachDB/Spanner) 마이그레이션
- "Settlement Router + user-partitioned wallet update topic" 같은 구조는 만들지 않음. 단순함 유지.

### 만약 미래에 정말 wallet 샤딩이 필요해지면 (재논의 트리거)
- vertical scale 한계 도달 + read replica로 해결 안 됨 + 분산 SQL이 부적합한 특수 사유
- 그때 별도 ADR로 wallet shard 정책 + cross-shard trade 처리 정책을 함께 결정

## 관계
- [ADR-001](001-single-db-with-market-type.md): "유저 샤딩 고려" 부분을 보류로 refine.
- [ADR-011](011-ticker-partition-strategy.md): ticker partition은 wallet과 무관, 그대로 유효.
