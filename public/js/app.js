/* ═══════════════════════════════════════════════
   DataVibe — Frontend Application
   ═══════════════════════════════════════════════ */

const API = '';
let TOKEN = localStorage.getItem('dv_token');
let USER = JSON.parse(localStorage.getItem('dv_user') || 'null');
let currentDataset = null;
let currentDashboard = null;
let chartInstances = [];

// ─── API Helper ───
async function api(path, opts = {}) {
  const headers = { ...opts.headers };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Toast ───
function toast(msg, type = 'success') {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ─── Utility ───
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════
//  INIT & AUTH
// ═══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  console.log('[DV] DOM ready');
  bindAuth();
  bindNav();
  bindUpload();

  if (TOKEN && USER) {
    showApp();
  } else {
    showAuth();
  }
});

function showAuth() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app-layout').style.display = 'none';
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-layout').style.display = 'flex';
  if (USER) {
    document.getElementById('user-avatar').textContent = USER.username[0].toUpperCase();
    document.getElementById('user-name').textContent = USER.username;
    document.getElementById('topbar-welcome').textContent = `Hello, ${USER.username} 👋`;
  }
  navigateTo('overview');
  loadStats();
}

function bindAuth() {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const toggleLinks = document.querySelectorAll('.auth-toggle a');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const login = document.getElementById('login-user').value;
    const password = document.getElementById('login-pass').value;
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: { login, password } });
      TOKEN = data.token; USER = data.user;
      localStorage.setItem('dv_token', TOKEN);
      localStorage.setItem('dv_user', JSON.stringify(USER));
      showApp();
      toast('Welcome back!');
    } catch (err) {
      const el = document.getElementById('login-error');
      el.textContent = err.message;
      el.classList.add('show');
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-user').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-pass').value;
    try {
      const data = await api('/api/auth/register', { method: 'POST', body: { username, email, password } });
      TOKEN = data.token; USER = data.user;
      localStorage.setItem('dv_token', TOKEN);
      localStorage.setItem('dv_user', JSON.stringify(USER));
      showApp();
      toast('Account created!');
    } catch (err) {
      const el = document.getElementById('reg-error');
      el.textContent = err.message;
      el.classList.add('show');
    }
  });

  toggleLinks.forEach(link => {
    link.addEventListener('click', () => {
      loginForm.style.display = loginForm.style.display === 'none' ? 'block' : 'none';
      registerForm.style.display = registerForm.style.display === 'none' ? 'block' : 'none';
      document.querySelectorAll('.auth-error').forEach(e => e.classList.remove('show'));
    });
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    TOKEN = null; USER = null;
    localStorage.removeItem('dv_token');
    localStorage.removeItem('dv_user');
    showAuth();
  });
}

// ═══════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════

function bindNav() {
  document.querySelectorAll('.nav-item[data-section]').forEach(item => {
    item.addEventListener('click', () => {
      navigateTo(item.dataset.section);
      closeSidebar();
    });
  });
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('show');
  });
  document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
}

function navigateTo(section) {
  console.log('[DV] navigateTo:', section);
  // Destroy any existing charts
  destroyCharts();

  // Hide everything
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('dv-viewer').classList.remove('active');

  // Show target
  const el = document.getElementById('section-' + section);
  if (el) el.classList.add('active');
  const nav = document.querySelector(`.nav-item[data-section="${section}"]`);
  if (nav) nav.classList.add('active');

  const titles = { overview: '📊 Overview', upload: '📤 Upload Data', datasets: '📂 My Datasets', dashboards: '📈 Dashboards', export: '📥 Export Center' };
  document.getElementById('topbar-title').textContent = titles[section] || 'DataVibe';

  if (section === 'datasets') loadDatasets();
  if (section === 'dashboards') loadDashboards();
  if (section === 'export') loadExportCenter();
}

function destroyCharts() {
  chartInstances.forEach(c => { try { c.destroy(); } catch(e) {} });
  chartInstances = [];
}

async function loadStats() {
  try {
    const data = await api('/api/auth/me');
    document.getElementById('stat-datasets').textContent = data.stats.datasets;
    document.getElementById('stat-dashboards').textContent = data.stats.dashboards;
  } catch {}
}

// ═══════════════════════════════════════════════
//  FILE UPLOAD
// ═══════════════════════════════════════════════

