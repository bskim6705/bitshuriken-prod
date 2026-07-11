# 리팩토링 중 발견한 관찰/버그 후보 (2026-06-12, 트리아지 2026-06-22)

> 리팩토링 phase 1~4 진행 중 에이전트들이 발견. **원칙에 따라 수정하지 않고 기록만** — 리팩토링 커밋과 동작 변경을 분리하기 위함. 각 건은 유저 판단 후 별도 수정.

## 버그 후보 — 2026-06-22 트리아지: #1 FIXED, #2/#3 OPEN, #4 의도된 동작(주석화). 2026-07-11: #2/#3 FIXED

1. **[심각] OCO 생성 크래시 윈도우** — `createOcoList` tx 커밋 후 limit leg NO 발행 전 크래시 시, 부트 복구(`recoverList`)에 "EXECUTING + 양 레그 NEW + stopPendingAt null" 분기가 없어 limit NO가 영원히 미전송 → 잠금 자금 고착. 이후 stop 트리거 시 엔진-unknown limit에 CO 발행. (order-list)
   - **✅ FIXED (2026-06-22)**: 엔진 멱등성(`OrderBook.contains` + `submit_new_order`가 이미 resting인 id의 중복 NEW 무시) + `recoverList` 크래시윈도우 분기(limit NO 재드라이브, stop 재arm은 trigger.service:38이 담당). 엔진은 정의상 미체결 limit만 대상이라 안전. 테스트: matcher dedup + recoverList 크래시윈도우. pytest 44/44, jest order-list 27/27. **부수효과: 기존 복구 분기들(stop NO 재전송 등)의 이중전송 리스크도 제거**.
2. **OCO 취소 vs arming 레이스** — arming claim 커밋~NO emit 사이에 cancelList가 CO를 먼저 emit하면 파티션에서 CO가 NO를 앞질러 유저 취소가 소실된 채 stop 레그가 엔진에 잔존. (order-list)
   - ~~**VERIFIED STILL-PRESENT**: `order-list.service.ts:318-327,364-379`. 코드 주석(line 369 "레이스 패배")이 인지하나 방어 CO는 역방향만 보호. kafkajs `send()`는 호출 간 순서보장 없음([kafka.service.ts:29-35]).~~
   - **✅ FIXED (2026-07-11)**: arming 경로가 NO ack **후** `cancelRequested`를 재확인하고 추격 CO 전송(`redriveCancelIfRequested` — NO ack 뒤 전송이라 파티션 순서 보장, 중복 CO는 엔진이 unknown 무시). 부트 복구에 cancelRequested 재드라이브 분기 추가: 미트리거=로컬 취소, armed NEW=NO 재드라이브(엔진 멱등) 후 CO, 엔진 거주=CO. 테스트: 추격 CO 인터리빙 + 복구 3분기. jest order-list 34/34.
3. **trigger NO 전송 실패 dead path** — fire 실패 시 registry는 복원되지만 triggeredAt claim이 박혀 있어 다음 trade 재발화가 무전송. armed-but-unsent 상태가 다음 부팅 복구까지 지속. (trigger)
   - ~~**VERIFIED STILL-PRESENT (알려진 한계)**: `trigger.service.ts:65,71-89,112-127`. spec:344-360이 "세션 내 재발화 무전송, 부트 복구 의존"으로 명시. catch가 DB triggeredAt claim을 롤백 못 함.~~
   - **✅ FIXED (2026-07-11)**: 단일 주문 — claim 유지한 채 5s 주기 재전송 루프(`redriveArmedNo`, 매회 DB status 재확인으로 이중전송 가드 — 부트 복구와 동일 패턴; status가 NEW를 벗어나면 중단). OCO 레그 — 발화 실패 마커(`ocoRedrive`)로 다음 trade에서 가격 조건 없이 재발화하고, claim 선점 상태의 유실 CO/NO를 `onStopTriggered(leg, redrive=true)`가 재드라이브. jest trigger 21/21, 전체 289/289.
4. **상장 직후 검증 우회** — last price 부재 시 stop 즉시-트리거 검사와 market-like SELL minNotional 검사가 생략됨. (order-validation)
   - **의도된 동작으로 결론 (2026-06-22, 주석 명확화함)**: #4a stop 즉시트리거는 *체결가* 기준이라 거래 0건이면 트리거 불가→skip이 정상(버그 아님). #4b market SELL minNotional은 lastPrice 없으면 추정 불가→placement skip은 의도적(빈 책이면 미체결, dust는 정산 처리). 무리한 reject는 정상 첫 주문 과잉차단이라 미수정. `order.service.ts`·`order-validation.ts` 주석에 의도 명시.

