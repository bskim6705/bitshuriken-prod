# 매칭엔진 테스트 설계 (색인)

전부 인프로세스(Kafka 불필요). `venv/bin/python -m pytest -q`. 각 테스트 파일 옆의 같은 이름 `.md`가
그 파일의 설계 근거("무엇을 왜 이렇게 검증하나")다 — 테스트를 고치기 전에 그 문서부터 읽는다.

## 트리

```
tests/
├── scenario_support.py                 # 공용 헬퍼: n()/new_book/limit/market/setup_*/trade_tuples/book_state/불변식 단정
├── test_matcher.py                     # 매칭 코어 기본(중복 id, MARKET, TIF·PO, 가격-시간, cancel, DPD seq, maker 회계)
├── test_snapshot.py / test_snapshot_store.py / test_lane.py / test_control.py   # 복구·레인·상장
├── test_lane_stall_repro.py / test_terminated_dedup_repro.py                    # 사고 재현(07-14, #24)
├── units/orderbook/                    # OrderBook 자료구조 CRUD — .md 4종이 방어/pairwise 차원을 정의
│   ├── test_orderbook_create.{py,md}   #   add: 중복 id + (side × 레벨존재 × 상대가격) S1~S8
│   ├── test_orderbook_read.{py,md}     #   best_* / get_*_levels 순서 S1~S4
│   ├── test_orderbook_delete.{py,md}   #   cancel: unknown + S2~S7(단일/다중/승격)
│   └── test_orderbook_update.{py,md}   #   partial_fill: 방어 + S1~S4
├── scenarios/
│   ├── limit/standard/{gtc,ioc,fok}/   # LIMIT × TIF 시나리오 매트릭스 — 각 폴더에 test_overview.md
│   │   ├── test_ob_empty.{py,md}
│   │   ├── test_ob_non_matching_single_level.{py,md}
│   │   ├── test_ob_matching_single_level_single_maker.{py,md}
│   │   ├── test_ob_matching_single_level_multi_maker.{py,md}
│   │   └── test_ob_matching_multi_level.{py,md}
│   ├── limit/post_only/test_post_only.{py,md}
│   └── market/test_market.{py,md}      # base/quote-driven, MARKET+FOK, Trade 필드, 자전거래, xfail 갭
└── invariants/test_book_invariants_random.{py,md}   # 시드 고정 무작위 시퀀스 불변식 16종
```

원본 설계(`wasd/matching-engine`)는 각 TIF 아래 `stp_none/`으로 STP 축을 예약했다. 이 엔진은 STP가
없어(ADR-007 §7) 그 폴더 층을 두지 않는다 — 쓰지 않는 차원을 위한 구조는 만들지 않는다(feedback-008).
STP 도입 시 같은 자리에 모드별 폴더를 추가한다.

## 시나리오 매트릭스 (LIMIT GTC / IOC / FOK 공통)

축 3개의 곱. 각 셀은 BUY·SELL 대칭으로 2번 검증한다. 상세 근거는 각 폴더의 `test_overview.md`.

| 반대편 책 상태 (OB) | 수량 관계 (QRel) | GTC | IOC | FOK |
|---|---|---|---|---|
| EMPTY | — | OPEN rest | CANCELED | REJECTED |
| NON_MATCHING_SINGLE_LEVEL | — | rest, 반대편 무변경 | CANCELED, 책 무변경 | REJECTED, 책 무변경 |
| MATCHING_SINGLE_LEVEL_SINGLE_MAKER | smaller / equal / larger | 부분·전량·**잔여 rest** | 부분·전량·**잔여 종결(P)** | 전량·전량·**REJECTED** |
| MATCHING_SINGLE_LEVEL_MULTI_MAKER (2,3,4 @100) | smaller / equal / larger | FIFO 소비, 잔여 rest | FIFO, 잔여 종결 | FIFO, 부족하면 REJECTED |
| MATCHING_MULTI_LEVEL (95/100/110…) | 깊이 미만 / 한도 정지 / 전 레벨 | 스프레드 안·너머 rest | 잔여 종결, rest 없음 | **한도 안 합산**으로 판정 |

표기: 가격·수량은 `n("100.5")` = int × 10^8, qtyPrecision 3(step 0.001), pricePrecision 1.

## 원본과의 대응 규칙

| 원본 | 이 엔진 |
|---|---|
| `trades` 튜플 `(taker, maker, price, qty)` | `MatchResult.trades` → `trade_tuples()`로 같은 형태 |
| `cancels`(IOC_LEFTOVER 시스템 취소) | 별도 메시지 없음 — taker `status` P(체결 있음)/C(없음) + `contains` 거짓 + `was_terminated` 참 |
| `OrderReject(reason)` | `status == REJECTED`, `updated_orders == [taker]`, `book_state()` 무변경(seq 포함) |
| FOK: 매칭 후 롤백 | **매칭 전 사전 합산** — 부분 체결 자체가 발생하지 않음 |
| `delta` 목록(`a`/`d`/`u`) | `updated_orders`의 status + `drain_dirty_levels()`의 레벨 잔량 |
| `partially_fill_order`가 `q` 감소 | `partial_fill`이 `executed_qty` 증가 — `remaining_qty`로 단정 |
| `post_only=True` 플래그 | `OrderType.POST_ONLY` 별도 타입 |
| `MARKET_NO_LIQUIDITY` 거부 | CANCELED |

이식하지 않은 것과 이유:
- OrderBook `add`의 타입/범위/심볼/주문타입/TIF 방어, 교차 삽입·내부 손상 `RuntimeError` — 이 엔진은 "검증기가 아니라
  매칭기"(입력 검증은 BE)이고 `add`는 매칭 후에만 호출된다. 같은 불변식을 `invariants/`가 결과 층에서 검사한다.
- `tests/stress`(Kafka 부하 도구) — 이 프로젝트는 `bitshuriken-prod-bots/src/loadtest.ts`가 담당.

## 알려진 갭 (실행 가능한 명세로 남김)

- `scenarios/market/test_market.py::test_quote_fok_never_ends_partial` — **xfail(strict)**. quote-driven MARKET BUY + FOK가
  step floor 때문에 PARTIAL로 끝나는 갭. 엔진 수정 시 마크 제거(`test_market.md` §4).
- `invariants/`는 quote-driven + FOK 조합을 생성하지 않는다(위 갭).
- `main.py`(부팅·라이브 상장·GC·시그널)는 미검증. combined config 모드(spot+futures 한 프로세스)도 미검증이며 lane registry가 symbol만으로, 부팅 워터마크가 partition만으로 키를 잡아 두 마켓이 겹치면 충돌할 수 있는 잠재 버그가 있다 — 프로드는 `MATCH_CONFIG_PATH` 분리 운영만 쓴다.
