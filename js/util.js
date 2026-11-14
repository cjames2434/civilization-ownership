/* Shared helpers: HTTP, dates, money, area, geometry conversion. */
'use strict';

const U = {};

/* ---------- HTTP ---------- */

U.fetchJSON = async function (url, { signal, timeout = 30000, method = 'GET', body = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeout);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  try {
    const opts = { signal: ctrl.signal, method };
    if (body) {
      opts.body = body;
      opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    }
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    const text = await res.text();
    const json = JSON.parse(text);
    if (json && json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json;
  } finally {
    clearTimeout(timer);
  }
};

U.qs = function (params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v))
    .join('&');
};

/* GET when the URL is short enough, POST otherwise (ArcGIS accepts both). */
U.arcgis = function (layerUrl, op, params, opts = {}) {
  const q = U.qs({ ...params, f: params.f || 'json' });
  const url = `${layerUrl}/${op}`;
  if (url.length + q.length < 1900) return U.fetchJSON(`${url}?${q}`, opts);
  return U.fetchJSON(url, { ...opts, method: 'POST', body: q });
};

/* ---------- Text ---------- */

U.esc = function (s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};

U.clean = function (v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || /^(null|none|n\/a|unknown|0+)$/i.test(s)) return null;
  return s;
};

/* Collapse whitespace; title-case names that arrive in ALL CAPS. */
U.name = function (v) {
  const s = U.clean(v);
  if (!s) return null;
  return s.replace(/\s+/g, ' ');
};

U.splitNames = function (s, sep = /\s*;\s*/) {
  const c = U.clean(s);
  return c ? c.split(sep).map(U.name).filter(Boolean) : [];
};

/* ---------- Dates ---------- */

function validYMD(y, m, d) {
  if (y < 1600 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt : null;
}

function fromExcelSerial(n) {
  // Excel day 0 = 1899-12-30
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000);
}

/**
 * Parse the many date formats public records use.
 * hint: 'yymmdd' | 'yyyymmdd' | 'excel' | 'epoch' | undefined (auto)
 * Returns a Date (UTC midnight) or null.
 */
U.parseDate = function (v, hint) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;

  if (typeof v === 'number') {
    if (hint === 'epoch') return new Date(v);
    if (hint === 'excel' || (v > 10000 && v < 80000)) return fromExcelSerial(v);
    if (v >= 16000101 && v <= 22001231) {
      const s = String(Math.trunc(v));
      return validYMD(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    }
    if (Math.abs(v) > 1e9) return new Date(v); // epoch milliseconds (ArcGIS dates)
    return null;
  }

  let s = String(v).trim();
  if (!s || /^0+([.\-/]0+)*$/.test(s) || /^null$/i.test(s)) return null;

  let m;
  if ((m = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/))) return validYMD(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return validYMD(+m[3], +m[1], +m[2]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/))) {
    const yy = +m[3];
    return validYMD(yy > (new Date().getFullYear() % 100) ? 1900 + yy : 2000 + yy, +m[1], +m[2]);
  }
  if (/^\d{8}$/.test(s) && hint !== 'mmddyyyy') return validYMD(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
  if (/^\d{8}$/.test(s)) return validYMD(+s.slice(4, 8), +s.slice(0, 2), +s.slice(2, 4));
  if (/^\d{6}$/.test(s)) {
    if (hint === 'yyyymm') return validYMD(+s.slice(0, 4), +s.slice(4, 6), 1);
    const yy = +s.slice(0, 2);
    const year = yy > (new Date().getFullYear() % 100) ? 1900 + yy : 2000 + yy;
    return validYMD(year, +s.slice(2, 4), +s.slice(4, 6));
  }
  if (/^\d{5}$/.test(s)) return fromExcelSerial(+s);
  if (/^\d{4}$/.test(s)) return validYMD(+s, 1, 1);
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
};

