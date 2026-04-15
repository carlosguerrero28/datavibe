const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { parse: csvParse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || uuidv4();

// ─── Ensure dirs ───
['data', 'uploads'].forEach(d => fs.mkdirSync(path.join(__dirname, d), { recursive: true }));

// ─── Database ───
const db = new Database(path.join(__dirname, 'data', 'datavibe.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    plan TEXT DEFAULT 'free',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  );
  CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    columns TEXT NOT NULL,
    row_count INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS dashboards (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    dataset_id TEXT NOT NULL,
    title TEXT NOT NULL,
    config TEXT,
    is_public INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
  );
`);

// ─── Middleware ───
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Upload Config ───
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Auth Middleware ───
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ═══════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════

app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.status(409).json({ error: 'Username or email already exists' });

  const hash = bcrypt.hashSync(password, 12);
  const result = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(username, email, hash);
  const token = jwt.sign({ id: result.lastInsertRowid, username, email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: result.lastInsertRowid, username, email, plan: 'free' } });
});

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'All fields required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email, plan: user.plan } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, email, plan, created_at FROM users WHERE id = ?').get(req.user.id);
  const datasetCount = db.prepare('SELECT COUNT(*) as count FROM datasets WHERE user_id = ?').get(req.user.id).count;
  const dashboardCount = db.prepare('SELECT COUNT(*) as count FROM dashboards WHERE user_id = ?').get(req.user.id).count;
  res.json({ user, stats: { datasets: datasetCount, dashboards: dashboardCount } });
});

// ═══════════════════════════════════════════════════
//  FILE PARSER
// ═══════════════════════════════════════════════════

function parseFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const buffer = fs.readFileSync(filePath);

  if (ext === '.csv' || ext === '.tsv') {
    const delimiter = ext === '.tsv' ? '\t' : ',';
    const records = csvParse(buffer.toString('utf-8'), {
      columns: true, skip_empty_lines: true, trim: true, delimiter, relax_column_count: true
    });
    const columns = records.length ? Object.keys(records[0]) : [];
    return { data: records, columns };
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);
    const columns = data.length ? Object.keys(data[0]) : [];
    return { data, columns };
  }
  if (ext === '.json') {
    const raw = JSON.parse(buffer.toString('utf-8'));
    const data = Array.isArray(raw) ? raw : [raw];
    const columns = data.length ? Object.keys(data[0]) : [];
    return { data, columns };
  }
  throw new Error('Unsupported format: ' + ext);
}

// ═══════════════════════════════════════════════════
//  DATASET ROUTES
// ═══════════════════════════════════════════════════

app.post('/api/datasets/upload', auth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { data, columns } = parseFile(req.file.path, req.file.originalname);
    const id = uuidv4();
    const name = req.body.name || path.basename(req.file.originalname, path.extname(req.file.originalname));
    const fileType = path.extname(req.file.originalname).toLowerCase().slice(1);

    // Save data as JSON
    fs.writeFileSync(path.join(__dirname, 'data', id + '.json'), JSON.stringify(data));

    db.prepare('INSERT INTO datasets (id, user_id, name, original_name, file_type, columns, row_count, file_size) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.user.id, name, req.file.originalname, fileType, JSON.stringify(columns), data.length, req.file.size);

    // Clean upload
    fs.unlinkSync(req.file.path);

    res.json({ id, name, fileType, columns, rowCount: data.length, preview: data.slice(0, 5) });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to process file: ' + err.message });
  }
});

app.get('/api/datasets', auth, (req, res) => {
  const datasets = db.prepare('SELECT id, name, original_name, file_type, columns, row_count, file_size, created_at FROM datasets WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  datasets.forEach(d => d.columns = JSON.parse(d.columns));
  res.json(datasets);
});

app.get('/api/datasets/:id', auth, (req, res) => {
  const ds = db.prepare('SELECT * FROM datasets WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Dataset not found' });
  const dataFile = path.join(__dirname, 'data', ds.id + '.json');
  if (!fs.existsSync(dataFile)) return res.status(404).json({ error: 'Data file missing' });
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  ds.columns = JSON.parse(ds.columns);
  res.json({ ...ds, data });
});

app.delete('/api/datasets/:id', auth, (req, res) => {
  const ds = db.prepare('SELECT id FROM datasets WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Dataset not found' });
  db.prepare('DELETE FROM dashboards WHERE dataset_id = ?').run(ds.id);
  db.prepare('DELETE FROM datasets WHERE id = ?').run(ds.id);
  const dataFile = path.join(__dirname, 'data', ds.id + '.json');
  if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
//  DASHBOARD ROUTES
// ═══════════════════════════════════════════════════

app.post('/api/dashboards', auth, (req, res) => {
  const { datasetId, title } = req.body;
  const ds = db.prepare('SELECT id FROM datasets WHERE id = ? AND user_id = ?').get(datasetId, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Dataset not found' });
  const id = uuidv4();
  db.prepare('INSERT INTO dashboards (id, user_id, dataset_id, title) VALUES (?,?,?,?)').run(id, req.user.id, datasetId, title || 'Untitled Dashboard');
  res.json({ id, datasetId, title: title || 'Untitled Dashboard' });
});

app.get('/api/dashboards', auth, (req, res) => {
  const dashboards = db.prepare(`
    SELECT d.*, ds.name as dataset_name, ds.row_count, ds.file_type
    FROM dashboards d JOIN datasets ds ON d.dataset_id = ds.id
    WHERE d.user_id = ? ORDER BY d.created_at DESC
  `).all(req.user.id);
  res.json(dashboards);
});

app.get('/api/dashboards/:id', auth, (req, res) => {
  const d = db.prepare(`
    SELECT d.*, ds.name as dataset_name, ds.row_count, ds.file_type, ds.columns
    FROM dashboards d JOIN datasets ds ON d.dataset_id = ds.id
    WHERE d.id = ? AND d.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  db.prepare('UPDATE dashboards SET view_count = view_count + 1 WHERE id = ?').run(d.id);
  d.columns = JSON.parse(d.columns);
  res.json(d);
});

app.delete('/api/dashboards/:id', auth, (req, res) => {
  const d = db.prepare('SELECT id FROM dashboards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!d) return res.status(404).json({ error: 'Dashboard not found' });
  db.prepare('DELETE FROM dashboards WHERE id = ?').run(d.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
//  CHART GENERATION ENGINE
// ═══════════════════════════════════════════════════

function analyzeDataset(data, columns) {
  const numericCols = [];
  const categoricalCols = [];
  const stats = {};

  columns.forEach(col => {
    const values = data.map(r => r[col]).filter(v => v != null && v !== '');
    const numericValues = values.map(Number).filter(v => !isNaN(v) && isFinite(v));
    if (numericValues.length > values.length * 0.5 && numericValues.length > 2) {
      numericCols.push(col);
      numericValues.sort((a, b) => a - b);
      const sum = numericValues.reduce((a, b) => a + b, 0);
      const mean = sum / numericValues.length;
      const median = numericValues[Math.floor(numericValues.length / 2)];
      const std = Math.sqrt(numericValues.reduce((s, v) => s + (v - mean) ** 2, 0) / numericValues.length);
      stats[col] = { type: 'numeric', mean, median, min: numericValues[0], max: numericValues[numericValues.length - 1], std, sum, count: numericValues.length };
    } else {
      categoricalCols.push(col);
      const freq = {};
      values.forEach(v => { const s = String(v); freq[s] = (freq[s] || 0) + 1; });
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
      stats[col] = { type: 'categorical', unique: sorted.length, top: sorted.slice(0, 20), distribution: freq, count: values.length };
    }
  });

  // Generate charts
  const charts = [];
  const palette = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16', '#e11d48', '#0ea5e9', '#a855f7', '#22c55e'];

  // For each categorical → Donut + Bar
  categoricalCols.forEach(col => {
    const s = stats[col];
    if (s.unique <= 25 && s.unique >= 2) {
      charts.push({
        type: 'doughnut', section: 'distribution', title: `${col} Distribution`,
        data: { labels: s.top.map(t => t[0]), values: s.top.map(t => t[1]) },
        insight: generateCategoricalInsight(col, s)
      });
      charts.push({
        type: 'bar', section: 'distribution', title: `${col} Count`,
        data: { labels: s.top.map(t => t[0]), values: s.top.map(t => t[1]) },
        insight: generateCategoricalInsight(col, s)
      });
    }
  });

  // For each numeric → Histogram
  numericCols.forEach(col => {
    const s = stats[col];
    charts.push({
      type: 'bar', section: 'distribution', title: `${col} Distribution (Histogram)`,
      data: makeHistogram(data.map(r => Number(r[col])).filter(v => !isNaN(v)), 10),
      insight: generateNumericInsight(col, s)
    });
  });

  // For cat+num pairs → Grouped bar + Polar
  categoricalCols.forEach(catCol => {
    const catStats = stats[catCol];
    if (catStats.unique > 25) return;
    numericCols.forEach(numCol => {
      const groups = {};
      data.forEach(r => {
        const key = String(r[catCol]);
        if (!groups[key]) groups[key] = [];
        groups[key].push(Number(r[numCol]));
      });
      const labels = Object.keys(groups);
      const means = labels.map(l => groups[l].reduce((a, b) => a + b, 0) / groups[l].length);
      if (labels.length <= 20) {
        charts.push({
          type: 'bar', section: 'analysis', title: `Average ${numCol} by ${catCol}`,
          data: { labels, values: means.map(v => +v.toFixed(2)) },
          insight: generateGroupedInsight(catCol, numCol, labels, means)
        });
        charts.push({
          type: 'polarArea', section: 'analysis', title: `${numCol} by ${catCol} (Polar)`,
          data: { labels, values: means.map(v => +v.toFixed(2)) },
          insight: generateGroupedInsight(catCol, numCol, labels, means)
        });
      }
    });
  });

  // For num+num → Scatter
  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const xCol = numericCols[i], yCol = numericCols[j];
      const points = data.map(r => ({ x: Number(r[xCol]), y: Number(r[yCol]) })).filter(p => !isNaN(p.x) && !isNaN(p.y));
      if (points.length > 2) {
        charts.push({
          type: 'scatter', section: 'cross', title: `${xCol} vs ${yCol}`,
          data: { points },
          insight: generateScatterInsight(xCol, yCol, points)
        });
      }
    }
  }

  // For cat+cat → Stacked
  if (categoricalCols.length >= 2) {
    for (let i = 0; i < Math.min(categoricalCols.length, 3); i++) {
      for (let j = i + 1; j < Math.min(categoricalCols.length, 4); j++) {
        const col1 = categoricalCols[i], col2 = categoricalCols[j];
        if (stats[col1].unique > 10 || stats[col2].unique > 10) continue;
        const crossTab = {};
        data.forEach(r => {
          const k1 = String(r[col1]), k2 = String(r[col2]);
          if (!crossTab[k1]) crossTab[k1] = {};
          crossTab[k1][k2] = (crossTab[k1][k2] || 0) + 1;
        });
        const labels = Object.keys(crossTab);
        const subLabels = [...new Set(Object.values(crossTab).flatMap(o => Object.keys(o)))];
        charts.push({
          type: 'bar', section: 'cross', title: `${col1} × ${col2} (Stacked)`,
          data: {
            labels, datasets: subLabels.map((sl, idx) => ({
              label: sl, data: labels.map(l => crossTab[l][sl] || 0), backgroundColor: palette[idx % palette.length]
            }))
          },
          stacked: true,
          insight: `Cross-tabulation of ${col1} and ${col2}. Shows how categories combine across these two dimensions.`
        });
      }
    }
  }

  // For numeric series → Line with trend
  numericCols.forEach(col => {
    const vals = data.map(r => Number(r[col])).filter(v => !isNaN(v));
    if (vals.length > 5) {
      charts.push({
        type: 'line', section: 'analysis', title: `${col} Trend`,
        data: { labels: vals.map((_, i) => `#${i + 1}`), values: vals },
        insight: generateNumericInsight(col, stats[col])
      });
    }
  });

  // KPIs
  const kpis = [
    { label: 'Total Records', value: data.length, icon: '📊' },
    { label: 'Columns', value: columns.length, icon: '📋' },
    { label: 'Numeric Fields', value: numericCols.length, icon: '🔢' },
    { label: 'Categories', value: categoricalCols.length, icon: '🏷️' }
  ];
  numericCols.slice(0, 2).forEach(col => {
    kpis.push({ label: `Avg ${col}`, value: stats[col].mean.toFixed(2), icon: '📈' });
  });

  return { charts, stats, numericCols, categoricalCols, kpis };
}

function makeHistogram(values, bins) {
  const min = Math.min(...values), max = Math.max(...values);
  const width = (max - min) / bins || 1;
  const counts = Array(bins).fill(0);
  const labels = [];
  values.forEach(v => { const i = Math.min(Math.floor((v - min) / width), bins - 1); counts[i]++; });
  for (let i = 0; i < bins; i++) {
    labels.push(`${(min + i * width).toFixed(1)} - ${(min + (i + 1) * width).toFixed(1)}`);
  }
  return { labels, values: counts };
}

function generateCategoricalInsight(col, s) {
  const top = s.top[0];
  const pct = ((top[1] / s.count) * 100).toFixed(1);
  let msg = `"${top[0]}" is the most common value in ${col} with ${top[1]} occurrences (${pct}% of total). `;
  if (s.top.length > 1) {
    const second = s.top[1];
    const diff = ((top[1] - second[1]) / top[1] * 100).toFixed(1);
    msg += `"${second[0]}" follows with ${second[1]} (${((second[1] / s.count) * 100).toFixed(1)}%). `;
    if (diff > 50) msg += `"${top[0]}" dominates significantly with a ${diff}% lead.`;
  }
  if (s.unique > 10) msg += ` There are ${s.unique} unique values — consider grouping for clearer patterns.`;
  return msg;
}

function generateNumericInsight(col, s) {
  const range = s.max - s.min;
  const cv = (s.std / s.mean * 100).toFixed(1);
  let msg = `${col} ranges from ${s.min} to ${s.max} (range: ${range.toFixed(2)}). Mean: ${s.mean.toFixed(2)}, Median: ${s.median.toFixed(2)}. `;
  if (Math.abs(s.mean - s.median) / s.mean > 0.1) {
    msg += s.mean > s.median ? `Distribution is right-skewed (mean > median), suggesting some high outliers. ` : `Distribution is left-skewed (mean < median), suggesting some low outliers. `;
  }
  msg += `Standard deviation: ${s.std.toFixed(2)} (CV: ${cv}%). `;
  if (cv < 15) msg += `Values are tightly clustered around the mean — low variability.`;
  else if (cv > 50) msg += `High variability — values are widely spread.`;
  return msg;
}

function generateGroupedInsight(catCol, numCol, labels, means) {
  const maxIdx = means.indexOf(Math.max(...means));
  const minIdx = means.indexOf(Math.min(...means));
  const ratio = (means[maxIdx] / means[minIdx]).toFixed(2);
  return `${labels[maxIdx]} has the highest average ${numCol} (${means[maxIdx].toFixed(2)}), while ${labels[minIdx]} has the lowest (${means[minIdx].toFixed(2)}) — a ${ratio}x difference. This suggests ${catCol} is a meaningful differentiator for ${numCol}.`;
}

function generateScatterInsight(xCol, yCol, points) {
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  const num = points.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0);
  const denX = Math.sqrt(points.reduce((s, p) => s + (p.x - meanX) ** 2, 0));
  const denY = Math.sqrt(points.reduce((s, p) => s + (p.y - meanY) ** 2, 0));
  const r = denX && denY ? num / (denX * denY) : 0;
  let strength = Math.abs(r) < 0.3 ? 'weak' : Math.abs(r) < 0.7 ? 'moderate' : 'strong';
  let dir = r > 0 ? 'positive' : 'negative';
  return `Pearson correlation between ${xCol} and ${yCol}: r = ${r.toFixed(3)} (${strength} ${dir} relationship). ${Math.abs(r) > 0.5 ? 'These variables move together significantly.' : 'These variables appear largely independent.'}`;
}

app.post('/api/charts/generate', auth, (req, res) => {
  const { datasetId } = req.body;
  const ds = db.prepare('SELECT * FROM datasets WHERE id = ? AND user_id = ?').get(datasetId, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Dataset not found' });
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', ds.id + '.json'), 'utf-8'));
  const columns = JSON.parse(ds.columns);
  const result = analyzeDataset(data, columns);
  res.json(result);
});

// ═══════════════════════════════════════════════════
//  AI Q&A ENGINE
// ═══════════════════════════════════════════════════

app.post('/api/analyze', auth, (req, res) => {
  const { datasetId, question } = req.body;
  if (!datasetId || !question) return res.status(400).json({ error: 'datasetId and question required' });

  const ds = db.prepare('SELECT * FROM datasets WHERE id = ? AND user_id = ?').get(datasetId, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Dataset not found' });

  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', ds.id + '.json'), 'utf-8'));
  const columns = JSON.parse(ds.columns);
  const q = question.toLowerCase();

  // Find mentioned column
  const mentionedCol = columns.find(c => q.includes(c.toLowerCase()));

  // Pattern matching
  if (q.includes('how many') || q.includes('total') || q.includes('cuántos') || q.includes('registros')) {
    return res.json({ answer: `📊 This dataset has **${data.length} records** and **${columns.length} columns**: ${columns.join(', ')}.` });
  }

  if (q.includes('average') || q.includes('promedio') || q.includes('mean')) {
    if (mentionedCol) {
      const vals = data.map(r => Number(r[mentionedCol])).filter(v => !isNaN(v));
      if (vals.length) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sorted = [...vals].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        return res.json({ answer: `📈 **${mentionedCol}**: Mean = ${mean.toFixed(2)}, Median = ${median.toFixed(2)}, Min = ${sorted[0]}, Max = ${sorted[sorted.length - 1]}, Count = ${vals.length}` });
      }
    }
    // All numeric averages
    const numCols = columns.filter(c => {
      const vals = data.map(r => Number(r[c])).filter(v => !isNaN(v));
      return vals.length > data.length * 0.5;
    });
    const results = numCols.map(c => {
      const vals = data.map(r => Number(r[c])).filter(v => !isNaN(v));
      return `**${c}**: ${((vals.reduce((a, b) => a + b, 0) / vals.length)).toFixed(2)}`;
    });
    return res.json({ answer: `📈 Averages across all numeric fields:\n${results.join('\n')}` });
  }

  if (q.includes('top') || q.includes('most') || q.includes('frequent') || q.includes('común') || q.includes('frecuente')) {
    if (mentionedCol) {
      const freq = {};
      data.forEach(r => { const v = String(r[mentionedCol]); if (v && v !== 'undefined') freq[v] = (freq[v] || 0) + 1; });
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const total = data.length;
      return res.json({ answer: `🏆 **Top 5 values in ${mentionedCol}**:\n${sorted.map((e, i) => `${i + 1}. **${e[0]}**: ${e[1]} (${((e[1] / total) * 100).toFixed(1)}%)`).join('\n')}` });
    }
    // General top values for all categorical
    return res.json({ answer: `Please specify a column name for a detailed frequency analysis. Available columns: ${columns.join(', ')}` });
  }

  if (q.includes('correlation') || q.includes('relacion') || q.includes('relación') || q.includes('relationship')) {
    const numCols = columns.filter(c => {
      const vals = data.map(r => Number(r[c])).filter(v => !isNaN(v));
      return vals.length > data.length * 0.5;
    });
    const pairs = [];
    for (let i = 0; i < numCols.length; i++) {
      for (let j = i + 1; j < numCols.length; j++) {
        const xCol = numCols[i], yCol = numCols[j];
        const pts = data.map(r => ({ x: Number(r[xCol]), y: Number(r[yCol]) })).filter(p => !isNaN(p.x) && !isNaN(p.y));
        const n = pts.length;
        const mx = pts.reduce((s, p) => s + p.x, 0) / n;
        const my = pts.reduce((s, p) => s + p.y, 0) / n;
        const num = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
        const dx = Math.sqrt(pts.reduce((s, p) => s + (p.x - mx) ** 2, 0));
        const dy = Math.sqrt(pts.reduce((s, p) => s + (p.y - my) ** 2, 0));
        const r = dx && dy ? num / (dx * dy) : 0;
        pairs.push({ x: xCol, y: yCol, r });
      }
    }
    pairs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    return res.json({ answer: `🔗 **Correlation Analysis** (Pearson r):\n${pairs.slice(0, 5).map(p => `• **${p.x}** ↔ **${p.y}**: r = ${p.r.toFixed(3)} (${Math.abs(p.r) < 0.3 ? 'weak' : Math.abs(p.r) < 0.7 ? 'moderate' : 'strong'})`).join('\n')}` });
  }

  if (q.includes('summary') || q.includes('resumen') || q.includes('overview')) {
    const numCols = columns.filter(c => {
      const vals = data.map(r => Number(r[c])).filter(v => !isNaN(v));
      return vals.length > data.length * 0.5;
    });
    const catCols = columns.filter(c => !numCols.includes(c));
    let msg = `📋 **Dataset Summary**\n• Records: ${data.length}\n• Columns: ${columns.length} (${numCols.length} numeric, ${catCols.length} categorical)\n\n`;
    numCols.forEach(c => {
      const vals = data.map(r => Number(r[c])).filter(v => !isNaN(v)).sort((a, b) => a - b);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      msg += `📊 **${c}**: Mean=${mean.toFixed(2)}, Min=${vals[0]}, Max=${vals[vals.length - 1]}\n`;
    });
    catCols.forEach(c => {
      const freq = {};
      data.forEach(r => { const v = String(r[c]); freq[v] = (freq[v] || 0) + 1; });
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      msg += `🏷️ **${c}**: ${Object.keys(freq).length} unique values, most common: "${top[0]}" (${top[1]})\n`;
    });
    return res.json({ answer: msg });
  }

  if (q.includes('profile') || q.includes('perfil')) {
    const col = mentionedCol || columns[0];
    const vals = data.map(r => r[col]);
    const isNum = vals.filter(v => !isNaN(Number(v))).length > vals.length * 0.5;
    if (isNum) {
      const nv = vals.map(Number).filter(v => !isNaN(v)).sort((a, b) => a - b);
      const mean = nv.reduce((a, b) => a + b, 0) / nv.length;
      const p25 = nv[Math.floor(nv.length * 0.25)], p75 = nv[Math.floor(nv.length * 0.75)];
      return res.json({ answer: `📊 **Profile of ${col}**\n• Count: ${nv.length}\n• Mean: ${mean.toFixed(2)}\n• Median: ${nv[Math.floor(nv.length / 2)]}\n• Min: ${nv[0]}, Max: ${nv[nv.length - 1]}\n• Q1: ${p25}, Q3: ${p75}\n• IQR: ${(p75 - p25).toFixed(2)}` });
    }
    const freq = {};
    vals.forEach(v => { const s = String(v); freq[s] = (freq[s] || 0) + 1; });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return res.json({ answer: `🏷️ **Profile of ${col}**\n• Unique values: ${sorted.length}\n• Most common: "${sorted[0][0]}" (${sorted[0][1]}, ${((sorted[0][1] / vals.length) * 100).toFixed(1)}%)\n• Least common: "${sorted[sorted.length - 1][0]}" (${sorted[sorted.length - 1][1]})` });
  }

  // Default: general analysis
  const result = analyzeDataset(data, columns);
  let answer = `📊 **General Analysis**\n• ${data.length} records, ${columns.length} columns\n• ${result.numericCols.length} numeric, ${result.categoricalCols.length} categorical fields\n\n`;
  if (result.numericCols.length) {
    answer += `**Numeric columns:** ${result.numericCols.join(', ')}\n`;
  }
  if (result.categoricalCols.length) {
    answer += `**Categorical columns:** ${result.categoricalCols.join(', ')}\n`;
  }
  answer += `\n💡 Try asking: "What is the average [column]?", "Top values in [column]", "Any correlations?", "Give me a summary"`;
  res.json({ answer });
});

// ═══════════════════════════════════════════════════
//  EXPORT ENGINE (7 FORMATS)
// ═══════════════════════════════════════════════════

function getDatasetForExport(datasetId, userId) {
  const ds = db.prepare('SELECT * FROM datasets WHERE id = ? AND user_id = ?').get(datasetId, userId);
  if (!ds) return null;
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', ds.id + '.json'), 'utf-8'));
  const columns = JSON.parse(ds.columns);
  return { ...ds, data, columns };
}

// CSV
app.get('/api/export/csv/:id', auth, (req, res) => {
  const ds = getDatasetForExport(req.params.id, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Not found' });
  const header = ds.columns.join(',');
  const rows = ds.data.map(r => ds.columns.map(c => {
    const v = String(r[c] ?? '');
    return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(','));
  const bom = '\uFEFF';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${ds.name}.csv"`);
  res.send(bom + header + '\n' + rows.join('\n'));
});

// XLSX
app.get('/api/export/xlsx/:id', auth, (req, res) => {
  const ds = getDatasetForExport(req.params.id, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Not found' });
  const wb = XLSX.utils.book_new();

  // Sheet 1: Data
  const wsData = [ds.columns, ...ds.data.map(r => ds.columns.map(c => r[c] ?? ''))];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = ds.columns.map(c => ({ wch: Math.max(String(c).length, 12) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Data');

  // Sheet 2: Statistics
  const analysis = analyzeDataset(ds.data, ds.columns);
  const statsRows = [['Column', 'Type', 'Value 1', 'Value 2', 'Value 3']];
  Object.entries(analysis.stats).forEach(([col, s]) => {
    if (s.type === 'numeric') statsRows.push([col, 'Numeric', `Mean: ${s.mean.toFixed(2)}`, `Min: ${s.min}`, `Max: ${s.max}`]);
    else statsRows.push([col, 'Categorical', `${s.unique} unique`, `Top: ${s.top[0]?.[0] || 'N/A'}`, `Count: ${s.top[0]?.[1] || 0}`]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(statsRows), 'Statistics');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${ds.name}.xlsx"`);
  res.send(buf);
});

// JSON (enriched)
app.get('/api/export/json/:id', auth, (req, res) => {
  const ds = getDatasetForExport(req.params.id, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Not found' });
  const analysis = analyzeDataset(ds.data, ds.columns);
  const enriched = {
    metadata: { name: ds.name, fileType: ds.file_type, rowCount: ds.row_count, exportedAt: new Date().toISOString() },
    statistics: analysis.stats,
    data: ds.data
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${ds.name}.json"`);
  res.send(JSON.stringify(enriched, null, 2));
});

// TSV
app.get('/api/export/tsv/:id', auth, (req, res) => {
  const ds = getDatasetForExport(req.params.id, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Not found' });
  const header = ds.columns.join('\t');
  const rows = ds.data.map(r => ds.columns.map(c => r[c] ?? '').join('\t'));
  res.setHeader('Content-Type', 'text/tab-separated-values');
  res.setHeader('Content-Disposition', `attachment; filename="${ds.name}.tsv"`);
  res.send(header + '\n' + rows.join('\n'));
});

// Markdown
app.get('/api/export/md/:id', auth, (req, res) => {
  const ds = getDatasetForExport(req.params.id, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Not found' });
  const analysis = analyzeDataset(ds.data, ds.columns);
  let md = `# ${ds.name}\n\nExported: ${new Date().toISOString()}\n\n## Statistics\n\n`;
  md += `| Column | Type | Mean/Top | Min/Unique | Max/Freq |\n|--------|------|----------|------------|----------|\n`;
  Object.entries(analysis.stats).forEach(([col, s]) => {
    if (s.type === 'numeric') md += `| ${col} | Numeric | ${s.mean.toFixed(2)} | ${s.min} | ${s.max} |\n`;
    else md += `| ${col} | Categorical | ${s.unique} unique | ${s.top[0]?.[0] || 'N/A'} | ${s.top[0]?.[1] || 0} |\n`;
  });
  md += `\n## Data (first 100 rows)\n\n`;
  md += `| ${ds.columns.join(' | ')} |\n`;
  md += `|${ds.columns.map(() => '---').join('|')}|\n`;
  ds.data.slice(0, 100).forEach(r => {
    md += `| ${ds.columns.map(c => String(r[c] ?? '').replace(/\|/g, '\\|')).join(' | ')} |\n`;
  });
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${ds.name}.md"`);
  res.send(md);
});

// PDF (HTML for print)
app.get('/api/export/pdf/:id', auth, (req, res) => {
  const ds = getDatasetForExport(req.params.id, req.user.id);
  if (!ds) return res.status(404).json({ error: 'Not found' });
  const analysis = analyzeDataset(ds.data, ds.columns);
  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ds.name}</title>
<style>body{font-family:system-ui;padding:40px;max-width:900px;margin:auto;color:#1a1a2e}
h1{color:#6366f1;border-bottom:3px solid #6366f1;padding-bottom:8px}
table{width:100%;border-collapse:collapse;margin:20px 0}
th,td{border:1px solid #ddd;padding:10px;text-align:left}
th{background:#6366f1;color:#fff}
tr:nth-child(even){background:#f8f9fa}
.kpi{display:inline-block;background:#eef2ff;padding:15px 25px;border-radius:8px;margin:5px;text-align:center}
.kpi-val{font-size:28px;font-weight:700;color:#6366f1}
.kpi-lbl{font-size:12px;color:#666}</style></head><body>
<h1>📊 ${ds.name}</h1>
<p>Generated: ${new Date().toISOString()} | Records: ${ds.row_count} | Columns: ${ds.columns.length}</p>
<div>${analysis.kpis.map(k => `<div class="kpi"><div class="kpi-val">${k.icon} ${k.value}</div><div class="kpi-lbl">${k.label}</div></div>`).join('')}</div>
<h2>Statistical Summary</h2>
<table><tr><th>Column</th><th>Type</th><th>Mean/Top</th><th>Min/Unique</th><th>Max/Freq</th></tr>`;
  Object.entries(analysis.stats).forEach(([col, s]) => {
    if (s.type === 'numeric') html += `<tr><td>${col}</td><td>Numeric</td><td>${s.mean.toFixed(2)}</td><td>${s.min}</td><td>${s.max}</td></tr>`;
    else html += `<tr><td>${col}</td><td>Categorical</td><td>${s.unique} unique</td><td>${s.top[0]?.[0] || 'N/A'}</td><td>${s.top[0]?.[1] || 0}</td></tr>`;
  });
  html += `</table><h2>Data Preview</h2><table><tr>${ds.columns.map(c => `<th>${c}</th>`).join('')}</tr>`;
  ds.data.slice(0, 50).forEach(r => {
    html += `<tr>${ds.columns.map(c => `<td>${String(r[c] ?? '').replace(/</g, '&lt;')}</td>`).join('')}</tr>`;
  });
  html += `</table><footer style="margin-top:40px;text-align:center;color:#999;font-size:12px">Powered by DataVibe — Transform Your Data Into Beautiful Stories</footer></body></html>`;
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="${ds.name}.html"`);
  res.send(html);
});

// ═══════════════════════════════════════════════════
//  SPA FALLBACK
// ═══════════════════════════════════════════════════

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ⚡ DataVibe running on http://0.0.0.0:${PORT}\n`);
});
