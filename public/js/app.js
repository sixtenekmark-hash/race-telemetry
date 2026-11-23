// Race telemetry dashboard: live eChook data, energy pacing against the team's plan, laps, graphs, replay.
import * as M from './model.js';
import { LineChart } from './charts.js';
import { drawMap } from './map.js';
import { LiveMap } from './livemap.js';
import { createSync } from './sync.js';
/* global io */

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Per race class. F24: the team's C(t, n) = 0.12 + 0.137t + 0.249n and C(t) = 0.14 + 0.2388t, reference race
// 1 Dec 2025 (33 laps, 149.070 s), aim 1.5 h. F24+: fitted to the 1 Dec 2025 F24+ log (26 laps, 144.155 s), aim 1 h.
const CLASS_DEFAULTS = {
  F24: { targetAh: 20, refLaps: 33, refLapMs: 149070, raceLenMin: 90, tnA: 0.12, tnB: 0.137, tnC: 0.249, tA: 0.14, tB: 0.2388 },
  'F24+': { targetAh: 20, refLaps: 26, refLapMs: 144155, raceLenMin: 60, tnA: 1.684, tnB: 0.2385, tnC: 0.0956, tA: 1.3963, tB: 0.2811 },
};
const PER_CLASS = Object.keys(CLASS_DEFAULTS.F24);
const DEFAULTS = {
  cls: 'F24', idealModel: 'tn', nMode: 'done', bandAh: 0.2,
  units: 'mph', theme: 'auto', lapSource: 'auto', gate: null,
  vWarn: 18, vCrit: 14, tWarn: 55, tCrit: 65, iWarn: 40, iCrit: 120, imbWarn: 0.5,
  rpmKmh: 89, rpmAt: 2400, rpmLo: 2200, rpmHi: 2500,
};
let settings = (() => {
  const st = { ...DEFAULTS, ...store.get('et.settings', {}) };
  const saved = st.classes || {};
  st.classes = {};
  for (const c of Object.keys(CLASS_DEFAULTS)) st.classes[c] = { ...CLASS_DEFAULTS[c], ...(saved[c] || {}) };
  for (const k of PER_CLASS) delete st[k]; // older versions kept these at the top level
  delete st.liveStart; // the race start is now shared between devices
  if (!CLASS_DEFAULTS[st.cls]) st.cls = 'F24';
  return st;
})();
const planSettings = () => ({ ...settings, ...settings.classes[settings.cls] });
const saveSettings = () => store.set('et.settings', settings);

// ---------- formatting ----------
const SPEED = { mph: [2.23694, 'mph'], kmh: [3.6, 'km/h'], ms: [1, 'm/s'] };
const spd = (v) => (v == null ? null : v * SPEED[settings.units][0]);
const spdUnit = () => SPEED[settings.units][1];
const fx = (v, dp = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(dp));
const signed = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(dp));
const dcls = (v) => (v == null ? '' : v > 0 ? 'delta-over' : v < 0 ? 'delta-under' : '');
const clock = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const neg = ms < 0; ms = Math.abs(ms);
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4), s = Math.floor((ms % 6e4) / 1e3);
  return (neg ? '−' : '') + (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
};
const lapTime = (ms) => (ms == null ? '–' : `${Math.floor(ms / 6e4)}:${((ms % 6e4) / 1e3).toFixed(1).padStart(4, '0')}`);
const tod = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const U = (u) => (u ? `<span class="u">${u}</span>` : '');
const idxAtOrBefore = (S, t) => { let lo = 0, hi = S.length - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
const rpmOf = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return null;
  const kmh = ms * 3.6, f = (r) => (kmh * r) / settings.rpmKmh;
  return { rpm: f(settings.rpmAt), lo: f(settings.rpmLo), hi: f(settings.rpmHi) };
};
const medianGap = (S, a, b) => { const g = []; for (let k = Math.max(a + 1, b - 200); k <= b; k++) g.push(S[k].t - S[k - 1].t); g.sort((x, y) => x - y); return g.length ? g[g.length >> 1] : 0; };

// ---------- state ----------
const live = { S: [], raw: [], status: 'idle', socket: null, server: null, carId: null, lastWall: 0, offset: 0, pollTimer: null, error: '', everConnected: false };
const view = { mode: 'live', S: [], label: '', raceStart: null, manualLaps: [], gate: null, cursorT: null, playing: false, speed: 20, lastTick: 0 };
const sync = createSync(() => onSync());
let flashMsg = '', flashUntil = 0;
let res = null, tab = 'race';

const curS = () => (view.mode === 'live' ? live.S : view.S);
function nowIndex(S) {
  if (!S.length) return -1;
  if (view.mode === 'replay') return idxAtOrBefore(S, view.cursorT);
  if (view.mode === 'review' && res?.i1 != null) return res.i1;
  return S.length - 1;
}
function analysisOpts() {
  const plan = M.makePlan(planSettings());
  const base = { plan, lapSource: settings.lapSource, bandAh: settings.bandAh };
  if (view.mode === 'live') {
    return { ...base, raceStart: sync.state.start, manualLaps: sync.state.laps.map((l) => l.t), wallNow: Date.now(), pick: 'latest', gate: settings.gate };
  }
  return { ...base, raceStart: view.raceStart, manualLaps: view.manualLaps.map((l) => l.t), gate: view.gate, pick: view.mode === 'review' ? 'longest' : 'latest', nowT: view.mode === 'replay' ? view.cursorT : undefined };
}

// ---------- rendering ----------
let scheduled = false, lastRender = 0;
function invalidate() {
  if (scheduled) return;
  scheduled = true;
  // Plain timers, not requestAnimationFrame: rAF can stall in embedded or occluded views.
  const minGap = view.mode === 'replay' ? 200 : 16;
  setTimeout(() => {
    scheduled = false; lastRender = performance.now();
    try { render(); } catch (e) { console.error('render failed', e); }
  }, Math.max(0, minGap - (performance.now() - lastRender)));
}

function render() {
  const S = curS();
  res = S.length ? M.analyze(S, analysisOpts()) : null;
  const plan = M.makePlan(planSettings()), k = nowIndex(S);
  renderHeader();
  renderRaceBar();
  if (tab === 'race') {
    renderNotice(S);
    renderPace(plan);
    renderLastLap(S, plan);
    renderTiles(S, k);
    renderRaceCharts(S, plan, k);
    renderMap(S, k);
    renderLaps($('lapsShort'), S, plan, k, 5);
  } else if (tab === 'laps') renderLaps($('lapsFull'), S, plan, k, Infinity);
  else if (tab === 'graphs') renderGraphs(S, plan, k);
  else if (tab === 'settings') renderSettingsInfo(S);
  else if (tab === 'data') renderLoaded();
}

