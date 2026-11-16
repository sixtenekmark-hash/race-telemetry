// Telemetry model: pure functions shared by the browser and the Node test scripts.
// Samples are plain objects; every reading is a number or null (missing / filtered spike).

// Physical limits: anything outside is treated as a spike and dropped.
export const LIMITS = {
  v: [0, 32], vLo: [0, 17], vUp: [0, 17], i: [-50, 250], spd: [0, 25], gspd: [0, 25],
  rpm: [0, 3500], thr: [0, 100], gear: [0, 30], t1: [-20, 120], t2: [-20, 120], ah: [0, 500],
};

const num = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

function clean(s) {
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (s[k] !== null && s[k] !== undefined && (s[k] < lo || s[k] > hi)) s[k] = null;
  }
  if (s.vUp == null && s.v != null && s.vLo != null && s.vLo > 0 && s.v > s.vLo) s.vUp = +(s.v - s.vLo).toFixed(3);
  if (s.lat != null && s.lon != null && (Math.abs(s.lat) < 1e-6 && Math.abs(s.lon) < 1e-6)) s.lat = s.lon = null;
  return s;
}

const blank = (t) => ({
  t, v: null, vLo: null, vUp: null, i: null, ah: null, spd: null, gspd: null, rpm: null, thr: null, gear: null,
  t1: null, t2: null, brake: null, lap: null, lat: null, lon: null, track: null, wh: null, ll: null,
});

/** eChook API / socket packet -> sample */
export function fromPacket(p) {
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return null; } }
  if (Array.isArray(p)) p = p[0];
  if (!p || typeof p !== 'object') return null;
  const t = num(p.updated ?? p.timestamp ?? p.time);
  if (!t) return null;
  const s = blank(t);
  s.v = num(p.voltage); s.vLo = num(p.voltageLower); s.i = num(p.current); s.ah = num(p.ampH);
  s.spd = num(p.speed); s.rpm = num(p.rpm); s.thr = num(p.throttle); s.gear = num(p.gear);
  s.t1 = num(p.temp1); s.t2 = num(p.temp2);
  s.brake = p.brake == null ? null : (p.brake === true || p.brake === 1 || p.brake === '1' || p.brake === 'true');
  s.lap = num(p.currLap); s.lat = num(p.lat); s.lon = num(p.lon); s.track = p.track || null;
  const llt = num(p.LL_Time);
  if (llt && llt > 0) s.ll = { time: llt, v: num(p.LL_V), i: num(p.LL_I), rpm: num(p.LL_RPM), spd: num(p.LL_Spd), ah: num(p.LL_Ah) };
  return clean(s);
}

/** eChook app CSV/TSV export -> samples. Columns are matched by header name. */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('The file has no data rows.');
  const h0 = lines[0];
  const delim = h0.includes('\t') ? '\t' : (h0.split(';').length > h0.split(',').length ? ';' : ',');
  const head = h0.split(delim).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const find = (...keys) => head.findIndex((h) => keys.some((k) => (typeof k === 'string' ? h.includes(k) : k.test(h))));
  const c = {
    t: find(/^timestamp/, /^time ?\(ms\)/, /^epoch/), gspd: find('gps speed'), v: find('total voltage', /^voltage/),
    vLo: find('lower voltage'), vUp: find('upper voltage'), i: find(/^current/), ah: find('amphour', 'amp hour', /^ah\b/),
    wh: find('energy (wh)'), t1: find('temperature 1', /^temp1/), t2: find('temperature 2', /^temp2/),
    lat: find('latitude', /^lat\b/), lon: find('longitude', /^lon\b/), spd: find(/^speed/, 'wheel speed'),
    rpm: find('rpm', 'motor speed'), thr: find('throttle'), lap: find(/^lap\b/, 'current lap', 'currlap'), gear: find('gear'),
    brake: find('brake'),
  };
  if (c.t < 0) throw new Error('No "Timestamp" column (milliseconds) found in the header.');
  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const f = lines[r].split(delim);
    const g = (k) => (c[k] >= 0 ? num(f[c[k]]) : null);
    const t = g('t');
    if (!t) continue;
    const s = blank(t);
    for (const k of ['gspd', 'v', 'vLo', 'vUp', 'i', 'ah', 'wh', 't1', 't2', 'lat', 'lon', 'spd', 'rpm', 'thr', 'lap', 'gear']) s[k] = g(k);
    if (c.brake >= 0) s.brake = g('brake') ? true : false;
    out.push(clean(s));
  }
  return out;
}

