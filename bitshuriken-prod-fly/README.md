# bitshuriken-prod-fly

**A fruit fly's brain trades on bitshuriken-prod.** Experimental, standalone.

The [FlyWire](https://flywire.ai) adult *Drosophila* connectome (FAFB v783, Dorkenwald et al. 2024) is run as a
rate network on its real, signed synapses. Market bars are encoded into the fly's sensory neurons, activity
propagates through the central brain, and a linear decoder trained on the descending neurons (brain → body)
emits a long exposure that is traded on the local spot exchange as a normal user (HMAC subaccount).

```
Binance / local klines ─▶ 12 bounded features ─▶ ON/OFF channels ─▶ sensory neurons (ORN · GRN · JO · bristle · thermo)
        │                                                              │  4 steps / bar along 1,062,130 signed synapses
        │                                                              ▼
        │                                              41,750 central-brain neurons (leaky tanh, state carried bar to bar)
        │                                                              │
        └── train: ridge readout of 1,305 descending neurons ◀─────────┘ ──▶ ŷ ──▶ exposure 0..1 ──▶ market orders
```

Nothing inside the brain is learned: synapse signs and topology come from the connectome, magnitudes are a fixed
normalization. The only trained object is the 1,305-dimensional readout vector (reservoir computing). Whether that
readout predicts anything is measured, not assumed: `train` reports the validation IC / hit rate and runs an
out-of-sample backtest on the days it never saw.

## Setup

```bash
npm install
cp .env.example .env          # defaults target the local dev stack (localhost:5101 / 5103)
npm run fly build             # downloads FlyWire v783 (~53 MB, public bucket, no login) and builds data/fafb783-central.flybrain
```

## Real-time mode (v2): record the book, evolve flies, trade

```bash
npm run fly record BTCUSDT            # 1-second samples of the local top-20 book + trades → data/lob/BTCUSDT/*.jsonl (keep running)
npm run fly evolve BTCUSDT gens=8 pop=16 workers=6
                                      # each fly: brain genes → descending-neuron trajectory over the recording,
                                      # ridge readout on the first 70%, threshold policy scored on the last 30% (net of taker fee, win rate)
                                      # elites survive, mutants fill the population → best fly saved as data/models/BTCUSDT-1s.json
npm run fly live BTCUSDT              # picks the lob model automatically: streams the book, 5 min warm-up, then trades at 1 Hz
```

27 order-book features (level imbalance, microprice, signed flow, OFI, mid returns 1s–10m, spread, depth shape,
activity, volatility regime) enter the fly's taste / smell / touch / hearing / temperature neurons.

### The league — a trading competition

```bash
npm run fly league BTCUSDT flies=8 season=30 relegate=3 minTrades=2 capital=10000
```

Eight flies trade live at the same time, each in its own subaccount with the same capital and the same fees
(no fee-tier favours). Every season (30 min) they are ranked by season PnL; the bottom three are relegated
(positions flattened) and replaced by mutants of the survivors, whose readouts are refit on the latest recording.
A fly that places fewer than `minTrades` orders in a season is ranked last, whatever its PnL: sitting out is
not a strategy. The dashboard at http://127.0.0.1:5130 shows the standings, the relegation zone, the hall of
fame and each fly's brain. The bar-based v1 below still works and is kept for comparison.

## Train, test, trade (v1, 1-minute bars)

```bash
npm run fly train BTCUSDT 1m 30 test=7    # learn the readout on days 30..7 ago, backtest the last 7 days out of sample
npm run fly backtest BTCUSDT 1m 7         # re-run a backtest with the saved model
npm run fly live BTCUSDT                  # trade on the local exchange; dashboard at http://127.0.0.1:5130
npm run fly flatten BTCUSDT               # sell everything the fly holds
npm run fly info
```

`live` needs the exchange stack up (`../scripts/exchange.sh start`) and a book to trade against — the separate
bots service mirrors Binance (`cd ../bitshuriken-prod-bots && npm run bots`). The fly creates one funded
subaccount under its master account (`MASTER_EMAIL`), keeps its credentials in `data/live/<SYMBOL>.json`, and
resumes them on restart. Ctrl-C stops the loop and keeps the position.

## Deploy on Ubuntu 24.04 (2012 Mac mini, exchange elsewhere)

```bash
# on the mini — copy the fly folder (rsync, or git pull once the repo is committed), then:
rsync -av --exclude node_modules --exclude data bitshuriken-prod-fly/ mini:~/bitshuriken-prod-fly/
ssh mini 'cd ~/bitshuriken-prod-fly && ./deploy/ubuntu-macmini.sh http://<exchange-host>:5101 http://<exchange-host>:5103'
```

`deploy/ubuntu-macmini.sh` installs Docker Engine if missing, sizes the league from cores/RAM (4–8 flies), writes
`.env`, builds the x86_64 image, runs `fly bench` (brain-step time on that CPU → fly count), and starts
recorder + league from `docker-compose.remote.yml` (no exchange network needed; API on `0.0.0.0:5130`).
Then point the exchange FE at it: `NEXT_PUBLIC_FLY_API_URL=http://<mini-ip>:5130`. Run only one league per
exchange (stop the dev-machine league first) — they would compete for the same book and master account.

## Deploy alongside the exchange stack (same host)

```bash
cd bitshuriken-prod-fly && cp .env.example .env      # MASTER_*, FLY_CAPITAL_USDT, FLY_BIND=0.0.0.0 for LAN viewing
docker compose up -d --build                          # fly-record + fly-league on the exchange's internal network
docker compose logs -f fly-league
```

The image is tsx-runtime only; the first start downloads FlyWire (~53 MB) into the `fly-data` volume and builds
the connectome. The league API/dashboard is published on `${FLY_BIND}:5130`. The exchange frontend's `/fly` page
reads the same API: build the FE with `NEXT_PUBLIC_FLY_API_URL=http://<mac-mini>:5130`.

Resources (measured on a loaded M1): one fly ≈ 6–7 % of a core and ≈ 55 MB RSS (brain step ~20 ms unloaded,
~80 ms under load); eight flies ≈ half a core and ≈ 450 MB; recorder ≈ 7 MB of samples per hour.

## Dashboard

`web/` polls `GET /api/state`: equity and PnL, the readout ŷ and target exposure over time, mean activity of
every neuron population (sensory → central → descending), a heatmap of the 1,305 descending neurons the decoder
reads, every decision and every fill.

## Layout

| path | what |
| --- | --- |
| `src/brain/build.ts` | CSV → signed post-major CSR connectome (`central` excludes the optic lobes) |
| `src/brain/populations.ts` | classification → neuron populations (contiguous index ranges) |
| `src/brain/brain.ts` | leaky-tanh dynamics, sensory input projection, population activity |
| `src/brain/features.ts` | OHLCV → 12 bounded features → 24 rectified channels |
| `src/brain/readout.ts`, `train.ts` | ridge readout on descending neurons, λ by validation IC, echo-state self-check |
| `src/trade/policy.ts`, `trader.ts` | exposure policy; one trader object shared by backtest and live |
| `src/trade/backtest.ts`, `live.ts` | Binance replay with taker fills; live loop on the local exchange |
| `src/exchange/client.ts` | thin spot client: public klines/exchange-info, master JWT, subaccount HMAC |
| `web/` | dashboard |

## Data and citations

- Connectome: FlyWire consortium, Dorkenwald et al., *Neuronal wiring diagram of an adult brain*, Nature 2024;
  annotations Schlegel et al., Nature 2024. Files from the public Codex bucket
  `storage.googleapis.com/flywire-data/codex/data/fafb/783/` (CC BY 4.0).
- Neurotransmitter signs: Shiu et al., *A Drosophila computational brain model reveals sensorimotor processing*,
  Nature 2024 (GABA and glutamate inhibitory, the rest excitatory).
- Design lineage: connectome-as-reservoir (Costi et al. 2025), and the 2026 wave of fly-brain traders
  (fly-trader, Flybrain, Stonkfly) — sensory neurons in, descending neurons out.

Not financial advice; a simulation exchange experiment. Performance is reported, never claimed.
