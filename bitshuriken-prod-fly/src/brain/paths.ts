import { join } from 'node:path';
import { config } from '../config';

/** 커넥톰 원본·바이너리·학습 모델·라이브 상태는 DATA_DIR (gitignore). */
export const flyDir = (): string => config.dataDir;
export const rawDir = (): string => join(flyDir(), 'raw');
export const connectomePath = (region: 'central' | 'full'): string => join(flyDir(), `fafb783-${region}.flybrain`);
export const modelsDir = (): string => join(flyDir(), 'models');
export const modelPath = (symbol: string, interval: string): string => join(modelsDir(), `${symbol.toUpperCase()}-${interval}.json`);
export const liveStatePath = (symbol: string): string => join(flyDir(), 'live', `${symbol.toUpperCase()}.json`);
export const lobDir = (symbol: string): string => join(flyDir(), 'lob', symbol.toUpperCase());