// ---------- geometry ----------
const R_EARTH = 6371000;
export function distM(a, b) {
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(x)));
}
function localXY(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return (p) => [(p.lon - lon0) * kx, (p.lat - lat0) * ky];
}
const hasFix = (s) => s.lat != null && s.lon != null;

/** Sort, de-duplicate and add derived values: upper battery, power, GPS speed (if absent), energy. */
export function prepare(samples) {
  const S = samples.filter(Boolean).sort((a, b) => a.t - b.t);
  const out = [];
  for (const s of S) {
    if (out.length && out[out.length - 1].t === s.t) out[out.length - 1] = s; else out.push(s);
  }
  for (const s of out) { s._whInt = null; s._fixT = undefined; } // recompute after merges
  derive(out, 0);
  return out;
}

/** Fill derived fields from index `from` onwards (incremental for live data). */
export function derive(S, from = 0) {
  // Find the last GPS change before `from` so GPS speed continues across calls.
  let lastFix = null, lastChangeT = null, prevGspd = 0;
  for (let k = from - 1; k >= 0; k--) {
    if (hasFix(S[k])) { lastFix = S[k]; lastChangeT = S[k]._fixT ?? S[k].t; prevGspd = S[k].gspd ?? 0; break; }
  }
  for (let k = from; k < S.length; k++) {
    const s = S[k], p = k > 0 ? S[k - 1] : null;
    s.pw = s.v != null && s.i != null ? s.v * s.i : null;
    // Energy: keep a logged value, otherwise integrate V*I.
    if (s._whInt == null) {
      const dt = p ? (s.t - p.t) / 3.6e6 : 0;
      s._whInt = (p?._whInt ?? 0) + (p && s.pw != null && dt > 0 && dt < 30 / 3600 ? s.pw * dt : 0);
    }
    // GPS speed from consecutive distinct fixes, unless the source provides it.
    if (hasFix(s)) {
      const moved = lastFix && (s.lat !== lastFix.lat || s.lon !== lastFix.lon);
      if (s._gspdGiven === undefined) s._gspdGiven = s.gspd != null;
      if (!s._gspdGiven) {
        if (!lastFix) s.gspd = 0;
        else if (moved) {
          const dt = Math.min(s.t - lastChangeT, Math.max(s.t - (p?.t ?? lastChangeT), 1000)) / 1000;
          const v = dt > 0 && dt < 20 ? distM(lastFix, s) / dt : null;
          s.gspd = v != null && v <= LIMITS.gspd[1] ? +v.toFixed(2) : null;
        } else s.gspd = s.t - lastChangeT < 2500 ? prevGspd : 0;
      }
      if (!lastFix || moved) { lastChangeT = s.t; }
      s._fixT = lastChangeT;
      lastFix = s; prevGspd = s.gspd ?? prevGspd;
    }
  }
  return S;
}

// ---------- runs (stretches of driving) ----------
export const isMoving = (s) => (s.spd != null && s.spd > 1.5) || (s.gspd != null && s.gspd > 2.5);

/** Driving stretches separated by at least `restMs` without movement. */
export function detectRuns(S, { restMs = 5 * 60e3, minRunMs = 60e3 } = {}) {
  const runs = [];
  let cur = null;
  for (let k = 0; k < S.length; k++) {
    if (!isMoving(S[k])) continue;
    if (cur && S[k].t - S[cur.i1].t <= restMs) { cur.i1 = k; continue; }
    if (cur) runs.push(cur);
    cur = { i0: k, i1: k };
  }
  if (cur) runs.push(cur);
  return runs
    .map((r) => ({ ...r, t0: S[r.i0].t, t1: S[r.i1].t, dur: S[r.i1].t - S[r.i0].t }))
    .filter((r) => r.dur >= minRunMs);
}

