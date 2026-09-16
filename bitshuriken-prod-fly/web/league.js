// fly league dashboard — polls /api/league (standings) and /api/fly/:slot (selected fly detail)
const POLL_MS = 2000;
const SENSORY = ['ORN', 'ORN_PHEROMONE', 'GRN', 'MECH_JO', 'MECH_BRISTLE', 'THERMO_HYGRO'];
const el = (id) => document.getElementById(id);
const fmt = {
  usd: (x) => (x == null || !isFinite(x) ? '—' : Number(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
  qty: (x) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(5).replace(/\.?0+$/, '')),
  pct: (x, d = 3) => (x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d) + '%'),
  mmss: (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
  time: (t) => (t ? new Date(t).toLocaleTimeString() : '—'),
};
const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const metric = (label, value, c = '') => `<div class="metric"><span class="ml">${label}</span><span class="mv ${c}">${value}</span></div>`;
const state = { selected: null };

function banner(msg) {
  const b = el('banner');
  if (!msg) return b.classList.add('hidden');
  b.textContent = msg;
  b.classList.remove('hidden');
}

function renderLeague(L) {
  el('h-symbol').textContent = L.symbol;
  el('h-season').textContent = `#${L.season}${L.ending ? ' (ending…)' : ''}`;
  el('h-left').textContent = fmt.mmss(L.secondsLeft);
  el('h-flies').textContent = L.table.length;
  el('h-rule').textContent = `relegate ${L.relegate} · min ${L.minTrades} orders · fee ${L.takerFeeBps}bps`;
  el('table-sub').textContent = `${L.capital.toLocaleString()} USDT each · season ${Math.round(L.seasonMs / 60000)} min`;
  el('standings').innerHTML = L.table
    .map(
      (r) => `<tr data-slot="${r.slot}" class="${r.relegationZone ? 'relegation' : ''} ${state.selected === r.slot ? 'selected' : ''}">
        <td>${r.rank}${r.rank === 1 ? ' 🏆' : ''}</td><td class="mono">${r.id}</td><td class="mono dim">${r.parent ?? '—'}</td><td>${r.born}</td><td>${r.seasons}</td>
        <td><span class="badge ${r.status === 'running' ? 'running' : r.status === 'warming' ? 'warn' : 'stopped'}">${r.status}</span>${r.active ? '' : ' <span class="badge fail">inactive</span>'}</td>
        <td class="num">${fmt.usd(r.equity)}</td><td class="num ${cls(r.seasonPnlPct)}">${fmt.pct(r.seasonPnlPct)}</td><td class="num ${cls(r.lifetimePnlPct)}">${fmt.pct(r.lifetimePnlPct, 2)}</td>
        <td class="num">${r.ordersSeason}</td><td class="num">${(r.winRate * 100).toFixed(0)}%</td><td class="num ${cls(r.yhat)}">${r.yhat == null ? '—' : r.yhat.toFixed(4)}</td>
        <td>${r.exposure ? `<span class="pos">LONG ${fmt.qty(r.positionQty)}</span>` : '<span class="dim">flat</span>'}</td><td class="dim small">${esc(r.lastAction ?? '')}</td></tr>`,
    )
    .join('');
  el('standings').querySelectorAll('tr[data-slot]').forEach((tr) => tr.addEventListener('click', () => { state.selected = Number(tr.dataset.slot); renderDetail(); }));
  const h = L.hallOfFame;
  el('hof').innerHTML = [
    metric('Best season', h.bestSeason ? `${h.bestSeason.id} ${fmt.pct(h.bestSeason.pnlPct)} (s${h.bestSeason.season})` : '—'),
    metric('Longest survivor', h.longestSurvivor ? `${h.longestSurvivor.id} · ${h.longestSurvivor.seasons} seasons` : '—'),
    metric('Titles', Object.entries(h.champions || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => `${id}×${n}`).join(', ') || '—'),
  ].join('');
  el('history').innerHTML = L.history.length
    ? L.history.map((s) => `<tr><td>${s.season}</td><td class="mono">${s.table[0]?.id ?? '—'}</td><td class="num ${cls(s.table[0]?.seasonPnlPct)}">${fmt.pct(s.table[0]?.seasonPnlPct)}</td><td class="mono dim">${s.relegated.join(', ')}</td><td class="mono dim">${s.newborn.map((n) => `${n.id}←${n.parent}`).join(', ')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="dim">first season in progress</td></tr>';
  if (state.selected === null && L.table.length) { state.selected = L.table[0].slot; renderDetail(); }
}

async function renderDetail() {
  if (state.selected === null) return;
  let s;
  try {
    const j = await (await fetch(`/api/fly/${state.selected}`)).json();
    s = j.data;
  } catch { return; }
  if (!s) return;
  el('detail-title').textContent = `Fly ${esc(s.label ?? '')} · slot ${state.selected}`;
  el('detail-sub').textContent = `${s.status} · sub ${String(s.subaccountId).slice(0, 8)} · H=${s.model.horizon}s · replay IC ${Number(s.model.valIc).toFixed(3)}`;
  const snap = s.snapshot;
  el('detail-metrics').innerHTML = [
    metric('Equity', fmt.usd(s.equity)),
    metric('Position', fmt.qty(s.positionQty)),
    metric('ŷ', snap ? snap.yhat.toFixed(4) : '—', snap ? cls(snap.yhat) : ''),
    metric('Enter / exit', `${s.policy.thetaInAbs.toFixed(4)} / ${s.policy.thetaOutAbs.toFixed(4)}`),
    metric('Hold ≥', `${s.policy.minHoldSec}s`),
    metric('Brain', `gain ${s.model.brain.gain.toFixed(2)} leak ${s.model.brain.leak.toFixed(2)} K=${s.model.brain.substeps} p=${s.model.brain.normP.toFixed(2)}`),
  ].join('');
  drawReadout(s.history, [s.policy.thetaInAbs, s.policy.thetaOutAbs]);
  if (snap) {
    const maxMean = Math.max(...snap.populations.map((p) => p.mean), 1e-9);
    el('pops').innerHTML = snap.populations.map((p) => {
      const kind = SENSORY.includes(p.name) ? 'sensory' : p.name === 'DESCENDING' ? 'readout' : 'central';
      return `<div class="pop ${kind}"><span class="pname">${p.name}</span><span class="pn">${p.n.toLocaleString()}</span><span class="pbar"><span style="width:${((p.mean / maxMean) * 100).toFixed(1)}%"></span></span><span class="pval">${p.mean.toFixed(3)}</span></div>`;
    }).join('');
    drawDescending(snap.descending);
  }
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

function drawReadout(hist, thresholds) {
  const { ctx, w, h } = canvas2d('readout');
  if (!hist || hist.length < 2) { ctx.fillStyle = '#848e9c'; ctx.font = '12px sans-serif'; ctx.fillText('readout history builds up second by second', 12, 24); return; }
  const pad = 8;
  const lim = Math.max(...thresholds.map(Math.abs), ...hist.map((p) => Math.abs(p.yhat)), 1e-6) * 1.1;
  const x = (i) => pad + (i / (hist.length - 1)) * (w - 2 * pad);
  const y = (v) => h / 2 - (v / lim) * (h / 2 - pad);
  const bw = Math.max(1, (w - 2 * pad) / hist.length);
  ctx.fillStyle = 'rgba(14, 203, 129, 0.2)';
  hist.forEach((p, i) => { if (p.exposure > 0) ctx.fillRect(x(i), y(0) - (h / 2 - pad), bw, h / 2 - pad); });
  ctx.strokeStyle = '#2b3139'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  for (const lvl of [0, ...thresholds]) { ctx.beginPath(); ctx.moveTo(pad, y(lvl)); ctx.lineTo(w - pad, y(lvl)); ctx.stroke(); }
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
    const j = await (await fetch('/api/league')).json();
    if (!j.ok) throw new Error(j.error);
    renderLeague(j.data);
    banner(null);
    el('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
    if (state.selected !== null) renderDetail();
  } catch (e) {
    banner(`league unreachable — is \`npm run fly league <symbol>\` running? (${e.message})`);
  }
}
refresh();
setInterval(refresh, POLL_MS);
