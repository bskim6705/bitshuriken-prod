# ADR-006: Order 클래스에 `__slots__` 적용

## Status
Accepted

## Context
매칭엔진은 동시에 수십만~수백만 개의 Order 인스턴스를 호가창에 유지할 수 있다. Python의 일반 클래스 인스턴스는 속성을 `__dict__`에 저장하기 때문에 인스턴스당 메모리 오버헤드가 크다. 이 오버헤드를 줄여야 한다.

처음에는 "속성명을 축약하면(`price` → `p`) 메모리가 줄지 않을까?" 하는 아이디어도 검토했다.

## Decision
Order 클래스에 `__slots__`을 적용한다. 속성명은 풀네임(`id`, `user_id`, `price`, `amount`, ...)으로 유지한다.

```python
@dataclass
class Order:
    __slots__ = ("id", "user_id", "symbol", "market", "type", "side",
                 "price", "amount", "filled", "status", "ts")
    id: str
    user_id: str
    ...
```

## Rationale

### `__slots__`의 효과
- `__dict__`을 제거하고 속성을 C 배열처럼 고정 슬롯에 저장.
- 인스턴스당 메모리를 약 **30~40% 절감**.
- 속성 접근(`order.price`)도 약간 빠름.
- `dataclass`와 호환됨 (Python 3.10+에서는 `@dataclass(slots=True)`도 가능).

### 왜 속성명 축약은 의미가 없는가
- Python은 같은 문자열을 **interning**한다. `"price"`라는 문자열은 인터프리터 전체에서 1번만 메모리에 존재한다.
- Order 인스턴스가 100만 개 있어도 `__dict__`의 key string `"price"`는 메모리에 1개. `"p"`로 줄여도 1개 → 1개. 절감 효과 0.
- 속성명 축약은 가독성만 손해이고 실익이 없다. ADR-005의 "내부는 풀네임, 외부는 축약" 원칙을 그대로 유지한다.

## Consequences
- Order 인스턴스에 임의 속성 추가 불가 (slots에 정의된 것만 사용 가능). 디버깅용 monkey-patch 안 됨 → 안전성 측면에서는 오히려 좋음.
- 다중 상속 시 제약이 있을 수 있음 (현재는 Order가 단일 클래스이므로 무관).
- 새 필드 추가 시 `__slots__` 튜플과 dataclass 필드 두 곳을 모두 업데이트해야 한다.