function bindUpload() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('file-input');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files.length) uploadFile(input.files[0]); });
}

async function uploadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx', 'xls', 'json', 'tsv'].includes(ext)) {
    toast('Unsupported format. Use CSV, XLSX, JSON, or TSV.', 'error');
    return;
  }

  const bar = document.getElementById('upload-progress');
  const fill = bar.querySelector('.fill');
  const result = document.getElementById('upload-result');
  bar.style.display = 'block';
  result.style.display = 'none';
  fill.style.width = '30%';

  const fd = new FormData();
  fd.append('file', file);

  try {
    fill.style.width = '60%';
    const data = await api('/api/datasets/upload', { method: 'POST', body: fd });
    fill.style.width = '100%';
    setTimeout(() => { bar.style.display = 'none'; }, 500);

    currentDataset = data;
    result.style.display = 'block';
    document.getElementById('result-name').textContent = data.name;
    document.getElementById('result-rows').textContent = data.rowCount;
    document.getElementById('result-cols').textContent = data.columns.length;
    document.getElementById('result-type').textContent = data.fileType.toUpperCase();

    // Preview
    const preview = document.getElementById('result-preview');
    if (data.preview && data.preview.length) {
      let html = '<table><thead><tr>' + data.columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
      data.preview.forEach(r => {
        html += '<tr>' + data.columns.map(c => `<td>${esc(String(r[c] ?? ''))}</td>`).join('') + '</tr>';
      });
      html += '</tbody></table>';
      preview.innerHTML = html;
    }
    loadStats();
    toast('File uploaded successfully!');
  } catch (err) {
    bar.style.display = 'none';
    toast(err.message, 'error');
  }
}

// Global: called from inline onclick
function createDashboard() {
  if (!currentDataset) { toast('No dataset loaded', 'error'); return; }
  createDashboardFromDataset(currentDataset.id, currentDataset.name);
}

// ═══════════════════════════════════════════════
//  DATASETS LIST
// ═══════════════════════════════════════════════

async function loadDatasets() {
  const grid = document.getElementById('datasets-grid');
  try {
    const datasets = await api('/api/datasets');
    if (!datasets.length) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📂</div><h3>No datasets yet</h3><p>Upload a file to get started</p></div>';
      return;
    }
    grid.innerHTML = datasets.map(ds => `
      <div class="dataset-card">
        <button class="ds-delete" onclick="deleteDataset('${ds.id}')" title="Delete">🗑️</button>
        <h3>📄 ${esc(ds.name)}</h3>
        <div class="ds-meta">
          <span class="ds-tag">${ds.row_count} rows</span>
          <span class="ds-tag">${ds.columns.length} columns</span>
          <span class="ds-tag">${ds.file_type.toUpperCase()}</span>
        </div>
        <div class="ds-columns">${ds.columns.slice(0, 5).map(c => `<span class="col-chip">${esc(c)}</span>`).join('')}${ds.columns.length > 5 ? `<span class="col-chip">+${ds.columns.length - 5}</span>` : ''}</div>
        <div class="ds-actions">
          <button class="btn btn-sm btn-primary" onclick="createDashboardFromDataset('${ds.id}', '${esc(ds.name)}')">📊 Create Dashboard</button>
        </div>
      </div>
    `).join('');
  } catch (err) { grid.innerHTML = `<p style="color:var(--accent-2)">${esc(err.message)}</p>`; }
}

async function deleteDataset(id) {
  if (!confirm('Delete this dataset and associated dashboards?')) return;
  try { await api(`/api/datasets/${id}`, { method: 'DELETE' }); toast('Deleted'); loadDatasets(); loadStats(); }
  catch (err) { toast(err.message, 'error'); }
}

async function createDashboardFromDataset(datasetId, name) {
  console.log('[DV] createDashboard:', datasetId, name);
  try {
    const dash = await api('/api/dashboards', { method: 'POST', body: { datasetId, title: (name || 'Dashboard') + ' Dashboard' } });
    toast('Dashboard created!');
    openDashboard(dash.id);
  } catch (err) { toast(err.message, 'error'); }
}

// ═══════════════════════════════════════════════
//  DASHBOARDS LIST
// ═══════════════════════════════════════════════

