# syntax=docker/dockerfile:1
# Next.js standalone output. NEXT_PUBLIC_* are inlined at build time, so they are
# passed as build args (see .github/workflows/release.yml -> repository variables).

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_FUTURES_API_URL
ARG NEXT_PUBLIC_PORTAL_API_URL
ARG NEXT_PUBLIC_RATE_LIMIT_ENABLED=false
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_FUTURES_API_URL=$NEXT_PUBLIC_FUTURES_API_URL \
    NEXT_PUBLIC_PORTAL_API_URL=$NEXT_PUBLIC_PORTAL_API_URL \
    NEXT_PUBLIC_RATE_LIMIT_ENABLED=$NEXT_PUBLIC_RATE_LIMIT_ENABLED
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
