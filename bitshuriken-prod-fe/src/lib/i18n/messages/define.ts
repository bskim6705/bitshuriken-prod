// 영역(area)별 메시지 모듈 정의 헬퍼.
// en이 키의 원천이고, ko/ja/zh는 en과 정확히 같은 키 집합을 가져야 한다(누락/오타 시 타입 에러).
// 영역마다 파일이 분리돼 있어 동시 작업 시 충돌이 없다. index.ts가 4개 사전으로 병합한다.
export function defineMessages<const T extends Record<string, string>>(messages: {
  en: T;
  ko: Record<keyof T, string>;
  ja: Record<keyof T, string>;
  zh: Record<keyof T, string>;
}): {
  en: T;
  ko: Record<keyof T, string>;
  ja: Record<keyof T, string>;
  zh: Record<keyof T, string>;
} {
  return messages;
}
