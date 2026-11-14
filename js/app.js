/* Civilization Ownership — interactive U.S. land ownership map. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const INSPECT_MIN_ZOOM = 12;

/* ======================= Map setup ======================= */

const map = L.map('map', { zoomControl: false, preferCanvas: true, worldCopyJump: true, minZoom: 3, maxZoom: 21 });
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: true, metric: false }).addTo(map);

const basemaps = {
  satellite: L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 21,
      maxNativeZoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, opacity: 0.6 }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19 }),
  ]),
  streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 21,
    maxNativeZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }),
};
let basemapName = 'satellite';
basemaps.satellite.addTo(map);

const parcelRenderer = L.canvas({ padding: 0.3, tolerance: 3 });
const lineColor = () => (basemapName === 'satellite' ? '#ffd23f' : '#c2410c');

/* ======================= Coverage (low zoom) ======================= */

function stateLevel(abbr) {
  const order = ['history', 'sales', 'owner', 'lines'];
  const lv = SOURCES.filter((s) => s.states && s.states.includes(abbr)).map((s) => s.level);
  return order.find((l) => lv.includes(l)) || 'none';
}

const coverageLayer = L.geoJSON(window.US_STATES, {
  interactive: true,
  style: (f) => ({
    color: '#ffffff',
    weight: 1,
    fillColor: LEVELS[stateLevel(f.properties.abbr)].color,
    fillOpacity: 0.55,
  }),
  onEachFeature: (f, layer) => {
    const lv = stateLevel(f.properties.abbr);
    const cities = SOURCES.filter((s) => s.counties && U.stateAt((s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2)?.abbr === f.properties.abbr);
    layer.bindTooltip(
      `<strong>${U.esc(f.properties.name)}</strong><br>${LEVELS[lv].label}` +
        (cities.length ? `<br><em>Plus ${cities.map((c) => U.esc(c.region)).join(', ')}: ${LEVELS[cities[0].level].label.toLowerCase()}</em>` : ''),
      { sticky: true, direction: 'top', className: 'tip' }
    );
  },
});

const cityMarkers = L.layerGroup(
  SOURCES.filter((s) => s.counties).map((s) =>
    L.circleMarker([(s.bbox[1] + s.bbox[3]) / 2, (s.bbox[0] + s.bbox[2]) / 2], {
      radius: 7,
      color: '#fff',
      weight: 2,
      fillColor: LEVELS[s.level].color,
      fillOpacity: 1,
    }).bindTooltip(`<strong>${U.esc(s.region)}</strong><br>${LEVELS[s.level].label}`, { direction: 'top', className: 'tip' })
  )
);

let showCoverage = true;
function updateCoverageVisibility() {
  const z = map.getZoom();
  const on = showCoverage && z < 9;
  for (const l of [coverageLayer, cityMarkers]) {
    if (on && !map.hasLayer(l)) l.addTo(map);
    if (!on && map.hasLayer(l)) map.removeLayer(l);
  }
  coverageLayer.setStyle((f) => ({ fillOpacity: z <= 5 ? 0.55 : 0.35 }));
  $('#legend').classList.toggle('hidden', !on);
}

/* ======================= Public lands (PAD-US) ======================= */

const PAD_COLORS = { FED: '#2f7d32', STAT: '#1e6fb8', LOC: '#8b5cf6', TRIB: '#b45309', NGO: '#0f766e', PVT: '#9ca3af', DIST: '#64748b', JNT: '#0e7490', UNK: '#9ca3af' };
let padDomains = null;
async function loadPadDomains() {
  if (padDomains) return padDomains;
  try {
    const meta = await U.fetchJSON(`${PADUS.url}?f=json`);
    padDomains = {};
    for (const f of meta.fields) if (f.domain && f.domain.codedValues) padDomains[f.name] = Object.fromEntries(f.domain.codedValues.map((c) => [c.code, c.name]));
  } catch {
    padDomains = {};
  }
  return padDomains;
}
const padDecode = (field, code) => (padDomains && padDomains[field] && padDomains[field][code]) || code;

const publicLandsLayer = L.geoJSON(null, {
  renderer: parcelRenderer,
  interactive: false,
  style: (f) => ({ color: PAD_COLORS[f.properties.Mang_Type] || '#2f7d32', weight: 1, fillOpacity: 0.18, fillColor: PAD_COLORS[f.properties.Mang_Type] || '#2f7d32' }),
});
let showPublic = true;
let padCtrl = null;

async function refreshPublicLands() {
  if (padCtrl) padCtrl.abort();
  const z = map.getZoom();
  if (!showPublic || z < 9) {
    publicLandsLayer.clearLayers();
    if (map.hasLayer(publicLandsLayer)) map.removeLayer(publicLandsLayer);
    return;
  }
  if (!map.hasLayer(publicLandsLayer)) publicLandsLayer.addTo(map);
  padCtrl = new AbortController();
  const b = map.getBounds();
  const degPerPx = (b.getEast() - b.getWest()) / map.getSize().x;
  try {
    const gj = await U.arcgis(
      PADUS.url,
      'query',
      {
        where: "FeatClass='Fee'",
        geometry: { xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth(), spatialReference: { wkid: 4326 } },
        geometryType: 'esriGeometryEnvelope',
        inSR: 4326,
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'Mang_Type',
        returnGeometry: true,
        outSR: 4326,
        maxAllowableOffset: degPerPx * 1.5,
        geometryPrecision: 5,
        resultRecordCount: 2000,
        f: 'geojson',
      },
      { signal: padCtrl.signal, timeout: 40000 }
    );
    publicLandsLayer.clearLayers();
    publicLandsLayer.addData(gj);
    publicLandsLayer.bringToBack();
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('PAD-US', e);
  }
}

/* ======================= Parcel boundaries ======================= */

const parcelLayers = {}; // id -> L.GeoJSON or L.ImageOverlay
let parcelCtrl = null;

function visibleSources() {
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const z = map.getZoom();
  return SOURCES.filter((s) => z >= s.minZoom && U.bboxIntersects(s.bbox, view));
}

async function loadVector(src, signal) {
  const b = map.getBounds();
  const degPerPx = (b.getEast() - b.getWest()) / map.getSize().x;
  const features = [];
  if (src.type === 'carto') {
    const sql = `SELECT cartodb_id, the_geom FROM ${src.table} WHERE the_geom && ST_MakeEnvelope(${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()},4326) LIMIT 4000`;
    const gj = await U.fetchJSON(`https://phl.carto.com/api/v2/sql?format=GeoJSON&q=${encodeURIComponent(sql)}`, { signal, timeout: 40000 });
    return gj.features || [];
  }
  let offset = 0;
  for (let page = 0; page < 8; page++) {
    const gj = await U.arcgis(
      src.url,
      'query',
      {
        geometry: { xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth(), spatialReference: { wkid: 4326 } },
        geometryType: 'esriGeometryEnvelope',
        inSR: 4326,
        spatialRel: 'esriSpatialRelIntersects',
        returnGeometry: true,
        outSR: 4326,
        maxAllowableOffset: degPerPx * 0.5,
        geometryPrecision: 6,
        resultOffset: offset || undefined,
        f: 'geojson',
      },
      { signal, timeout: 40000 }
    );
    const got = gj.features || [];
    features.push(...got);
    const more = gj.exceededTransferLimit || (gj.properties && gj.properties.exceededTransferLimit);
    if (!more || !got.length) break;
    offset += got.length;
  }
  return features;
}

function imageOverlay(src) {
  const b = map.getBounds();
  const size = map.getSize();
  const sw = map.options.crs.project(b.getSouthWest());
  const ne = map.options.crs.project(b.getNorthEast());
  const url =
    `${src.url}/export?` +
    U.qs({
      bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
      bboxSR: 3857,
      imageSR: 3857,
      size: `${size.x},${size.y}`,
      layers: `show:${src.layerId}`,
      format: 'png32',
      transparent: true,
      dpi: 96,
      f: 'image',
    });
  return L.imageOverlay(url, b, { opacity: 0.85, interactive: false });
}

async function refreshParcels() {
  if (parcelCtrl) parcelCtrl.abort();
  parcelCtrl = new AbortController();
  const { signal } = parcelCtrl;
  const active = visibleSources();
  const activeIds = new Set(active.map((s) => s.id));

  for (const id of Object.keys(parcelLayers)) {
    if (!activeIds.has(id)) {
      map.removeLayer(parcelLayers[id]);
      delete parcelLayers[id];
    }
  }
  updateHint(active);
  if (!active.length) return;

  setBusy('lines', true);
  await Promise.allSettled(
    active.map(async (src) => {
      try {
        if (src.draw === 'image') {
          const next = imageOverlay(src);
          next.once('load', () => {
            if (signal.aborted) return map.removeLayer(next);
            if (parcelLayers[src.id] && parcelLayers[src.id] !== next) map.removeLayer(parcelLayers[src.id]);
            parcelLayers[src.id] = next;
          });
          next.addTo(map);
          return;
        }
        const features = await loadVector(src, signal);
        if (signal.aborted) return;
        const layer = L.geoJSON({ type: 'FeatureCollection', features }, {
          renderer: parcelRenderer,
          interactive: false,
          style: { color: lineColor(), weight: 1.2, opacity: 0.95, fill: false },
        });
        if (parcelLayers[src.id]) map.removeLayer(parcelLayers[src.id]);
        parcelLayers[src.id] = layer.addTo(map);
        if (selectedLayer) selectedLayer.bringToFront();
      } catch (e) {
        if (e.name !== 'AbortError' && !signal.aborted) {
          console.warn(src.id, e);
          toast(`${src.name} didn’t send property lines (${e.message}). Clicking still works.`);
        }
      }
    })
  );
  if (!signal.aborted) setBusy('lines', false);
}

function restyleParcels() {
  for (const l of Object.values(parcelLayers)) if (l.setStyle) l.setStyle({ color: lineColor() });
}

/* ======================= Hint / status ======================= */

function updateHint(active) {
  const z = map.getZoom();
  const hint = $('#hint');
  const center = map.getCenter();
  const here = SOURCES.filter((s) => U.bboxContains(s.bbox, [center.lng, center.lat]));
  let msg;
  if (z < INSPECT_MIN_ZOOM) msg = 'Zoom in or search an address. Click the map to zoom closer.';
  else if (!here.length) msg = 'No free parcel data here. Click to see public land and county records.';
  else if (!active.length) msg = 'Zoom in a little more to see property lines.';
  else msg = 'Click any piece of land to see its owner and history.';
  hint.textContent = msg;
}

const busy = new Set();
function setBusy(key, on) {
  on ? busy.add(key) : busy.delete(key);
  $('#spinner').classList.toggle('hidden', busy.size === 0);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 6000);
}

