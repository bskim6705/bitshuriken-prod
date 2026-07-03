# Feedback-003: RESTful API 규칙 준수

## Rule
API는 RESTful하게 유지한다.

## Why
일관된 API 설계를 위해 리소스 중심의 RESTful 규칙을 따른다.

## How to apply
- 리소스 생성: `POST /orders`
- 리소스 삭제: `DELETE /orders`
- 조회: `GET /orders`, `GET /orders/:id`
- 동사형 경로(`/orders/new`, `/orders/cancel`) 사용 금지