function renderHeader() {
  const badge = $('modeBadge'), dot = $('connDot'), txt = $('connText');
  badge.textContent = view.mode.toUpperCase();
  badge.className = 'badge' + (view.mode === 'live' ? '' : ' ' + view.mode);
  const S = curS(), k = nowIndex(S);
  if (view.mode === 'live') {
    const age = live.lastWall ? (Date.now() - live.lastWall) / 1000 : null;
    let cls = 'bad', msg;
    if (live.status === 'nocar') msg = 'No Car ID: add it in Settings';
    else if (live.status === 'connected') {
      if (age == null) { cls = 'warn'; msg = 'Connected · no data from the car yet'; }
      else { cls = age < 10 ? 'ok' : age < 30 ? 'warn' : 'bad'; msg = `Connected · last data ${age < 90 ? Math.round(age) + ' s' : clock(age * 1000)} ago`; }
    } else if (live.status === 'connecting') { cls = 'warn'; msg = 'Connecting to eChook…'; }
    else if (live.status === 'reconnecting') { cls = 'warn'; msg = 'Reconnecting…'; }
    else msg = `Not connected${live.error ? ': ' + live.error : ''}`;
    dot.className = 'dot ' + cls; txt.textContent = msg;
  } else {
    dot.className = 'dot';
    txt.textContent = view.mode === 'replay' ? `${view.label} · ${view.speed}×${view.playing ? '' : ' · paused'}` : `${view.label} · whole session`;
  }
  // Live: real time since the shared race start, so every device shows the same clock.
  let el = null;
  const t0 = view.mode === 'live' ? (sync.state.start ?? res?.t0) : res?.t0;
  if (t0 != null) el = view.mode === 'live' ? Date.now() - t0 : (k >= 0 ? S[k].t - t0 : null);
  $('raceClock').textContent = el == null ? '--:--' : clock(el);
}

function renderNotice(S) {
  const n = $('notice');
  let msg = '';
  if (view.mode === 'live') {
    if (live.status === 'nocar') msg = 'Add your eChook Car ID in <b>Settings</b> to see live data.';
    else if (!S.length) msg = 'No data from the car yet today. This page updates by itself as soon as the eChook app starts sending. To try it now, open <b>Data &amp; replay</b> and replay a past race.';
    else if (res && res.t0 == null) msg = 'The car has not driven off yet. Press <b>Start race</b> at the start so every device uses the same clock.';
    else if (sync.state.start == null && res?.t0 != null) msg = 'The race start was detected from the car driving off. Press <b>Start race</b> to pin it for every device.';
  }
  n.hidden = !msg; n.innerHTML = msg;
}

function renderPace(plan) {
  const c = res?.cap;
  const set = (id, v) => { $(id).innerHTML = v; };
  if (!c) {
    set('paceDelta', '–'); $('paceCall').className = 'pace-call'; $('paceCall').textContent = 'Waiting for the race to start';
    $('paceSub').textContent = `Ideal: ${modelFormula(plan)}`;
    $('pgMark').style.left = '50%'; $('capUsed').style.width = '0%'; $('capIdeal').style.left = '0%';
    $('capText').textContent = `0 of ${fx(plan.targetAh, 1)} Ah used`; $('capIdealText').textContent = '';
    for (const id of ['stTargetA', 'stRecentA', 'stProj', 'stLaps', 'stByLaps']) set(id, '–');
    set('stPerLap', `${fx(plan.avgLapAh, 3)}${U('Ah')}`);
    return;
  }
  set('paceDelta', `${signed(c.delta)}${U('Ah')}`);
  const call = { slow: '▼ SLOW DOWN', hold: '✓ ON PACE', push: '▲ SPEED UP' }[c.call];
  $('paceCall').className = 'pace-call ' + c.call; $('paceCall').textContent = call;
  $('paceSub').textContent = `${fx(c.used, 2)} Ah used, ideal ${fx(c.ideal, 2)} Ah at ${clock(c.elapsed)}${c.nUsed != null ? `, n = ${c.nUsed}` : ''}`;
  const R = Math.max(1, settings.bandAh * 4);
  $('pgMark').style.left = `${50 + Math.max(-1, Math.min(1, c.delta / R)) * 50}%`;
  const bw = (settings.bandAh / R) * 50;
  Object.assign($('pgBand').style, { left: `${50 - bw}%`, width: `${2 * bw}%` });
  $('capUsed').style.width = `${Math.min(100, (c.used / plan.targetAh) * 100)}%`;
  $('capIdeal').style.left = `${Math.min(100, (c.ideal / plan.targetAh) * 100)}%`;
  $('capText').textContent = `${fx(c.used, 2)} of ${fx(plan.targetAh, 1)} Ah used (${Math.round(c.pctUsed * 100)}%)`;
  $('capIdealText').textContent = c.remainingMs > 0 ? `Black mark = ideal now · ${clock(c.remainingMs)} of the race plan left` : 'Planned race length reached';
  set('stTargetA', c.targetRestA != null ? `${fx(c.targetRestA, 1)}${U('A')}` : '–');
  set('stRecentA', c.recentA != null ? `${fx(c.recentA, 1)}${U('A')}` : '–');
  set('stProj', c.projected != null ? `${fx(c.projected, 1)}${U('Ah')}` : '–');
  set('stPerLap', `${fx(plan.avgLapAh, 3)}${U('Ah')}`);
  set('stLaps', String(c.lapsDone));
  set('stByLaps', c.deltaByLaps != null ? `<span class="${dcls(c.deltaByLaps)}">${signed(c.deltaByLaps)}</span>${U('Ah')}` : '–');
}

function lapSourceText(S) {
  if (!res?.lapSource) return '';
  if (res.lapSource === 'manual') return 'marked by hand';
  const gap = res.i0 != null ? medianGap(S, res.i0, res.i1) : 0;
  const src = res.lapSource === 'counter' ? 'eChook lap counter' : 'GPS start/finish line';
  return gap > 1500 ? `${src} · ±${Math.round(gap / 1000)} s (data every ${Math.round(gap / 1000)} s)` : src;
}