// ---------- capacity ----------
/** Race-relative amp-hours used, robust to counter resets and spikes. Returns array aligned with S (null before start). */
export function usedAhSeries(S, i0) {
  const out = new Array(S.length).fill(null);
  let used = 0, prev = null, prevT = null;
  const haveAh = S.slice(i0).some((s) => s.ah != null && s.ah > 0);
  // Dense logs (eChook app CSV, 4 Hz) store Ah rounded to 0.1, so integrating current is more precise there.
  const gaps = [];
  for (let k = i0 + 1; k < Math.min(S.length, i0 + 400); k++) gaps.push(S[k].t - S[k - 1].t);
  gaps.sort((a, b) => a - b);
  const dense = gaps.length > 10 && gaps[gaps.length >> 1] <= 1000 && S.slice(i0, i0 + 400).some((s) => s.i != null);
  out.mode = !haveAh || dense ? 'integrated current' : 'eChook Ah counter';
  for (let k = i0; k < S.length; k++) {
    const s = S[k];
    if (!haveAh || dense) { // integrate current
      if (k > i0 && s.i != null) {
        const dt = (s.t - S[k - 1].t) / 3.6e6;
        if (dt > 0 && dt < 30 / 3600) used += Math.max(0, s.i) * dt;
      }
      out[k] = used; continue;
    }
    const a = s.ah;
    if (a != null) {
      if (prev == null) { prev = a; prevT = s.t; }
      else {
        const d = a - prev, maxStep = (250 * (s.t - prevT)) / 3.6e6 + 0.15;
        if (d >= 0 && d <= maxStep) { used += d; prev = a; prevT = s.t; }
        else if (d < 0 && a < 0.3) { used += a; prev = a; prevT = s.t; } // logger restarted from zero
        // otherwise: spike or noise, ignore
      }
    }
    out[k] = used;
  }
  return out;
}

/** The pacing plan, exactly as defined by the team: Ah per lap = target / laps, then per second / ms. */
export function makePlan(st) {
  const targetAh = +st.targetAh || 20, refLaps = +st.refLaps || 33, refLapMs = +st.refLapMs || 149085;
  const perLap = targetAh / refLaps;
  const raceLenMs = st.raceLenMin ? st.raceLenMin * 60e3 : refLaps * refLapMs;
  const perMs = targetAh / raceLenMs;
  return { targetAh, refLaps, refLapMs, perLap, raceLenMs, perMs, perS: perMs * 1e3, perMin: perMs * 6e4, idealA: perMs * 3.6e6 };
}

// ---------- laps ----------
/** Lap boundaries from the eChook lap counter (currLap increases). */
export function counterBoundaries(S, i0, i1) {
  const b = [];
  let last = null;
  for (let k = i0; k <= i1; k++) {
    const l = S[k].lap;
    if (l == null) continue;
    if (last != null && l > last) b.push({ k, t: S[k].t, src: 'counter' });
    last = l;
  }
  return b;
}

/** A start/finish gate: point + heading, taken where the car first drives in the window. */
export function autoGate(S, i0, i1) {
  for (let k = i0; k <= i1; k++) {
    const s = S[k];
    if (!hasFix(s) || !isMoving(s)) continue;
    for (let j = k + 1; j <= i1 && S[j].t - s.t < 20e3; j++) {
      if (hasFix(S[j]) && distM(s, S[j]) > 8) {
        const xy = localXY(s.lat, s.lon), [hx, hy] = xy(S[j]), n = Math.hypot(hx, hy);
        return { lat: s.lat, lon: s.lon, hx: hx / n, hy: hy / n };
      }
    }
  }
  return null;
}

export function gateFrom(lat, lon, lat2, lon2) {
  const xy = localXY(lat, lon), [hx, hy] = xy({ lat: lat2, lon: lon2 }), n = Math.hypot(hx, hy) || 1;
  return { lat, lon, hx: hx / n, hy: hy / n };
}

