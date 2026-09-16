import { version } from "../../package.json";

/** 화면에 보이는 버전 표기의 단일 출처 — package.json `version`만 올리면 된다. */
export const APP_VERSION = `v${version}`;
