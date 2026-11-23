// Shared race state for every device that has the Car ID: race start, manual laps, race class, ideal model.
// Small events are relayed through ntfy.sh (free, no account, keeps messages for 12 hours). The channel name is
// a one-way hash of the Car ID, so only devices with the Car ID find it, and the Car ID itself is never sent.
// No telemetry goes through it. Every device replays the events, so a page or device that was closed catches up.
const BASE = 'https://ntfy.sh/';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

async function topicFor(carId) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('race-telemetry-sync|' + carId));
  return 'rt' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

export function createSync(onChange) {
  const device = Math.random().toString(36).slice(2, 8);
  const state = { start: null, laps: [], cls: null, model: null, status: 'off', ready: false };
  let topic = null, events = [], seen = new Set(), es = null, pending = [], lastId = null, lastAt = 0, retry = null;

  const cacheKey = () => 'et.sync.' + topic;
  function reduce() {
    events.sort((a, b) => a.at - b.at || (a.eid < b.eid ? -1 : 1));
    let start = null, laps = [], cls = null, model = null;
    for (const e of events) {
      if (e.k === 'start') { start = e.t ?? null; laps = []; }
      else if (e.k === 'lap') { if (!laps.some((l) => l.id === e.eid)) laps.push({ id: e.eid, t: e.t }); }
      else if (e.k === 'unlap') laps = laps.filter((l) => l.id !== e.id);
      else if (e.k === 'autolaps') laps = [];
      else if (e.k === 'class') cls = e.v;
      else if (e.k === 'model') model = e.v;
    }
    Object.assign(state, { start, laps: laps.sort((a, b) => a.t - b.t), cls, model });
    store.set(cacheKey(), events.filter((e) => e.at > Date.now() - 12 * 3600e3));
    onChange(state);
  }
  function add(e) {
    if (!e || typeof e !== 'object' || !e.eid || seen.has(e.eid)) return false;
    seen.add(e.eid); events.push(e); return true;
  }
  function fromMessage(m) {
    if (!m || m.event !== 'message') return null;
    lastId = m.id;
    try { return JSON.parse(m.message); } catch { return null; }
  }
  const setStatus = (s) => { if (state.status !== s) { state.status = s; onChange(state); } };

  async function flush() {
    while (pending.length) {
      try {
        const r = await fetch(BASE + topic, { method: 'POST', body: JSON.stringify(pending[0]) });
        if (!r.ok) throw new Error(r.status);
        pending.shift(); setStatus('ok');
      } catch { setStatus('offline'); return; }
    }
  }
  function listen() {
    if (es) es.close();
    es = new EventSource(BASE + topic + '/sse' + (lastId ? '?since=' + lastId : ''));
    es.onopen = () => { setStatus('ok'); flush(); };
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (add(fromMessage(m))) reduce();
    };
    es.onerror = () => setStatus('offline'); // EventSource reconnects by itself
  }

  return {
    state,
    async start(carId) {
      topic = await topicFor(carId);
      events = []; seen = new Set();
      for (const e of store.get(cacheKey(), [])) add(e);
      setStatus('connecting');
      try {
        const r = await fetch(BASE + topic + '/json?poll=1&since=12h');
        for (const line of (await r.text()).split('\n')) {
          if (!line.trim()) continue;
          try { add(fromMessage(JSON.parse(line))); } catch { /* skip */ }
        }
        state.status = 'ok';
      } catch { state.status = 'offline'; }
      state.ready = true;
      reduce();
      listen();
      clearInterval(retry);
      retry = setInterval(() => { if (pending.length) flush(); }, 10000);
    },
    /** Apply at once on this device, then share. */
    publish(e) {
      e.eid = `${device}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      e.at = lastAt = Math.max(Date.now(), lastAt + 1); // keep this device's events in the order they were made
      add(e); reduce();
      if (!topic) return;
      pending.push(e); flush();
    },
  };
}
