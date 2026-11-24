// Mock backend for the Smart Kubernetes Autoscaler demo.
// No dependencies: run with `node backend/server.js`.
// It serves the frontend pages and returns fake JSON that mimics the real controller API.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const FRONTEND = path.join(__dirname, '..', 'frontend');
const FIGURES = path.join(__dirname, '..', 'docs', 'figures');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// ---- in-memory mock state -------------------------------------------------
const state = {
  policy: { mode: 'smart', minReplicas: 3, maxReplicas: 40, sloMs: 250, horizon: 8, capPerPod: 80 },
  services: [
    { name: 'checkout-api', slo: 250, base: 0.62, min: 3, max: 16 },
    { name: 'search', slo: 200, base: 0.48, min: 2, max: 12 },
    { name: 'payments', slo: 300, base: 0.55, min: 3, max: 10 },
    { name: 'catalog', slo: 220, base: 0.40, min: 2, max: 8 },
    { name: 'notifications', slo: 400, base: 0.30, min: 1, max: 6 },
  ],
  alerts: [
    { id: 1, sev: 'crit', svc: 'checkout-api', msg: 'p99 latency 312ms exceeds SLO 250ms', detail: 'scale-up blocked: max replicas reached (40)', acked: false },
    { id: 2, sev: 'warn', svc: 'search', msg: 'forecast under-predicted load by 22%', detail: 'horizon 10m · model drift check', acked: false },
    { id: 3, sev: 'warn', svc: 'payments', msg: 'pods pending: insufficient node capacity', detail: 'cluster autoscaler requested 2 nodes', acked: false },
    { id: 4, sev: 'info', svc: 'catalog', msg: 'scaled down 6 → 3 replicas', detail: 'load fell below 40% for 15m', acked: false },
    { id: 5, sev: 'crit', svc: 'payments', msg: 'error rate 2.1% over 1m window', detail: 'auto-rollback to HPA triggered', acked: false },
  ],
};

// ---- fake signal generators (deterministic-ish, time based) ---------------
function demandAt(t) {
  return 120 + (Math.sin(t / 12) * 0.5 + 0.5) * 520;
}

function currentTick() {
  return Date.now() / 4000;
}

function latencyFor(load, capacity) {
  const util = capacity > 0 ? load / capacity : 2;
  if (util < 0.6) return Math.round(60 + util * 40);
  return Math.round(60 + Math.pow(Math.max(util - 0.6, 0), 2) * 900 + 40);
}

function podsFor(load, cap, policy) {
  const target = policy.mode === 'hpa' ? 0.8 : 0.75;
  const desired = Math.ceil(load / cap / target);
  return Math.min(policy.maxReplicas, Math.max(policy.minReplicas, desired));
}

function tradeoffPoint(target, minReplicas) {
  const t = target / 100;
  const pods = Math.max(minReplicas, Math.round((12 * 0.7) / t));
  const p99 = Math.round(90 + Math.pow(Math.max(t - 0.55, 0), 2) * 900 + (minReplicas < 3 ? 40 : 0));
  return { target, minReplicas, pods, cost: pods, p99LatencyMs: p99, meetsSlo: p99 <= 250 };
}

// ---- helpers ---------------------------------------------------------------
function sendJson(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

function serveFile(res, baseDir, relPath) {
  const file = path.normalize(path.join(baseDir, relPath));
  if (!file.startsWith(baseDir)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- routes ----------------------------------------------------------------
async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { status: 'ok', mode: 'mock', time: new Date().toISOString() });
  }

  if (pathname === '/api/metrics' && req.method === 'GET') {
    const t = currentTick();
    const load = Math.round(demandAt(t));
    const pods = podsFor(load, state.policy.capPerPod, state.policy);
    const latency = latencyFor(load, pods * state.policy.capPerPod);
    return sendJson(res, 200, {
      timestamp: new Date().toISOString(),
      loadReqPerSec: load,
      pods,
      p99LatencyMs: latency,
      costIndex: Math.round((pods / state.policy.maxReplicas) * 100),
      sloBreached: latency > state.policy.sloMs,
    });
  }

  if (pathname === '/api/services' && req.method === 'GET') {
    const t = currentTick();
    const wave = 0.85 + 0.25 * Math.sin(t / 1.5);
    const list = state.services.map((s) => {
      const demand = s.base * wave;
      const pods = Math.min(s.max, Math.max(s.min, Math.round((demand * (s.min + 1)) / 0.7)));
      const util = Math.min(1.2, demand);
      const latency = Math.round(90 + Math.pow(Math.max(util - 0.6, 0), 2) * 700);
      return { name: s.name, pods, utilization: +util.toFixed(2), p99LatencyMs: latency, sloMs: s.slo, status: latency > s.slo ? 'breach' : 'ok' };
    });
    return sendJson(res, 200, list);
  }

  if (pathname === '/api/timeline' && req.method === 'GET') {
    const points = [];
    for (let i = 0; i < 96; i++) {
      const h = i / 4;
      const demand = 0.5 + 0.4 * Math.sin(((h - 6) / 24) * Math.PI * 2);
      const smart = Math.max(2, Math.round(demand * 12));
      const hpa = Math.max(2, Math.round(demand * 12 - (i % 8 < 3 ? 2 : 0)));
      points.push({ hour: +h.toFixed(2), smartPods: smart, hpaPods: hpa, breach: demand > 0.85 && i % 7 === 0 });
    }
    return sendJson(res, 200, { hours: Number(searchParams.get('hours') || 24), points });
  }

  if (pathname === '/api/tradeoff' && req.method === 'POST') {
    const body = await readBody(req);
    const target = Number(body.target ?? 70);
    const minReplicas = Number(body.minReplicas ?? 3);
    return sendJson(res, 200, tradeoffPoint(target, minReplicas));
  }

  if (pathname === '/api/policy' && req.method === 'GET') {
    return sendJson(res, 200, state.policy);
  }

  if (pathname === '/api/policy' && req.method === 'PUT') {
    const body = await readBody(req);
    state.policy = { ...state.policy, ...body };
    return sendJson(res, 200, state.policy);
  }

  if (pathname === '/api/alerts' && req.method === 'GET') {
    const sev = searchParams.get('sev');
    const list = sev && sev !== 'all' ? state.alerts.filter((a) => a.sev === sev) : state.alerts;
    return sendJson(res, 200, list);
  }

  const ack = pathname.match(/^\/api\/alerts\/(\d+)\/ack$/);
  if (ack && req.method === 'POST') {
    const alert = state.alerts.find((a) => a.id === Number(ack[1]));
    if (!alert) return sendJson(res, 404, { error: 'alert not found' });
    alert.acked = !alert.acked;
    return sendJson(res, 200, alert);
  }

  return sendJson(res, 404, { error: 'no such endpoint', path: pathname });
}

// ---- server ----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch((err) => sendJson(res, 500, { error: String(err) }));
  }
  if (url.pathname.startsWith('/figures/')) {
    return serveFile(res, FIGURES, url.pathname.replace('/figures/', ''));
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  return serveFile(res, FRONTEND, rel);
});

server.listen(PORT, () => {
  console.log(`Mock autoscaler running at http://localhost:${PORT}`);
  console.log('Pages: /  /cluster-view.html  /timeline-view.html  /tradeoff-view.html  /alerts-view.html');
  console.log('Figures: /figures/ch8-graph.html  /figures/ch8-explainer.html');
});
