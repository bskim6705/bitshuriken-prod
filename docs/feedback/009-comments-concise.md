# Feedback-009: 주석은 짧고 self-contained, ADR 번호를 코드에 적지 않는다

## Rule
코드 주석은 핵심만 짧게. ADR 본문을 옮기거나 `(ADR-NNN)` marker를 박지 않는다. 결정의 맥락은 ADR 폴더에서 찾는다.

## Why
- ADR이 superseded돼도 코드 주석은 안 따라감 → stale + misleading
- 번호만으로는 무슨 결정인지 모름 → 결국 클릭/검색해야 함. 단어로 단서를 적는 게 가치가 더 큼
- ADR이 누적되면 marker가 흔해져 신호 가치 떨어짐
- "왜 이 코드인가"의 정확한 출처는 git blame + 커밋 메시지. ADR은 archive, 코드는 현재. 둘이 분리되는 게 정상
- 큰 코드베이스(Linux, Postgres 등)도 ADR-style marker는 거의 안 씀

## How to apply
- 함수/클래스 docstring: 1~3줄. "무엇을 하는가" + 비자명한 한 가지만
- inline 주석: 그 코드가 왜 평범하지 않은지 한 줄. 자명한 코드는 주석 없음
- ADR 번호 marker 금지. 단, 정말 헷갈릴 코드(기괴해 보이는 한두 줄)에만 예외적으로 사용
- 큰 주석 블록(10줄+)이 필요해 보이면 신호: 그 결정은 ADR로 빠져야 하거나, 코드 자체를 재구조해야 함
- ADR을 찾고 싶으면 `ls docs/adr/` + `grep` 또는 git log. agent도 동일