function renderLastLap(S, plan) {
  const L = res?.laps?.at(-1);
  $('llSrc').textContent = lapSourceText(S);
  if (!L) {
    $('llTitle').textContent = 'Last lap'; $('llTime').textContent = '–';
    $('llStats').innerHTML = '<div><dt>No completed lap yet</dt><dd>–</dd></div>';
    return;
  }
  $('llTitle').textContent = `Last lap · lap ${L.n}`;
  $('llTime').innerHTML = `${lapTime(L.dur)} <span class="small ${dcls(L.dur - plan.refLapMs)}">${signed((L.dur - plan.refLapMs) / 1000, 1)} s</span>`;
  const items = [
    ['Ah used', `${fx(L.ah, 3)}${U('Ah')} <span class="small ${dcls(L.ahDelta)}">${signed(L.ahDelta, 3)}</span>`],
    ['Average current', `${fx(L.avgI, 1)}${U('A')}`],
    ['Average voltage', `${fx(L.avgV, 2)}${U('V')}`],
    ['Lowest voltage', `${fx(L.minV, 2)}${U('V')}`],
    ['Average speed', `${fx(spd(L.avgSpd), 1)}${U(spdUnit())}`],
    ['Average GPS speed', `${fx(spd(L.avgGspd), 1)}${U(spdUnit())}`],
    ['Average motor RPM', fx(rpmOf(L.avgSpd ?? L.avgGspd)?.rpm, 0)],
    ['Energy', `${fx(L.wh, 1)}${U('Wh')}`],
  ];
  if (L.device) items.push(['eChook lap time', `${fx(L.device.time, 1)}${U('s')}`]);
  $('llStats').innerHTML = items.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('');
}

