# bitshuriken-prod-infra

Production deployment for **Bitshuriken** on a single Linux host (amd64).

Images are built by the monorepo's GitHub Actions (`.github/workflows/release-{be,fe,match}.yml`
at the repo root, path-filtered per service directory) and pushed to **GHCR**; this
host only **pulls + runs**. No builds happen on the host. (ADR-062)

```
Cloudflare (edge TLS/CDN)  ->  this host: nginx :443 (CF Origin cert)
GitHub Actions (amd64 runners)              this host (Intel/Linux)
  bitshuriken-prod-be/   -> ghcr.io/.../be      docker compose pull
  bitshuriken-prod-fe/   -> ghcr.io/.../fe   ->  docker compose up -d
  bitshuriken-prod-match/-> ghcr.io/.../match   (nginx serves :80/:443)
```

Deployed services: **be** (spot/futures/portal/settle, 4 processes from 1 image —
`settle` is the settlement tier: without it fills never reach wallets),
**match** (spot + futures), **fe**, plus **postgres**, **kafka** (KRaft), **nginx**
(reverse proxy, TLS = Cloudflare Origin cert).

## Routing (same-origin per environment)

One host per environment serves both the FE and the API. **nginx** strips the
`/api` prefix (`nginx/bitshuriken.conf`), so the apps keep serving their bare
paths. Same-origin ⇒ no CORS, and the `bs_session` cookie (SameSite=Lax,
host-only) is isolated per env.

| Path | Upstream |
| --- | --- |
| `https://<DOMAIN>/` (everything not `/api`) | fe |
| `https://<DOMAIN>/api/spot/*` + `/api/ws/market`,`/api/ws/user` | be-spot |
| `https://<DOMAIN>/api/futures/*` + `/api/ws/fmarket`,`/api/ws/fuser` | be-futures |
| `https://<DOMAIN>/api/*` (everything else) | be-portal (auth/account/admin/leaderboard/subaccounts) |

Future envs: `dev.bitshuriken.com`, `qa.bitshuriken.com` — add the `server_name`
to `nginx/bitshuriken.conf` (or a per-env server block). The FE `NEXT_PUBLIC_*`
are baked per-env, so build a separate fe image per env (or use a relative `/api`
base).

---

## First-time setup

### 1. Cloudflare + DNS + router
- In Cloudflare: `A` record `bitshuriken.com` → host public IP, **proxied (orange cloud)**. Single host serves FE + API; no `api.` subdomain.
- SSL/TLS mode: **Full (strict)**. Create an **Origin Certificate** (Cloudflare → SSL/TLS → Origin Server) and put it on the host:
  - `/etc/ssl/cloudflare/origin.pem` (cert) and `/etc/ssl/cloudflare/origin.key` (key) — nginx mounts this dir read-only.
- Forward port **443** (and 80 for the http→https redirect) on the router to this host.
- Real client IP arrives as `CF-Connecting-IP`; nginx maps it to `$remote_addr` (`nginx/cloudflare-realip.conf`), so `RATE_LIMIT_TRUST_PROXY_HOPS=1` stays correct.
- Optional hardening: since only Cloudflare should reach the origin, restrict the firewall (or nginx) to the Cloudflare IP ranges in `nginx/cloudflare-realip.conf`.
- If your router lacks NAT hairpin, add to the host `/etc/hosts`: `127.0.0.1 bitshuriken.com` so the host can reach itself by name.

### 2. Clone + env
The infra definition lives inside the monorepo; only this directory is needed on the host.
```bash
sudo git clone https://github.com/bskim6705/bitshuriken-prod /opt/bitshuriken-prod
cd /opt/bitshuriken-prod/bitshuriken-prod-infra
cp .env.prod.example .env.prod
# fill in: DOMAIN, POSTGRES_PASSWORD (+DATABASE_URL), JWT_SECRET,
# API_KEY_ENCRYPTION_KEY, ADMIN_API_SECRET, Gmail SMTP_USER/SMTP_PASS, CORS_ORIGINS, APP_BASE_URL
#   openssl rand -hex 32   # for each secret
# PORT_SETTLE (5104) must be present — the settle process refuses to boot without it.
```

### 3. Log in to GHCR (images are private)
Create a classic PAT with `read:packages`, then:
```bash
echo "$GHCR_PAT" | docker login ghcr.io -u bskim6705 --password-stdin
```

### 4. Gmail SMTP
Enable 2FA on the Google account → create an **App Password** → put it in `SMTP_PASS`.
`MAIL_FROM` / `SMTP_USER` must be that Gmail address.

### 5. Bring it up
```bash
./deploy.sh
```
`be-migrate` (prisma migrate deploy) and `kafka-init` (topic creation) run automatically before the apps start.

### 6. Seed once (first boot only)
The DB needs initial assets/admin. Seeding uses dev tooling, so run it once from a checkout of `bitshuriken-prod-be` against the running DB:
```bash
# in a bitshuriken-prod-be checkout, with DATABASE_URL pointing at the host's postgres
npx prisma db seed   # or: npx tsx prisma/seed.ts
```

---

## Deploy

Each push to `main` that touches a service directory builds a fresh `:latest` image
for that service (GitHub Actions → GHCR). To roll it out, the host **pulls + runs** —
that's the whole flow (`git pull` first if this directory itself changed):

```bash
./deploy.sh        # = docker compose pull && docker compose up -d (+ image prune)
```

`be-migrate` (prisma migrate deploy) runs before the apps via compose `depends_on`,
so this is safe to run anytime. Want it automatic? Add a cron line, e.g.
`*/3 * * * * /opt/bitshuriken-prod-infra/deploy.sh >> /var/log/bs-deploy.log 2>&1`.

## Ops

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f be-spot
./scripts/admin-ticker.mjs            # ticker listing/delisting (needs ADMIN_API_SECRET)
```

### Postgres backup (recommended cron)
```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > backup-$(date +%F).sql.gz
```

## Notes
- Kafka topics use **fixed bucket partitions** (`MATCH_*_PARTITIONS`, default 6) and compacted `state`/`control` topics. Symbols hash to a bucket via FNV-1a%P, so the partition count is independent of how many tickers exist.
- `NEXT_PUBLIC_*` are **baked into the fe image at build time** — set them as repository variables in `bitshuriken-prod-fe` (not here). See that repo's release workflow.
- Only nginx publishes host ports; Postgres/Kafka are internal-only.
- Order-book liquidity is not part of this stack — without an external maker feeding orders, books are empty. The Binance/Upbit mirroring bots live in `../bitshuriken-prod-bots/` with their own `docker-compose.yml`; they attach to the `bitshuriken_internal` network as ordinary API-key users (the core compose stays core-only).
