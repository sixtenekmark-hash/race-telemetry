// Interactive track map (Leaflet): satellite or street map, zoom and pan, the race trace, the current lap,
// the start/finish line and the car. Click the trace to see the readings at that point.
/* global L */
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class LiveMap {
  constructor(el, { describe } = {}) {
    this.el = el; this.describe = describe; this.map = null; this.follow = false; this.fitted = false; this.pts = [];
  }
  ensure() {
    if (this.map || typeof L === 'undefined') return !!this.map;
    const map = L.map(this.el, { zoomControl: true, attributionControl: true, preferCanvas: true });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri' });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' });
    sat.addTo(map);
    L.control.layers({ Satellite: sat, Map: osm }, null, { position: 'topright' }).addTo(map);
    this.trace = L.polyline([], { color: '#c3c2b7', weight: 3, opacity: 0.75 }).addTo(map);
    this.lap = L.polyline([], { color: cssVar('--s1') || '#3987e5', weight: 4.5 }).addTo(map);
    this.gate = L.polyline([], { color: '#ffffff', weight: 3, dashArray: '6 5' }).addTo(map);
    this.car = L.circleMarker([0, 0], { radius: 8, color: '#ffffff', weight: 2.5, fillColor: '#eb6834', fillOpacity: 1 });
    const pick = (e) => this.pick(e.latlng);
    this.trace.on('click', pick); this.lap.on('click', pick);
    // "Follow car" and "Whole track" buttons
    const Ctl = L.Control.extend({
      onAdd: () => {
        const box = L.DomUtil.create('div', 'leaflet-bar mapbtns');
        box.innerHTML = '<a href="#" data-a="fit" title="Show the whole track">⤢</a><a href="#" data-a="follow" title="Follow the car">◎</a>';
        L.DomEvent.disableClickPropagation(box);
        box.addEventListener('click', (ev) => {
          ev.preventDefault();
          const a = ev.target.closest('[data-a]')?.dataset.a;
          if (a === 'fit') { this.follow = false; this.fit(); }
          if (a === 'follow') { this.follow = !this.follow; if (this.follow) this.panToCar(); }
          box.querySelector('[data-a="follow"]').classList.toggle('on', this.follow);
        });
        return box;
      },
    });
    new Ctl({ position: 'topleft' }).addTo(map);
    map.on('dragstart', () => { this.follow = false; this.el.querySelector('[data-a="follow"]')?.classList.remove('on'); });
    this.map = map;
    return true;
  }
  /** pts: samples with lat/lon (in time order); lapFrom: time the current lap began; gate: {lat,lon,hx,hy} */
  update(pts, lapFrom, gate) {
    if (!this.ensure()) return false;
    this.map.invalidateSize(false);
    this.pts = pts;
    const ll = pts.map((p) => [p.lat, p.lon]);
    this.trace.setLatLngs(ll);
    this.lap.setLatLngs(lapFrom == null ? [] : pts.filter((p) => p.t >= lapFrom).map((p) => [p.lat, p.lon]));
    if (gate) {
      const kx = Math.cos((gate.lat * Math.PI) / 180), half = 25 / 110540;
      const nx = -gate.hy, ny = gate.hx;
      this.gate.setLatLngs([[gate.lat + ny * half, gate.lon + (nx * half) / kx], [gate.lat - ny * half, gate.lon - (nx * half) / kx]]);
    } else this.gate.setLatLngs([]);
    if (pts.length) {
      const c = pts[pts.length - 1];
      this.car.setLatLng([c.lat, c.lon]);
      if (!this.map.hasLayer(this.car)) this.car.addTo(this.map);
      if (!this.fitted) { this.fit(); this.fitted = true; } else if (this.follow) this.panToCar();
    }
    return true;
  }
  fit() { if (this.pts.length > 1) this.map.fitBounds(this.trace.getBounds(), { padding: [20, 20], maxZoom: 19 }); else if (this.pts.length) this.map.setView([this.pts[0].lat, this.pts[0].lon], 17); }
  panToCar() { if (this.pts.length) this.map.panTo(this.car.getLatLng(), { animate: false }); }
  pick(latlng) {
    let best = null, bd = Infinity;
    for (const p of this.pts) { const d = (p.lat - latlng.lat) ** 2 + (p.lon - latlng.lng) ** 2; if (d < bd) { bd = d; best = p; } }
    if (best && this.describe) L.popup().setLatLng([best.lat, best.lon]).setContent(this.describe(best)).openOn(this.map);
  }
  resetView() { this.fitted = false; }
}
