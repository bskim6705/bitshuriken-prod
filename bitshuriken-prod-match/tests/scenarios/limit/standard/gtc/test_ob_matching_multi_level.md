# LIMIT STANDARD GTC – OB = MATCHING_MULTI_LEVEL 시나리오

가격이 맞는 반대편 레벨이 **여러 개**일 때. 초점은 **다중 레벨 순회에서의 가격 축**이다.

전제:

-   단일 레벨 파일들이 한 가격에서의 수량 관계를 이미 덮는다.
-   `EMPTY` / `NON_MATCHING_SINGLE_LEVEL`이 "매칭이 아예 시작되지 않는" 경우를 덮는다.

그래서 여기의 각 시나리오는:

-   실제로 **2개 이상의 가격 레벨을 통과**해야 한다 (아니면 단일 레벨 테스트로 퇴화한다).
-   매칭이 어디서 멈추고, 잔여가 가격 공간의 **어디에** rest하는지를 검증한다.

---

## 1. BUY taker

### 1.1. 총 잔량보다 작음 – 책 중간에서 정지, rest 없음

-   Given: asks `95:2`, `100:5`, `110:5` (총 12). BUY taker `price=110, qty=4`.
-   Then:
    -   가격-시간 순으로 95 → 100 → (필요하면) 110.
    -   100 레벨을 소비하는 도중 taker 수량이 소진된다: `(taker, ask-95, 95, 2)`, `(taker, ask-100, 100, 2)`.
    -   95 레벨 소멸, 100 레벨 잔량 3, 110 **무접촉**. `ask_prices == [100, 110]`.
    -   taker FILLED, `cumulative_quote_qty == 2×95 + 2×100 = 390`, rest 없음.
    -   dirty 레벨 = `{(SELL, 95, 0), (SELL, 100, 3)}` — depth diff가 정확히 변경된 레벨만 싣는다.
    -   확인하는 것: 레벨을 가격 순으로 걷고, 수량이 소진되면 더 비싼 레벨을 건드리지 않는다.

### 1.2. 처음 N레벨 잔량보다 큼 – 가격 한도에서 정지, 잔여가 taker 가격(스프레드 안)에 rest

-   Given: asks `95:3`, `100:3`, `110:3`. BUY taker `price=105`(100과 110 사이, 105엔 ask 없음), `qty=10`.
-   Then:
    -   95, 100은 `<= taker.price`라 매칭, 110은 `> taker.price`라 **매칭하지 않는다**.
    -   체결 `(taker, ask-95, 95, 3)`, `(taker, ask-100, 100, 3)`. 95·100 레벨 소멸, 110이 새 best ask.
    -   잔여 `10 − 6 = 4`가 bid side **`price = 105`**에 PARTIAL로 rest — 100과 110 사이에 새 레벨.
    -   확인하는 것: rest 가격은 **taker 가격(105)**이지 마지막 체결가(100)가 아니다.

### 1.3. 총 잔량보다 큼 – 전 레벨 관통, 잔여가 마지막 레벨 너머에 rest

-   Given: asks `95:3`, `100:3`, `105:3` (총 9). BUY taker `price=120`(모든 ask보다 좋음), `qty=11`.
-   Then:
    -   95 → 100 → 105 전부 소진(체결 합 9). `best_ask is None`.
    -   잔여 `11 − 9 = 2`가 bid side **`120`**에 rest.
    -   확인하는 것: 매칭 가능한 레벨을 전부 소진한 뒤에야 rest하고, rest 가격은 정확히 taker 가격(120)이지
        체결가(95/100/105)가 아니다.

---

## 2. SELL taker (대칭)

### 2.1. 총 잔량보다 작음 – 책 중간에서 정지

-   Given: bids `110:2`, `105:5`, `95:5`. SELL taker `price=95, qty=4`.
-   Then: 110 → 105 순. `(taker, bid-110, 110, 2)`, `(taker, bid-105, 105, 2)`. 110 소멸, 105 잔량 3, 95 무접촉.
    `bid_prices == [105, 95]`. taker FILLED.

### 2.2. 가격 한도에서 정지 – 잔여가 스프레드 안(100)에 rest

-   Given: bids `110:3`, `105:3`, `95:3`. SELL taker `price=100, qty=10`.
-   Then: 110·105 매칭(`>= 100`), 95는 매칭 안 함. 잔여 4가 ask side **`100`**에 rest. `best_bid == 95`, `best_ask == 100`.

### 2.3. 전 레벨 관통 – 잔여가 마지막 레벨 너머(90)에 rest

-   Given: bids `110:3`, `105:3`, `100:3`. SELL taker `price=90, qty=11`.
-   Then: 전부 소진(9), 잔여 2가 ask side **`90`**에 rest. `best_bid is None`.