function renderTiles(S, k) {
  const el = $('tiles');
  if (k < 0) { el.innerHTML = ''; return; }
  const s = S[k], st = settings;
  const usedRace = res?.used?.[k];
  const whRace = res?.i0 != null ? s._whInt - S[res.i0]._whInt : null;
  const a = res?.i0 ?? 0;
  let t2Zero = false, brakeNever = false;
  for (let j = a; j <= k; j++) {
    const q = S[j];
    if (q.t2 != null) { if (q.t2) { t2Zero = false; break; } t2Zero = true; }
  }
  for (let j = a; j <= k; j++) {
    const q = S[j];
    if (q.brake != null) { if (q.brake) { brakeNever = false; break; } brakeNever = true; }
  }
  const imb = s.vUp != null && s.vLo != null ? s.vUp - s.vLo : null;
  const sensorOff = s.gspd != null && s.gspd > 3 && s.spd != null && s.spd < 0.5;
  const T = [
    ['Speed (eChook)', fx(spd(s.spd), 1), spdUnit(), sensorOff ? ['warn', '⚠ Check'] : null, sensorOff ? 'GPS says the car is moving' : ''],
    ['GPS speed', fx(spd(s.gspd), 1), spdUnit()],
    ['Current', fx(s.i, 1), 'A', s.i == null ? null : s.i >= st.iCrit ? ['crit', '⛔ High'] : s.i >= st.iWarn ? ['warn', '⚠ High'] : null],
    ['Power', fx(s.pw, 0), 'W'],
    ['Pack voltage', fx(s.v, 2), 'V', s.v == null ? null : s.v < st.vCrit ? ['crit', '⛔ Low'] : s.v < st.vWarn ? ['warn', '⚠ Low'] : null],
    ['Lower battery', fx(s.vLo, 2), 'V'],
    ['Upper battery', fx(s.vUp, 2), 'V', null, 'pack − lower'],
    ['Battery imbalance', signed(imb, 2), 'V', imb != null && Math.abs(imb) >= st.imbWarn ? ['warn', '⚠ Check'] : null, 'upper − lower'],
    (() => { const r = rpmOf(s.spd ?? s.gspd); return ['Motor RPM', r ? fx(r.rpm, 0) : '–', 'rpm', null, r ? `range ${fx(r.lo, 0)}–${fx(r.hi, 0)} · from ${s.spd != null ? 'eChook' : 'GPS'} speed` : '']; })(),
    ['Throttle', fx(s.thr, 0), '%'],
    ['Gear ratio', fx(s.gear, 2), '', null, 'motor ÷ wheel speed'],
    ['Temperature 1', fx(s.t1, 1), '°C', s.t1 == null ? null : s.t1 >= st.tCrit ? ['crit', '⛔ Hot'] : s.t1 >= st.tWarn ? ['warn', '⚠ Hot'] : null],
    ['Temperature 2', fx(s.t2, 1), '°C', s.t2 == null ? null : s.t2 >= st.tCrit ? ['crit', '⛔ Hot'] : s.t2 >= st.tWarn ? ['warn', '⚠ Hot'] : null, t2Zero ? 'always 0: sensor not connected?' : ''],
    ['Brake', s.brake == null ? '–' : s.brake ? 'ON' : 'off', '', null, brakeNever ? 'never on: switch not wired?' : ''],
    ['Ah used (race)', fx(usedRace, 2), 'Ah', null, usedRace != null ? 'since the race start' : 'starts with the race'],
    (() => { const e = res?.echook?.[k] ?? s.ah; return ['eChook Ah counter', fx(e, 2), 'Ah', null, e != null && s.ah != null && Math.abs(e - s.ah) > 0.005 ? `includes ${fx(e - s.ah, 2)} Ah from before an app restart` : 'as eChook shows it']; })(),
    ['Energy used (race)', fx(whRace, 0), 'Wh'],
    ['eChook lap counter', s.lap == null ? '–' : String(s.lap), '', null, s.track ? esc(s.track) : ''],
    ['GPS position', s.lat == null ? '–' : `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`, '', null, tod(s.t)],
  ];
  el.innerHTML = T.map(([lbl, val, unit, status, sub]) => {
    const cls = ['tile', val === '–' ? 'na' : '', status ? status[0] : ''].join(' ');
    return `<div class="${cls}"><div class="lblrow"><span class="lbl">${lbl}</span>${status ? `<span class="chip">${status[1]}</span>` : ''}</div>` +
      `<div class="val">${val}${val === '–' ? '' : U(unit)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }).join('');
}

// ---------- charts ----------
const charts = {};
const chart = (id, cfg) => (charts[id] ||= new LineChart($(id), cfg));
const bandFn = () => settings.bandAh;
function chartWindow(S, k) {
  if (k < 0) return null;
  const a = res?.t0 != null ? idxAtOrBefore(S, res.t0 - 60e3) : idxAtOrBefore(S, S[k].t - 30 * 60e3);
  return [a, k];
}
function columns(S, a, b, fns) {
  const n = b - a + 1, x = new Array(n), ys = fns.map(() => new Array(n));
  for (let j = 0; j < n; j++) {
    const s = S[a + j]; x[j] = s.t / 1000;
    fns.forEach((f, q) => { ys[q][j] = f(s, a + j); });
  }
  return [x, ...ys];
}
const usedAt = (j) => (res?.i0 != null && j >= res.i0 ? res.used[j] : null);
// Ideal at each sample. C(t, n) needs the laps completed at that moment, so walk the lap end times
// alongside the samples (columns() visits them in time order).
const idealAt = (plan) => {
  const ends = (res?.laps || []).map((l) => l.tb);
  let p = 0;
  return (s, j) => {
    if (res?.i0 == null || j < res.i0) return null;
    while (p < ends.length && ends[p] <= s.t) p++;
    return M.idealAh(plan, s.t - res.t0, p);
  };
};
const deltaAt = (plan) => {
  const ideal = idealAt(plan);
  return (s, j) => { const id = ideal(s, j), u = usedAt(j); return id == null || u == null ? null : u - id; };
};
const modelFormula = (p) => (p.model === 'tn' ? `C(t, n) = ${p.coef.a} + ${p.coef.b}t + ${p.coef.c}n`
  : p.model === 't' ? `C(t) = ${p.coef.a} + ${p.coef.b}t`
    : `${fx(p.targetAh, 1)} Ah ÷ ${p.refLaps} laps ÷ ${(p.refLapMs / 1000).toFixed(3)} s per lap`);

function renderRaceCharts(S, plan, k) {
  const w = chartWindow(S, k);
  if (!w) return;
  const [a, b] = w;
  chart('chDelta', { series: [{ label: 'Δ Ah' }], unit: 'Ah', dp: 2, delta: true, band: bandFn, height: 200 })
    .setData(columns(S, a, b, [deltaAt(plan)]));
  chart('chSpeedR', { series: [{ label: 'eChook', color: '--s1' }, { label: 'GPS', color: '--s2' }], unit: spdUnit, dp: 1, height: 200 })
    .setData(columns(S, a, b, [(s) => spd(s.spd), (s) => spd(s.gspd)]));
  chart('chCurrentR', { series: [{ label: 'Current', color: '--s1' }], unit: 'A', dp: 1, height: 200 })
    .setData(columns(S, a, b, [(s) => s.i]));
  document.querySelectorAll('.unitLabel').forEach((e) => { e.textContent = spdUnit(); });
}

const GRAPHS = [
  { id: 'gUsed', title: 'Ah used vs ideal', unit: 'Ah', dp: 2, series: [{ label: 'Used', color: '--s1' }, { label: 'Ideal', color: '--s2', dash: [6, 4] }], cols: (plan) => [(s, j) => usedAt(j), idealAt(plan)] },
  { id: 'gDelta', title: 'Δ Ah vs ideal', unit: 'Ah', dp: 2, delta: true, series: [{ label: 'Δ Ah' }], cols: (plan) => [deltaAt(plan)] },
  { id: 'gSpeed', title: 'Speed', unit: spdUnit, dp: 1, series: [{ label: 'eChook', color: '--s1' }, { label: 'GPS', color: '--s2' }], cols: () => [(s) => spd(s.spd), (s) => spd(s.gspd)] },
  { id: 'gCurrent', title: 'Current', unit: 'A', dp: 1, series: [{ label: 'Current', color: '--s1' }], cols: () => [(s) => s.i] },
  { id: 'gPower', title: 'Power', unit: 'W', dp: 0, series: [{ label: 'Power', color: '--s1' }], cols: () => [(s) => s.pw] },
  { id: 'gBatt', title: 'Battery voltages', unit: 'V', dp: 2, series: [{ label: 'Lower', color: '--s1' }, { label: 'Upper', color: '--s2' }], cols: () => [(s) => s.vLo, (s) => s.vUp] },
  { id: 'gPack', title: 'Pack voltage', unit: 'V', dp: 2, series: [{ label: 'Pack', color: '--s1' }], cols: () => [(s) => s.v] },
  { id: 'gRpm', title: 'Motor RPM (from speed)', unit: 'rpm', dp: 0, series: [{ label: 'RPM', color: '--s1' }, { label: 'Low', color: '--s2', dash: [5, 4] }, { label: 'High', color: '--s3', dash: [5, 4] }], cols: () => [(s) => rpmOf(s.spd ?? s.gspd)?.rpm ?? null, (s) => rpmOf(s.spd ?? s.gspd)?.lo ?? null, (s) => rpmOf(s.spd ?? s.gspd)?.hi ?? null] },
  { id: 'gThr', title: 'Throttle', unit: '%', dp: 0, series: [{ label: 'Throttle', color: '--s1' }], cols: () => [(s) => s.thr] },
  { id: 'gTemp', title: 'Temperature', unit: '°C', dp: 1, series: [{ label: 'Temp 1', color: '--s1' }, { label: 'Temp 2', color: '--s2' }], cols: () => [(s) => s.t1, (s) => s.t2] },
];
let graphsBuilt = false;
function renderGraphs(S, plan, k) {
  if (!graphsBuilt) {
    $('graphs').innerHTML = GRAPHS.map((g) => `<article class="card"><div class="card-head"><h3>${g.title}</h3><span class="muted small" data-unit="${g.id}"></span></div><div id="${g.id}" class="chart"></div></article>`).join('');
    graphsBuilt = true;
  }
  const w = chartWindow(S, k);
  if (!w) return;
  for (const g of GRAPHS) {
    const unit = typeof g.unit === 'function' ? g.unit() : g.unit;
    document.querySelector(`[data-unit="${g.id}"]`).textContent = unit;
    chart(g.id, { series: g.series, unit: g.unit, dp: g.dp, delta: g.delta, band: bandFn, height: 220 }).setData(columns(S, w[0], w[1], g.cols(plan)));
  }
}

const liveMap = new LiveMap($('map'), {
  describe: (p) => {
    const r = rpmOf(p.spd ?? p.gspd);
    return `<b>${tod(p.t)}</b><br>Speed ${fx(spd(p.spd ?? p.gspd), 1)} ${spdUnit()}${r ? ` · ${fx(r.rpm, 0)} rpm` : ''}<br>` +
      `Current ${fx(p.i, 1)} A · Pack ${fx(p.v, 2)} V<br>Ah ${fx(p.ah, 2)}${p.lap != null ? ` · eChook lap ${p.lap}` : ''}`;
  },
});
let mapCanvas = null;
function renderMap(S, k) {
  if (k < 0) return;
  const from = res?.i0 ?? idxAtOrBefore(S, S[k].t - 10 * 60e3);
  const pts = [];
  let last = null;
  for (let j = from; j <= k; j++) {
    const s = S[j];
    if (s.lat == null || s.lon == null || (last && last.lat === s.lat && last.lon === s.lon)) continue;
    pts.push(s); last = s;
  }
  const gate = res?.lapSource === 'gps' ? res.gate : null, lapFrom = res?.bounds?.at(-1)?.t ?? null;
  if (!liveMap.update(pts, lapFrom, gate)) { // map library missing: plain drawing instead
    if (!mapCanvas) { mapCanvas = document.createElement('canvas'); mapCanvas.className = 'map'; $('map').replaceChildren(mapCanvas); }
    drawMap(mapCanvas, S, { from, to: k, lapFrom, gate });
  }
  $('mapNote').textContent = pts.length ? 'Blue = current lap · click the track for readings · ◎ follows the car' : 'No GPS track yet';
}

function renderLaps(table, S, plan, k, max) {
  const u = spdUnit();
  const head = ['Lap', 'Time', 'vs ref lap', 'Ah', 'Δ Ah', 'Avg A', 'Peak A', 'Avg V', 'Min V', `Speed ${u}`, `GPS ${u}`, 'RPM', 'Throttle %', 'Wh', 'Max °C'];
  const laps = res?.laps || [];
  if (table === $('lapsFull')) $('lapsNote').textContent = laps.length ? `${laps.length} laps · ${lapSourceText(S)} · Δ Ah = lap Ah − ideal for a lap of that length (${modelFormula(plan)}) · vs ref lap = lap time − the reference average lap (${fx(plan.refLapMs / 1000, 1)} s)` : '';
  if (!laps.length && !(res?.bounds?.length)) { table.innerHTML = `<tr><td class="muted">No laps yet</td></tr>`; return; }
  const best = laps.length ? laps.reduce((m, l) => (l.dur < m.dur ? l : m)) : null;
  const rows = [];
  // lap in progress
  const lastB = res?.bounds?.at(-1);
  if (lastB && k >= 0 && S[k].t > lastB.t) {
    const j = idxAtOrBefore(S, lastB.t);
    const ah = (res.used[k] ?? 0) - (res.used[j] ?? 0);
    rows.push(`<tr class="partial"><td>${laps.length + 1} (now)</td><td>${lapTime(S[k].t - lastB.t)}</td><td></td><td>${fx(ah, 3)}</td>${'<td></td>'.repeat(11)}</tr>`);
  }
  for (const L of laps.slice().reverse().slice(0, max)) {
    rows.push(`<tr class="${L === best ? 'best' : ''}"><td>${L.n}</td><td>${lapTime(L.dur)}</td>` +
      `<td class="${dcls(L.dur - plan.refLapMs)}">${signed((L.dur - plan.refLapMs) / 1000, 1)} s</td>` +
      `<td>${fx(L.ah, 3)}</td><td class="${dcls(L.ahDelta)}">${signed(L.ahDelta, 3)}</td>` +
      `<td>${fx(L.avgI, 1)}</td><td>${fx(L.peakI, 0)}</td><td>${fx(L.avgV, 2)}</td><td>${fx(L.minV, 2)}</td>` +
      `<td>${fx(spd(L.avgSpd), 1)}</td><td>${fx(spd(L.avgGspd), 1)}</td><td>${fx(rpmOf(L.avgSpd ?? L.avgGspd)?.rpm, 0)}</td><td>${fx(L.avgThr, 0)}</td>` +
      `<td>${fx(L.wh, 1)}</td><td>${fx(L.maxT, 1)}</td></tr>`);
  }
  table.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody>`;
}

// ---------- settings ----------
const FIELDS = [
  ['sCls', 'cls', String], ['sRpmKmh', 'rpmKmh', Number], ['sRpmAt', 'rpmAt', Number], ['sRpmLo', 'rpmLo', Number], ['sRpmHi', 'rpmHi', Number],
  ['sModel', 'idealModel', String], ['sNMode', 'nMode', String],
  ['sTnA', 'tnA', Number], ['sTnB', 'tnB', Number], ['sTnC', 'tnC', Number], ['sTA', 'tA', Number], ['sTB', 'tB', Number],
  ['sTarget', 'targetAh', Number], ['sRefLaps', 'refLaps', Number],
  ['sRefLap', 'refLapMs', (v) => Math.round(Number(v) * 1000), (v) => (v / 1000).toFixed(3)],
  ['sRaceLen', 'raceLenMin', (v) => (v === '' ? null : Number(v)), (v) => (v == null ? '' : v)],
  ['sBand', 'bandAh', Number], ['sUnits', 'units', String], ['sTheme', 'theme', String], ['sLapSrc', 'lapSource', String],
  ['sVw', 'vWarn', Number], ['sVc', 'vCrit', Number], ['sTw', 'tWarn', Number], ['sTc', 'tCrit', Number],
  ['sIw', 'iWarn', Number], ['sIc', 'iCrit', Number], ['sImb', 'imbWarn', Number],
];
function fillSettings() {
  for (const [id, key, , show] of FIELDS) { const src = PER_CLASS.includes(key) ? settings.classes[settings.cls] : settings; $(id).value = show ? show(src[key]) : src[key]; }
  syncModelRows();
  renderPlanOut();
}
function syncModelRows() {
  document.querySelectorAll('[data-model]').forEach((el) => { el.hidden = !el.dataset.model.split(' ').includes(settings.idealModel); });
}
function renderPlanOut() {
  const p = M.makePlan(planSettings());
  if (p.model !== 'ref') {
    const lapMin = p.refLapMs / 60000;
    const rows = [
      ['Ideal now', modelFormula(p)],
      p.model === 'tn' ? ['n', p.nMode === 'current' ? 'the lap in progress (1 on lap 1)' : 'laps completed (0 on lap 1)'] : null,
      p.model === 'tn'
        ? ['Ideal grows', `${p.coef.b} Ah/min (a steady ${(p.coef.b * 60).toFixed(2)} A) during a lap, plus ${p.coef.c} Ah at each lap line`]
        : ['Ideal grows', `${p.coef.b} Ah/min (a steady ${(p.coef.b * 60).toFixed(2)} A)`],
      ['Ideal for an average lap', `${p.coef.b} × ${lapMin.toFixed(4)} min${p.model === 'tn' ? ` + ${p.coef.c}` : ''} = ${p.avgLapAh.toFixed(4)} Ah`],
      ['Ideal at the end of the race plan', `${M.idealAh(p, p.raceLenMs, p.refLaps).toFixed(2)} Ah after ${clock(p.raceLenMs)}${p.model === 'tn' ? ` and ${p.refLaps} laps` : ''}`],
    ].filter(Boolean);
    $('planOut').innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
    return;
  }
  const rows = [
    ['Ah per lap', `${fx(p.targetAh, 1)} ÷ ${p.refLaps} = ${p.perLap.toFixed(4)} Ah`],
    ['Average lap', `${(p.refLapMs / 1000).toFixed(3)} s = ${p.refLapMs} ms`],
    ['Race length the plan covers', `${clock(p.raceLenMs)}${planSettings().raceLenMin ? ' (aim for this class)' : ` (${p.refLaps} × ${(p.refLapMs / 1000).toFixed(3)} s)`}`],
    ['Ah per minute', `${p.perMin.toFixed(5)} Ah`],
    ['Ah per second', `${p.perS.toFixed(7)} Ah`],
    ['Ah per millisecond', `${p.perMs.toExponential(5).replace('e-6', ' × 10⁻⁶').replace('e-7', ' × 10⁻⁷')} Ah`],
    ['Same as a steady current of', `${p.idealA.toFixed(2)} A`],
  ];
  $('planOut').innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
}
function renderSettingsInfo(S) {
  const isLive = view.mode === 'live', manual = isLive ? sync.state.start : view.raceStart;
  const t0 = isLive ? (sync.state.start ?? res?.t0) : res?.t0;
  $('startNote').textContent = t0 == null
    ? 'No race start yet. It is detected when the car drives off after standing still for 5 minutes, or set it here.'
    : `Race start: ${new Date(t0).toLocaleString()} (${manual != null ? 'set by hand' : 'detected: the car drove off'}). ` +
      (manual == null ? 'A stop longer than 5 minutes would start a new race, so press “Race starts now” at the start to pin it for every device.' : (isLive ? 'Shared with every device.' : ''));
  const g = (isLive ? settings.gate : view.gate);
  $('gateNote').textContent = g ? `Start/finish line set by hand at ${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}. It is only used when laps are counted with GPS.`
    : 'GPS start/finish line: placed where the car drives off at the race start. Used when the eChook lap counter is not counting.';
  $('btnStartNow').textContent = view.mode === 'replay' ? 'Race starts at replay position' : 'Race starts now';
  renderPlanOut();
}
function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  Object.values(charts).forEach((c) => c.rebuild());
}
function renderCarIdCard() {
  const server = !!live.server;
  $('carIdNote').textContent = server
    ? 'This site runs with its own server, which keeps the Car ID. Nothing to enter here.'
    : 'This copy of the site has no server, so the Car ID is kept in this browser only (never in the site’s code). Anyone using this device could read it.';
  $('carIdRow').hidden = server;
}

// ---------- live data ----------
async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// eChook's history API only answers its own site and localhost:5173 (CORS).
const directOk = ['localhost:5173', '127.0.0.1:5173'].includes(location.host);
const dayKey = () => 'et.live.' + new Date().toLocaleDateString('en-CA');
const lastT = () => live.S.at(-1)?.t ?? Date.now() - 3600e3;

function ingest(p) {
  const s = M.fromPacket(p);
  if (!s) return;
  const S = live.S, last = S[S.length - 1];
  if (!last || s.t > last.t) { S.push(s); M.derive(S, S.length - 1); }
  else if (s.t === last.t) { S[S.length - 1] = s; M.derive(S, S.length - 1); }
  else live.S = M.prepare(S.concat([s]));
  live.lastWall = Date.now(); live.offset = s.t - Date.now();
  if (!live.server) { const q = { ...(typeof p === 'object' ? p : {}) }; delete q.carId; live.raw.push(q); saveRawSoon(); }
}
let rawTimer = null;
function saveRawSoon() {
  if (rawTimer) return;
  rawTimer = setTimeout(() => { rawTimer = null; store.set(dayKey(), live.raw.slice(-8000)); }, 10000);
}
function merge(rows) {
  const add = (rows || []).map(M.fromPacket).filter(Boolean);
  if (add.length) live.S = M.prepare(live.S.concat(add));
}
async function backfill(since) {
  const start = since ?? new Date().setHours(0, 0, 0, 0), end = Date.now() + 60e3;
  try {
    if (live.server) merge(await getJson(`api/history?start=${start}&end=${end}`));
    else {
      // Works only where eChook allows it (localhost:5173); otherwise use what this browser saved.
      if (directOk) { try { merge(await getJson(`https://data.echook.uk/api/history/${encodeURIComponent(live.carId)}?start=${start}&end=${end}&page=1&limit=5000`)); } catch { /* CORS */ } }
      if (since == null) { live.raw = store.get(dayKey(), []); merge(live.raw); }
    }
  } catch (e) { live.error = 'history: ' + e.message; }
  if (live.S.length && !live.lastWall) { live.lastWall = Date.now() - Math.max(0, Date.now() - live.S.at(-1).t); live.offset = 0; }
  invalidate();
}
function connect() {
  if (live.socket) live.socket.close();
  live.status = 'connecting';
  const sock = io('https://data.echook.uk', { transports: ['websocket'], reconnectionDelayMax: 10000 });
  live.socket = sock;
  sock.on('connect', () => {
    live.status = 'connected'; live.error = '';
    sock.emit('join', live.carId);
    if (live.everConnected && live.server) backfill(lastT() - 15e3);
    live.everConnected = true; invalidate();
  });
  sock.on('disconnect', () => { live.status = 'reconnecting'; invalidate(); });
  sock.on('connect_error', (e) => { live.status = 'error'; live.error = e?.message || 'connection failed'; invalidate(); });
  sock.on('data', (p) => { (Array.isArray(p) ? p : [p]).forEach(ingest); if (view.mode === 'live') invalidate(); });
  clearInterval(live.pollTimer);
  live.pollTimer = setInterval(async () => { // fallback while the socket is down
    if (!live.server || live.status === 'connected') return;
    try { const p = await getJson('api/latest'); if (p) { ingest(p); invalidate(); } } catch { /* offline */ }
  }, 3000);
}
async function initLive() {
  try { live.server = await getJson('api/config'); } catch { live.server = null; }
  live.carId = live.server?.carId || store.get('et.carId', null);
  renderCarIdCard();
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('et.live.') && k !== dayKey()) store.del(k); }
  if (!live.carId) { live.status = 'nocar'; invalidate(); loadDays(); return; }
  sync.start(live.carId);
  await backfill();
  connect();
  loadDays();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && live.server && live.S.length) backfill(lastT() - 15e3);
});

