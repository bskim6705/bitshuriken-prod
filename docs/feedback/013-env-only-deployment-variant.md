# Feedback-013: .env에는 deployment-variant 값만 넣는다

## Rule
`.env`는 배포 환경마다 값이 달라지는 항목만 담는다(secrets, 외부 URL, 포트, 허용 origin 등). 구현 세부 옵션(cookie httpOnly/sameSite/maxAge, JWT 알고리즘, 기본 pagination size 등)은 코드에 하드코딩한다. dev/prod 분기가 필요한 세부는 `NODE_ENV`로 내부에서 결정한다.

## Why
- env 항목이 늘어날수록 `.env.example` drift 위험이 커지고, 조용히 동작 바뀜
- cookie·JWT처럼 auth 메커니즘 세부는 코드와 함께 읽혀야 의미가 유지됨. env로 뽑으면 리뷰/감사 시 흩어진 파일들을 동시에 봐야 함
- env는 "배포마다 달라지는 것"이라는 의미 — 여기에 정책(예: sameSite='lax')까지 넣으면 origin이 흐려짐
- 옵션 과잉은 실수 비용. 고를 일이 없는 값을 env로 노출하면 누군가 틀리게 고친다

## How to apply
- env에 OK한 것: secrets(JWT_SECRET), 연결 문자열(DATABASE_URL, KAFKA_BROKER), 포트(PORT), 배포 타깃(CORS_ORIGINS), 외부 서비스 URL, 환경 플래그(NODE_ENV)
- env에 NOT OK: cookie httpOnly/sameSite/secure/maxAge/name, JWT 알고리즘/expiresIn, ValidationPipe 옵션, 페이지네이션 기본값, 기본 rate limit 값
- dev/prod 분기: `process.env.NODE_ENV === 'production'`로 내부에서 판단. env에 `COOKIE_SECURE` 같은 별도 플래그 두지 않는다
- 예외: 한 번만 읽는 서비스 constructor에서 env 읽는 건 OK. 여러 파일에서 같은 env 키를 읽으면 provider/constants로 빼고 env는 그대로