async function loadDashboards() {
  const grid = document.getElementById('dashboards-grid');
  try {
    const dashboards = await api('/api/dashboards');
    if (!dashboards.length) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📈</div><h3>No dashboards yet</h3><p>Create one from a dataset</p></div>';
      return;
    }
    grid.innerHTML = dashboards.map(d => `
      <div class="dashboard-card" onclick="openDashboard('${d.id}')">
        <button class="db-delete" onclick="event.stopPropagation(); deleteDashboard('${d.id}')">🗑️</button>
        <h3>📊 ${esc(d.title)}</h3>
        <div class="db-meta">
          <span>📁 ${esc(d.dataset_name)}</span>
          <span>👁️ ${d.view_count} views</span>
          <span>📋 ${d.row_count} rows</span>
        </div>
      </div>
    `).join('');
  } catch (err) { grid.innerHTML = `<p style="color:var(--accent-2)">${esc(err.message)}</p>`; }
}

async function deleteDashboard(id) {
  if (!confirm('Delete this dashboard?')) return;
  try { await api(`/api/dashboards/${id}`, { method: 'DELETE' }); toast('Deleted'); loadDashboards(); loadStats(); }
  catch (err) { toast(err.message, 'error'); }
}

// ═══════════════════════════════════════════════
//  DASHBOARD VIEWER
// ═══════════════════════════════════════════════

async function openDashboard(id) {
  console.log('[DV] openDashboard:', id);
  try {
    // Fetch dashboard + chart analysis in parallel
    const dash = await api(`/api/dashboards/${id}`);
    console.log('[DV] Dashboard loaded:', dash.title, 'dataset:', dash.dataset_id);

    const analysis = await api('/api/charts/generate', {
      method: 'POST', body: { datasetId: dash.dataset_id }
    });
    console.log('[DV] Charts generated:', analysis.charts.length, 'KPIs:', analysis.kpis.length);

    // Store state
    currentDashboard = {
      id: dash.id,
      title: dash.title,
      dataset_id: dash.dataset_id,
      charts: analysis.charts,
      kpis: analysis.kpis
    };

    // Show viewer - hide all sections, show dv-viewer
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('dv-viewer').classList.add('active');
    document.getElementById('dv-title').textContent = dash.title;
    document.getElementById('topbar-title').textContent = '📊 ' + dash.title;

    // Render KPIs
    document.getElementById('kpi-bar').innerHTML = analysis.kpis.map(k => `
      <div class="kpi-item">
        <div class="kpi-icon">${k.icon}</div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-label">${esc(k.label)}</div>
      </div>
    `).join('');

    // Render first tab
    switchChartTab('distribution');

  } catch (err) {
    console.error('[DV] openDashboard error:', err);
    toast('Failed to load dashboard: ' + err.message, 'error');
  }
}

function switchChartTab(tab) {
  console.log('[DV] switchChartTab:', tab);
  destroyCharts();

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  const grid = document.getElementById('chart-grid');
  const aiSection = document.getElementById('ai-section');

  // AI tab is special
  if (tab === 'ai') {
    grid.innerHTML = '';
    aiSection.style.display = 'block';
    initAIChat();
    return;
  }
  aiSection.style.display = 'none';

  // Filter charts for this tab
  const charts = (currentDashboard.charts || []).filter(c => c.section === tab);
  console.log('[DV] Charts for tab', tab + ':', charts.length);

  if (!charts.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><h3>No charts for this section</h3></div>';
    return;
  }

  // Build HTML (single set, no +=)
  grid.innerHTML = charts.map((chart, idx) => `
    <div class="chart-card">
      <h3>📊 ${esc(chart.title)}</h3>
      <div class="chart-canvas-wrap"><canvas id="cv-${tab}-${idx}"></canvas></div>
      <div class="chart-actions">
        <button onclick="toggleInsight('ins-${tab}-${idx}')">💡 Insight</button>
        <button onclick="saveChartPNG('cv-${tab}-${idx}', '${esc(chart.title)}')">📷 Save PNG</button>
      </div>
      <div class="insight-box" id="ins-${tab}-${idx}">${esc(chart.insight || 'No insight available')}</div>
    </div>
  `).join('');

  // Render charts on next frame (wait for DOM)
  requestAnimationFrame(() => renderCharts(charts, tab));
}