// ---------- history, CSV, replay ----------
async function loadDays() {
  const box = $('days'), note = $('daysNote');
  if (!live.carId) { note.textContent = 'Needs the Car ID'; return; }
  try {
    if (!live.server && !directOk) throw new Error('blocked');
    const days = live.server ? await getJson('api/days') : await getJson(`https://data.echook.uk/api/history/days/${encodeURIComponent(live.carId)}`);
    const list = (days || []).slice().sort().reverse();
    note.textContent = `${list.length} days with data`;
    box.innerHTML = list.map((d) => `<button class="btn" data-day="${esc(d)}">${new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</button>`).join('');
  } catch {
    note.textContent = '';
    box.innerHTML = '<p class="muted small">eChook only lets its own site and the server version of this site read history. Run the site with its server (see README) to browse past days here. CSV files from the eChook app work everywhere.</p>';
  }
}
$('days').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  const day = b.dataset.day, d0 = Date.parse(day + 'T00:00:00Z');
  document.querySelectorAll('#days .btn').forEach((x) => x.classList.toggle('sel', x === b));
  $('daysNote').textContent = 'Loading…';
  try {
    const rows = live.server
      ? await getJson(`api/history?start=${d0 - 3 * 3600e3}&end=${d0 + 27 * 3600e3}`)
      : await getJson(`https://data.echook.uk/api/history/${encodeURIComponent(live.carId)}?start=${d0 - 3 * 3600e3}&end=${d0 + 27 * 3600e3}&page=1&limit=5000`);
    setLoaded(M.prepare((rows || []).map(M.fromPacket)), b.textContent.trim());
    $('daysNote').textContent = `${rows.length} packets`;
  } catch (err) { $('daysNote').textContent = 'Could not load: ' + err.message; }
});
$('csvFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const S = M.prepare(M.parseCsv(await f.text()));
    $('csvNote').textContent = `${S.length} rows read from ${f.name}`;
    setLoaded(S, f.name);
  } catch (err) { $('csvNote').textContent = 'Could not read the file: ' + err.message; }
  e.target.value = '';
});

