# syntax=docker/dockerfile:1
# bitshuriken-prod-bots — Binance/Upbit-mirroring liquidity + monetary-integrity checker.
# No build step (tsx runtime), single stage. Default command is the headless launcher `npm run bots`
# (discovers symbols from exchange-info, mirrors continuously, restart-safe).

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# tsx is a devDependency needed at runtime, so install the full tree.
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
CMD ["npm", "run", "bots"]