function renderCharts(charts, tab) {
  console.log('[DV] renderCharts:', charts.length, 'Chart.js:', typeof Chart);
  if (typeof Chart === 'undefined') {
    document.getElementById('chart-grid').innerHTML =
      '<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Chart.js not loaded</h3></div>';
    return;
  }

  const palette = [
    '#6366f1','#f43f5e','#10b981','#f59e0b','#3b82f6',
    '#8b5cf6','#ec4899','#14b8a6','#f97316','#06b6d4',
    '#84cc16','#e11d48','#0ea5e9','#a855f7','#22c55e'
  ];

  charts.forEach((chart, idx) => {
    const canvas = document.getElementById('cv-' + tab + '-' + idx);
    if (!canvas) { console.warn('[DV] Canvas not found:', 'cv-' + tab + '-' + idx); return; }

    try {
      const ctx = canvas.getContext('2d');
      const cfg = buildChartConfig(chart, palette);
      chartInstances.push(new Chart(ctx, cfg));
    } catch (e) {
      console.error('[DV] Chart error:', chart.title, e);
    }
  });
}

function buildChartConfig(chart, palette) {
  const baseOpts = {
    responsive: true,
    maintainAspectRatio: true,
    animation: { duration: 600, easing: 'easeOutQuart' },
    plugins: {
      legend: { labels: { color: '#94a3b8', font: { size: 11 } } },
      tooltip: {
        backgroundColor: '#1e293b', titleColor: '#f1f5f9', bodyColor: '#94a3b8',
        borderColor: '#334155', borderWidth: 1, cornerRadius: 8, padding: 12
      }
    }
  };

  // Scatter
  if (chart.type === 'scatter') {
    return {
      type: 'scatter',
      data: { datasets: [{ data: chart.data.points, backgroundColor: palette[0] + '99', borderColor: palette[0], pointRadius: 5 }] },
      options: { ...baseOpts, scales: {
        x: { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8' } },
        y: { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8' } }
      }}
    };
  }

  // Stacked bar
  if (chart.stacked && chart.data.datasets) {
    return {
      type: 'bar',
      data: {
        labels: chart.data.labels,
        datasets: chart.data.datasets.map((ds, i) => ({
          ...ds, borderWidth: 1, borderColor: '#0a0e1a',
          backgroundColor: ds.backgroundColor || palette[i % palette.length]
        }))
      },
      options: { ...baseOpts, scales: {
        x: { stacked: true, grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', maxRotation: 45 } },
        y: { stacked: true, grid: { color: '#1e293b' }, ticks: { color: '#94a3b8' } }
      }}
    };
  }

  // Doughnut / Polar
  if (chart.type === 'doughnut' || chart.type === 'polarArea') {
    const labels = chart.data.labels || [];
    return {
      type: chart.type,
      data: {
        labels,
        datasets: [{ data: chart.data.values || [], backgroundColor: palette.slice(0, labels.length), borderColor: '#0a0e1a', borderWidth: 2 }]
      },
      options: { ...baseOpts, ...(chart.type === 'doughnut' ? { cutout: '55%' } : {}) }
    };
  }

  // Line
  if (chart.type === 'line') {
    return {
      type: 'line',
      data: {
        labels: chart.data.labels || [],
        datasets: [{
          label: chart.title, data: chart.data.values || [],
          borderColor: palette[0], backgroundColor: palette[0] + '20',
          borderWidth: 2, fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: palette[0]
        }]
      },
      options: { ...baseOpts, scales: {
        x: { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', maxRotation: 45 } },
        y: { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8' } }
      }}
    };
  }

  // Default: bar
  const values = chart.data.values || [];
  return {
    type: 'bar',
    data: {
      labels: chart.data.labels || [],
      datasets: [{
        label: chart.title, data: values,
        backgroundColor: palette.slice(0, values.length),
        borderColor: palette.slice(0, values.length),
        borderWidth: 1, borderRadius: 4
      }]
    },
    options: { ...baseOpts, scales: {
      x: { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', maxRotation: 45 } },
      y: { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8' } }
    }}
  };
}

function toggleInsight(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('show');
}

function saveChartPNG(canvasId, title) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = (title || 'chart').replace(/[^a-zA-Z0-9 ]/g, '') + '.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
  toast('Chart saved as PNG');
}

// ═══════════════════════════════════════════════
//  AI CHAT
// ═══════════════════════════════════════════════

function initAIChat() {
  const messages = document.getElementById('ai-messages');
  messages.innerHTML = '<div class="ai-msg bot">🤖 Hello! I can analyze your dataset. Ask me anything — averages, distributions, correlations, or get a full summary.</div>';

  document.getElementById('ai-suggestions').innerHTML = [
    'How many records?', 'Give me a summary', 'Any correlations?',
    'Top values in City', 'Average salary', 'Show profile'
  ].map(s => `<span class="ai-suggestion" onclick="aiAsk('${s}')">${s}</span>`).join('');

  document.getElementById('ai-input').onkeydown = (e) => {
    if (e.key === 'Enter') aiSend();
  };
  document.getElementById('ai-send').onclick = aiSend;
}

async function aiSend() {
  const input = document.getElementById('ai-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  aiAsk(q);
}

async function aiAsk(question) {
  const messages = document.getElementById('ai-messages');
  messages.innerHTML += `<div class="ai-msg user">${esc(question)}</div>`;
  messages.scrollTop = messages.scrollHeight;

  try {
    const data = await api('/api/analyze', {
      method: 'POST',
      body: { datasetId: currentDashboard.dataset_id, question }
    });
    messages.innerHTML += `<div class="ai-msg bot">${esc(data.answer)}</div>`;
  } catch (err) {
    messages.innerHTML += `<div class="ai-msg bot" style="color:var(--accent-2)">Error: ${esc(err.message)}</div>`;
  }
  messages.scrollTop = messages.scrollHeight;
}

// ═══════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════

async function loadExportCenter() {
  try {
    const datasets = await api('/api/datasets');
    const sel = document.getElementById('export-dataset-select');
    sel.innerHTML = datasets.map(d => `<option value="${d.id}">${esc(d.name)} (${d.row_count} rows)</option>`).join('');
  } catch {}

  document.querySelectorAll('.format-card[data-format]').forEach(card => {
    card.onclick = () => {
      const format = card.dataset.format;
      const datasetId = document.getElementById('export-dataset-select').value;
      if (!datasetId) { toast('Select a dataset first', 'error'); return; }
      if (format === 'png') { toast('Export PNG from a dashboard viewer', 'success'); return; }
      window.open(`${API}/api/export/${format}/${datasetId}`, '_blank');
    };
  });
}

function exportFromDashboard(format) {
  if (!currentDashboard) return;
  document.getElementById('export-dropdown').classList.remove('show');

  if (format === 'png') {
    chartInstances.forEach((c, i) => {
      const link = document.createElement('a');
      link.download = `chart-${i + 1}.png`;
      link.href = c.canvas.toDataURL('image/png');
      link.click();
    });
    toast('Charts exported as PNG');
  } else if (format === 'pdf') {
    generatePDFReport();
  } else {
    window.open(`${API}/api/export/${format}/${currentDashboard.dataset_id}`, '_blank');
  }
}

// ═══════════════════════════════════════════════
//  PDF GENERATION (Client-side jsPDF)
// ═══════════════════════════════════════════════

async function generatePDFReport() {
  if (!currentDashboard || !chartInstances.length) {
    toast('No charts to export', 'error');
    return;
  }

  // Show loading toast
  toast('Generating PDF report...');

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = 210, pageH = 297;
    const margin = 15;
    const contentW = pageW - margin * 2;
    let y = margin;
    let pageNum = 1;

    // ─── Title Page ───
    // Gradient bar at top
    doc.setFillColor(99, 102, 241);
    doc.rect(0, 0, pageW * 0.5, 6, 'F');
    doc.setFillColor(244, 63, 94);
    doc.rect(pageW * 0.5, 0, pageW * 0.5, 6, 'F');

    y = 20;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(28);
    doc.setTextColor(99, 102, 241);
    doc.text('DataVibe', margin, y);

    y += 12;
    doc.setFontSize(18);
    doc.setTextColor(30, 41, 59);
    doc.text(currentDashboard.title || 'Dashboard Report', margin, y);

    y += 8;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text('Generated: ' + new Date().toLocaleString(), margin, y);

    // KPIs
    y += 15;
    if (currentDashboard.kpis && currentDashboard.kpis.length) {
      const kpiPerRow = Math.min(currentDashboard.kpis.length, 4);
      const kpiW = contentW / kpiPerRow;
      const kpiH = 22;

      currentDashboard.kpis.forEach((kpi, i) => {
        const row = Math.floor(i / kpiPerRow);
        const col = i % kpiPerRow;
        const kx = margin + col * kpiW;
        const ky = y + row * (kpiH + 4);

        doc.setFillColor(241, 245, 249);
        doc.roundedRect(kx + 1, ky, kpiW - 2, kpiH, 3, 3, 'F');

        doc.setFontSize(18);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(99, 102, 241);
        doc.text(String(kpi.value), kx + kpiW / 2, ky + 10, { align: 'center' });

        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(100, 116, 139);
        doc.text(kpi.label, kx + kpiW / 2, ky + 18, { align: 'center' });
      });

      y += Math.ceil(currentDashboard.kpis.length / kpiPerRow) * (kpiH + 4) + 5;
    }

    // Divider
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageW - margin, y);
    y += 8;

    // ─── Charts Section ───
    const activeTab = document.querySelector('.tab-btn.active');
    const sectionTitle = activeTab ? activeTab.textContent.trim() : 'Charts';

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text(sectionTitle, margin, y);
    y += 8;

    for (let i = 0; i < chartInstances.length; i++) {
      try {
        const canvas = chartInstances[i].canvas;
        if (!canvas || canvas.width < 10 || canvas.height < 10) continue;

        const imgData = canvas.toDataURL('image/png', 0.95);
        if (!imgData || imgData.length < 100) continue;

        const canvasRatio = canvas.height / canvas.width;
        const imgW = contentW;
        const imgH = Math.min(imgW * canvasRatio, 90);

        // Page break
        if (y + imgH + 16 > pageH - margin) {
          drawFooter(doc, pageW, pageH, pageNum);
          doc.addPage();
          pageNum++;
          y = margin;
        }

        // Chart title
        const chartCard = canvas.closest('.chart-card');
        const cTitle = chartCard ? (chartCard.querySelector('h3')?.textContent?.replace('📊', '').trim() || '') : 'Chart ' + (i + 1);

        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(30, 41, 59);
        doc.text(cTitle, margin, y);
        y += 4;

        // Chart image
        doc.addImage(imgData, 'PNG', margin, y, imgW, imgH);
        y += imgH + 8;

      } catch (e) {
        console.error('[DV] PDF chart error:', i, e);
      }
    }

    // ─── Insights Section (if any visible) ───
    const visibleInsights = Array.from(document.querySelectorAll('.insight-box.show'));
    if (visibleInsights.length > 0) {
      if (y + 20 > pageH - margin) {
        drawFooter(doc, pageW, pageH, pageNum);
        doc.addPage();
        pageNum++;
        y = margin;
      }

      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30, 41, 59);
      doc.text('Insights', margin, y);
      y += 6;

      visibleInsights.forEach(ins => {
        const text = ins.textContent;
        if (!text) return;

        if (y + 12 > pageH - margin) {
          drawFooter(doc, pageW, pageH, pageNum);
          doc.addPage();
          pageNum++;
          y = margin;
        }

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(71, 85, 105);
        const lines = doc.splitTextToSize(text, contentW);
        doc.text(lines, margin, y);
        y += lines.length * 4 + 6;
      });
    }

    // Final footer
    drawFooter(doc, pageW, pageH, pageNum);

    // Save — use blob URL approach for better compatibility
    const filename = (currentDashboard.title || 'dashboard').replace(/[^a-zA-Z0-9 _-]/g, '') + '_Report.pdf';
    const pdfBlob = doc.output('blob');
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);

    toast('PDF downloaded: ' + filename);

  } catch (err) {
    console.error('[DV] PDF generation error:', err);
    toast('PDF error: ' + err.message, 'error');
  }
}

function drawFooter(doc, pageW, pageH, pageNum) {
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.3);
  doc.line(15, pageH - 18, pageW - 15, pageH - 18);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(148, 163, 184);
  doc.text('Powered by DataVibe — Transform Your Data Into Beautiful Stories', pageW / 2, pageH - 12, { align: 'center' });
  doc.text('Page ' + pageNum, pageW / 2, pageH - 7, { align: 'center' });
}
