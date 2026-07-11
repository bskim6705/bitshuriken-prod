# syntax=docker/dockerfile:1
# bitshuriken-prod-agents — multi-strategy trading-agent daemon (agentd).
# No build step (tsx runtime), so this is a single stage. Default command runs the
# always-on daemon: fleet host + control API + management dashboard (:5120).
# The dashboard is auth-less — publish 5120 to 127.0.0.1 only and reach it over an
# SSH tunnel; never expose it. CLI/MCP are run on demand against the same control API.

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# tsx is a devDependency and is needed at runtime, so install the full tree.
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY web ./web

ENV NODE_ENV=production
CMD ["npm", "run", "daemon"]