function setLoaded(S, label) {
  view.S = S; view.label = label; view.raceStart = null; view.gate = null; view.manualLaps = [];
  liveMap.resetView();
  $('refResult').hidden = true;
  enterMode('review');
  renderLoaded();
}
function renderLoaded() {
  const S = view.S;
  $('loadedCard').hidden = !S.length;
  if (!S.length) return;
  $('loadedTitle').textContent = view.label;
  const dur = S.at(-1).t - S[0].t;
  $('loadedNote').textContent = `${S.length} samples · ${tod(S[0].t)} – ${tod(S.at(-1).t)} (${clock(dur)})`;
  const runs = M.detectRuns(S);
  const chosen = view.mode !== 'live' ? res?.t0 : null;
  $('runsList').innerHTML = runs.length
    ? '<span class="muted small">Driving stretches (pick the race):</span> ' + runs.map((r, i) => `<button class="btn ${chosen != null && r.t0 <= chosen && chosen <= r.t1 ? 'sel' : ''}" data-run="${r.t0}">${i + 1}: ${tod(r.t0)} · ${clock(r.dur)}</button>`).join('')
    : '<span class="muted small">The car never drives in this data.</span>';
}
$('runsList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-run]');
  if (!b) return;
  view.raceStart = Number(b.dataset.run);
  invalidate();
});
$('btnReview').onclick = () => enterMode('review');
$('btnReplay').onclick = () => {
  const S = view.S;
  if (!S.length) return;
  const runs = M.detectRuns(S);
  const start = view.raceStart ?? (runs.length ? runs.reduce((a, b) => (b.dur > a.dur ? b : a)).t0 : S[0].t);
  view.cursorT = Math.max(S[0].t, start - 30e3); view.playing = true;
  enterMode('replay');
  selectTab('race');
};
$('btnRef').onclick = () => {
  const r = M.referenceFrom(view.S, planSettings().targetAh);
  const box = $('refResult'); box.hidden = false;
  if (!r.ok) { box.innerHTML = 'No complete laps found in this data.'; return; }
  const src = r.res.lapSource === 'counter' ? 'the eChook lap counter' : 'GPS (start/finish line where the car drove off)';
  box.innerHTML = `<b>${r.laps} complete laps</b> in the longest driving stretch (laps counted with ${src}).<br>` +
    `Average lap ${(r.avgLapMs / 1000).toFixed(3)} s · ${fx(planSettings().targetAh, 1)} Ah ÷ ${r.laps} = <b>${r.perLap.toFixed(4)} Ah per lap</b> · ` +
    `${r.perS.toFixed(7)} Ah per second · ${(r.perMs * 1e6).toFixed(5)} × 10⁻⁶ Ah per ms (a steady ${(r.perMs * 3.6e6).toFixed(2)} A).<br>` +
    `<span class="muted">Actually used over those laps: ${fx(r.res.used[r.res.i1], 2)} Ah.</span>` +
    `<br><span class="muted">Applying them sets the reference race for ${settings.cls} (used by the reference-race model and the lap time comparison).</span>` +
    `<div class="row"><button class="btn primary" id="btnApplyRef">Use these numbers</button></div>`;
  $('btnApplyRef').onclick = () => {
    Object.assign(settings.classes[settings.cls], { refLaps: r.laps, refLapMs: Math.round(r.avgLapMs) });
    saveSettings(); fillSettings(); invalidate();
    $('btnApplyRef').textContent = 'Applied ✓';
  };
};

