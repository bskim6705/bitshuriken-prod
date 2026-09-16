// fly dashboard — polls GET /api/state (same origin) and draws the brain + account.
const POLL_MS = 3000;
const SENSORY = ['ORN', 'ORN_PHEROMONE', 'GRN', 'MECH_JO', 'MECH_BRISTLE', 'THERMO_HYGRO'];
const FEATURES = [
  ['r1', 'ORN / pheromone'], ['r3', 'ORN / pheromone'], ['r6', 'ORN / pheromone'], ['r12', 'ORN / pheromone'], ['r24', 'ORN / pheromone'], ['r48', 'ORN / pheromone'],
  ['volZ', 'MECH_JO'], ['rangeZ', 'MECH_JO'], ['volRegime', 'THERMO_HYGRO'], ['posInRange', 'GRN'], ['emaDist20', 'MECH_BRISTLE'], ['emaDist100', 'MECH_BRISTLE'],
];
const el = (id) => document.getElementById(id);
const fmt = {
  usd: (x) => (x == null || !isFinite(x) ? '—' : Number(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
  qty: (x) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(6).replace(/\.?0+$/, '')),
  pct: (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(2) + '%'),
  signed: (x) => (x > 0 ? '+' : '') + fmt.usd(x),
  time: (t) => (t ? new Date(t).toLocaleTimeString() : '—'),
};
const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const metric = (label, value, c = '') => `<div class="metric"><span class="ml">${label}</span><span class="mv ${c}">${value}</span></div>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function banner(msg) {
  const b = el('banner');
  if (!msg) return b.classList.add('hidden');
  b.textContent = msg;
  b.classList.remove('hidden');
}

function render(s) {
  el('h-status').textContent = s.status;
  el('h-status').className = `v ${s.status === 'running' ? 'pos' : s.status === 'stopped' ? 'neg' : ''}`;
  el('h-symbol').textContent = `${s.symbol} ${s.interval}`;
  el('h-neurons').textContent = s.model.neurons.toLocaleString();
  el('h-synapses').textContent = s.model.synapses.toLocaleString();
  el('h-bar').textContent = fmt.time(s.lastBarTime);

  const pnl = s.equity - s.capitalUsdt;
  el('acct-sub').textContent = `sub ${s.subaccountId} · ${s.label}`;
  el('acct-metrics').innerHTML = [
    metric('Equity', fmt.usd(s.equity)),
    metric('PnL', fmt.signed(pnl), cls(pnl)),
    metric('ROI', fmt.pct(s.capitalUsdt ? pnl / s.capitalUsdt : 0), cls(pnl)),
    metric('Position', `${fmt.qty(s.positionQty)} (${fmt.usd(s.positionQty * s.price)} USDT)`),
    metric('Price', fmt.usd(s.price)),
    metric('Cash', fmt.usd(s.quoteTotal)),
  ].join('');
  const snap = s.snapshot;
  el('exposure-bar').style.width = `${((snap ? snap.exposure : 0) * 100).toFixed(1)}%`;
  drawEquity(s.equityCurve, s.capitalUsdt);

  el('model-sub').textContent = `model ${s.model.symbol} ${s.model.interval} · H=${s.model.horizon} · val IC ${s.model.valIc.toFixed(3)} · hit ${(s.model.valHitRate * 100).toFixed(1)}% · trained ${new Date(s.model.trainedAt).toLocaleString()}`;
  el('readout-metrics').innerHTML = snap
    ? [
        metric('ŷ', (snap.yhat >= 0 ? '+' : '') + snap.yhat.toFixed(4), cls(snap.yhat)),
        metric('Full exposure at', '+' + snap.yScale.toFixed(4)),
        metric('Target exposure', (snap.exposure * 100).toFixed(0) + '%', snap.exposure > 0 ? 'pos' : ''),
        metric('Bars seen', String(s.barsSeen) + (s.warm ? '' : ' (warming)')),
        metric('Policy', s.mode === 'lob' ? `enter ŷ>${s.policy.thetaInAbs.toFixed(4)} · exit ŷ<${s.policy.thetaOutAbs.toFixed(4)} · hold ${s.policy.minHoldSec}s · ${(s.policy.maxFrac * 100).toFixed(0)}%` : `maxFrac ${s.policy.maxFrac} · band ${s.policy.band} · hold ${s.policy.minHoldBars}`),
        metric('Brain', `p=${s.model.brain.normP} gain ${s.model.brain.gain} leak ${s.model.brain.leak} K=${s.model.brain.substeps}`),
      ].join('')
    : '<p class="dim">no bar yet</p>';
  drawReadout(s.history, snap ? snap.yScale : 1, s.mode === 'lob' ? [s.policy.thetaInAbs, s.policy.thetaOutAbs] : null);

  renderBook(s);
  if (snap) {
    const maxMean = Math.max(...snap.populations.map((p) => p.mean), 1e-9);
    el('pops').innerHTML = snap.populations
      .map((p) => {
        const kind = SENSORY.includes(p.name) ? 'sensory' : p.name === 'DESCENDING' ? 'readout' : 'central';
        return `<div class="pop ${kind}"><span class="pname">${p.name}</span><span class="pn">${p.n.toLocaleString()}</span><span class="pbar"><span style="width:${((p.mean / maxMean) * 100).toFixed(1)}%"></span></span><span class="pval">${p.mean.toFixed(3)} · ${(p.active * 100).toFixed(0)}%</span></div>`;
      })
      .join('');
    drawDescending(snap.descending);
    if (s.mode === 'lob' && snap.features) {
      el('sensory-sub').textContent = '실시간 오더북 피처 27 · 현재값 (−1..1)';
      el('sensory').innerHTML = s.featureNames
        .map((name, i) => {
          const v = snap.features[i] ?? 0;
          return `<div class="feat lob"><span class="pname">${name}</span><span class="fbar"><span class="${v >= 0 ? 'fpos' : 'fneg'}" style="left:${v >= 0 ? 50 : 50 + v * 50}%;width:${Math.abs(v) * 50}%"></span></span><span class="pval ${cls(v)}">${v.toFixed(2)}</span></div>`;
        })
        .join('');
    } else {
      el('sensory').innerHTML = FEATURES.map(([name, target]) => `<div class="feat"><span class="pname">${name}</span><span class="dim">→ ${target}</span></div>`).join('');
    }
  }

  el('dec-sub').textContent = `${s.actions.length} recent · ${s.consecutiveErrors ? `errors ${s.consecutiveErrors}: ${s.lastError}` : 'no errors'}`;
  el('actions').innerHTML = s.actions.length
    ? s.actions
        .map(
          (a) => `<tr><td class="mono">${fmt.time(a.t)}</td><td class="num">${fmt.usd(a.price)}</td><td class="num ${cls(a.yhat)}">${a.yhat.toFixed(4)}</td><td class="num">${(a.exposure * 100).toFixed(0)}%</td><td class="${/BUY/.test(a.action) ? 'pos' : /SELL|FLATTEN/.test(a.action) ? 'neg' : 'dim'}">${esc(a.action)}</td><td class="num">${fmt.usd(a.equity)}</td><td class="num">${fmt.qty(a.positionQty)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="dim">waiting for the first bar…</td></tr>';
  el('fills').innerHTML = s.fills.length
    ? s.fills
        .map(
          (f) => `<tr><td class="mono">${fmt.time(f.time)}</td><td class="${f.isBuyer ? 'pos' : 'neg'}">${f.isBuyer ? 'BUY' : 'SELL'}</td><td class="num">${fmt.usd(Number(f.price))}</td><td class="num">${fmt.qty(Number(f.qty))}</td><td class="num">${fmt.usd(Number(f.quoteQty))}</td><td class="num">${Number(f.commission).toFixed(6)} ${f.commissionAsset}</td><td>${f.isMaker ? 'maker' : 'taker'}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="dim">no fills yet</td></tr>';
}

function canvas2d(id) {
  const cv = el(id);
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawEquity(curve, initial) {
  const { ctx, w, h } = canvas2d('equity');
  if (!curve || curve.length < 2) { ctx.fillStyle = '#848e9c'; ctx.font = '12px sans-serif'; ctx.fillText('equity curve builds up bar by bar', 12, 24); return; }
  const pad = 8;
  const ys = curve.map((p) => p.equity);
  const lo = Math.min(...ys, initial), hi = Math.max(...ys, initial), range = hi - lo || 1;
  const x = (i) => pad + (i / (curve.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - lo) / range) * (h - 2 * pad);
  ctx.strokeStyle = '#2b3139'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad, y(initial)); ctx.lineTo(w - pad, y(initial)); ctx.stroke(); ctx.setLineDash([]);
  const last = ys[ys.length - 1];
  ctx.strokeStyle = last >= initial ? '#0ecb81' : '#f6465d'; ctx.lineWidth = 1.5; ctx.beginPath();
  curve.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.equity)) : ctx.moveTo(x(i), y(p.equity))));
  ctx.stroke();
}

function drawReadout(hist, yScale, thresholds) {
  const { ctx, w, h } = canvas2d('readout');
  if (!hist || hist.length < 2) { ctx.fillStyle = '#848e9c'; ctx.font = '12px sans-serif'; ctx.fillText('readout history builds up bar by bar', 12, 24); return; }
  const pad = 8;
  const lim = Math.max(yScale * 1.2, ...(thresholds ? thresholds.map(Math.abs) : []), ...hist.map((p) => Math.abs(p.yhat)));
  const x = (i) => pad + (i / (hist.length - 1)) * (w - 2 * pad);
  const y = (v) => h / 2 - (v / lim) * (h / 2 - pad);
  const bw = Math.max(1, (w - 2 * pad) / hist.length);
  ctx.fillStyle = 'rgba(14, 203, 129, 0.2)';
  hist.forEach((p, i) => { if (p.exposure > 0) ctx.fillRect(x(i), y(0) - p.exposure * (h / 2 - pad), bw, p.exposure * (h / 2 - pad)); });
  ctx.strokeStyle = '#2b3139'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  for (const lvl of thresholds ? [0, ...thresholds] : [0, yScale]) { ctx.beginPath(); ctx.moveTo(pad, y(lvl)); ctx.lineTo(w - pad, y(lvl)); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#fcd535'; ctx.lineWidth = 1.5; ctx.beginPath();
  hist.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.yhat)) : ctx.moveTo(x(i), y(p.yhat))));
  ctx.stroke();
}

function drawDescending(values) {
  const cv = el('dn');
  const n = values.length;
  const cols = Math.ceil(Math.sqrt(n * 2.2));
  const rows = Math.ceil(n / cols);
  const cell = Math.max(3, Math.floor(cv.clientWidth / cols));
  const dpr = window.devicePixelRatio || 1;
  cv.width = cols * cell * dpr; cv.height = rows * cell * dpr;
  cv.style.height = `${rows * cell}px`;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0b0e11'; ctx.fillRect(0, 0, cols * cell, rows * cell);
  let maxAbs = 1e-6;
  for (const v of values) maxAbs = Math.max(maxAbs, Math.abs(v));
  for (let i = 0; i < n; i++) {
    const v = values[i] / maxAbs;
    const a = Math.min(1, Math.abs(v)) ** 0.6;
    ctx.fillStyle = v >= 0 ? `rgba(252, 160, 53, ${a})` : `rgba(80, 140, 255, ${a})`;
    ctx.fillRect((i % cols) * cell, Math.floor(i / cols) * cell, cell - 1, cell - 1);
  }
}

async function refresh() {
  try {
    const r = await fetch('/api/state');
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    render(j.data);
    banner(null);
    el('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    el('h-status').textContent = 'offline';
    el('h-status').className = 'v neg';
    banner(`fly unreachable — is \`npm run fly live <symbol>\` running? (${e.message})`);
  }
}
refresh();
setInterval(refresh, POLL_MS);


// ---- order book (lob mode) ----
function renderBook(s) {
  const card = el('book-card');
  if (s.mode !== 'lob' || !s.book) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const b = s.book;
  const maxQ = Math.max(...b.bids.map((l) => l[1]), ...b.asks.map((l) => l[1]), 1e-9);
  const row = (side, [p, q]) => `<div class="lvl ${side}"><span class="lp">${p.toFixed(2)}</span><span class="lq">${q.toFixed(5)}</span><span class="lbar"><span style="width:${((q / maxQ) * 100).toFixed(1)}%"></span></span></div>`;
  el('book-sub').textContent = `${b.trades} trades · ${b.depthMsgs} depth updates in the last second · mid ${fmt.usd(s.price)}`;
  el('book').innerHTML = `<div class="side asks">${[...b.asks].reverse().map((l) => row('ask', l)).join('')}</div><div class="side bids">${b.bids.map((l) => row('bid', l)).join('')}</div>`;
}
