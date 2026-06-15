// ============================================================
// CONFIG
// ============================================================
const API_BASE = (window.SEREIA_API_BASE || 'https://sereia-cs.up.railway.app').replace(/\/+$/, '');
const TOKEN_KEY = 'sereia-cs-token';

// ============================================================
// LOGIN
// ============================================================
const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const tokenInput = document.getElementById('token-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function tentarLogin(token) {
  loginError.textContent = '';
  try {
    const r = await fetch(`${API_BASE}/api/metrics/overview`, { headers: { 'X-CS-Token': token } });
    if (r.status === 401) { loginError.textContent = 'Token inválido.'; return false; }
    if (!r.ok) { loginError.textContent = 'Erro ao conectar com o servidor.'; return false; }
    setToken(token);
    iniciarDashboard();
    return true;
  } catch (err) {
    loginError.textContent = 'Não foi possível alcançar o servidor.';
    return false;
  }
}

loginBtn.addEventListener('click', () => {
  const t = tokenInput.value.trim();
  if (t) tentarLogin(t);
});

tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  clearToken();
  location.reload();
});

// ============================================================
// FETCH HELPER
// ============================================================
async function api(path) {
  const token = getToken();
  const r = await fetch(`${API_BASE}${path}`, { headers: { 'X-CS-Token': token } });
  if (r.status === 401) { clearToken(); location.reload(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

// ============================================================
// DASHBOARD INIT
// ============================================================
function iniciarDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');

  configurarTabs();
  conectarWebSocket();
  carregarVolume();
  carregarBacklog();

  // Refresh periódico (fallback caso o WS caia)
  setInterval(carregarBacklog, 30000);
  setInterval(carregarVolume, 60000);
}

// ============================================================
// TABS
// ============================================================
function configurarTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `panel-${tab}`));
      if (tab === 'volume') carregarVolume();
      if (tab === 'backlog') carregarBacklog();
    });
  });
}

// ============================================================
// VOLUME
// ============================================================
async function carregarVolume() {
  try {
    const [overview, series, heatmap, top] = await Promise.all([
      api('/api/metrics/overview'),
      api('/api/metrics/timeseries?days=30'),
      api('/api/metrics/heatmap'),
      api('/api/metrics/top-clientes?period=mes&limit=10')
    ]);
    renderOverview(overview);
    renderTimeseries(series);
    renderHeatmap(heatmap);
    renderTopClientes(top);
  } catch (err) {
    console.error('volume erro:', err);
  }
}

function renderOverview(o) {
  document.getElementById('metric-hoje').textContent = fmtNum(o.hoje.valor);
  document.getElementById('metric-semana').textContent = fmtNum(o.semana.valor);
  document.getElementById('metric-mes').textContent = fmtNum(o.mes.valor);

  setDelta('metric-hoje-delta', o.hoje.delta_abs, ' vs ontem', false);
  setDelta('metric-semana-delta', o.semana.delta_pct, '% vs semana passada', true);
  setDelta('metric-mes-delta', o.mes.delta_pct, '% vs mês anterior', true);
}

function setDelta(id, valor, suffix, isPct) {
  const el = document.getElementById(id);
  el.classList.remove('up', 'down', 'flat');
  if (valor === null || valor === undefined) { el.textContent = ''; el.classList.add('flat'); return; }
  const num = Number(valor);
  const dir = num > 0 ? 'up' : num < 0 ? 'down' : 'flat';
  const icon = num > 0 ? 'ti-trending-up' : num < 0 ? 'ti-trending-down' : 'ti-minus';
  const prefix = num > 0 ? '+' : '';
  el.classList.add(dir);
  el.innerHTML = `<i class="ti ${icon}"></i> ${prefix}${num}${suffix}`;
}

function renderTimeseries(series) {
  const svg = document.getElementById('timeseries');
  if (!series.length) { svg.innerHTML = ''; return; }

  const W = 700, H = 180, padL = 30, padR = 10, padT = 12, padB = 24;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const maxY = Math.max(10, ...series.map((d) => Math.max(d.abertos, d.resolvidos))) * 1.1;
  const step = series.length > 1 ? innerW / (series.length - 1) : 0;

  const pathFor = (key) => series.map((d, i) => `${i === 0 ? 'M' : 'L'} ${padL + i * step},${padT + innerH - (d[key] / maxY) * innerH}`).join(' ');

  svg.innerHTML = `
    <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="rgba(0,0,0,0.1)" stroke-width="0.5"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="rgba(0,0,0,0.1)" stroke-width="0.5"/>
    <line x1="${padL}" y1="${padT + innerH/2}" x2="${W - padR}" y2="${padT + innerH/2}" stroke="rgba(0,0,0,0.05)" stroke-width="0.5" stroke-dasharray="2,3"/>
    <path d="${pathFor('abertos')}" fill="none" stroke="#D85C3F" stroke-width="1.5"/>
    <path d="${pathFor('resolvidos')}" fill="none" stroke="#4A2C4F" stroke-width="1.5" stroke-dasharray="3,2"/>
    <text x="4" y="${padT + 6}" font-size="9" fill="#888780">${Math.round(maxY)}</text>
    <text x="4" y="${padT + innerH + 4}" font-size="9" fill="#888780">0</text>
    <text x="${padL}" y="${H - 8}" font-size="9" fill="#888780">${formatDia(series[0].dia)}</text>
    <text x="${W - padR - 20}" y="${H - 8}" font-size="9" fill="#888780" text-anchor="end">hoje</text>
  `;
}