## 일관성/설계 관찰 (현재 무해)

5. **ROUND_DOWN vs ROUND_FLOOR** — `settlement.service.ts` 수수료 절사가 ROUND_DOWN(0방향), shared floor8는 ROUND_FLOOR(−∞방향). 피연산자가 실질 양수라 결과 동일하나 음수에서 1비트 다른 함수. 통일 여부 판단 필요.
6. **OCO 0원 환불 멱등성** — 전량 체결 finalize 시 listref 이벤트 row가 안 생겨 멱등성이 sourceKey가 아닌 status claim에만 의존.
7. **liquidation restoreNormal** — count===0(worker가 먼저 복귀)에도 "released" 로그 출력.
8. **LIQUIDATING 순간 노출** — claim 직후 재검증 통과 시 fuser로 LIQUIDATING→NORMAL이 연달아 emit.
9. **futures placeOrder 검증 순서** — 필드 normalize가 LIQUIDATING 체크보다 먼저 실행(주석의 순서 표기와 미세 불일치, 동작 영향 없음).
10. **DEFAULT_LEVERAGE=10 3중 동기화** — Prisma 스키마 기본값 / BE futures-trading / FE 주문 폼이 수동 동기화 전제.
11. **partitionOf 캐시 중복** — FuturesTradingService와 LiquidationExecutor가 각자 보유.
12. **cancel-replace 비원자** — 신규 placement 후 cancelSingle 실패 시 두 주문·두 잠금 공존(코드 주석에 인지된 동작).
13. **cancelSingle의 OCO dust 가드 도달 불가** — 모든 호출 경로가 사전 라우팅. 방어 코드.
14. **stop registry.add가 tx 커밋 후** — 커밋~add 사이 크래시 시 rehydrate까지 트리거 평가 누락(부트 복구로 회복됨).
15. **spot/futures API 필드명 불일치** — 요청 DTO가 spot `tickerSymbol`/futures `symbol`. FE 통일은 BE DTO 변경(계약 변경)이 선행돼야 해서 보류.
16. **FE lib/hooks 시장별 훅 중복** — `useTrades` vs `useFuturesTrades` 등 react-query 훅 쌍이 잔존(Phase 4 승인 범위 외). 통합 시 queryKey 체계 재설계 필요.
17. **단일 stop 취소 vs 발화 NO 앞지름 (2026-07-11 추가)** — `cancelSingle`이 armed stop에 보내는 CO가 발화/재전송 NO보다 먼저 파티션에 닿으면 엔진이 무시(#2와 동형이나 Order에는 cancelRequested 필드가 없어 같은 패턴 적용 불가). NO가 자리잡은 뒤(OPEN) 유저가 재취소하면 해결되고, #3 수정으로 armed-but-unsent 고착이 사라져 윈도우가 좁아짐. 근본 해결은 Order에 취소 의도 영속화(예: `cancelRequestedAt`) 후 #2 패턴 적용 — 스키마 변경이라 유저 판단. (order)
18. **[심각·미해결] 정산 워커 poison 이벤트가 FIFO 드레인 영구 차단 (2026-07-12, 첫 미러링 실행에서 검출)** — `FuturesSettlementWorker`가 적용 불가 이벤트 하나(관측된 트리거: `futures USDT wallet not found`)에서 throw하면 FIFO 순서상 뒤 이벤트가 전부 PENDING 고착, 매 tick 무한 재시도(정산 파이프라인 정지). poison 이벤트 격리/스킵/DLQ/quarantine 부재. 실제로 130건이 고착됐고 F1c(exec=Σ체결)·F4(locked) 불일치로 하네스가 자동 검출. 방아쇠는 dev 크로스마켓 충돌(test-report 2026-07-12 F#1, up.sh 2-인스턴스 분리로 수정)이었으나 **임의의 적용 불가 이벤트가 전체 정산을 멈추는 로버스트니스 갭은 프로드에서도 위험**. spot `SettlementWorker`도 동형 여부 검토 필요. 근본 해결: 실패 이벤트 N회 후 격리(별도 status/DLQ) + 알람, 후속 이벤트 진행. (settlement)