/* ======================= Inspecting a point ======================= */

let selectedLayer = null;
let pinMarker = null;
let inspectCtrl = null;
let selectedPoint = null;

async function lookupCounty(lng, lat, signal) {
  try {
    const j = await U.arcgis(
      COUNTIES_URL,
      'query',
      {
        geometry: { x: lng, y: lat, spatialReference: { wkid: 4326 } },
        geometryType: 'esriGeometryPoint',
        inSR: 4326,
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'NAME,BASENAME,STATE,COUNTY,GEOID',
        returnGeometry: false,
      },
      { signal, timeout: 15000 }
    );
    return j.features && j.features[0] ? j.features[0].attributes : null;
  } catch {
    return null;
  }
}

async function lookupPublicLand(lng, lat, signal) {
  try {
    await loadPadDomains();
    const j = await U.arcgis(
      PADUS.url,
      'query',
      {
        where: "FeatClass IN ('Fee','Easement')",
        geometry: { x: lng, y: lat, spatialReference: { wkid: 4326 } },
        geometryType: 'esriGeometryPoint',
        inSR: 4326,
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'FeatClass,Unit_Nm,Loc_Nm,Own_Type,Own_Name,Loc_Own,Mang_Type,Mang_Name,Loc_Mang,Des_Tp,GIS_Acres,Date_Est,Pub_Access,EsmtHldr',
        returnGeometry: false,
      },
      { signal, timeout: 20000 }
    );
    return (j.features || []).map((f) => f.attributes);
  } catch {
    return [];
  }
}

