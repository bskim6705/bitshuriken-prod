# ADR-029: 마크 프라이스 — 자체 spot 시장 인덱스 (외부 오라클 없음)

## Status
Accepted

## Context

USDT-margined 무기한 선물에는 mark price가 필요하다 — UPNL 표시, 마진비율/청산 판정, 펀딩 premium의 기준가가 전부 mark에 걸린다. futures last trade price를 그대로 쓰면 얇은 호가에서 체결 한 건으로 mark를 움직여 청산을 연쇄 유발할 수 있어, 실제 거래소들은 체결가와 분리된 mark를 둔다.

bitshuriken은 외부 오라클이 없는 폐쇄 거래소다. index 후보는 3개였다:

1. **자체 spot 시장** — 동일 심볼의 spot last price를 인덱스로
2. **futures 자가참조** — futures 자체 가격(last/mid)으로 mark를 구성
3. **외부 가격 소스** — Binance API 등 외부 시세

futures 자가참조는 자기 시장 체결로 mark를 직접 움직일 수 있어 조작에 취약하고, mark와 비교할 외부 기준이 없어 펀딩 premium 자체가 정의되지 않는다 → 기각. 외부 소스는 폐쇄계 정책 위반에 외부 장애 도메인이 추가된다 → 기각.

## Decision

**index = 자체 spot 시장 동일 심볼 last price의 EMA30s. mark = index에 futures 괴리를 clamp로 제한 반영한 값.**

1. **index 수집**: MarkPriceService가 자체 kafkajs consumer(groupId `bitshuriken-futures-index`)로 `match.spot.out`을 read-only 구독, op=TR만 파싱해 `index[sym] = EMA30s(price)` 갱신. BE 메인 consumer group과 분리된 별도 group이므로 `MARKETS_ENABLED` 조합이 무엇이든(spot 동거 단일 앱·futures 단독 인스턴스) 동일하게 동작한다.
2. **mark 산식** (이 산식이 곧 결정):
   ```
   mark = index + clamp(EMA30s(futures mid − index), ±index × markClampPct)
   ```
   futures mid = OrderBookCache(FUTURES) best bid/ask 중간값. `markClampPct`는 FuturesConfig(DB) 소유.
3. **mid 부재**: futures 호가가 비면 `mark = index`.
4. **index 부재** (부팅 직후 spot 체결 0건): mark 없음 — `getMark()`가 throw 한다. 주문 접수·청산 판정·펀딩이 조용히 잘못된 값으로 돌지 않고 fail loudly.
5. **spot 체결 중단 시 index 동결**: staleness에 의한 거래 정지 없음. 폐쇄계 정책 — 외부 진실이 없으므로 마지막 자체 가격이 곧 최신 진실이다.
6. 연산은 전부 Decimal, floor 8dp. 1s tick으로 계산·캐시·EventEmitter emit, 1분마다 premium 샘플을 FundingScheduler에 적립.

## Rationale

- **자체 spot 채택**: spot은 futures 청산/펀딩 인센티브와 분리된 시장이다. futures 포지션을 가진 쪽이 mark를 움직이려면 spot에서 실제 체결을 만들어야 하므로 자가참조보다 조작 비용이 높고, index가 따로 있어 펀딩 premium이 정의된다.
- **EMA30s**: 단일 체결 스파이크를 평활해 순간 조작/노이즈가 mark에 직결되지 않게 한다.
- **clamp 반영**: futures가 spot과 실제로 괴리됐을 때 mark가 실거래가에 근접해야 청산가가 현실적이다. 다만 무제한 반영은 자가참조 문제를 되살리므로 `±index×markClampPct`로 제한 — Binance식 mark 구조의 축소판.
- **자체 consumer group**: `match.spot.out`은 spot 정산 파이프라인 소유 토픽이다. 같은 group에 끼면 offset을 나눠 갖게 되어 spot 정산이 깨진다. read-only 별도 group이면 spot 무영향이고, 배포 토폴로지(ADR-018 S0~S3)와 무관하게 같은 코드가 동작한다.
- **throw vs 디폴트 가격**: index 부재 시 0이나 seed 가격으로 굴리면 청산 오발동·오결제가 조용히 발생한다. 임의 디폴트 금지([feedback-005](../feedback/005-no-arbitrary-defaults.md))와 fail loudly([feedback-014](../feedback/014-fail-loudly.md))의 적용.
- **동결 vs 정지**: 외부 오라클 거래소의 staleness 정지는 "외부 진실과의 어긋남"을 막는 장치다. 폐쇄계에는 어긋날 외부 진실이 없으므로 정지의 근거도 없다.

## Consequences

- spot에 체결이 최소 1건 있어야 futures가 동작을 시작한다 — 부팅 시나리오에서 spot 체결이 선행돼야 하며, 그 전까지 futures 주문/청산/펀딩은 전부 에러.
- spot 유동성이 곧 mark 품질 — spot이 얇으면 mark도 흔들린다. dev 폐쇄계 수준에서 수용.
- index 동결 중 futures만 움직이면 premium이 clamp 경계에 고정되어 펀딩이 한 방향으로 누적될 수 있다. 해소는 spot 체결로 index를 깨우는 운영 행위.
- 프로세스 재시작 시 EMA 상태가 리셋되어 첫 spot TR까지 `getMark()` throw 구간이 재발한다.
- BE 안에 kafkajs consumer가 1개 추가된다(groupId `bitshuriken-futures-index`).

## 관계

- [ADR-027](027-futures-code-separation-and-deployment.md): futures 코드 분리 — MarkPriceService의 위치(`src/futures/mark-price/`)와 `match.spot.out` read-only 소비 경로
- [ADR-030](030-funding.md): 펀딩 — 본 ADR의 mark/index가 premium 샘플의 입력
- [ADR-031](031-liquidation-insurance-fund.md): 청산 — marginRatio 판정이 mark tick으로 구동됨
- [ADR-018](018-product-prefix-and-deployment-options.md): 배포 옵션 — 자체 consumer group이 모든 토폴로지에서 동일 동작하는 전제
- [ADR-020](020-orderbook-diff-and-be-reconstruction.md): OrderBookCache — futures mid의 소스
- [feedback-005](../feedback/005-no-arbitrary-defaults.md), [feedback-014](../feedback/014-fail-loudly.md): index 부재 시 throw의 근거
