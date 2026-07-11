// bitshuriken agents — management dashboard (vanilla, polls the agentd control API same-origin)

const POLL_MS = 5000;
const INTEGRITY_EVERY = 3; // refresh integrity once per N ticks (it pages trade history)

const state = {
  objective: 'sharpe',
  selectedId: null,
  agents: [],
  integrityById: new Map(),
  tick: 0,
};

// ---- api ----
async function get(path) {
  const r = await fetch(path);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || `GET ${path} failed`);
  return j.data;
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || `POST ${path} failed`);
  return j.data;
}

// ---- format ----
const fmt = {
  usd: (x) => (x == null || !isFinite(x) ? '—' : x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
  qty: (x) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(6).replace(/\.?0+$/, '')),
  pct: (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(2) + '%'),
  signed: (x) => (x > 0 ? '+' : '') + fmt.usd(x),
  uptime: (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  },
  ago: (ms) => (ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`),
};
const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const el = (id) => document.getElementById(id);

function banner(msg) {
  const b = el('banner');
  if (!msg) return b.classList.add('hidden');
  b.textContent = msg;
  b.classList.remove('hidden');
}

// ---- render ----
function renderHealth(h) {
  el('h-status').textContent = 'online';
  el('h-status').className = 'v pos';
  el('h-uptime').textContent = fmt.uptime(h.uptimeMs);
  el('h-agents').textContent = h.agents;
  el('h-strategies').textContent = h.strategies;
}

function renderAgents(agents) {
  const body = el('agents-body');
  if (!agents.length) {
    body.innerHTML = '<tr><td colspan="8" class="dim">No agents running. Start one with the CLI: <span class="mono">npm run cli start &lt;strategy&gt; &lt;symbol&gt;</span></td></tr>';
    return;
  }
  body.innerHTML = agents
    .map((a) => {
      const integ = state.integrityById.get(a.id);
      const ib = integ ? `<span class="badge ${integ.status}">${integ.status}</span>` : '<span class="dim">—</span>';
      const pnl = a.equityUsdt - a.capitalUsdt;
      return `<tr data-id="${a.id}" class="${a.id === state.selectedId ? 'selected' : ''}">
        <td class="mono">${a.id}</td>
        <td>${a.strategyId}</td>
        <td>${a.symbol}</td>
        <td><span class="badge ${a.status}">${a.status}</span></td>
        <td class="num ${cls(pnl)}">${fmt.usd(a.equityUsdt)}</td>
        <td class="num">${fmt.qty(a.positionQty)}</td>
        <td class="num ${a.consecutiveErrors ? 'neg' : ''}">${a.consecutiveErrors}</td>
        <td>${ib}</td>
      </tr>`;
    })
    .join('');
  body.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => selectAgent(tr.dataset.id)));
}

function renderRanking(result) {
  const body = el('ranking-body');
  if (!result.rows.length) {
    body.innerHTML = '<tr><td colspan="9" class="dim">No agents to rank yet.</td></tr>';
    return;
  }
  body.innerHTML = result.rows
    .map((r) => {
      const base = r.id === result.baselineId ? ' baseline' : '';
      return `<tr class="${base}">
        <td>${r.rank}</td>
        <td>${r.strategyId}${r.id === result.baselineId ? ' <span class="dim">(base)</span>' : ''}</td>
        <td>${r.symbol}</td>
        <td class="num ${cls(r.roi)}">${fmt.pct(r.roi)}</td>
        <td class="num ${cls(r.totalPnl)}">${fmt.signed(r.totalPnl)}</td>
        <td class="num">${r.sharpe.toFixed(2)}</td>
        <td class="num neg">${fmt.pct(r.maxDrawdown)}</td>
        <td class="num">${fmt.pct(r.winRate)}</td>
        <td class="num">${r.tradeCount}</td>
      </tr>`;
    })
    .join('');
}

function renderIntegrity(reports) {
  el('integrity-time').textContent = reports.length ? `checked ${new Date().toLocaleTimeString()}` : '';
  const body = el('integrity-body');
  if (!reports.length) {
    body.innerHTML = '<p class="dim">No agents to check.</p>';
    return;
  }
  body.innerHTML = reports
    .map(
      (r) => `<div class="iagent">
      <div class="iagent-head">
        <span class="badge ${r.status}">${r.status}</span>
        <span class="name mono">${r.agentId}</span>
        <span class="sym">${r.strategyId} · ${r.symbol}</span>
      </div>
      <div class="checks">
        ${r.checks
          .map(
            (c) => `<div class="check"><span class="dot ${c.status}"></span><span class="cname">${c.name}</span><span class="cdetail">${escapeHtml(c.detail)}</span></div>`,
          )
          .join('')}
      </div>
    </div>`,
    )
    .join('');
}

async function renderDetail(id) {
  const a = state.agents.find((x) => x.id === id);
  if (!a) return;
  el('detail-title').textContent = `${a.strategyId} · ${a.symbol}`;
  el('detail-sub').textContent = `${a.id} · sub ${a.subaccountId} · ${a.interval}`;
  el('detail-body').innerHTML = '<p class="dim">Loading metrics…</p>';
  let m;
  try {
    m = await get(`/agents/${id}/metrics`);
  } catch (e) {
    el('detail-body').innerHTML = `<p class="neg">${escapeHtml(e.message)}</p>`;
    return;
  }
  el('detail-body').innerHTML = `
    <div class="metrics">
      ${metric('Equity', fmt.usd(m.finalEquity))}
      ${metric('ROI', fmt.pct(m.roi), cls(m.roi))}
      ${metric('Total PnL', fmt.signed(m.totalPnl), cls(m.totalPnl))}
      ${metric('Realized', fmt.signed(m.realizedPnl), cls(m.realizedPnl))}
      ${metric('Unrealized', fmt.signed(m.unrealizedPnl), cls(m.unrealizedPnl))}
      ${metric('Max DD', fmt.pct(m.maxDrawdown), 'neg')}
      ${metric('Sharpe', m.sharpe.toFixed(2))}
      ${metric('Win rate', fmt.pct(m.winRate))}
      ${metric('Trades', String(m.tradeCount))}
      ${metric('Fees', fmt.usd(m.feesPaid))}
    </div>
    <div class="chart-wrap"><canvas id="equity"></canvas></div>`;
  drawEquity(m.equityCurve, m.initialCapital);
}

const metric = (label, value, c = '') => `<div class="metric"><span class="ml">${label}</span><span class="mv ${c}">${value}</span></div>`;

function drawEquity(curve, initial) {
  const cv = el('equity');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!curve || curve.length < 2) {
    ctx.fillStyle = '#848e9c'; ctx.font = '12px sans-serif';
    ctx.fillText('not enough equity samples yet', 12, 24);
    return;
  }
  const pad = 8;
  const ys = curve.map((p) => p.equity);
  const lo = Math.min(...ys, initial), hi = Math.max(...ys, initial);
  const range = hi - lo || 1;
  const x = (i) => pad + (i / (curve.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - lo) / range) * (h - 2 * pad);
  // baseline (initial capital)
  ctx.strokeStyle = '#2b3139'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad, y(initial)); ctx.lineTo(w - pad, y(initial)); ctx.stroke();
  ctx.setLineDash([]);
  // equity line
  const last = ys[ys.length - 1];
  ctx.strokeStyle = last >= initial ? '#0ecb81' : '#f6465d';
  ctx.lineWidth = 1.5; ctx.beginPath();
  curve.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.equity)) : ctx.moveTo(x(i), y(p.equity))));
  ctx.stroke();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function selectAgent(id) {
  state.selectedId = id;
  document.querySelectorAll('#agents-body tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === id));
  renderDetail(id);
}

// ---- poll ----
async function refresh() {
  try {
    const [health, agents, ranking] = await Promise.all([get('/health'), get('/agents'), post('/compare', { objective: state.objective })]);
    banner(null);
    state.agents = agents;
    renderHealth(health);
    renderAgents(agents);
    renderRanking(ranking);
    if (state.selectedId && agents.some((a) => a.id === state.selectedId)) renderDetail(state.selectedId);
    if (state.tick % INTEGRITY_EVERY === 0) {
      const reports = await get('/integrity');
      state.integrityById = new Map(reports.map((r) => [r.agentId, r]));
      renderIntegrity(reports);
      renderAgents(state.agents); // repaint integrity badges in the agents table
    }
    el('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    el('h-status').textContent = 'offline';
    el('h-status').className = 'v neg';
    banner(`agentd unreachable — is the daemon running? (${e.message})`);
  } finally {
    state.tick++;
  }
}

el('objective').addEventListener('change', (e) => { state.objective = e.target.value; refresh(); });
el('refresh').addEventListener('click', () => { state.tick = 0; refresh(); });

refresh();
setInterval(refresh, POLL_MS);