async function lookupParcel(src, lng, lat, signal) {
  const pointGeom = { x: lng, y: lat, spatialReference: { wkid: 4326 } };
  if (src.type === 'carto') {
    const sql = `SELECT cartodb_id, ${src.idField}, owner1, owner2, address, bldg_desc, ST_AsGeoJSON(the_geom) AS gj FROM ${src.table} WHERE ST_Intersects(the_geom, ST_SetSRID(ST_Point(${lng},${lat}),4326)) LIMIT 10`;
    const j = await U.fetchJSON(`https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}`, { signal });
    return (j.rows || []).map((r) => ({ attrs: r, geom: JSON.parse(r.gj) }));
  }
  if (src.type === 'arcgis-identify') {
    const d = 0.002;
    const j = await U.arcgis(
      src.url,
      'identify',
      {
        geometry: pointGeom,
        geometryType: 'esriGeometryPoint',
        sr: 4326,
        layers: `all:${src.layerId}`,
        tolerance: 0,
        mapExtent: `${lng - d},${lat - d},${lng + d},${lat + d}`,
        imageDisplay: '400,400,96',
        returnGeometry: true,
      },
      { signal, timeout: 30000 }
    );
    return (j.results || []).map((r) => ({ attrs: r.attributes, geom: U.esriToGeoJSON(r.geometry) }));
  }
  const gj = await U.arcgis(
    src.url,
    'query',
    {
      geometry: pointGeom,
      geometryType: 'esriGeometryPoint',
      inSR: 4326,
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: true,
      outSR: 4326,
      geometryPrecision: 7,
      f: 'geojson',
    },
    { signal, timeout: 30000 }
  );
  return (gj.features || []).map((f) => ({ attrs: f.properties || {}, geom: f.geometry }));
}

function makeRecord(src, hit) {
  const base = { source: src, owners: [], sales: [], details: [], keys: {}, link: null };
  const rec = Object.assign(base, src.normalize(hit.attrs));
  rec.owners = rec.owners || [];
  rec.sales = rec.sales || [];
  rec.details = rec.details || [];
  rec.keys = rec.keys || {};
  rec.geom = hit.geom;
  rec.mappedAcres = hit.geom ? U.geomArea(hit.geom) / U.SQM_PER_ACRE : null;
  return rec;
}

