// Track map on a canvas: whole trace muted, current lap highlighted, start/finish line, car marker.
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export function drawMap(canvas, S, { from = 0, to = S.length - 1, lapFrom = null, gate = null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return '';
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pts = [];
  let last = null;
  for (let k = Math.max(0, from); k <= to && k < S.length; k++) {
    const s = S[k];
    if (s.lat == null || s.lon == null) continue;
    if (last && last.lat === s.lat && last.lon === s.lon) continue;
    pts.push(s); last = s;
  }
  if (pts.length < 2) {
    ctx.fillStyle = cssVar('--muted'); ctx.font = '14px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No GPS track yet', w / 2, h / 2);
    return '';
  }
  // Equal-aspect projection
  const lat0 = pts[0].lat, kx = Math.cos((lat0 * Math.PI) / 180);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    const x = p.lon * kx, y = p.lat;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const pad = 18, sx = (w - 2 * pad) / Math.max(1e-9, maxX - minX), sy = (h - 2 * pad) / Math.max(1e-9, maxY - minY);
  const sc = Math.min(sx, sy);
  const ox = (w - (maxX - minX) * sc) / 2, oy = (h - (maxY - minY) * sc) / 2;
  const P = (p) => [ox + (p.lon * kx - minX) * sc, h - (oy + (p.lat - minY) * sc)];

  const stroke = (arr, color, width) => {
    if (arr.length < 2) return;
    ctx.beginPath();
    arr.forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
  };
  stroke(pts, cssVar('--axis'), 3);
  if (lapFrom != null) stroke(pts.filter((p) => p.t >= lapFrom), cssVar('--s1'), 3.5);

  if (gate) {
    const half = 25 / 110540; // ~25 m in degrees latitude
    const nx = -gate.hy, ny = gate.hx; // perpendicular, in local metres
    const a = { lat: gate.lat + ny * half, lon: gate.lon + (nx * half) / kx };
    const b = { lat: gate.lat - ny * half, lon: gate.lon - (nx * half) / kx };
    const [ax, ay] = P(a), [bx, by] = P(b);
    ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = cssVar('--ink'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.restore();
  }
  const car = pts[pts.length - 1];
  const [cx, cy] = P(car);
  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = cssVar('--s2'); ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = cssVar('--surface'); ctx.stroke();
  const span = Math.max((maxX - minX) * 111320, (maxY - minY) * 110540);
  return `${Math.round(span)} m across`;
}