/** Lap boundaries from GPS: crossings of the gate line in the driving direction. */
export function gpsBoundaries(S, i0, i1, gate, { halfWidth = 25, minLapMs = 20e3 } = {}) {
  if (!gate) return [];
  const xy = localXY(gate.lat, gate.lon), b = [];
  let A = null, Ak = -1;
  for (let k = i0; k <= i1; k++) {
    const s = S[k];
    if (!hasFix(s) || (A && s.lat === A.lat && s.lon === A.lon)) continue;
    if (A) {
      const [ax, ay] = xy(A), [bx, by] = xy(s);
      const sa = ax * gate.hx + ay * gate.hy, sb = bx * gate.hx + by * gate.hy;
      if (sa < 0 && sb >= 0 && Math.hypot(bx - ax, by - ay) < 200) {
        const f = -sa / (sb - sa), px = ax + f * (bx - ax), py = ay + f * (by - ay);
        if (Math.abs(-px * gate.hy + py * gate.hx) <= halfWidth) {
          const t = A.t + f * (s.t - A.t);
          if (!b.length || t - b[b.length - 1].t >= minLapMs) b.push({ k, t, src: 'gps' });
        }
      }
    }
    A = s; Ak = k;
  }
  return b;
}

const lerpAt = (S, arr, t) => {
  let lo = 0, hi = S.length - 1;
  if (t <= S[0].t) return arr[0];
  if (t >= S[hi].t) return arr[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].t <= t) lo = m; else hi = m; }
  const a = arr[lo], b = arr[hi];
  if (a == null) return b; if (b == null) return a;
  return a + ((b - a) * (t - S[lo].t)) / (S[hi].t - S[lo].t);
};
const lowerIdx = (S, t) => { let lo = 0, hi = S.length; while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].t < t) lo = m + 1; else hi = m; } return lo; };

/** Per-lap statistics between consecutive boundaries. */
export function lapStats(S, bounds, used, plan) {
  const laps = [], whArr = S.map((s) => s._whInt);
  for (let n = 1; n < bounds.length; n++) {
    const ta = bounds[n - 1].t, tb = bounds[n].t;
    const a = lowerIdx(S, ta), z = lowerIdx(S, tb);
    const acc = { i: [0, 0], v: [0, 0], spd: [0, 0], gspd: [0, 0], rpm: [0, 0], thr: [0, 0] };
    let minV = null, peakI = null, peakW = null, maxT = null, dist = 0, prevFix = null, ll = null;
    for (let k = a; k < z; k++) {
      const s = S[k];
      for (const f in acc) if (s[f] != null) { acc[f][0] += s[f]; acc[f][1]++; }
      if (s.v != null) minV = minV == null ? s.v : Math.min(minV, s.v);
      if (s.i != null) peakI = peakI == null ? s.i : Math.max(peakI, s.i);
      if (s.pw != null) peakW = peakW == null ? s.pw : Math.max(peakW, s.pw);
      if (s.t1 != null) maxT = maxT == null ? s.t1 : Math.max(maxT, s.t1);
      if (hasFix(s)) { if (prevFix && (s.lat !== prevFix.lat || s.lon !== prevFix.lon)) dist += distM(prevFix, s); prevFix = s; }
    }
    for (let k = z; k < Math.min(S.length, z + 3); k++) if (S[k].ll) { ll = S[k].ll; break; }
    const avg = (f) => (acc[f][1] ? acc[f][0] / acc[f][1] : null);
    const ah = used ? lerpAt(S, used, tb) - lerpAt(S, used, ta) : null;
    const wh = lerpAt(S, whArr, tb) - lerpAt(S, whArr, ta);
    laps.push({
      n, ta, tb, dur: tb - ta, ah, ahDelta: ah != null && plan ? ah - plan.perLap : null,
      avgI: avg('i'), avgV: avg('v'), minV, avgSpd: avg('spd'), avgGspd: avg('gspd'), avgRpm: avg('rpm'), avgThr: avg('thr'),
      peakI, peakW, maxT, wh, dist, samples: z - a, device: ll,
    });
  }
  return laps;
}

// ---------- whole-session analysis ----------
/**
 * opts: { plan, raceStart (ms|null), pick: 'latest'|'longest', lapSource: 'auto'|'counter'|'gps', gate, nowT, bandAh }
 */