async function inspect(latlng, { fly = false } = {}) {
  const { lat, lng } = latlng;
  if (inspectCtrl) inspectCtrl.abort();
  inspectCtrl = new AbortController();
  const { signal } = inspectCtrl;
  selectedPoint = latlng;
  writeHash();

  if (pinMarker) pinMarker.remove();
  pinMarker = L.circleMarker(latlng, { radius: 5, color: '#fff', weight: 2, fillColor: '#e11d48', fillOpacity: 1 }).addTo(map);
  if (selectedLayer) {
    selectedLayer.remove();
    selectedLayer = null;
  }
  if (fly) map.setView(latlng, Math.max(map.getZoom(), 17));

  openPanel(renderLoading());
  setBusy('inspect', true);
  // On phones the details sheet covers the lower half: keep the picked point visible above it.
  if (window.innerWidth <= 760) {
    const size = map.getSize();
    const sheet = $('#panel').getBoundingClientRect().height;
    const want = (size.y - sheet) / 2;
    const now = map.latLngToContainerPoint(latlng).y;
    if (now > size.y - sheet - 30 || now < 60) map.panBy([0, now - want], { animate: true });
  }

  const state = U.stateAt(lng, lat);
  const countyP = lookupCounty(lng, lat, signal);
  const publicP = lookupPublicLand(lng, lat, signal);

  const candidates = SOURCES.filter((s) => U.bboxContains(s.bbox, [lng, lat]) && (!s.states || (state && s.states.includes(state.abbr))));
  const settled = await Promise.allSettled(candidates.map((s) => lookupParcel(s, lng, lat, signal)));
  if (signal.aborted) return;

  let rec = null;
  let others = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === 'rejected') failures.push(candidates[i]);
    else if (!rec && r.value.length) {
      rec = makeRecord(candidates[i], r.value[0]);
      others = r.value.slice(1).map((h) => makeRecord(candidates[i], h));
    }
  });

  const [county, publicLand] = await Promise.all([countyP, publicP]);
  if (signal.aborted) return;
  const ctx = { lat, lng, state, county, publicLand, failures, candidates };

  if (!rec) {
    setBusy('inspect', false);
    openPanel(renderNoParcel(ctx));
    return;
  }

  rec.others = others;
  if (rec.source.enrich) {
    try {
      await rec.source.enrich(rec, signal);
    } catch (e) {
      if (signal.aborted) return;
      console.warn('enrich', e);
    }
  }
  if (!rec.acres && rec.mappedAcres) {
    rec.acres = rec.mappedAcres;
    rec.acresLabel = 'mapped';
  }

  if (rec.geom) {
    selectedLayer = L.geoJSON(rec.geom, {
      renderer: L.svg(),
      interactive: false,
      style: { color: '#e11d48', weight: 3, fillColor: '#e11d48', fillOpacity: 0.15 },
    }).addTo(map);
    const gb = selectedLayer.getBounds();
    if (gb.isValid() && !map.getBounds().contains(gb)) map.fitBounds(gb, { padding: [40, 40], maxZoom: 19 });
  }

  const provider = rec.source.history && HISTORY[rec.source.history];
  let ownership = buildOwnership(rec, []);
  openPanel(renderParcel(rec, ownership, ctx, provider ? 'loading' : 'none'));

  if (provider) {
    try {
      const events = await provider(rec, signal);
      if (signal.aborted) return;
      ownership = buildOwnership(rec, events);
      openPanel(renderParcel(rec, ownership, ctx, 'done'), true);
    } catch (e) {
      if (signal.aborted) return;
      console.warn('history', e);
      openPanel(renderParcel(rec, ownership, ctx, 'failed'), true);
    }
  }
  setBusy('inspect', false);
}

/* ======================= Panel rendering ======================= */

const h = U.esc;

function openPanel(html, keepScroll = false) {
  const panel = $('#panel');
  const body = $('#panelBody');
  const top = body.scrollTop;
  body.innerHTML = html;
  if (keepScroll) body.scrollTop = top;
  panel.classList.remove('hidden');
  document.body.classList.add('panel-open');
}

function closePanel() {
  $('#panel').classList.add('hidden');
  document.body.classList.remove('panel-open');
  if (inspectCtrl) inspectCtrl.abort();
  setBusy('inspect', false);
  if (selectedLayer) selectedLayer.remove();
  if (pinMarker) pinMarker.remove();
  selectedLayer = pinMarker = selectedPoint = null;
  writeHash();
}

function renderLoading() {
  return `<div class="loading"><div class="bar"></div><p>Looking up public records…</p></div>`;
}

function placeLine(rec, ctx) {
  const county = ctx.county ? ctx.county.NAME : null;
  const parts = [rec.place, county, ctx.state ? ctx.state.name : null].filter(Boolean);
  return [...new Set(parts)].join(', ');
}

/* In these New England states, land records are kept by each town, not the county. */
const TOWN_RECORD_STATES = ['CT', 'VT', 'RI'];

