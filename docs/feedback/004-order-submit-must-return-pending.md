# Feedback-004: 주문 접수 시 PENDING 상태 응답 필수

## Rule
주문 생성/취소 API는 매칭엔진에 전달하기 전에 DB에 PENDING 상태로 저장하고, 그 결과를 응답으로 돌려줘야 한다.

## Why
프론트와 API 호출자가 주문 접수 여부를 즉시 확인할 수 있어야 한다.

## How to apply
- 흐름: API 요청 -> DB에 PENDING 저장 -> 응답 반환 -> Kafka emit -> 매칭엔진 처리
- Kafka emit만 하고 끝내면 안 됨