export function analyze(S, opts) {
  const res = { runs: [], i0: null, i1: null, t0: null, bounds: [], laps: [], lapSource: null, gate: null, used: null, cap: null };
  if (!S.length) return res;
  const nowIdx = opts.nowT == null ? S.length - 1 : Math.max(0, lowerIdx(S, opts.nowT + 1) - 1);
  res.runs = detectRuns(S.slice(0, nowIdx + 1));
  let i0;
  if (opts.raceStart != null && opts.raceStart >= S[0].t && opts.raceStart <= S[nowIdx].t) i0 = lowerIdx(S, opts.raceStart);
  else if (res.runs.length) {
    const r = opts.pick === 'longest' ? res.runs.reduce((a, b) => (b.dur > a.dur ? b : a)) : res.runs[res.runs.length - 1];
    i0 = r.i0;
  } else i0 = null;
  if (i0 == null) return res;
  const run = res.runs.find((r) => r.i0 <= i0 && i0 <= r.i1);
  const i1 = opts.pick === 'longest' && run && opts.raceStart == null ? Math.min(nowIdx, run.i1 + 30) : nowIdx;
  Object.assign(res, { i0, i1, t0: S[i0].t });
  res.used = usedAhSeries(S, i0);

  const counter = counterBoundaries(S, i0, i1);
  const gate = opts.gate || autoGate(S, i0, i1);
  const useCounter = opts.lapSource === 'counter' || (opts.lapSource !== 'gps' && counter.length >= 2);
  res.gate = gate;
  if (useCounter) { res.bounds = [{ k: i0, t: S[i0].t, src: 'start' }, ...counter]; res.lapSource = 'counter'; }
  else {
    let b = gpsBoundaries(S, i0, i1, gate);
    // If the car starts at the gate (normal for a race start), the start itself begins lap 1.
    let f = i0; while (f <= i1 && !hasFix(S[f]) && S[f].t - S[i0].t < 30e3) f++;
    if (gate && f <= i1 && hasFix(S[f]) && distM(S[f], gate) < 30) {
      b = b.filter((x) => x.t - S[i0].t > 20e3);
      b.unshift({ k: i0, t: S[i0].t, src: 'start' });
    }
    res.bounds = b; res.lapSource = 'gps';
  }
  res.laps = lapStats(S, res.bounds, res.used, opts.plan);
  res.cap = capacity(S, res, opts.plan, i1, opts.bandAh ?? 0.2);
  return res;
}

export function capacity(S, res, plan, k, band) {
  const s = S[k], elapsed = s.t - res.t0, used = res.used[k] ?? 0;
  const ideal = plan.perMs * elapsed, delta = used - ideal;
  const remainingMs = Math.max(0, plan.raceLenMs - elapsed);
  // recent consumption: last 5 minutes
  let j = k; while (j > res.i0 && s.t - S[j - 1].t <= 5 * 60e3) j--;
  const span = s.t - S[j].t;
  const recentA = span > 30e3 ? (((res.used[k] ?? 0) - (res.used[j] ?? 0)) / span) * 3.6e6 : null;
  const lapsDone = res.laps.length;
  const lastLapEnd = lapsDone ? res.laps[lapsDone - 1].tb : null;
  const usedAtLap = lastLapEnd != null ? lerpAt(S, res.used, lastLapEnd) - (res.bounds[0] ? lerpAt(S, res.used, res.bounds[0].t) : 0) : null;
  return {
    elapsed, used, ideal, delta, remainingMs, recentA,
    call: delta > band ? 'slow' : delta < -band ? 'push' : 'hold',
    targetRestA: remainingMs > 60e3 ? ((plan.targetAh - used) / remainingMs) * 3.6e6 : null,
    projected: recentA != null ? used + (recentA * remainingMs) / 3.6e6 : null,
    lapsDone, idealByLaps: lapsDone * plan.perLap, deltaByLaps: usedAtLap != null ? usedAtLap - lapsDone * plan.perLap : null,
    pctUsed: used / plan.targetAh,
  };
}

/** The team's reference method: laps completed in a race, average lap time, Ah per lap / s / ms. */
export function referenceFrom(S, targetAh = 20) {
  const res = analyze(S, { plan: makePlan({ targetAh }), pick: 'longest', lapSource: 'auto' });
  const laps = res.laps.length;
  if (!laps) return { ok: false, res };
  const avgLapMs = (res.bounds[res.bounds.length - 1].t - res.bounds[0].t) / laps;
  const usedTotal = res.used[res.i1] ?? null;
  return { ok: true, res, laps, avgLapMs, perLap: targetAh / laps, perS: targetAh / laps / (avgLapMs / 1e3), perMs: targetAh / laps / avgLapMs, usedTotal };
}