function countyRecordsLinks(ctx, rec) {
  const q = (s) => `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  const stateName = ctx.state ? ctx.state.name : '';
  if (ctx.state && TOWN_RECORD_STATES.includes(ctx.state.abbr) && rec && rec.place) {
    const town = rec.place.replace(/\b\w+/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
    return `
    <a class="linkbtn" href="${q(`${town} ${stateName} town clerk land records online search`)}" target="_blank" rel="noopener">Search ${h(town)} land records ↗</a>
    <a class="linkbtn" href="${q(`${town} ${stateName} assessor property database`)}" target="_blank" rel="noopener">Find the ${h(town)} assessor ↗</a>`;
  }
  if (!ctx.county) return '';
  const where = `${ctx.county.NAME}, ${stateName}`;
  return `
    <a class="linkbtn" href="${q(`${where} recorder of deeds online records search`)}" target="_blank" rel="noopener">Search ${h(ctx.county.NAME)} deed records ↗</a>
    <a class="linkbtn" href="${q(`${where} property appraiser assessor parcel search`)}" target="_blank" rel="noopener">Find the ${h(ctx.county.NAME)} assessor ↗</a>`;
}

function priceText(p) {
  if (p === null || p === undefined) return null;
  if (p === 0) return '$0 (no price recorded)';
  if (p <= 100) return `${U.fmtMoney(p)} (nominal, usually a family, trust or non-market transfer)`;
  return U.fmtMoney(p);
}

function ownersHtml(owners, rec, period) {
  if (owners && owners.length) return owners.map((o) => `<span class="name">${h(o)}</span>`).join('<span class="amp"> &amp; </span>');
  if (period && period.boughtEvent && period.boughtEvent.buyerPending) return `<span class="unknown">New owner (not yet named in published records)</span>`;
  if (period && !period.current) return `<span class="unknown">Owner not named in this record</span>`;
  return `<span class="unknown">${h(rec.ownerNote ? 'Name not published' : 'Owner not named in this record')}</span>`;
}

function renderPeriods(rec, ownership, historyState) {
  const periods = ownership.periods;
  const items = periods
    .map((p) => {
      const from = p.from ? U.fmtDate(p.from) : p.current && p.gap ? 'after the last recorded sale' : 'unknown';
      const to = p.current ? 'today' : p.to ? U.fmtDate(p.to) : 'unknown';
      const bought = p.boughtEvent ? priceText(p.boughtFor) : null;
      const sold = p.soldEvent ? priceText(p.soldFor) : null;
      const docBits = (e) => [e.docType, e.book, e.note].filter(Boolean).map(h).join(' · ');
      return `
      <li class="${p.current ? 'current' : ''}">
        <div class="who">${ownersHtml(p.owners, rec, p)}${p.inferred ? '<span class="tag" title="Named as the seller on the next transfer">from next deed</span>' : ''}${p.current ? '<span class="tag now">current</span>' : ''}</div>
        <div class="when">${p.from || !p.current ? `${h(from)} → ${h(to)}` : 'Owner today'}</div>
        ${bought ? `<div class="money"><span>Bought for</span> ${h(bought)}</div>` : p.boughtEvent ? `<div class="money muted"><span>Bought for</span> price not published</div>` : ''}
        ${p.boughtEvent && docBits(p.boughtEvent) ? `<div class="doc">${docBits(p.boughtEvent)}</div>` : ''}
        ${sold ? `<div class="money"><span>Sold for</span> ${h(sold)}</div>` : p.soldEvent ? `<div class="money muted"><span>Sold for</span> price not published</div>` : ''}
      </li>`;
    })
    .join('');

  let status = '';
  if (historyState === 'loading') status = `<p class="status"><span class="dotspin"></span> Loading deed history from ${h(rec.source.history === 'acris' ? 'ACRIS' : 'public records')}…</p>`;
  if (historyState === 'failed') status = `<p class="status warn">The deed-history service didn’t respond. Showing what the parcel record has. Try again in a minute.</p>`;

  const empty = !periods.length || (periods.length === 1 && !periods[0].from && !periods[0].boughtEvent && historyState !== 'loading');
  let body;
  if (!empty) {
    const limits = rec.source.history
      ? rec.source.note || ''
      : 'This area’s free public data only includes the sale(s) shown. Earlier owners are in the county deed records (links below).';
    body = `<ol class="timeline">${items}</ol><p class="fine">${h(limits)}</p>`;
  } else if (historyState === 'loading') {
    body = '';
  } else if (rec.source.history) {
    body = `<p class="muted">No transfers are recorded for this parcel in ${h(rec.source.name)}.</p><p class="fine">${h(rec.source.note || '')}</p>`;
  } else {
    body = `<p class="muted">This area’s free public data has no sale history. Past owners are in the county deed records (links below).</p>`;
  }

  return `
    <section class="block">
      <h3>Ownership history</h3>
      ${status}
      ${body}
    </section>`;
}

function renderPublicLand(list) {
  if (!list || !list.length) return '';
  const fee = list.filter((p) => p.FeatClass === 'Fee');
  const rows = (fee.length ? fee : list).slice(0, 3).map((p) => {
    // Prefer the decoded standard name ("National Park Service"); fall back to the local name.
    const decoded = (field, code, local) => {
      const d = padDecode(field, code);
      return d && d !== code ? d : U.clean(local) || d;
    };
    const owner = decoded('Own_Name', p.Own_Name, p.Loc_Own);
    const manager = decoded('Mang_Name', p.Mang_Name, p.Loc_Mang);
    const est = U.parseDate(p.Date_Est);
    return `
      <div class="pub">
        <div class="pubname">${h(U.clean(p.Unit_Nm) || U.clean(p.Loc_Nm) || 'Protected area')}</div>
        <dl class="kv">
          ${p.FeatClass === 'Easement' ? `<dt>Type</dt><dd>Conservation easement${p.EsmtHldr ? ' held by ' + h(padDecode('EsmtHldr', p.EsmtHldr)) : ''}</dd>` : ''}
          <dt>Owner</dt><dd>${h(owner)} <span class="muted">(${h(padDecode('Own_Type', p.Own_Type))})</span></dd>
          ${manager && manager !== owner ? `<dt>Managed by</dt><dd>${h(manager)}</dd>` : ''}
          <dt>Designation</dt><dd>${h(padDecode('Des_Tp', p.Des_Tp))}</dd>
          ${p.GIS_Acres ? `<dt>Size</dt><dd>${h(U.fmtArea(p.GIS_Acres))}</dd>` : ''}
          ${est ? `<dt>Established</dt><dd>${h(String(est.getUTCFullYear()))}</dd>` : ''}
          ${p.Pub_Access ? `<dt>Public access</dt><dd>${h(padDecode('Pub_Access', p.Pub_Access))}</dd>` : ''}
        </dl>
      </div>`;
  });
  return `<section class="block public"><h3>Public &amp; protected land</h3>${rows.join('')}<p class="fine">From USGS PAD-US 4.1.</p></section>`;
}

function renderSourceBlock(src) {
  return `
    <section class="block source">
      <h3>Where this comes from</h3>
      <p><a href="${h(src.homepage)}" target="_blank" rel="noopener">${h(src.name)}</a><br><span class="muted">${h(src.publisher)}</span></p>
      <p class="fine">Public records can be out of date or wrong, and this is not a title search. For anything legal or financial, check the official record.</p>
    </section>`;
}

function renderParcel(rec, ownership, ctx, historyState) {
  const cur = ownership.periods.find((p) => p.current);
  const pending = !!(cur && cur.boughtEvent && cur.boughtEvent.buyerPending);
  const since = cur && cur.from && !pending ? U.fmtDate(cur.from) : null;
  const paid = cur && cur.boughtEvent && !pending ? priceText(cur.boughtFor) : null;
  const lag = ownership.rollLags && cur && cur.owners.length;
  const shownOwners = lag ? cur.owners : rec.owners;
  const ownerLabel = pending
    ? 'Owner on the tax roll'
    : lag
      ? `Current owner${cur.owners.length > 1 ? 's' : ''} (from the latest deed)`
      : rec.ownerLabel || (rec.owners.length > 1 ? 'Current owners' : 'Current owner');
  let pendingNote = '';
  if (pending) {
    pendingNote = `<p class="note">Sold on ${h(U.fmtDate(cur.from))}${cur.boughtFor > 100 ? ` for ${h(U.fmtMoney(cur.boughtFor))}` : ''}. The tax roll hasn’t caught up, so the new owner isn’t named in published records yet.</p>`;
  } else if (lag) {
    pendingNote = `<p class="note">The tax roll still lists ${h(rec.owners.join(' & '))}, an earlier owner. Tax rolls often lag behind recorded deeds.</p>`;
  }
  const area = U.fmtArea(rec.acres);
  const mapped = rec.acresLabel !== 'mapped' && rec.mappedAcres ? U.fmtArea(rec.mappedAcres) : null;
  const details = rec.details.filter(([, v]) => v !== null && v !== undefined && v !== '');

  const others = (rec.others || []).filter((o) => o.owners.length);
  const othersHtml = others.length
    ? `<section class="block"><h3>Other records on this spot</h3><p class="fine">Condos, stacked units or overlapping parcels:</p><ul class="others">${others
        .slice(0, 12)
        .map((o) => `<li><strong>${h(o.owners.join(' & '))}</strong>${o.address ? ` · ${h(o.address)}` : ''}${o.parcelId ? ` <span class="muted">(${h(o.parcelId)})</span>` : ''}</li>`)
        .join('')}${others.length > 12 ? `<li class="muted">…and ${others.length - 12} more</li>` : ''}</ul></section>`
    : '';

  return `
    <header class="phead">
      <div class="eyebrow">${h(placeLine(rec, ctx))}</div>
      <h2>${h(rec.address || rec.parcelId || 'Parcel')}</h2>
      ${rec.address && rec.parcelId ? `<div class="pid">${h(rec.parcelId)}</div>` : ''}
    </header>

    <section class="owner">
      <div class="label">${h(ownerLabel)}</div>
      <div class="owners">${shownOwners.length ? shownOwners.map((o) => `<div class="big">${h(o)}</div>`).join('') : `<div class="big unknown">Not published</div>`}</div>
      ${!shownOwners.length && rec.ownerNote ? `<p class="note">${h(rec.ownerNote)}</p>` : ''}
      ${pendingNote}
      <div class="facts">
        ${since ? `<div><span>Owned since</span><strong>${h(since)}</strong></div>` : ''}
        ${paid ? `<div><span>Bought for</span><strong>${h(paid)}</strong></div>` : ''}
        ${area ? `<div><span>Size${rec.acresLabel ? ` (${h(rec.acresLabel)})` : ''}</span><strong>${h(area)}</strong></div>` : ''}
        ${mapped ? `<div><span>Size (mapped)</span><strong>${h(mapped)}</strong></div>` : ''}
      </div>
      ${rec.link ? `<a class="linkbtn primary" href="${h(rec.link.url)}" target="_blank" rel="noopener">${h(rec.link.label)} ↗</a>` : ''}
    </section>

    ${renderPeriods(rec, ownership, historyState)}
    ${othersHtml}
    ${renderPublicLand(ctx.publicLand)}

    ${details.length ? `<section class="block"><h3>Details</h3><dl class="kv">${details.map(([k, v]) => `<dt>${h(k)}</dt><dd>${h(v)}</dd>`).join('')}</dl></section>` : ''}

    <section class="block">
      <h3>Official records</h3>
      <div class="links">${countyRecordsLinks(ctx, rec)}</div>
    </section>
    ${renderSourceBlock(rec.source)}`;
}

function renderNoParcel(ctx) {
  const where = [ctx.county && ctx.county.NAME, ctx.state && ctx.state.name].filter(Boolean).join(', ') || 'This spot';
  const hasSource = ctx.candidates.length > 0;
  const failed = ctx.failures.length > 0;
  let msg;
  if (failed && ctx.failures.length === ctx.candidates.length) {
    msg = `<p>The parcel service for this area (${ctx.failures.map((s) => h(s.name)).join(', ')}) didn’t respond. Government map servers go down now and then, so try again in a minute.</p>`;
  } else if (hasSource) {
    msg = `<p>No parcel at this exact spot. Roads, rivers and rights-of-way usually aren’t parcels. Try clicking inside a lot.</p>`;
  } else {
    msg = `<p>There’s no free online parcel service for <strong>${h(where)}</strong> that this map can read yet. Owners and deed history for private land are kept by the county. The links below go to its records offices.</p>`;
  }
  const fee = (ctx.publicLand || []).filter((p) => p.FeatClass === 'Fee');
  const isPublic = fee.length > 0;
  let title = hasSource ? 'No parcel here' : 'No free parcel data';
  if (isPublic && !hasSource) {
    const p = fee[0];
    const d = padDecode('Own_Name', p.Own_Name);
    title = `Public land: ${d && d !== p.Own_Name ? d : U.clean(p.Loc_Own) || d}`;
    msg = `<p class="fine">Private parcels around here aren’t in a free data source this map can read. The county’s records offices have them.</p>`;
  }
  return `
    <header class="phead">
      <div class="eyebrow">${h(where)}</div>
      <h2>${h(title)}</h2>
      <div class="pid">${ctx.lat.toFixed(5)}, ${ctx.lng.toFixed(5)}</div>
    </header>
    ${isPublic && !hasSource ? '' : `<section class="block">${msg}${!hasSource && !isPublic ? '<p class="fine">This spot isn’t public or protected land in PAD-US, so it’s most likely privately owned.</p>' : ''}</section>`}
    ${renderPublicLand(ctx.publicLand)}
    ${isPublic && !hasSource ? `<section class="block">${msg}</section>` : ''}
    <section class="block"><h3>Official records</h3><div class="links">${countyRecordsLinks(ctx)}</div></section>`;
}

/* ======================= Search ======================= */

async function geocode(q) {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    let a = +m[1], b = +m[2];
    if (Math.abs(a) > 90) [a, b] = [b, a];
    return [{ label: `${a.toFixed(5)}, ${b.toFixed(5)}`, lat: a, lng: b, exact: true }];
  }
  try {
    const j = await U.fetchJSON(`https://photon.komoot.io/api/?${U.qs({ q, limit: 6, lang: 'en', bbox: '-180,17,-64,72' })}`, { timeout: 10000 });
    const out = (j.features || [])
      .filter((f) => f.properties.countrycode === 'US')
      .map((f) => {
        const p = f.properties;
        const line1 = [p.housenumber, p.street].filter(Boolean).join(' ') || p.name;
        const line2 = [p.city || p.county, p.state, p.postcode].filter(Boolean).join(', ');
        return { label: [line1, line2].filter(Boolean).join(' — '), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], exact: !!p.housenumber, extent: p.extent };
      });
    if (out.length) return out;
  } catch (e) {
    console.warn('photon', e);
  }
  const j = await U.fetchJSON(`https://nominatim.openstreetmap.org/search?${U.qs({ q, format: 'jsonv2', countrycodes: 'us', limit: 6 })}`, { timeout: 10000 });
  return j.map((r) => ({ label: r.display_name, lat: +r.lat, lng: +r.lon, exact: r.addresstype === 'building' || r.type === 'house' }));
}