U.fmtDate = function (d) {
  if (!d) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

U.dayKey = function (d) {
  return d ? d.toISOString().slice(0, 10) : 'nodate';
};

/* ---------- Money ---------- */

U.parseMoney = function (v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : null;
};

U.fmtMoney = function (n) {
  if (n === null || n === undefined) return null;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
};

/* ---------- Area ---------- */

const R_EARTH = 6378137;
const rad = (d) => (d * Math.PI) / 180;

/* Signed spherical area (m²) of a ring of [lng, lat] points. */
function ringArea(ring) {
  let area = 0;
  const n = ring.length;
  if (n < 3) return 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    area += (rad(p2[0]) - rad(p1[0])) * (2 + Math.sin(rad(p1[1])) + Math.sin(rad(p2[1])));
  }
  return (area * R_EARTH * R_EARTH) / 2;
}

/* Area in m² of a GeoJSON Polygon / MultiPolygon geometry. */
U.geomArea = function (geom) {
  if (!geom) return 0;
  const poly = (rings) => rings.reduce((acc, r, i) => acc + (i === 0 ? Math.abs(ringArea(r)) : -Math.abs(ringArea(r))), 0);
  if (geom.type === 'Polygon') return Math.max(0, poly(geom.coordinates));
  if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((a, p) => a + Math.max(0, poly(p)), 0);
  return 0;
};

U.SQM_PER_ACRE = 4046.8564224;

U.fmtArea = function (acres) {
  if (acres === null || acres === undefined || !isFinite(acres) || acres <= 0) return null;
  const sqft = acres * 43560;
  if (acres >= 640) {
    return `${(acres / 640).toLocaleString('en-US', { maximumFractionDigits: 2 })} sq mi (${Math.round(acres).toLocaleString('en-US')} acres)`;
  }
  if (acres >= 1) {
    return `${acres.toLocaleString('en-US', { maximumFractionDigits: 2 })} acres (${Math.round(sqft).toLocaleString('en-US')} sq ft)`;
  }
  return `${Math.round(sqft).toLocaleString('en-US')} sq ft (${acres.toLocaleString('en-US', { maximumFractionDigits: 3 })} acres)`;
};

/* ---------- Geometry ---------- */

/* Esri JSON polygon rings → GeoJSON MultiPolygon (each ring kept; holes detected by orientation). */
U.esriToGeoJSON = function (g) {
  if (!g || !g.rings) return null;
  const outers = [];
  const holes = [];
  for (const ring of g.rings) {
    // Esri: outer rings are clockwise, which gives a POSITIVE value with this formula; holes are counter-clockwise
    (ringArea(ring) > 0 ? outers : holes).push(ring);
  }
  if (!outers.length) return { type: 'Polygon', coordinates: g.rings };
  const polys = outers.map((o) => [o]);
  for (const h of holes) {
    const pt = h[0];
    const host = polys.find((p) => U.pointInRing(pt, p[0])) || polys[0];
    host.push(h);
  }
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
};

U.pointInRing = function (pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

U.pointInGeom = function (pt, geom) {
  const inPoly = (rings) => U.pointInRing(pt, rings[0]) && !rings.slice(1).some((h) => U.pointInRing(pt, h));
  if (geom.type === 'Polygon') return inPoly(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(inPoly);
  return false;
};

U.geomBBox = function (geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return [w, s, e, n];
};

U.bboxIntersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
U.bboxContains = (b, pt) => pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3];

/* ---------- US state lookup (from bundled outlines) ---------- */

U.states = (window.US_STATES && window.US_STATES.features) || [];
U.states.forEach((f) => (f.bbox = U.geomBBox(f.geometry)));

U.stateAt = function (lng, lat) {
  const pt = [lng, lat];
  return U.states.find((f) => U.bboxContains(f.bbox, pt) && U.pointInGeom(pt, f.geometry))?.properties || null;
};

U.stateBBox = function (abbr) {
  return U.states.find((f) => f.properties.abbr === abbr)?.bbox || null;
};

U.stateName = function (abbr) {
  return U.states.find((f) => f.properties.abbr === abbr)?.properties.name || abbr;
};
