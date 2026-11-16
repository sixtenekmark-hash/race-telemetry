// eChook race telemetry server (no npm dependencies, Node 20.12+).
// - Serves the dashboard in ./public
// - Keeps the Car ID on the server (env CAR_ID) and proxies eChook's history API, which browsers
//   on other domains cannot call directly (CORS).
// - Optional team password (env SITE_PASSWORD). Without one the server only listens on localhost.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const CAR_ID = (process.env.CAR_ID || '').trim();
const PASSWORD = process.env.SITE_PASSWORD || '';
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || (PASSWORD ? '0.0.0.0' : '127.0.0.1');
const API = 'https://data.echook.uk/api';
const TOKEN = PASSWORD ? createHmac('sha256', PASSWORD).update('echook-telemetry/v1').digest('hex') : null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const send = (res, code, body, type = 'application/json', extra = {}) => {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
};

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authed(req) {
  if (!TOKEN) return true;
  const c = cookies(req).et_auth || '';
  return c.length === TOKEN.length && timingSafeEqual(Buffer.from(c), Buffer.from(TOKEN));
}

const loginPage = (error = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Race Telemetry</title>
<style>:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--fg:#14171c;--mut:#5b6472;--acc:#0b6bcb;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#0d1014;--card:#161b22;--fg:#e8ebef;--mut:#9aa4b2;--acc:#4ea1ff;--bad:#ff6b6b}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px system-ui,sans-serif}
form{background:var(--card);padding:28px;border-radius:14px;width:min(340px,calc(100vw - 32px));box-shadow:0 8px 30px #0002}
h1{font-size:20px;margin:0 0 4px}p{color:var(--mut);margin:0 0 18px;font-size:14px}
input,button{width:100%;box-sizing:border-box;font:inherit;padding:11px 12px;border-radius:9px;border:1px solid #8884;background:transparent;color:inherit}
button{margin-top:12px;background:var(--acc);color:#fff;border:0;font-weight:600;cursor:pointer}.err{color:var(--bad);font-size:14px;margin-top:10px}</style></head>
<body><form method="post" action="/login"><h1>Race Telemetry</h1><p>Team password</p>
<input type="password" name="password" autofocus autocomplete="current-password" aria-label="Team password">
<button type="submit">Open dashboard</button>${error ? `<div class="err">${error}</div>` : ''}</form></body></html>`;

async function readBody(req, limit = 4096) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > limit) break; }
  return body;
}

// ---- eChook API proxy ----
const cache = new Map(); // finished time ranges never change
async function echook(pathname, params) {
  const url = `${API}${pathname}${params ? '?' + new URLSearchParams(params) : ''}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'race-telemetry-dashboard' }, signal: AbortSignal.timeout(30000) });
  if (r.status === 204) return null;
  if (!r.ok) throw Object.assign(new Error(`eChook API answered ${r.status}`), { status: r.status });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
async function history(start, end) {
  const key = `${start}-${end}`;
  if (cache.has(key)) return cache.get(key);
  const rows = [];
  for (let page = 1; page <= 40; page++) {
    const batch = await echook(`/history/${CAR_ID}`, { start, end, page, limit: 5000 });
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < 5000) break;
  }
  for (const r of rows) delete r.carId; // the browser does not need the Car ID in every row
  if (end < Date.now() - 3600e3) { cache.set(key, rows); if (cache.size > 30) cache.delete(cache.keys().next().value); }
  return rows;
}

async function api(req, res, url) {
  if (!CAR_ID) return send(res, 503, { error: 'CAR_ID is not set on the server.' });
  try {
    switch (url.pathname) {
      case '/api/config':
        return send(res, 200, { server: true, carId: CAR_ID, password: !!PASSWORD });
      case '/api/days':
        return send(res, 200, (await echook(`/history/days/${CAR_ID}`)) || []);
      case '/api/latest': {
        const p = await echook(`/get/${CAR_ID}`);
        if (p) delete p.carId;
        return p ? send(res, 200, p) : send(res, 204, '');
      }
      case '/api/history': {
        const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 3 * 86400e3)
          return send(res, 400, { error: 'start and end (ms) are required, at most 3 days apart' });
        return send(res, 200, await history(start, end));
      }
      default:
        return send(res, 404, { error: 'Unknown API route' });
    }
  } catch (e) {
    return send(res, e.status === 429 ? 429 : 502, { error: e.message || 'eChook API request failed' });
  }
}

async function staticFile(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const data = await readFile(file);
    const ext = path.extname(file);
    const cacheCtl = ext === '.html' ? 'no-cache' : rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheCtl, 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (url.pathname === '/login') {
    if (!TOKEN) return send(res, 302, '', 'text/plain', { Location: '/' });
    if (req.method === 'POST') {
      const pw = new URLSearchParams(await readBody(req)).get('password') || '';
      const ok = pw.length === PASSWORD.length && timingSafeEqual(Buffer.from(pw), Buffer.from(PASSWORD));
      if (!ok) { await new Promise((r) => setTimeout(r, 800)); return send(res, 401, loginPage('Wrong password.'), MIME['.html']); }
      const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      return send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': `et_auth=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` });
    }
    return send(res, 200, loginPage(), MIME['.html']);
  }
  if (!authed(req)) {
    return url.pathname.startsWith('/api/') ? send(res, 401, { error: 'Log in first' }) : send(res, 302, '', 'text/plain', { Location: '/login' });
  }
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
  return staticFile(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Race telemetry on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!CAR_ID) console.log('Warning: CAR_ID is not set, so live data and history are unavailable.');
  if (!PASSWORD) console.log('No SITE_PASSWORD set: listening on this computer only. Set one before putting it online.');
});