function goTo(r) {
  $('#results').classList.add('hidden');
  if (r.exact) {
    map.setView([r.lat, r.lng], 18);
    inspect(L.latLng(r.lat, r.lng));
  } else if (r.extent) {
    map.fitBounds([[r.extent[1], r.extent[0]], [r.extent[3], r.extent[2]]]);
  } else {
    map.setView([r.lat, r.lng], 15);
  }
}

$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  const box = $('#results');
  box.innerHTML = '<li class="muted">Searching…</li>';
  box.classList.remove('hidden');
  try {
    const results = await geocode(q);
    if (!results.length) {
      box.innerHTML = '<li class="muted">No matches in the U.S.</li>';
      return;
    }
    if (results.length === 1 || results[0].exact) return goTo(results[0]);
    box.innerHTML = results.map((r, i) => `<li><button type="button" data-i="${i}">${h(r.label)}</button></li>`).join('');
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => goTo(results[+b.dataset.i])));
  } catch (err) {
    box.innerHTML = `<li class="muted">Search failed: ${h(err.message)}</li>`;
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#searchForm')) $('#results').classList.add('hidden');
});

/* ======================= Controls ======================= */

$('#panelClose').addEventListener('click', closePanel);
$('#grab').addEventListener('click', () => $('#panel').classList.toggle('expanded'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#about').open) closePanel();
});