function enterMode(mode) {
  view.mode = mode;
  $('replayBar').hidden = mode === 'live';
  for (const id of ['rpPlay', 'rpSpeed', 'rpSeek', 'rpTime']) $(id).hidden = mode !== 'replay';
  clearTimeout(view.timer);
  if (mode === 'replay') { view.lastTick = performance.now(); view.timer = setTimeout(() => tick(performance.now()), 100); }
  invalidate();
}
function tick(now) {
  if (view.mode !== 'replay') return;
  view.timer = setTimeout(() => tick(performance.now()), 100);
  const S = view.S, end = S.at(-1)?.t ?? 0;
  if (view.playing) {
    view.cursorT = Math.min(end, view.cursorT + (now - view.lastTick) * view.speed);
    if (view.cursorT >= end) view.playing = false;
    invalidate();
  }
  view.lastTick = now;
  $('rpPlay').textContent = view.playing ? 'Pause' : 'Play';
  if (document.activeElement !== $('rpSeek')) $('rpSeek').value = String(Math.round(((view.cursorT - S[0].t) / Math.max(1, end - S[0].t)) * 1000));
  $('rpTime').textContent = tod(view.cursorT);
}
$('rpPlay').onclick = () => {
  if (!view.playing && view.cursorT >= view.S.at(-1).t) view.cursorT = view.S[0].t;
  view.playing = !view.playing; invalidate();
};
$('rpSpeed').onchange = (e) => { view.speed = Number(e.target.value); invalidate(); };
$('rpSeek').oninput = (e) => { const S = view.S; view.cursorT = S[0].t + (Number(e.target.value) / 1000) * (S.at(-1).t - S[0].t); invalidate(); };
$('rpLive').onclick = () => { liveMap.resetView(); enterMode('live'); };