function renderHeatmap(matriz) {
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const container = document.getElementById('heatmap');
  // matriz vem do banco como dow 0=domingo. Reordenamos pra começar segunda.
  const ordemSemana = [1, 2, 3, 4, 5, 6, 0];

  // Encontra o máximo pra escalar bandas
  const flat = matriz.flat();
  const max = Math.max(1, ...flat);

  function band(v) {
    if (!v) return 0;
    const r = v / max;
    if (r < 0.2) return 1;
    if (r < 0.4) return 2;
    if (r < 0.7) return 3;
    return 4;
  }

  let html = '<div></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="label-h">${h}h</div>`;
  }
  ordemSemana.forEach((dow) => {
    html += `<div class="label-d">${dias[dow]}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = matriz[dow][h] || 0;
      html += `<span class="hm-cell hm-${band(v)}" title="${dias[dow]} ${h}h: ${v}"></span>`;
    }
  });
  container.innerHTML = html;
}

function renderTopClientes(rows) {
  const tbody = document.getElementById('top-clientes-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="4" class="muted" style="padding:1rem;text-align:center;">Sem dados</td></tr>'; return; }
  tbody.innerHTML = rows.map((r) => {
    const pct = r.pct_resolvido ?? 0;
    const pctClass = pct >= 90 ? 'pct-good' : pct >= 80 ? 'pct-warn' : 'pct-bad';
    return `
      <tr>
        <td>${escapeHtml(r.nome)}</td>
        <td class="num"><strong>${r.total}</strong></td>
        <td class="num ${pctClass}">${pct}%</td>
        <td class="num">${sparkline(r.sparkline || [])}</td>
      </tr>
    `;
  }).join('');
}

function sparkline(data) {
  if (!data || !data.length) return '<span class="muted">—</span>';
  const W = 100, H = 22;
  const max = Math.max(1, ...data);
  const step = data.length > 1 ? W / (data.length - 1) : 0;
  const pts = data.map((v, i) => `${i * step},${H - 2 - (v / max) * (H - 4)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:80px;height:22px;vertical-align:middle;"><polyline points="${pts}" fill="none" stroke="#4A2C4F" stroke-width="1"/></svg>`;
}

// ============================================================
// BACKLOG
// ============================================================
async function carregarBacklog() {
  try {
    const data = await api('/api/backlog');
    renderBacklog(data);
  } catch (err) {
    console.error('backlog erro:', err);
  }
}

function renderBacklog({ resumo, chamados }) {
  document.getElementById('kpi-ok').textContent = resumo.ok;
  document.getElementById('kpi-atencao').textContent = resumo.atencao;
  document.getElementById('kpi-critico').textContent = resumo.critico;
  document.getElementById('kpi-tempo').textContent = `${resumo.tempo_medio_aguardando_min} min`;

  const badge = document.getElementById('tab-badge-backlog');
  const totalAguardando = resumo.ok + resumo.atencao + resumo.critico;
  if (totalAguardando > 0) {
    badge.textContent = totalAguardando;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const list = document.getElementById('backlog-list');
  const empty = document.getElementById('backlog-empty');

  if (!chamados.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = chamados.map((c) => {
    const aguardando = c.aguardando_desde !== null;
    const dotClass = !aguardando
      ? 'dot-purple'
      : c.semaforo === 'critico' ? 'dot-red'
      : c.semaforo === 'atencao' ? 'dot-amber'
      : 'dot-green';

    const tempoFmt = aguardando
      ? `${fmtMinutos(c.aguardando_minutos)} aguardando`
      : `respondido · ${fmtMinutos(c.minutos_aberto)} aberto`;
    const tempoUrgent = aguardando && c.semaforo === 'critico';
    const resp = c.responsavel_nome || (aguardando ? 'sem resposta' : '—');
    const respClass = !c.responsavel_nome && aguardando ? 'aguardando' : '';

    return `
      <div class="backlog-row">
        <span class="dot ${dotClass}" title="${aguardando ? 'aguardando resposta' : 'aguardando cliente'}"></span>
        <div class="cliente">${escapeHtml(c.cliente_nome)}</div>
        <div class="tempo ${tempoUrgent ? 'urgent' : ''}">${tempoFmt}</div>
        <div class="msg">${escapeHtml(c.ultima_mensagem || c.texto_abertura || '')}</div>
        <div class="resp ${respClass}">${escapeHtml(resp)}</div>
      </div>
    `;
  }).join('');
}

// ============================================================
// WEBSOCKET
// ============================================================
let socket = null;
function conectarWebSocket() {
  socket = io(API_BASE, { auth: { token: getToken() }, transports: ['websocket', 'polling'] });

  const dot = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');

  socket.on('connect', () => { dot.classList.add('connected'); dot.classList.remove('error'); label.textContent = 'ao vivo'; });
  socket.on('disconnect', () => { dot.classList.remove('connected'); label.textContent = 'reconectando'; });
  socket.on('connect_error', () => { dot.classList.add('error'); label.textContent = 'erro de conexão'; });

  socket.on('backlog:atualizado', () => carregarBacklog());
  socket.on('chamado:novo', () => { carregarBacklog(); carregarVolume(); });
  socket.on('chamado:fechado', () => { carregarBacklog(); carregarVolume(); });
}

// ============================================================
// UTILS
// ============================================================
function fmtNum(n) {
  return Number(n).toLocaleString('pt-BR');
}

function fmtMinutos(min) {
  const m = Number(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

function formatDia(iso) {
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================
// BOOT
// ============================================================
if (getToken()) {
  tentarLogin(getToken()).then((ok) => { if (!ok) loginView.classList.remove('hidden'); });
}