document.querySelectorAll('[name=basemap]').forEach((r) =>
  r.addEventListener('change', () => {
    map.removeLayer(basemaps[basemapName]);
    basemapName = r.value;
    basemaps[basemapName].addTo(map);
    restyleParcels();
  })
);
$('#togglePublic').addEventListener('change', (e) => {
  showPublic = e.target.checked;
  refreshPublicLands();
});
$('#toggleCoverage').addEventListener('change', (e) => {
  showCoverage = e.target.checked;
  updateCoverageVisibility();
});
$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Your browser can’t share its location.');
  navigator.geolocation.getCurrentPosition(
    (p) => map.setView([p.coords.latitude, p.coords.longitude], 17),
    () => toast('Location permission was denied.')
  );
});

/* About dialog */
function renderAbout() {
  const rows = (filterFn) =>
    SOURCES.filter(filterFn)
      .map(
        (s) => `<tr>
          <td><span class="swatch" style="background:${LEVELS[s.level].color}"></span>${h(s.region || s.states.map(U.stateName).join(', '))}</td>
          <td><a href="${h(s.homepage)}" target="_blank" rel="noopener">${h(s.name)}</a><div class="muted">${h(s.note || '')}</div></td>
        </tr>`
      )
      .join('');
  $('#sourceTable').innerHTML = `
    <thead><tr><th>Area</th><th>Source and what it includes</th></tr></thead>
    <tbody>${rows((s) => s.counties)}${rows((s) => s.states)}</tbody>`;
  $('#legendAbout').innerHTML = Object.values(LEVELS)
    .map((l) => `<li><span class="swatch" style="background:${l.color}"></span>${h(l.label)}</li>`)
    .join('');
}
$('#aboutBtn').addEventListener('click', () => {
  renderAbout();
  $('#about').showModal();
});
$('#aboutClose').addEventListener('click', () => $('#about').close());