// ---------- settings events ----------
for (const [id, key, parse] of FIELDS) {
  $(id).addEventListener('change', (e) => {
    const v = parse(e.target.value);
    if (typeof v === 'number' && !Number.isFinite(v)) return;
    if (PER_CLASS.includes(key)) settings.classes[settings.cls][key] = v; else settings[key] = v;
    saveSettings();
    if (key === 'cls') { setClass(v); return; }
    if (key === 'idealModel' && view.mode === 'live') sync.publish({ k: 'model', v });
    if (key === 'theme') applyTheme();
    if (key === 'idealModel') syncModelRows();
    if (key === 'units') Object.values(charts).forEach((c) => c.rebuild());
    renderPlanOut(); invalidate();
  });
}
// ---------- race control: start, laps, class (shared with every device in live mode) ----------
function startRace(t) {
  if (view.mode === 'live') sync.publish({ k: 'start', t });
  else { view.raceStart = t; view.manualLaps = []; }
  invalidate();
}
function raceRunning() {
  return view.mode === 'live' ? sync.state.start != null && Date.now() - sync.state.start < 4 * 3600e3 : view.raceStart != null;
}
$('btnStartRace').onclick = () => {
  if (view.mode === 'review') return flash('Start the replay first, then press Start race at the right moment.');
  if (raceRunning() && !confirm('Restart the race clock? This resets the race and its marked laps on every device.')) return;
  startRace(view.mode === 'replay' ? view.cursorT : Date.now());
};
$('btnStartNow').onclick = () => $('btnStartRace').onclick();
$('btnStartAuto').onclick = () => { startRace(null); $('sStartAt').value = ''; };
$('sStartAt').onchange = (e) => {
  const t = Date.parse(e.target.value);
  if (Number.isFinite(t)) startRace(t);
};
const lapList = () => (view.mode === 'live' ? sync.state.laps : view.manualLaps);
const raceStartNow = () => (view.mode === 'live' ? sync.state.start : view.raceStart) ?? res?.t0 ?? null;
function markLap() {
  if (view.mode === 'review') return flash('Laps can be marked live or during a replay.');
  const t = view.mode === 'live' ? Date.now() : view.cursorT, start = raceStartNow();
  if (start == null) return flash('Start the race first.');
  const last = lapList().filter((l) => l.t > start).at(-1);
  if (last && t - last.t < 10e3) return flash(`Ignored: a lap was marked ${Math.round((t - last.t) / 1000)} s ago.`);
  if (view.mode === 'live') {
    if (sync.state.start == null) sync.publish({ k: 'start', t: start }); // pin the detected start for every device
    sync.publish({ k: 'lap', t });
  } else {
    view.raceStart ??= start;
    view.manualLaps.push({ id: 'l' + t, t });
  }
  flash(`Lap marked at ${tod(t)}.`);
  invalidate();
}
function undoLap() {
  const start = raceStartNow(), last = lapList().filter((l) => start == null || l.t > start).at(-1);
  if (!last) return flash('No marked lap to undo.');
  if (view.mode === 'live') sync.publish({ k: 'unlap', id: last.id });
  else view.manualLaps = view.manualLaps.filter((l) => l !== last);
  flash(`Removed the lap marked at ${tod(last.t)}.`);
  invalidate();
}
$('btnLap').onclick = markLap;
$('btnUndoLap').onclick = undoLap;
$('btnAutoLaps').onclick = () => {
  if (!confirm('Delete the laps marked by hand and count laps automatically again?')) return;
  if (view.mode === 'live') sync.publish({ k: 'autolaps' }); else view.manualLaps = [];
  invalidate();
};
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
  if (e.key === 'l' || e.key === 'L') { e.preventDefault(); markLap(); }
  else if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undoLap(); }
});
function setClass(c) {
  if (!CLASS_DEFAULTS[c]) return;
  settings.cls = c; saveSettings();
  if (view.mode === 'live') sync.publish({ k: 'class', v: c });
  fillSettings(); invalidate();
}
$('clsSel').onchange = (e) => setClass(e.target.value);
function onSync() {
  const st = sync.state;
  let changed = false;
  if (st.cls && CLASS_DEFAULTS[st.cls] && st.cls !== settings.cls) { settings.cls = st.cls; changed = true; }
  if (st.model && st.model !== settings.idealModel) { settings.idealModel = st.model; changed = true; }
  if (changed) { saveSettings(); fillSettings(); }
  invalidate();
}
function flash(msg) {
  flashMsg = msg; flashUntil = Date.now() + 4000;
  renderRaceBar(); setTimeout(renderRaceBar, 4100);
}
function renderRaceBar() {
  $('clsSel').value = settings.cls;
  $('btnAutoLaps').hidden = res?.lapSource !== 'manual';
  $('btnStartRace').textContent = raceRunning() ? 'Restart race' : 'Start race';
  let note = res?.lapSource === 'manual' ? 'Laps marked by hand: automatic lap counting is off for this race.'
    : res?.lapSource ? `Laps counted automatically (${res.lapSource === 'counter' ? 'eChook lap counter' : 'GPS line'}). Pressing Lap switches to marking by hand.` : '';
  if (flashMsg && Date.now() < flashUntil) note = flashMsg;
  $('raceBarNote').textContent = note;
  const sn = $('syncNote');
  if (view.mode !== 'live') { sn.textContent = 'Replay: start and laps stay on this device'; sn.className = 'small syncnote'; return; }
  const st = sync.state.status;
  sn.textContent = st === 'ok' ? '● Shared with your other devices' : st === 'connecting' ? '○ Connecting…' : st === 'offline' ? '● Not shared right now: this device only (retrying)' : '';
  sn.className = 'small syncnote ' + (st === 'ok' ? 'ok' : st === 'offline' ? 'off' : '');
}
$('btnGateHere').onclick = () => {
  const S = curS(), k = nowIndex(S);
  let b = null, a = null;
  for (let j = k; j >= 0 && S[k].t - S[j].t < 30e3; j--) {
    if (S[j].lat == null) continue;
    if (!b) b = S[j]; else if (M.distM(S[j], b) > 3) { a = S[j]; break; }
  }
  if (!a || !b) { $('gateNote').textContent = 'The car needs to be moving (with GPS) to set the line from its position and direction.'; return; }
  const g = M.gateFrom(b.lat, b.lon, b.lat + (b.lat - a.lat), b.lon + (b.lon - a.lon));
  if (view.mode === 'live') { settings.gate = g; saveSettings(); } else view.gate = g;
  invalidate();
};
$('btnGateAuto').onclick = () => {
  if (view.mode === 'live') { settings.gate = null; saveSettings(); } else view.gate = null;
  invalidate();
};
$('btnCarId').onclick = () => {
  const v = $('sCarId').value.trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(v)) { $('carIdNote').textContent = 'That does not look like a Car ID.'; return; }
  store.set('et.carId', v); $('sCarId').value = '';
  live.S = []; live.status = 'idle'; initLive();
};

// ---------- tabs ----------
function selectTab(name) {
  tab = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
  try { sessionStorage.setItem('et.tab', name); } catch { /* ignore */ }
  invalidate();
}
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) selectTab(b.dataset.tab); });
document.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => selectTab(b.dataset.goto); });
window.addEventListener('resize', () => invalidate());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });

// ---------- start ----------
applyTheme();
fillSettings();
let firstTab = 'race';
try { firstTab = sessionStorage.getItem('et.tab') || 'race'; } catch { /* ignore */ }
selectTab(firstTab);
setInterval(() => { if (view.mode === 'live') { renderHeader(); } }, 1000);
setInterval(() => { if (view.mode === 'live') invalidate(); }, 2000);
initLive();
