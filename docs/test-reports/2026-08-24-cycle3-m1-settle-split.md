# 2026-08-24 — 사이클 3: M1 정산 프로세스 분리 (리서치→구현→적대검증)

> 플랜: docs/specs/m1-settlement-split-plan.md. 유저 확정: M1 착수 / mark는 이벤트 동봉
> (실사 결과 legs가 이미 동봉 — 스키마 변경 불요로 해소).

## 1. 구현 — 신규 `apps/settle` 프로세스 (:5104)
- **settle이 가져간 것**: out 토픽 DB 효과 컨슈머(그룹 `bitshuriken-settle-server`, spot 오케스트레이터
  ·futures 서비스 재사용) + 양 정산 워커 + 원장 프로젝터/드리프트(단독 구동) + 양 마켓 원장 읽기
  레플리카(부팅 리플레이 95.9만 엔트리 실측 + 테일 ≤250ms) + control 토픽 meta 동기화 + F0 셧다운.
- **API 앱 잔류**: 경량 out 컨슈머(DB 쓰기 0 — TR→24h 통계·트리거 클록·WS 팬아웃 with 인메모리
  디덥, OU→주문 read+executionReport 합성), 원장 소유(reserve·저널 append·테일), book/control/
  mark-price 컨슈머, WS·트리거·펀딩·청산·순자산(mark 의존이라 잔류 — 감사 H5와 의도적 편차).
- 구조 정리: WsUserGateway를 UserStreamModule→WsModule로 이동(게이트웨이는 앱 계층 —
  settle 임포트 시 WS 어댑터 크래시가 이를 노출), InsuranceFund 모듈 분리, MARK_READER 토큰.
- exchange.sh 6지점 통합: PATTERNS·포트 5104·기동 BE→settle→엔진(신규 그룹이 out을 처음부터)
  ·staged stop에 settle 단계(BE 뒤·엔진 앞)·status·헬스 게이트.
- 게이트: 빌드 4앱 green, jest 41스위트/415 green, tsc 기존 5건 외 0.

## 2. 적대 검증 — rec150/TPS20 드릴 (M1 이전엔 7심볼도 과부하였던 페이싱)
6분 라이브 (7심볼 미러):
| t | NEW | PENDING | spot | fut | settle |
|---|---|---|---|---|---|
| +1m | 2,581 | 86 | 90% | 87% | 24% |
| +4m | 4,202 (정점) | 69 | 69% | 69% | 50% |
| +6m | 3,564 (**하강**) | **6** | 127% | 103% | 63% |
- **판정: 지속 가능** — PENDING 진동·드레인(정산이 따라감), NEW 정점 후 하강 전환, 부하가
  3프로세스로 실분산. M1 이전 동일 페이싱: NEW +14/s 단조 증가·spot 단일 163% 포화.
- staged stop: settle 워커 quiesce 2/2 + 엔진 최종 스냅샷 2/2 → 재기동 → PENDING 0 →
  **check-integrity 금전 0 fail·패리티 0 fail** (분리 토폴로지에서 F1~F4 첫 클린).
- 부팅 크래시 1건 발견·수정: UserStreamModule의 WS 게이트웨이 동반(위 §1) — 첫 기동은 헬스
  게이트가 잡았고(RESTART FAILED), 게이트웨이 재배치로 해소.

## 3. 충실도 벤치 (rec150/TPS20 × M1, 10분·594틱) — 목표 사슬의 최종 증명
|mid 편차| bps median/p95/p99/max · 스프레드 loc/src · 캔들 worst H/L/C · 볼륨:
- BTCUSDT 0.02/2.20/**2.68**/3.02 · 0.0/0.0 · ≤5.05 · 62.7%
- ETHUSDT 0.31/2.31/4.28/6.34 · 0.1/0.0 · ≤6.07 · 57.4% (프로브 수정 후 첫 완전 측정)
- BTCKRW 0.00/1.46/2.97 · ETHKRW 0.00/1.48/4.45 · USDTKRW 0.00/0.00/3.63 · 7.3/7.3 일치
- **F:BTCUSDT 0.32/2.20/3.63** · F:ETHUSDT 0.96/4.84/6.29 — 선물 미러 최초의 양심볼 완전 추적
- rec300/TPS10 대비 개선 (BTCUSDT p99 5.73→2.68, BTCKRW 5.46→2.97). 선물 볼륨 1.6~2.4%는
  인벤토리 인지 리플레이의 알려진 한계 (가격·타이밍 우선 — 유저 정책).
- 판정: **spot+KRW+선물 7심볼 전부 p99 ≤6.3bps에서 지속 가능** — M1 이전엔 이 페이싱 자체가
  불가능했다. 07-12의 0.22bps는 스팟 전용·일회성 수측정이라 직접 비교 불가; 이 수치가 재현
  가능한 정본 기준선이다.

## 4. 남은 것 (사이클 4 입력)
- **NEW 재고 ~3.5k**: OU ack(NEW→OPEN DB 전이)가 settle 컨슈머 직렬 처리에 묶여 분 단위 랙 —
  매칭·호가는 실시간(엔진), DB 표시만 지연. 실거래소 기준 개선 필요: settle의 OU 배치화 또는
  컨슈머 동시성 상향.
- 감사 A6(컨슈머 poison crash-loop)·A15(DLQ 재적용 도구) — settle 티어로 승격된 리스크.
- kill -9 매트릭스(F4)의 settle 행 드릴 미실시 (staged stop만 검증).
- bench 프로브 틱별 판정 / reduceOnly 클램프 레이스 / clear 검증창 (사이클 1 잔여).
