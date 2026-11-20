import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Store } from './store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export function createServer(dbPath) {
  const store = new Store(openDb(dbPath));

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
    );
    routes.push({ method, regex, keys, handler });
  };

  // ---- API 路由 ----
  route('GET', '/api/summary', () => {
    const batches = store.listBatches();
    return {
      batches: batches.length,
      periods: [...new Set(batches.map((b) => b.period))],
      total_commission_cents: batches.reduce((a, b) => a + b.total_commission_cents, 0),
      total_payout_cents: batches.reduce((a, b) => a + b.total_payout_cents, 0),
      open_disputes: store.listDisputes().filter((d) => d.status === 'open').length,
      paid_batches: batches.filter((b) => b.status === 'paid').length,
    };
  });
  route('GET', '/api/rates', () => store.listRateVersions());
  route('POST', '/api/rates', (body) => store.createRateVersion(body));
  route('GET', '/api/batches', () => store.listBatches());
  route('GET', '/api/batches/:id', (_body, p) => {
    const batch = store.getBatch(Number(p.id));
    if (!batch) throw Object.assign(new Error('批次不存在'), { status: 404 });
    return { batch, lines: store.listLines(batch.id), approvals: store.listApprovals(batch.id) };
  });
  route('POST', '/api/settlements/run', (body) => {
    if (!body.period || !body.rate_version_id)
      throw Object.assign(new Error('需要 period 与 rate_version_id'), { status: 400 });
    return store.runSettlement(body.period, Number(body.rate_version_id));
  });
  route('POST', '/api/rates/revise', (body) => {
    if (!body.period || !body.new_rate_version_id)
      throw Object.assign(new Error('需要 period 与 new_rate_version_id'), { status: 400 });
    return store.reviseRate(body.period, Number(body.new_rate_version_id));
  });
  route('POST', '/api/batches/:id/submit', (_b, p) => store.submit(Number(p.id), 'ops'));
  route('POST', '/api/batches/:id/approve', (body, p) => store.approve(Number(p.id), 'finance', body?.note));
  route('POST', '/api/batches/:id/reject', (body, p) => store.reject(Number(p.id), 'finance', body?.note));
  route('POST', '/api/batches/:id/pay', (body, p) =>
    store.pay(Number(p.id), 'treasury', body?.idempotency_key));
  route('GET', '/api/disputes', () => store.listDisputes());
  route('POST', '/api/disputes', (body) => {
    if (!body.settlement_line_id || !body.reason)
      throw Object.assign(new Error('需要 settlement_line_id 与 reason'), { status: 400 });
    return store.createDispute(body);
  });
  route('POST', '/api/disputes/:id/resolve', (body, p) =>
    store.resolveDispute(Number(p.id), body));
  route('GET', '/api/orders', () => store.listOrders());
  route('GET', '/api/orders/:id/trace', (_b, p) => {
    const trace = store.traceOrder(p.id);
    if (!trace) throw Object.assign(new Error('订单不存在'), { status: 404 });
    return trace;
  });
  route('POST', '/api/refunds', (body) => store.addRefund(body));
  route('GET', '/api/payments', () => store.listPayments());

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const body = await readBody(req);
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.regex);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const result = await r.handler(body, params, req);
          return sendJson(res, 200, result ?? {});
        }
        return sendJson(res, 404, { error: `接口不存在: ${req.method} ${url.pathname}` });
      }
      // 静态文件
      let path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = normalize(join(PUBLIC_DIR, path));
      if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      if (e.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
      sendJson(res, e.status || 500, { error: e.message });
    }
  });

  return { server, store };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 直接运行（非测试导入）时启动监听
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server } = createServer(process.env.DB_PATH || 'settlement.db');
  server.listen(PORT, () => console.log(`佣金结算平台已启动: http://localhost:${PORT}`));
}
