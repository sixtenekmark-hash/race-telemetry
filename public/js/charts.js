// Thin wrapper around uPlot: one y-axis per chart, synced crosshair, theme-aware colours.
/* global uPlot */
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const fmtNum = (dp) => (v) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(dp));

export class LineChart {
  /**
   * @param {HTMLElement} el
   * @param {{series: {label:string,color?:string,dash?:number[],dp?:number}[], height?:number, unit?:string, dp?:number,
   *          delta?: boolean, band?: () => number}} cfg
   */
  constructor(el, cfg) {
    this.el = el; this.cfg = cfg; this.u = null; this.data = null;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
  }
  build() {
    const c = this.cfg, el = this.el;
    if (this.u) { this.u.destroy(); this.u = null; }
    const width = el.clientWidth;
    if (!width) return;
    const ink2 = cssVar('--ink-2'), muted = cssVar('--muted'), grid = cssVar('--grid'), axis = cssVar('--axis');
    const font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const dp = c.dp ?? 1;
    const unit = typeof c.unit === 'function' ? c.unit() : c.unit || '';
    const series = [{ value: (u, v) => (v == null ? '–' : new Date(v * 1000).toLocaleTimeString()) }];
    for (const s of c.series) {
      const ser = { label: s.label, width: 2, points: { show: false }, value: (u, v) => (v == null ? '–' : `${v.toFixed(s.dp ?? dp)} ${unit}`) };
      if (s.dash) ser.dash = s.dash;
      if (c.delta) {
        ser.stroke = (u) => diverging(u, cssVar('--over'), cssVar('--under'));
      } else ser.stroke = cssVar(s.color || '--s1');
      series.push(ser);
    }
    const opts = {
      width, height: c.height || 200,
      cursor: { sync: { key: 'telemetry' }, drag: { x: true, y: false }, points: { size: 8 } },
      legend: { show: true, live: true },
      scales: { x: { time: true }, y: c.delta ? { range: (u, mn, mx) => { const m = Math.max(0.3, Math.abs(mn ?? 0), Math.abs(mx ?? 0), (c.band?.() ?? 0) * 1.5) * 1.15; return [-m, m]; } } : { auto: true } },
      axes: [
        { stroke: muted, font, grid: { stroke: grid, width: 1 }, ticks: { stroke: axis, width: 1, size: 4 } },
        { stroke: muted, font, size: 52, grid: { stroke: grid, width: 1 }, ticks: { stroke: axis, width: 1, size: 4 }, values: (u, vals) => vals.map(fmtNum(c.axisDp ?? (dp > 1 ? 1 : dp))) },
      ],
      series,
      hooks: {
        drawClear: [(u) => {
          if (!c.delta) return;
          const ctx = u.ctx, b = c.band?.() ?? 0, { left, width: w } = u.bbox;
          const y0 = u.valToPos(0, 'y', true);
          if (b > 0) {
            const ya = u.valToPos(b, 'y', true), yb = u.valToPos(-b, 'y', true);
            ctx.save(); ctx.fillStyle = cssVar('--good'); ctx.globalAlpha = 0.12; ctx.fillRect(left, ya, w, yb - ya); ctx.restore();
          }
          ctx.save(); ctx.strokeStyle = ink2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, y0); ctx.lineTo(left + w, y0); ctx.stroke(); ctx.restore();
        }],
      },
    };
    this.u = new uPlot(opts, this.data || [[], ...c.series.map(() => [])], el);
  }
  setData(data) {
    this.data = data;
    if (!this.u) this.build();
    else this.u.setData(data, true);
  }
  resize() {
    const w = this.el.clientWidth;
    if (!w) return;
    if (!this.u) { if (this.data) this.build(); return; }
    if (Math.abs(this.u.width - w) > 2) this.u.setSize({ width: w, height: this.cfg.height || 200 });
  }
  rebuild() { if (this.u) this.build(); }
}

// Red above zero (over plan), blue below (under plan).
function diverging(u, over, under) {
  const ctx = u.ctx, top = u.bbox.top, h = u.bbox.height;
  const y0 = u.valToPos(0, 'y', true);
  if (!Number.isFinite(y0) || h <= 0) return over;
  const f = Math.min(1, Math.max(0, (y0 - top) / h));
  const g = ctx.createLinearGradient(0, top, 0, top + h);
  g.addColorStop(0, over); g.addColorStop(f, over); g.addColorStop(f, under); g.addColorStop(1, under);
  return g;
}
