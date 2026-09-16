# docs/feedback — 교정 기록

이 프로젝트는 설계·정책 결정과 검증은 사람이, 구현의 상당 부분은 AI 코딩 에이전트에 위임해 만들었다. 에이전트가 방향을 잘못 잡아 "아니, 그렇게 말고"라는 교정을 받을 때마다 그 자리에서 규칙으로 적은 것이 이 폴더다. 한 건 = 한 파일, 형식은 **Rule / Why / How to apply**.

목적은 같은 교정을 다음 세션이 반복해서 받지 않게 하는 것이다. 그래서 내용은 코드 규칙(정밀도, 예외 처리, 주문 mutation 경로)부터 작업 방식(요청 범위만, 정책은 사람이 확정, 실험은 자기 폴더에)까지 섞여 있다. 번호는 시간순이며 ADR과 달리 서로 대체하지 않는다.

아키텍처 결정은 [docs/adr/](../adr/), 검증 캠페인은 [docs/test-reports/](../test-reports/), 미해결 버그는 [docs/specs/refactor-observations.md](../specs/refactor-observations.md).
