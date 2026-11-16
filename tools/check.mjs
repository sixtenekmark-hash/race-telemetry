// Sanity checks for public/js/model.js against real logs.
// Usage: node tools/check.mjs <eChook CSV/TSV export> [<history JSON from the API>]
import { readFileSync } from 'node:fs';
import * as M from '../public/js/model.js';

const [csvPath, jsonPath] = process.argv.slice(2);
const fmt = (ms) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, '0')}`;

if (csvPath) {
  const S = M.prepare(M.parseCsv(readFileSync(csvPath, 'utf8')));
  const ref = M.referenceFrom(S, 20);
  console.log(`CSV: ${S.length} samples, runs: ${ref.res.runs.map((r) => fmt(r.dur)).join(', ')}`);
  console.log(`lap source ${ref.res.lapSource}, laps completed ${ref.laps}, avg lap ${(ref.avgLapMs / 1000).toFixed(3)} s`);
  console.log(`lap times: ${ref.res.laps.map((l) => (l.dur / 1000).toFixed(0)).join(' ')}`);
  console.log(`Ah per lap ${ref.perLap.toFixed(4)}  Ah/s ${ref.perS.toExponential(5)}  Ah/ms ${ref.perMs.toExponential(5)}  ideal current ${(ref.perMs * 3.6e6).toFixed(2)} A`);
  console.log(`Ah used in race window ${ref.usedTotal?.toFixed(2)}, logged final ${S[S.length - 1].ah}`);
  console.log(`lap Ah: ${ref.res.laps.map((l) => l.ah.toFixed(2)).join(' ')}`);
  // Pace indicator over the race with the plan derived from this race
  const plan = M.makePlan({ targetAh: 20, refLaps: ref.laps, refLapMs: ref.avgLapMs });
  const line = [];
  for (let m = 5; m <= 85; m += 5) {
    const r = M.analyze(S, { plan, pick: 'longest', nowT: S[0].t + m * 60e3 });
    if (r.cap) line.push(`${m}m:${r.cap.delta >= 0 ? '+' : ''}${r.cap.delta.toFixed(2)}`);
  }
  console.log('delta vs plan:', line.join(' '));
}

if (jsonPath) {
  const S = M.prepare(JSON.parse(readFileSync(jsonPath, 'utf8')).map(M.fromPacket));
  const plan = M.makePlan({ targetAh: 20, refLaps: 33, refLapMs: 149085 });
  const r = M.analyze(S, { plan, pick: 'longest' });
  const durs = r.laps.map((l) => l.dur / 1000).sort((a, b) => a - b);
  console.log(`\nJSON: ${S.length} samples, runs ${r.runs.length} (${r.runs.map((x) => fmt(x.dur)).join(', ')})`);
  console.log(`lap source ${r.lapSource}, laps ${r.laps.length}, median lap ${durs[durs.length >> 1]?.toFixed(1)} s, used ${r.used[r.i1]?.toFixed(2)} Ah`);
  const g = M.analyze(S, { plan, pick: 'longest', lapSource: 'gps' });
  const gd = g.laps.map((l) => l.dur / 1000).sort((a, b) => a - b);
  console.log(`GPS-gate laps for comparison: ${g.laps.length}, median ${gd[gd.length >> 1]?.toFixed(1)} s`);
  const last = r.laps[r.laps.length - 1];
  console.log('last lap:', JSON.stringify(last, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
  const gs = S.filter((s) => s.gspd != null && s.spd != null && s.spd > 3);
  const ratio = gs.reduce((a, s) => a + s.gspd / s.spd, 0) / gs.length;
  console.log(`GPS speed / wheel speed (moving) mean ratio ${ratio.toFixed(3)} over ${gs.length} samples`);
}

// Live path: packets arrive one by one (as from the socket) and must give the same result as a batch load.
if (jsonPath) {
  const rows = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const plan = M.makePlan({ targetAh: 20, refLaps: 33, refLapMs: 149085 });
  const batch = M.analyze(M.prepare(rows.map(M.fromPacket)), { plan, pick: 'latest' });
  const S = [];
  let t = performance.now(), renders = 0;
  for (const p of rows) {
    const s = M.fromPacket(p);
    S.push(s); M.derive(S, S.length - 1);
    if (S.length % 50 === 0) { M.analyze(S, { plan, pick: 'latest' }); renders++; }
  }
  const per = (performance.now() - t) / renders;
  const inc = M.analyze(S, { plan, pick: 'latest' });
  const same = (a, b) => Math.abs(a - b) < 1e-9;
  console.log(`\nincremental vs batch: laps ${inc.laps.length}/${batch.laps.length}, used ${inc.cap.used.toFixed(4)}/${batch.cap.used.toFixed(4)}, ` +
    `delta ${inc.cap.delta.toFixed(4)}/${batch.cap.delta.toFixed(4)}, gps speed equal: ${S.every((s, i) => same(s.gspd ?? -1, M.prepare(rows.map(M.fromPacket))[i]?.gspd ?? -1)) ? 'yes' : 'NO'}`);
  console.log(`analysis time per render with up to ${S.length} packets: ${per.toFixed(1)} ms`);
}
