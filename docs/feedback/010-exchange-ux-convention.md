# Feedback-010: 거래소 UI는 거래소 컨벤션을 따른다 (에디토리얼/아트 방향 금지)

## Rule
암호화폐 거래소 프론트는 Binance/OKX/Bybit/Gate.io 등 업계 컨벤션을 1차 레퍼런스로 삼는다. 에디토리얼 타이포, 거대한 디스플레이 폰트, 아트북 풍 레이아웃은 쓰지 않는다.

## Why
- 거래소는 도구. 사용자는 빠르게 호가창/차트/주문폼을 스캔하고 조작해야 한다. 예술성보다 정보 밀도가 우선
- 트레이더는 다른 거래소에서 습득한 시각 언어(녹/적 방향, 오더북 밀집, 얇은 헤더 멀티 내비)를 그대로 가져온다. 컨벤션 이탈은 학습비용
- 거대한 헤드라인/이탤릭 디스플레이는 마케팅 사이트 언어. 거래 화면의 `<h1>`은 심볼 이름 한 줄로 충분
- 조도/채도 튀는 악센트(강한 朱색 등)는 상승/하락 시그널 색과 경합. 액센트는 CTA 최소 영역에 제한

## How to apply
- **레퍼런스**: Binance spot/futures, OKX trade, Bybit spot이 표준. 레이아웃 의심되면 이들 스크린 먼저 확인
- **색**:
  - base `#0b0e11`, surface `#181a20`, raised `#1e2329`
  - line `#2b3139`, line-strong `#474d57`
  - text `#eaecef`, dim `#848e9c`, muted `#5e6673`
  - up/bid `#0ecb81`, down/ask `#f6465d`
  - accent는 CTA/브랜드 최소 영역 (예: `#fcd535` Binance yellow 계열)
- **타이포**: 디스플레이 폰트(Fraunces 등) 금지. Geist/Inter 계열 sans 하나로 통일. 숫자는 `font-variant-numeric: tabular-nums`
- **크기**: label 11px, 데이터 12~13px, 헤더 14~16px. h1이 있더라도 20px를 넘지 않는다
- **밀도**: 테이블 row-height 32~40px, 셀 padding 8~12px. 호가창 row-height ~22px
- **레이아웃**: 트레이드 페이지는 좌(orderbook) / 중(chart + 포지션 탭) / 우(order form + trades) 3컬럼 표준. 디스플레이 hero/마케팅 섹션 금지
- **호가창**: 가격 왼쪽, 수량 오른쪽. depth를 셀 배경에 그라데이션으로 시각화 (bid: 좌→우 녹 fade, ask: 우→좌 적 fade)
- **헤더**: 48~56px 얇게. logo + 다중 내비(Markets/Trade/Futures/Earn/Wallet 등) + 우측(Search/Notifications/Wallet/Orders/Profile)
- **랜딩(/)**: 로그아웃 상태면 간결한 마케팅 + 티커. 로그인 상태면 /markets 또는 /trade로 리다이렉트. 편집적 카피/거대 타이포 없음