$('#legend').innerHTML =
  `<div class="lg-title">Free data available</div>` +
  Object.values(LEVELS)
    .map((l) => `<div class="lg-row"><span class="swatch" style="background:${l.color}"></span>${h(l.label)}</div>`)
    .join('');

/* ======================= Map events & URL state ======================= */

map.on('click', (e) => {
  if (map.getZoom() < INSPECT_MIN_ZOOM) {
    map.setView(e.latlng, Math.min(map.getZoom() + 3, 16));
    return;
  }
  inspect(e.latlng);
});

let moveTimer;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    updateCoverageVisibility();
    refreshParcels();
    refreshPublicLands();
    writeHash();
  }, 150);
});

function writeHash() {
  const c = map.getCenter();
  let hash = `#${map.getZoom()}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
  if (selectedPoint) hash += `/pick/${selectedPoint.lat.toFixed(6)},${selectedPoint.lng.toFixed(6)}`;
  history.replaceState(null, '', hash);
}

function readHash() {
  const m = location.hash.match(/^#(\d+)\/(-?[\d.]+)\/(-?[\d.]+)(?:\/pick\/(-?[\d.]+),(-?[\d.]+))?/);
  if (!m) return null;
  return { z: +m[1], lat: +m[2], lng: +m[3], pick: m[4] ? L.latLng(+m[4], +m[5]) : null };
}

const start = readHash();
if (start) map.setView([start.lat, start.lng], start.z);
else map.fitBounds([[24.5, -125], [49.5, -66.9]]);
updateCoverageVisibility();
refreshParcels();
refreshPublicLands();
if (start && start.pick) inspect(start.pick);
