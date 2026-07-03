# ADR-063: 매칭 파티션 버킷화(symbol-hash) + key 라우팅 복구 + 스냅샷 STW 완화

## Status
Accepted (2026-06-18)

## Context
ADR-013은 "1 partition = 1 ticker"로 심볼당 파티션을 핀했다. 자가호스팅 타깃이 **구형 Intel
듀얼코어 + 5400rpm HDD**(ADR-062)로 정해지면서, spot 50 + futures 47 심볼 × 4토픽(in/out/book/state)
= ~388 파티션이 HDD 랜덤 I/O·부팅 복구에 부담이라는 문제가 드러났다. 파티션 수는 심볼 수에 묶여
있어 코어 수로 줄일 수 없었다. 또 단일 스레드 매칭 루프가 스냅샷 직렬화까지 떠안아, 오더북이 커지면
STW(stop-the-world) pause가 전체 lane을 멈춘다.

## Decision
1. **파티션 = 버킷(P=6), 심볼은 `FNV-1a(symbol) % P`로 배정.** 파티션 수를 심볼 수에서 분리.
   심볼-결정적 함수라 config 파일 3종(tickers-spot/futures/tickers.json)·seed·BE-produce가 항상 일치
   (파일 순서·index 무관). ~388 → ~48 파티션.
2. **핫루프는 message key(symbol)로 라우팅.** 여러 심볼이 한 파티션을 공유하므로 `(topic,partition)`
   대신 `registry.get(msg.key())`. BE는 `in` produce에 `key=symbol` 첨부(15개 produce 지점 + kafka.service).
   엔진은 P개 파티션 전부 assign 후 key로 lane 식별. 심볼별 ordering은 "한 심볼=한 파티션" 유지로 보존.
3. **복구는 per-symbol skip replay (ADR-062 합의 A안).** state 스냅샷은 심볼별 유지(작음·pause 제한).
   파티션별 assign offset = 그 파티션 스냅샷 lane들의 `min(last_offset+1)`. 핫루프 skip:
   - 스냅샷 lane: `msg.offset() <= last_offset` 이면 skip(이미 반영, 책 이중적용 방지).
   - 빈 책 lane: `msg.offset() < boot_hw[partition]` 이면 skip(빈 책에 과거 replay=가짜 매칭 방지).
   idle drag는 봇 연속 미러링(심볼당 1.5s)으로 모든 lane이 30s마다 스냅샷 → min이 HW−30s 이내로 bound.
   엔진이 state를 `lane.partition`(config)에 produce하므로 config==DB partition 일치가 **복구 정합성의 전제**
   (그래서 symbol-hash로 강제 일치).
4. **스냅샷 STW 완화(in-loop, 분리 안 함).** ADR-062에서 별도 복구 프로세스 분리는 2코어 박스엔 이득이
   작아 보류. 대신: **L1 orjson**(직렬화 5~10×, bytes 반환), **L3 GC 제어**(`gc.disable()`+복구 후 `gc.freeze()`,
   순환 수거는 poll 유휴 틈에만). 청크 스냅샷(L2)은 봇 bounded 북(~40주문)엔 불필요해 보류.
5. **분리 seam만 확보.** `out`은 이미 완전한 order-level changelog(OPEN/PARTIAL/FILLED/CANCELED + 잔량)라
   추후 별도 folding 스냅샷터로 복구를 분리 가능. 단 그때 `out`에 **소스 `in` offset 태깅**이 필요(현재 미구현).

## Consequences
- 파티션 ~48로 감소 → HDD I/O·부팅 복구 부담↓. 듀얼코어 단일 컨슈머에 충분.
- 파티션 수는 이제 자유 파라미터(`MATCH_*_PARTITIONS`, 기본 6) — 심볼 추가해도 안 늘어남.
- **불변식**: 엔진 config partition == DB `Ticker.partition` == BE produce partition. 전부 `FNV-1a(symbol)%P`
  라 자동 성립. P를 바꾸면 config 재생성 + `prisma db seed`(update도 partition 반영) + 토픽 재생성 필요.
- 기존 DB는 재시드로 partition 재배정(seed update 브랜치가 partition 갱신). 토픽 파티션 수 변경은 신규 토픽 필요.
- pytest 39/39 green(공유 파티션 복구 테스트 추가). BE typecheck clean.
- STW: 평상시 스냅샷 sub-ms(orjson). 북이 수천 주문으로 커지면 L2(청크) 후속 — 또는 복구 분리(seam 활용).
- ADR-013의 "1 partition = 1 ticker"는 본 ADR로 대체. Lane 패턴·1인스턴스 N ticker·JSON config는 유지.
