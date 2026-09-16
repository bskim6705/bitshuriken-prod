# syntax=docker/dockerfile:1
# bitshuriken-prod-fly — 초파리 커넥톰 트레이딩 뇌 (실험). tsx 런타임이라 빌드 단계 없음.
# 한 이미지로 recorder / league / live 를 각각 띄운다 (docker-compose.yml). 커넥톰 원본(FlyWire, 53MB)과
# 바이너리·기록·모델·리그 상태는 /app/data 볼륨에 산다 — 첫 기동에 없으면 entrypoint가 내려받아 굽는다.
FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
ENV NODE_ENV=production DATA_DIR=/app/data FLY_HOST=0.0.0.0
VOLUME ["/app/data"]
EXPOSE 5130
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["league", "BTCUSDT"]
