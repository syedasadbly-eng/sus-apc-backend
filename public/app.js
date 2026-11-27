/* ============================================
   SMART URBAN SENSING — APC DASHBOARD
   Direct MQTT Integration (UR35 + VS125)
   ============================================ */

/* eslint-disable no-redeclare */
/* global L, Chart, XLSX, lucide, mqtt */
/* eslint-enable no-redeclare */

// ============================================
// CONFIGURATION & STATE
// ============================================

// Backend API — same-origin when served by Railway backend
let API_BASE = '';  // Empty = same-origin (default for Railway-hosted dashboard)
let backendAvailable = null; // null = not checked, true/false after probe

async function probeBackend() {
  if (backendAvailable !== null) return backendAvailable;
  // Same-origin first (primary — dashboard is served by the backend)
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
    if (res.ok) { API_BASE = ''; backendAvailable = true; console.log('[API] Backend available (same-origin)'); return true; }
  } catch { /* not reachable */ }
  // Fallback: localhost:3001 (local dev)
  try {
    const res = await fetch('http://localhost:3001/api/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) { API_BASE = 'http://localhost:3001'; backendAvailable = true; console.log('[API] Backend available (localhost:3001)'); return true; }
  } catch { /* not reachable */ }
  backendAvailable = false;
  console.log('[API] Backend not reachable — using live MQTT data only');
  return false;
}

async function apiFetch(endpoint, params = {}) {
  if (backendAvailable === null) await probeBackend();
  if (!backendAvailable) return null;
  const url = new URL(`${API_BASE}${endpoint}`, window.location.origin);
  Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`API ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[API] ${endpoint} failed:`, err.message);
    return null;
  }
}

const CONFIG = {
  dashPassword: 'sus2026',
  busCapacity: 16,
  // VS125 JSON payload field mappings (supports real VS125 + flat formats)
  vs125Fields: {
    // Running daily totals (from line_total_data — best source for KPI counts)
    totalIn: ['line_total_data.0.total.out_counted'],   // VS125 in/out inverted: sensor 'out' = boarding
    totalOut: ['line_total_data.0.total.in_counted'],    // VS125 in/out inverted: sensor 'in' = alighting
    totalCapacity: ['line_total_data.0.total.capacity_counted'],
    // Periodic window totals (line_periodic_data — per-minute summary)
    periodicIn: ['line_periodic_data.0.total.out'],    // VS125 in/out inverted: sensor 'out' = boarding
    periodicOut: ['line_periodic_data.0.total.in'],     // VS125 in/out inverted: sensor 'in' = alighting
    // Trigger events (line_trigger_data — individual door events, 0 or 1)
    triggerIn: ['line_trigger_data.0.total.out'],      // VS125 in/out inverted: sensor 'out' = boarding
    triggerOut: ['line_trigger_data.0.total.in'],       // VS125 in/out inverted: sensor 'in' = alighting
    // Legacy / flat format fallbacks
    lineIn: ['line.0.total.in', 'linePeriod.0.total.in', 'line1_in', 'total.in'],
    lineOut: ['line.0.total.out', 'linePeriod.0.total.out', 'line1_out', 'total.out'],
    capacity: ['capacity', 'lineTotal.capacity'],
    passersby: ['passersby'],
    // UR35 GPS format: data.latitude = "44.97780 N", data.longitude = "93.26500 W"
    latitude: ['data.latitude', 'latitude', 'gps.latitude'],
    longitude: ['data.longitude', 'longitude', 'gps.longtitude', 'gps.longitude'],
    speed: ['data.speed', 'speed', 'gps.speed'],
    gpsStatus: ['data.status', 'status'],
  },
};

// In-memory config — settings persist only during the current browser session
let configStore = {
  mqtt: {
    host: '492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud',
    port: 8884,
    username: 'sus-dashboard',
    password: 'SuS-Mqtt#2026!Secure',
    useTls: true,
    path: '/mqtt',
    topic: 'bus/#',
  },
  dashPassword: CONFIG.dashPassword,
  // Gateway-to-bus mapping: [{topic: 'bus/001', label: '515', route: '101'}, ...]
  // Bus 515 (first bus): bus/001 (+ bus/002 door merged in via topicMap).
  // Bus 419 (second bus): bus/003 (+ bus/004 door merged in via topicMap).
  gateways: [
    { topic: 'bus/001', label: '515', route: '' },
    { topic: 'bus/003', label: '419', route: '' },
  ],
  // Topic remapping: a bus's second door sensor is physically on the same bus as
  // its first door. Maps busBase → canonical busBase so doors merge into one device.
  //   bus/002 -> bus/001  (second door of bus 515)
  //   bus/004 -> bus/003  (second door of bus 419, if/when added)
  topicMap: {
    'bus/002': 'bus/001',
    'bus/004': 'bus/003',
  },
};

// ============================================
// DEMO MODE (window.SUS_DEMO from /demo-config.js)
// ============================================
// On a demo service the server generates sample data itself and the browser
// must never open its own connection to the live broker. Blank the broker
// settings so even the Settings > Connect button cannot reach it.
// Dashboard clock time zone follows the server's DISPLAY_TZ (default US Central).
const APP_TZ = (typeof window !== 'undefined' && window.SUS_DEMO && window.SUS_DEMO.tz) || 'America/Chicago';
const DEMO = (typeof window !== 'undefined' && window.SUS_DEMO && window.SUS_DEMO.enabled) ? window.SUS_DEMO : null;
if (DEMO) {
  configStore.mqtt = { host: '', port: 0, username: '', password: '', useTls: true, path: '/mqtt', topic: 'bus/#' };
}

// White-label demo: the server already strips the pilot client's name from
// API data; this removes it from the static page too (logos, tooltips,
// placeholders) and keeps any later-rendered text clean.
const DEMO_WHITE_LABEL = !!(DEMO && DEMO.whiteLabel);
function demoScrub(str) {
  if (!DEMO_WHITE_LABEL || typeof str !== 'string' || typeof window.SUS_SCRUB !== 'function') return str;
  return window.SUS_SCRUB(str);
}
function demoScrubTree(root) {
  if (!DEMO_WHITE_LABEL || !root) return;
  if (root.nodeType === 3) { const t = demoScrub(root.nodeValue); if (t !== root.nodeValue) root.nodeValue = t; return; }
  if (root.nodeType !== 1 && root.nodeType !== 9) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n; while ((n = walker.nextNode())) { const t = demoScrub(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; }
  const els = root.querySelectorAll ? root.querySelectorAll('[title],[placeholder],[alt],[aria-label]') : [];
  els.forEach((el) => ['title', 'placeholder', 'alt', 'aria-label'].forEach((a) => {
    const v = el.getAttribute(a); if (v) { const nv = demoScrub(v); if (nv !== v) el.setAttribute(a, nv); }
  }));
}
if (DEMO) {
  const relabel = () => document.querySelectorAll('.kpi-sub').forEach((el) => {
    if (el.textContent.trim() === 'live via MQTT') el.textContent = 'parallel connection';
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', relabel); else relabel();
}
if (DEMO_WHITE_LABEL) {
  document.documentElement.classList.add('demo-white-label');
  document.title = demoScrub(document.title);
  const run = () => {
    demoScrubTree(document.body);
    new MutationObserver((muts) => muts.forEach((m) => {
      if (m.type === 'characterData') demoScrubTree(m.target);
      else if (m.type === 'attributes') demoScrubTree(m.target.parentNode || m.target);
      else m.addedNodes.forEach(demoScrubTree);
    })).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder', 'alt', 'aria-label'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
}


// ----- Map base layer -------------------------------------------------------
// White-label demo: a dark OpenFreeMap vector style with every label layer
// removed, so no town, street or building names appear on the map. Free for
// commercial use, no key; attribution "© OpenMapTiles © OpenStreetMap".
// Live dashboard keeps its existing raster tiles.
const DEMO_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';   // detailed street map, Google-style colours (free, no key)
let _demoMapLibs = null;
function loadDemoMapLibs() {
  if (_demoMapLibs) return _demoMapLibs;
  const addCss = (href) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); };
  const addJs = (src) => new Promise((ok, fail) => { const t = document.createElement('script'); t.src = src; t.onload = ok; t.onerror = fail; document.head.appendChild(t); });
  addCss('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css');
  _demoMapLibs = addJs('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js')
    .then(() => addJs('https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.0.22/leaflet-maplibre-gl.js'))
    .then(() => fetch(DEMO_MAP_STYLE_URL).then((r) => r.json()))
    .then((style) => {
      // Hide street/area names only while the demo sits on the pilot client's city.
      if (DEMO_WHITE_LABEL && !(DEMO && DEMO.mapLabels)) style.layers = style.layers.filter((l) => l.type !== 'symbol');
      // Google-like look: drop small POI icons, transit icons (they clash with
      // our bus stops) and 3D buildings; soften land, water and parks.
      const DROP = new Set(['poi_r20', 'poi_r7', 'poi_transit', 'building-3d']);
      style.layers = style.layers.filter((l) => !DROP.has(l.id));
      const paint = (id, prop, val) => { const l = style.layers.find((x) => x.id === id); if (l) { l.paint = l.paint || {}; l.paint[prop] = val; } };
      paint('background', 'background-color', '#f5f3ef');
      paint('water', 'fill-color', '#aadaff');
      paint('park', 'fill-color', '#c8e6c9');
      paint('landcover_grass', 'fill-color', '#d4ecd0');
      paint('landcover_wood', 'fill-color', '#c3e2bf');
      paint('landuse_residential', 'fill-color', '#efece6');
      paint('building', 'fill-color', '#e8e4dd');
      // Google-style roads: white streets with soft grey edges, gold motorways,
      // so the coloured bus routes stand out clearly on top.
      style.layers.forEach((l) => {
        if (l.type !== 'line' || !/^(road|bridge|tunnel)_/.test(l.id)) return;
        l.paint = l.paint || {};
        if (/rail|path|pedestrian|arrow|area/.test(l.id)) return;
        if (/motorway/.test(l.id)) l.paint['line-color'] = /casing/.test(l.id) ? '#e3b84f' : '#fbd977';
        else l.paint['line-color'] = /casing/.test(l.id) ? '#d6d0c6' : '#ffffff';
      });
      return style;
    });
  return _demoMapLibs;
}
// Which vector tile endpoint can this browser reach? Some networks / blockers
// allow the OpenFreeMap style but block its tile endpoint, which left every
// map blank. Try the direct endpoint first, then our own same-origin relay
// (/maptiles/*). Checked once per page; each probe = TileJSON + one tile.
let _tileSource = null;
function probeTiles(tileJsonUrl, ms) {
  const withTimeout = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
  return withTimeout((async () => {
    const r0 = await fetch(tileJsonUrl);
    if (!r0.ok) return false;
    const tj = await r0.json();
    const u = String((tj.tiles || [])[0] || '').replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
    if (!u) return false;
    const r = await fetch(u);
    return r.ok;
  })()).catch(() => false);
}
function vectorTileSource() {
  if (_tileSource) return _tileSource;
  const RELAY = location.origin + '/maptiles/tilejson';
  _tileSource = probeTiles('https://tiles.openfreemap.org/planet', 5000)
    .then((ok) => ok ? 'direct' : probeTiles(RELAY, 8000).then((ok2) => ok2 ? RELAY : null));
  return _tileSource;
}
// Last-resort raster street map (Esri World Street Map, no key needed).
function addRasterFallback(map) {
  if (map._rasterFallback) return;
  map._rasterFallback = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri',
  }).addTo(map);
  map._rasterFallback.bringToBack && map._rasterFallback.bringToBack();
}
function addBaseLayer(map, url, opts) {
  // Every map (demo and live) uses the free OpenFreeMap vector style. If the
  // tile host is blocked we route tiles through our server; a raster map is
  // the last resort, so a map is never left blank.
  L.control.attribution({ prefix: false }).addAttribution('&copy; OpenMapTiles &copy; OpenStreetMap contributors').addTo(map);
  Promise.all([loadDemoMapLibs(), vectorTileSource()]).then(([baseStyle, src]) => {
    if (!src) throw new Error('vector tiles unreachable');
    if (!L.maplibreGL) throw new Error('maplibre-gl-leaflet missing');
    let style = baseStyle;
    if (src !== 'direct') {
      style = { ...baseStyle, sources: { ...baseStyle.sources } };
      Object.keys(style.sources).forEach((k) => {
        const s = style.sources[k];
        if (s && s.type === 'vector' && /openfreemap\.org\/planet/.test(String(s.url || ''))) style.sources[k] = { ...s, url: src };
      });
      console.info('[map] using tile relay');
    }
    const layer = L.maplibreGL({ style, interactive: false }).addTo(map);
    // Watchdog: if the vector map hasn't drawn within 12 s, swap to raster.
    let drawn = false;
    try {
      const gl = layer.getMaplibreMap();
      gl.once('idle', () => { drawn = true; });
      setTimeout(() => {
        if (drawn || (gl.isStyleLoaded() && gl.areTilesLoaded())) return;
        console.warn('[map] vector map did not load, using raster tiles');
        try { map.removeLayer(layer); } catch (e) { /* noop */ }
        addRasterFallback(map);
      }, 12000);
    } catch (e) { /* layer not ready: leave it */ }
  }).catch((e) => {
    console.warn('[map] vector map unavailable, using raster tiles', e && e.message);
    addRasterFallback(map);
  });
}
if (DEMO_WHITE_LABEL) document.documentElement.classList.add('demo-nolabel-map');

function startDemoFeed() {
  // Present as connected: the server-side simulator is the feed.
  mqttState.connected = true;
  isLiveMode = true;
  updateConnectionUI('connected');
  const label = document.getElementById('connLabel');
  if (label && DEMO.badge) label.textContent = 'Parallel connection';
  if (DEMO.badge && !document.getElementById('demoBadge')) {
    const live = document.getElementById('liveBadge');
    if (live && live.parentNode) {
      const chip = document.createElement('div');
      chip.id = 'demoBadge';
      chip.className = 'demo-badge';
      chip.title = 'This dashboard runs a parallel data connection, designed for clients because of GDPR';
      chip.textContent = 'PARALLEL CONNECTION';
      live.parentNode.insertBefore(chip, live.nextSibling);
    }
  }
  const poll = () => {
    seedBusPositionsFromAPI().then(() => { try { updateLiveKPIs(); } catch (e) { /* view not ready */ } });
  };
  poll();
  setInterval(poll, 2500);   // matches the demo GPS cadence (stop-and-go motion)
  setInterval(() => seedKPIsFromAPI(), 15000);
}

let mqttState = {
  client: null,
  connected: false,
  connecting: false,
  messageCount: 0,
  lastMessage: null,
};

// Live data from MQTT
let liveDeviceData = {};   // { gatewayKey: { lineIn, lineOut, lat, lng, ts, ... } }
let liveHistory = [];      // Accumulated records for charts — [{ts, lineIn, lineOut, gatewayKey}, ...]
let hourlyBuckets = {};    // { 'HH:00': { boardings: N, alightings: N } }

let currentView = 'overview';
// The chartjs-plugin-datalabels <script> tag exposes window.ChartDataLabels
// but (in this plugin's v2+ build) does NOT auto-register itself with
// Chart.js — it must be registered explicitly. Registering it here makes it
// available globally, so default it OFF everywhere and opt in per-chart via
// `options.plugins.datalabels.display: true` (used by the MoM % change chart).
if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
  Chart.register(ChartDataLabels);
  Chart.defaults.set('plugins.datalabels', { display: false });
}
if (typeof Chart !== 'undefined') {
  // Warm light theme: remap the dark-theme chart colours (light text, white
  // series, faint white grids) to warm, high-contrast equivalents. Runs on
  // every update, so colours set later by renderers are covered too.
  if (document.documentElement.getAttribute('data-theme') === 'warm') {
    Chart.defaults.color = '#57534e';
    Chart.defaults.borderColor = 'rgba(68,52,36,0.10)';
    const TEXT = new Set(['#c9cad8', '#8b8ea5', '#a5a8c1', '#dbdce6', '#e4e5ed', '#9a9cb0', '#e6e7ef', '#cbd5e1', '#94a3b8', '#9ca3af', '#d1d5db', '#e5e7eb', '#f3f4f6']);
    const DARK_EDGE = new Set(['#14151d', '#0f1117', '#161822', '#1c1e2e', 'rgba(10,11,18,0.85)', '#111827', '#0f172a']);
    const parseCol = (k) => {
      let m = k.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
      if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map((x) => x + x).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]; }
      m = k.match(/^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/);
      if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : parseFloat(m[4])];
      if (k === 'white') return [255, 255, 255, 1];
      return null;
    };
    const warmColor = (c, role) => {
      if (typeof c !== 'string') return c;
      const k = c.replace(/\s+/g, '').toLowerCase();
      if (TEXT.has(k)) return role === 'grid' ? 'rgba(68,52,36,0.10)' : '#57534e';
      if (DARK_EDGE.has(k)) return '#ffffff';
      const p = parseCol(k);
      if (!p) return c;
      const [r, g, b, a] = p;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const neutral = (mx - mn) < 48;
      if (neutral && lum > 0.62) {
        // Light neutral built for a dark background
        if (role === 'grid' || a < 0.2) return 'rgba(68,52,36,' + Math.min(0.14, a * 1.8 + 0.04).toFixed(3) + ')';
        if (role === 'text') return '#57534e';
        return 'rgba(30,58,95,' + Math.max(0.55, a) + ')';
      }
      if (neutral && lum < 0.14 && role === 'series' && a > 0.5) return '#ffffff';
      return c;
    };
    const mapVal = (v, role) => {
      if (Array.isArray(v)) return v.map((x) => warmColor(x, role));
      if (typeof v === 'function') { if (v._warm) return v; const f = (...a) => warmColor(v(...a), role); f._warm = true; return f; }
      return warmColor(v, role);
    };
    Chart.register({
      id: 'warmTheme',
      beforeUpdate(chart) {
        const o = chart.options || {};
        Object.values(o.scales || {}).forEach((sc) => {
          if (sc.ticks) sc.ticks.color = mapVal(sc.ticks.color, 'text');
          if (sc.grid) sc.grid.color = mapVal(sc.grid.color, 'grid');
          if (sc.title) sc.title.color = mapVal(sc.title.color, 'text');
          if (sc.pointLabels) sc.pointLabels.color = mapVal(sc.pointLabels.color, 'text');
        });
        const lg = o.plugins && o.plugins.legend && o.plugins.legend.labels;
        if (lg && lg.color) lg.color = mapVal(lg.color, 'text');
        if (o.plugins && o.plugins.datalabels && o.plugins.datalabels.color) o.plugins.datalabels.color = mapVal(o.plugins.datalabels.color, 'text');
        if (o.plugins && o.plugins.title && o.plugins.title.color) o.plugins.title.color = mapVal(o.plugins.title.color, 'text');
        (chart.data.datasets || []).forEach((ds) => {
          ['backgroundColor', 'borderColor', 'pointBackgroundColor', 'pointBorderColor', 'hoverBackgroundColor', 'hoverBorderColor', 'pointHoverBackgroundColor'].forEach((p) => {
            if (ds[p] != null) ds[p] = mapVal(ds[p], 'series');
          });
        });
      },
    });
  }
}

let charts = {};
let maps = {};
let mapMarkers = {};
let dataCurrentPage = 1;
const DATA_PER_PAGE = 50;
let isLiveMode = true;


// ============================================
// LIVE DATA ONLY — No simulated/demo data
// ============================================

// Route colours assigned dynamically to live buses
const ROUTE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16'];
// Default map centre (USA — Minneapolis/Minnesota), used before any live GPS fix arrives
const MAP_DEFAULT_CENTER = [44.9778, -93.2650];
// Last known GPS position from UR35 (used as fallback when GPS has no fix, status 52).
// Must match server.js LAST_KNOWN_GPS so the dashboard and the database agree.
const LAST_KNOWN_GPS = { lat: 44.9778, lng: -93.2650 };

let BUS_POSITIONS = []; // Populated exclusively from MQTT
let liveRecords = [];   // Populated exclusively from MQTT
// Track previous periodic totals per device so we can detect new counts
let prevPeriodicTotals = {};  // { gatewayKey: { in: N, out: N } }


// ============================================
// MQTT CLIENT — Direct connection via MQTT.js
// ============================================

const MQTT_CLIENT = {
  connect() {
    if (mqttState.client) {
      mqttState.client.end(true);
      mqttState.client = null;
    }

    const cfg = configStore.mqtt;
    if (!cfg.host) {
      updateMqttStatus('disconnected', 'No broker host configured');
      return;
    }

    const protocol = cfg.useTls ? 'wss' : 'ws';
    const url = `${protocol}://${cfg.host}:${cfg.port}${cfg.path || '/mqtt'}`;

    mqttState.connecting = true;
    updateConnectionUI('connecting');
    updateMqttStatus('connecting', `Connecting to ${cfg.host}...`);

    try {
      const client = mqtt.connect(url, {
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        clientId: 'sus-dashboard-' + Math.random().toString(16).slice(2, 8),
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        protocolVersion: 4,
      });

      client.on('connect', () => {
        console.log('[MQTT] Connected to', cfg.host);
        mqttState.connected = true;
        mqttState.connecting = false;
        isLiveMode = true;
        updateConnectionUI('connected');
        updateMqttStatus('connected', `Connected to ${cfg.host}`);

        // Subscribe to configured topic
        const topic = cfg.topic || '#';
        client.subscribe(topic, { qos: 0 }, (err) => {
          if (err) {
            console.error('[MQTT] Subscribe error:', err);
            updateMqttStatus('connected', `Connected but subscribe failed: ${err.message}`);
          } else {
            console.log('[MQTT] Subscribed to:', topic);
            updateMqttStatus('connected', `Connected — subscribed to ${topic}`);
          }
        });
      });

      client.on('message', (topic, message) => {
        const raw = message.toString();
        try {
          // Try JSON first (VS125 telemetry, UR35 Active Report)
          const payload = JSON.parse(raw);
          mqttState.messageCount++;
          mqttState.lastMessage = { topic, payload, ts: Date.now() };
          handleMqttMessage(topic, payload);
        } catch (e) {
          // Try NMEA GPS sentences from UR35 GPS MQTT Forward
          if (raw.indexOf('$GP') === 0 || raw.indexOf('$GN') === 0) {
            mqttState.messageCount++;
            const gpsData = parseNmeaSentences(raw);
            if (gpsData && (gpsData.latitude || gpsData.longitude)) {
              mqttState.lastMessage = { topic, payload: gpsData, ts: Date.now() };
              handleMqttMessage(topic, gpsData);
            }
          } else {
            console.warn('[MQTT] Unrecognised message on', topic, ':', raw.slice(0, 200));
          }
        }
      });

      client.on('error', (err) => {
        console.error('[MQTT] Error:', err);
        mqttState.connecting = false;
        updateConnectionUI('disconnected');
        updateMqttStatus('disconnected', `Error: ${err.message}`);
      });

      client.on('close', () => {
        console.log('[MQTT] Disconnected');
        mqttState.connected = false;
        mqttState.connecting = false;
        // isLiveMode stays true if we had data, to keep showing it
        updateConnectionUI('disconnected');
      });

      client.on('reconnect', () => {
        mqttState.connecting = true;
        updateConnectionUI('connecting');
      });

      mqttState.client = client;
    } catch (err) {
      console.error('[MQTT] Connection error:', err);
      mqttState.connecting = false;
      updateConnectionUI('disconnected');
      updateMqttStatus('disconnected', `Connection failed: ${err.message}`);
    }
  },

  disconnect() {
    if (mqttState.client) {
      mqttState.client.end(true);
      mqttState.client = null;
    }
    mqttState.connected = false;
    mqttState.connecting = false;
    updateConnectionUI('disconnected');
    updateMqttStatus('disconnected', 'Disconnected');
  },
};


// ============================================
// MQTT MESSAGE PARSING
// ============================================

function handleMqttMessage(topic, payload) {
  // Determine which bus this belongs to (bus/001/gps → bus/001)
  const gatewayKey = resolveGateway(topic, payload);
  const topicType = topic.split('/').pop(); // 'gps', 'telemetry', 'status', or other
  const now = Date.now();
  const F = CONFIG.vs125Fields;

  // --- GPS data (UR35 JSON or NMEA) ---
  let lat = extractField(payload, F.latitude);
  let lng = extractField(payload, F.longitude);
  if (typeof lat === 'string' && lat.match(/[NSEW]/i)) lat = parseGpsCoord(lat);
  if (typeof lng === 'string' && lng.match(/[NSEW]/i)) lng = parseGpsCoord(lng);
  lat = (lat != null) ? Number(lat) : null;
  lng = (lng != null) ? Number(lng) : null;
  // UR35 GPS status: 53 = valid fix, 52 = no fix (use stale/last-known instead)
  const gpsStatusRaw = extractField(payload, F.gpsStatus);
  const gpsStatus = (gpsStatusRaw != null) ? Number(gpsStatusRaw) : null;
  const hasValidFix = gpsStatus == null ? true : gpsStatus !== 52;
  // Reject impossible coordinates (sensor glitches / partial NMEA parses)
  const inRange = (v, max) => v != null && !isNaN(v) && Math.abs(v) <= max && v !== 0;
  const validLat = inRange(lat, 90) && inRange(lng, 180) && hasValidFix;
  const speed = extractField(payload, F.speed);
  const capacity = extractField(payload, F.capacity);
  const passersby = extractField(payload, F.passersby);

  // --- VS125 people counting data ---
  // Priority 1: Running daily totals (line_total_data — best for KPI headline numbers)
  const dailyIn = extractField(payload, F.totalIn);
  const dailyOut = extractField(payload, F.totalOut);
  // Priority 2: Periodic window (line_periodic_data — per-minute summary for hourly chart)
  const periodicIn = extractField(payload, F.periodicIn);
  const periodicOut = extractField(payload, F.periodicOut);
  // Priority 3: Trigger events (line_trigger_data — individual 0/1 door events)
  const triggerIn = extractField(payload, F.triggerIn);
  const triggerOut = extractField(payload, F.triggerOut);
  // Priority 4: Legacy/flat format
  const legacyIn = extractField(payload, F.lineIn);
  const legacyOut = extractField(payload, F.lineOut);

  // Detect message type — use !== null AND !== undefined
  const hasDailyTotals = dailyIn != null || dailyOut != null;
  const hasPeriodic = periodicIn != null || periodicOut != null;
  const hasTrigger = triggerIn != null || triggerOut != null;
  const hasLegacy = legacyIn != null || legacyOut != null;

  // Debug log for counting messages
  if (hasDailyTotals || hasPeriodic || hasTrigger || hasLegacy) {
    console.log('[MQTT] Counting data:', { gatewayKey, hasDailyTotals, dailyIn, dailyOut, hasPeriodic, periodicIn, periodicOut, hasTrigger, triggerIn, triggerOut });
  }

  // --- Store/update device data ---
  if (!liveDeviceData[gatewayKey]) {
    liveDeviceData[gatewayKey] = {
      lineIn: 0, lineOut: 0, lat: 0, lng: 0, ts: 0,
      capacity: CONFIG.busCapacity, triggerAccumIn: 0, triggerAccumOut: 0,
      // Continuous running occupancy (running-tally model). Seeded from the
      // server's persisted value via /api/live on load (see seedRunningOnboard),
      // then adjusted by each live delta below. Carries across midnight.
      runningOnboard: 0, runningSeeded: false,
    };
  }
  const dev = liveDeviceData[gatewayKey];

  // Update GPS — only accept a real, in-range fix; otherwise keep the previous
  // position. Fall back to last-known only if we have never had a fix.
  if (validLat) {
    dev.lat = lat;
    dev.lng = lng;
    dev.gpsValid = true;
    dev.gpsFixTs = now;
  } else if (lat != null || lng != null) {
    // Coordinates present but invalid (no fix / out of range) — log once for debugging
    console.warn('[GPS] Ignoring invalid coordinates', { gatewayKey, lat, lng, gpsStatus });
  }
  // If device has never had a valid fix, seed with the configured last-known position
  if ((!dev.lat || dev.lat === 0) && LAST_KNOWN_GPS.lat) { dev.lat = LAST_KNOWN_GPS.lat; dev.gpsValid = dev.gpsValid || false; }
  if ((!dev.lng || dev.lng === 0) && LAST_KNOWN_GPS.lng) dev.lng = LAST_KNOWN_GPS.lng;
  if (speed != null) dev.speed = Number(speed) || 0;
  if (capacity != null) dev.capacity = Number(capacity) || CONFIG.busCapacity;
  if (passersby != null) dev.passersby = Number(passersby) || 0;

  // Update passenger counts — ALWAYS accumulate periodic & trigger deltas.
  // line_periodic_data.total.in/out are per-interval deltas — add them every time.
  // line_trigger_data.total.in/out are per-event counts — add them every time.
  // line_total_data is cumulative — used ONLY for authoritative onboard count below.
  // Both door topics (bus/002/door1, bus/002/door2) resolve to same gatewayKey,
  // so accumulating on the shared dev object naturally merges both doors.

  const _cap = dev.capacity || CONFIG.busCapacity;
  const _applyRunning = (dIn, dOut) => {
    // Apply net delta to the continuous running occupancy, clamped [0, capacity].
    dev.runningOnboard = Math.max(0, Math.min(_cap, (dev.runningOnboard || 0) + dIn - dOut));
  };

  if (hasPeriodic) {
    const pIn = Number(periodicIn) || 0;
    const pOut = Number(periodicOut) || 0;
    dev.lineIn += pIn;
    dev.lineOut += pOut;
    _applyRunning(pIn, pOut);
    console.log('[MQTT] Accumulated periodic:', { door: topic, pIn, pOut, dayIn: dev.lineIn, dayOut: dev.lineOut, onboard: dev.runningOnboard });
  }

  if (hasTrigger) {
    const tIn = Number(triggerIn) || 0;
    const tOut = Number(triggerOut) || 0;
    dev.lineIn += tIn;
    dev.lineOut += tOut;
    dev.triggerAccumIn = (dev.triggerAccumIn || 0) + tIn;
    dev.triggerAccumOut = (dev.triggerAccumOut || 0) + tOut;
    _applyRunning(tIn, tOut);
    console.log('[MQTT] Accumulated trigger:', { door: topic, tIn, tOut, dayIn: dev.lineIn, dayOut: dev.lineOut, onboard: dev.runningOnboard });
  }

  // line_total_data: store cumulative for onboard calculation, do NOT overwrite lineIn/lineOut
  if (hasDailyTotals) {
    dev._lastCumIn = Number(dailyIn) || 0;
    dev._lastCumOut = Number(dailyOut) || 0;
    // Authoritative onboard = cumulative in - cumulative out (single door only,
    // but good signal). We store it; updateLiveBusPositions can use it.
    dev._onboardFromTotal = Math.max(0, dev._lastCumIn - dev._lastCumOut);
    console.log('[MQTT] Cumulative totals (for onboard):', { cumIn: dev._lastCumIn, cumOut: dev._lastCumOut, onboard: dev._onboardFromTotal });
  }

  if (hasLegacy && !hasPeriodic && !hasTrigger && !hasDailyTotals) {
    const lIn = Number(legacyIn);
    const lOut = Number(legacyOut);
    if (!isNaN(lIn) && lIn >= 0) dev.lineIn = lIn;
    if (!isNaN(lOut) && lOut >= 0) dev.lineOut = lOut;
  }

  if (topicType === 'gps') dev.gpsTs = now;
  if (topicType === 'telemetry') dev.telTs = now;
  dev.ts = now;
  dev.rawPayload = payload;

  // --- Accumulate hourly data for charts ---
  const hourLabel = new Date(now).getHours();
  const hourKey = `${String(hourLabel).padStart(2, '0')}:00`;
  if (!hourlyBuckets[hourKey]) hourlyBuckets[hourKey] = { boardings: 0, alightings: 0 };

  // Accumulate periodic deltas and trigger events into hourly buckets
  if (hasPeriodic) {
    const pIn = Number(periodicIn) || 0;
    const pOut = Number(periodicOut) || 0;
    if (pIn > 0) hourlyBuckets[hourKey].boardings += pIn;
    if (pOut > 0) hourlyBuckets[hourKey].alightings += pOut;
  }
  if (hasTrigger) {
    const tIn = Number(triggerIn) || 0;
    const tOut = Number(triggerOut) || 0;
    if (tIn > 0) hourlyBuckets[hourKey].boardings += tIn;
    if (tOut > 0) hourlyBuckets[hourKey].alightings += tOut;
  }
  // Note: line_total_data (hasDailyTotals) is NOT added to hourly buckets —
  // it's cumulative and would overwrite the correctly accumulated deltas.

  // --- Append to live history ---
  liveHistory.push({ ts: now, lineIn: dev.lineIn, lineOut: dev.lineOut, gatewayKey, lat: dev.lat, lng: dev.lng });
  if (liveHistory.length > 10000) liveHistory = liveHistory.slice(-5000);

  // --- Append to live records for Data Explorer ---
  const gwConfig = configStore.gateways.find(g => g.topic === gatewayKey || g.label === gatewayKey);
  const busId = gwConfig ? gwConfig.label : gatewayKey;
  const routeId = gwConfig ? (gwConfig.route || '-') : '-';
  // Use the continuous running-onboard (running-tally model) so the Data
  // Explorer record matches the live dashboard occupancy, not the daily net.
  const passengers = (dev.runningOnboard != null)
    ? Math.max(0, Math.min(dev.capacity || CONFIG.busCapacity, dev.runningOnboard))
    : Math.max(0, dev.lineIn - dev.lineOut);
  const occ = dev.capacity > 0 ? Math.min(100, Math.round((passengers / dev.capacity) * 100)) : 0;
  // Per-record event counts (the delta that just arrived)
  const evtIn = (hasPeriodic ? (Number(periodicIn) || 0) : 0) + (hasTrigger ? (Number(triggerIn) || 0) : 0);
  const evtOut = (hasPeriodic ? (Number(periodicOut) || 0) : 0) + (hasTrigger ? (Number(triggerOut) || 0) : 0);

  // Only add record if this is a counting message (not just GPS)
  if (hasDailyTotals || hasPeriodic || hasTrigger || hasLegacy) {
    liveRecords.push({
      timestamp: new Date(now).toISOString().slice(0, 16).replace('T', ' '),
      busId, route: routeId, stop: '-',
      boardings: evtIn, alightings: evtOut,
      onboard: passengers, occupancy: occ,
      lat: dev.lat ? dev.lat.toFixed(5) : '0', lng: dev.lng ? dev.lng.toFixed(5) : '0',
    });
    if (liveRecords.length > 5000) liveRecords = liveRecords.slice(-3000);
  }

  // Trigger UI updates
  onLiveDataUpdate();
}

// Parse UR35 GPS coordinate strings like "53.48076 N" or "2.23743 W"
function parseGpsCoord(str) {
  if (typeof str !== 'string') return parseFloat(str) || 0;
  const match = str.match(/([\d.]+)\s*([NSEW])/i);
  if (!match) return parseFloat(str) || 0;
  let val = parseFloat(match[1]);
  if (match[2].toUpperCase() === 'S' || match[2].toUpperCase() === 'W') val = -val;
  return val;
}

// Parse raw NMEA sentences from UR35 GPS MQTT Forward
// Input can contain multiple lines: $GPRMC, $GPGGA, $GPGSA, $GPGSV
function parseNmeaSentences(raw) {
  const result = { _nmea: true };
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.startsWith('$'));
  for (const line of lines) {
    const parts = line.split('*')[0].split(',');
    const type = parts[0];
    // $GPRMC or $GNRMC — Recommended Minimum (lat, lng, speed, course)
    if (type === '$GPRMC' || type === '$GNRMC') {
      if (parts[2] === 'A') { // A = Active/valid fix
        result.latitude = nmeaLatLng(parts[3], parts[4]);
        result.longitude = nmeaLatLng(parts[5], parts[6]);
        if (parts[7]) result.speed = (parseFloat(parts[7]) * 1.852).toFixed(1) + ' km/h'; // knots to km/h
        if (parts[8]) result.course = parseFloat(parts[8]);
        if (parts[9] && parts[1]) {
          const d = parts[9], t = parts[1];
          result.time = `20${d[4]}${d[5]}-${d[2]}${d[3]}-${d[0]}${d[1]}T${t[0]}${t[1]}:${t[2]}${t[3]}:${t[4]}${t[5]}Z`;
        }
        result.data = { status: 53 }; // Mark as valid GPS
      } else {
        result.data = { status: 52 }; // No valid fix
      }
    }
    // $GPGGA or $GNGGA — Fix quality, altitude, satellites
    if (type === '$GPGGA' || type === '$GNGGA') {
      if (parts[6] && parseInt(parts[6]) > 0) {
        if (!result.latitude && parts[2] && parts[3]) {
          result.latitude = nmeaLatLng(parts[2], parts[3]);
          result.longitude = nmeaLatLng(parts[4], parts[5]);
        }
        result.satellites = parseInt(parts[7]) || 0;
        if (parts[9]) result.altitude = parseFloat(parts[9]);
      }
    }
  }
  return (result.latitude !== undefined) ? result : null;
}

// Convert NMEA lat/lng (ddmm.mmmm, N/S/E/W) to decimal degrees
function nmeaLatLng(coord, dir) {
  if (!coord || !dir) return 0;
  const dotIdx = coord.indexOf('.');
  const degLen = (dir === 'N' || dir === 'S') ? 2 : 3;
  const degrees = parseInt(coord.substring(0, degLen));
  const minutes = parseFloat(coord.substring(degLen));
  let decimal = degrees + (minutes / 60);
  if (dir === 'S' || dir === 'W') decimal = -decimal;
  return decimal;
}

function resolveGateway(topic, payload) {
  // Extract bus base from topic: bus/001/gps -> bus/001, bus/002/door1/telemetry -> bus/002
  const topicParts = topic.split('/');
  if (topicParts.length >= 2 && topicParts[0] === 'bus') {
    let busBase = topicParts.slice(0, 2).join('/');
    // Remap: bus/002 sensors are on the same physical bus as bus/001
    if (configStore.topicMap && configStore.topicMap[busBase]) {
      busBase = configStore.topicMap[busBase];
    }
    // Check if this matches a configured gateway
    for (const gw of configStore.gateways) {
      if (gw.topic && busBase.includes(gw.topic)) return gw.topic;
    }
    return busBase;
  }
  // Check if topic matches a configured gateway
  for (const gw of configStore.gateways) {
    if (gw.topic && topic.includes(gw.topic)) return gw.topic;
  }
  // Check for device identifiers in payload
  if (payload.device_info && payload.device_info.sn) return payload.device_info.sn;
  if (payload.device && payload.device.sn) return payload.device.sn;
  if (payload.device && payload.device.mac) return payload.device.mac;
  if (payload.id) return payload.id; // UR35 uses "id" for device SN
  if (payload.deviceName) return payload.deviceName;
  // Fallback to topic
  return topic;
}

function extractField(obj, fieldPaths) {
  for (const path of fieldPaths) {
    const val = getNestedValue(obj, path);
    if (val !== undefined && val !== null) return val;
  }
  return null;
}

function getNestedValue(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(part)) {
      current = Array.isArray(current) ? current[parseInt(part)] : current[part];
    } else {
      current = current[part];
    }
  }
  return current;
}


// ============================================
// LIVE DATA PROCESSING
// ============================================

function onLiveDataUpdate() {
  updateLiveBusPositions();
  if (currentView === 'overview') { updateLiveKPIs(); updateLiveFleetList(); updateLiveMapMarkers(); }
  if (currentView === 'live-map') updateLiveMapMarkers();
  if (currentView === 'fleet') updateLiveFleetList();
  if (currentView === 'ridership') updateRidershipKPIs();
  if (currentView === 'data-table') renderDataTable();
}

function updateLiveBusPositions() {
  const liveBuses = [];
  const gateways = configStore.gateways.length > 0
    ? configStore.gateways
    : Object.keys(liveDeviceData).map((k, i) => ({ topic: k, label: `GW-${String(i+1).padStart(3,'0')}`, route: '' }));

  gateways.forEach((gw, idx) => {
    const key = gw.topic || Object.keys(liveDeviceData)[idx];
    const data = liveDeviceData[key];
    if (!data) return;

    const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
    // Onboard = CONTINUOUS running occupancy (running-tally model). Seeded from
    // the server's persisted value (/api/live) on load, then adjusted by live
    // deltas. This carries across midnight and matches the backend, unlike a
    // daily (lineIn - lineOut) net which floors to 0 when the day starts full.
    const capacity = data.capacity || CONFIG.busCapacity;
    const passengers = Math.max(0, Math.min(capacity,
      data.runningOnboard != null ? data.runningOnboard
        : Math.max(0, (data.lineIn || 0) - (data.lineOut || 0))));
    const occupancy = capacity > 0 ? Math.min(100, Math.round((passengers / capacity) * 100)) : 0;
    const ageSeconds = data.ts ? Math.round((Date.now() - data.ts) / 1000) : 999;

    // Server-side resolved state for this bus (route, scheduled stop, gpsSource)
    // — always merged in so the map can show a sensible position even when the
    // bus hasn't yet emitted a real GPS fix.
    const srv = SERVER_BUS_STATE[gw.label] || {};
    const lat = (data.lat || 0) || srv.lat || 0;
    const lng = (data.lng || 0) || srv.lng || 0;

    liveBuses.push({
      id: gw.label || key,
      route: gw.route || srv.routeName || '', routeName: gw.route || srv.routeName || '', routeColor: color,
      lat, lng,
      gpsValid: data.gpsValid === true,
      gpsSource: data.gpsValid === true ? 'live' : (srv.gpsSource || 'unknown'),
      stopId: srv.stopId || null,
      currentStopName: srv.gpsLabel || null,
      nextStopName: srv.nextStopName || null,
      gpsAge: data.gpsFixTs ? Math.round((Date.now() - data.gpsFixTs) / 1000) : null,
      passengers, capacity, occupancy,
      speed: data.speed || 0, status: ageSeconds < 300 ? 'active' : 'idle',
      sensorStatus: ageSeconds < 300 ? 'Online' : ageSeconds < 600 ? 'Degraded' : 'Offline',
      lastUpdate: formatAge(ageSeconds),
      lineIn: data.lineIn || 0,
      lineOut: data.lineOut || 0,
      lastEventIn: data.lastEventIn != null ? data.lastEventIn : (data.triggerAccumIn || 0),
      lastEventOut: data.lastEventOut != null ? data.lastEventOut : (data.triggerAccumOut || 0),
    });
  });

  // Add ghost rows for buses the server knows about but MQTT hasn't seen yet,
  // so the map can still display them at their current scheduled stop.
  Object.values(SERVER_BUS_STATE).forEach((srv, i) => {
    const already = liveBuses.find(b => b.id === srv.busId);
    if (already) return;
    if (!srv.lat || !srv.lng) return;
    liveBuses.push({
      id: srv.busId,
      route: srv.routeName || '', routeName: srv.routeName || '',
      routeColor: ROUTE_COLORS[i % ROUTE_COLORS.length],
      lat: srv.lat, lng: srv.lng,
      gpsValid: false, gpsSource: srv.gpsSource || 'unknown',
      stopId: srv.stopId || null,
      currentStopName: srv.gpsLabel || null,
      nextStopName: srv.nextStopName || null,
      gpsAge: null,
      passengers: srv.passengers || 0, capacity: CONFIG.busCapacity,
      occupancy: srv.occupancy || 0,
      speed: srv.speed || 0,
      status: srv.status || 'idle',
      sensorStatus: srv.sensorStatus || 'Offline',
      lastUpdate: srv.lastUpdate != null ? formatAge(srv.lastUpdate) : 'No MQTT yet',
      lineIn: srv.lineIn || 0, lineOut: srv.lineOut || 0,
      lastEventIn: srv.lastEventIn || 0, lastEventOut: srv.lastEventOut || 0,
    });
  });

  BUS_POSITIONS = liveBuses;
}

function formatAge(s) {
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

// ==========================================
// COUNTER RESET FUNCTION (Frontend)
// ==========================================
async function resetBusCounter(busId) {
  if (!confirm(`Reset onboard counter to 0 for bus ${busId}?`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/reset-counter/${encodeURIComponent(busId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.success) {
      // Zero the local continuous running-onboard for every device mapping to
      // this bus so the dashboard reflects the reset immediately (and keep it
      // seeded so the next /api/live poll doesn't re-pull a stale value).
      const gws = (configStore && configStore.gateways) ? configStore.gateways : [];
      gws.filter(g => g.label === busId).forEach(g => {
        const dev = liveDeviceData[g.topic];
        if (dev) { dev.runningOnboard = 0; dev.runningSeeded = true; }
      });
      if (typeof updateLiveBusPositions === 'function') updateLiveBusPositions();
      alert(`Counter reset successfully for ${busId}. Onboard: 0`);
      // Refresh fleet status view
      if (typeof renderFleetTable === 'function') renderFleetTable();
    } else {
      alert('Reset failed: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Error resetting counter: ' + e.message);
  }
}
// Expose for inline onclick handlers in dynamically-rendered fleet rows
window.resetBusCounter = resetBusCounter;

// Authoritative daily totals from the database. These accumulate across the day and
// never reset, unlike the live-fleet snapshot counters. The KPI cards read from these.
let dailyTotals = { boardings: null, alightings: null };

async function seedKPIsFromAPI() {
  try {
    const data = await apiFetch('/api/summary', { period: 'today' });
    if (!data || !data.totals) return;
    const t = data.totals;
    // The DB daily total is authoritative for these two cards. Update unconditionally
    // so a momentary 0 from the live MQTT snapshot can never wipe the real day total.
    dailyTotals.boardings = t.total_boardings || 0;
    dailyTotals.alightings = t.total_alightings || 0;
    setKPI('kpi-total-passengers', dailyTotals.boardings.toLocaleString());
    setKPI('kpi-alightings', dailyTotals.alightings.toLocaleString());
    if (t.avg_occupancy > 0) setKPI('kpi-occupancy', t.avg_occupancy + '%');
  } catch(e) { /* silent fail */ }
}

// ============================================
// STOP REGISTRY (rendered as small pins along each route)
// ============================================
let STOP_REGISTRY_CACHE = null;
const stopMarkers = { overview: [], liveMap: [] };
// Server-resolved bus state keyed by busId. Holds gpsSource/stopId/routeName/
// nextStopName for buses that haven't been seen via MQTT yet, so the map still
// has somewhere to draw them.
let SERVER_BUS_STATE = {};

async function loadStopRegistry() {
  if (STOP_REGISTRY_CACHE) return STOP_REGISTRY_CACHE;
  try {
    const res = await fetch(`${API_BASE}/api/stops`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    STOP_REGISTRY_CACHE = data.routes || {};
    return STOP_REGISTRY_CACHE;
  } catch (e) { return null; }
}

// Colour each route distinctly. Order matches the routes object keys.
// Strong, distinct route colours for the white maps.
const ROUTE_LINE_COLORS = ['#7c3aed', '#ea580c', '#0891b2', '#db2777'];
const MAP_ROUTE_HEX = { '515': '#7c3aed', '419': '#ea580c' };
function mapRouteHex(rk, idx) { return MAP_ROUTE_HEX[String(rk)] || routeColorByIndex(idx || 0); }
function routeColorByIndex(i) { return ROUTE_LINE_COLORS[i % ROUTE_LINE_COLORS.length]; }

// Draw small dot markers for every stop on every route. Idempotent per map.
// Full road-following line for a route when the stop file carries
// per-leg paths (path_to_next); otherwise straight lines between stops.
function routeLinePoints(route) {
  const stops = (route && route.stops) || [];
  const hasPaths = stops.some((s) => Array.isArray(s.path_to_next) && s.path_to_next.length > 1);
  if (!hasPaths) return { pts: stops.map((s) => [s.lat, s.lng]), roads: false };
  const pts = [];
  stops.forEach((s) => {
    if (Array.isArray(s.path_to_next) && s.path_to_next.length > 1) s.path_to_next.forEach((p) => pts.push(p));
    else pts.push([s.lat, s.lng]);
  });
  return { pts, roads: true };
}

// ----- Stop hover card (Live Map + History replay) ------------------------
// Hovering a stop shows its boardings/alightings (both directions): today in
// Live mode, the selected period in History mode, plus "so far" totals at
// the replay time during playback, and an hour-by-hour sparkline.
const STOP_CARD_CACHE = new Map();
let STOP_CARD_POPUP = null;

function stopCardRange() {
  if (typeof HISTORY === 'undefined' || HISTORY.mode !== 'history') {
    const t = displayDateStr(); return { from: t, to: t, label: 'Today' };
  }
  const p = historyParams();
  if (p.date) return { from: p.date, to: p.date, label: prettyDate(p.date) };
  if (p.from && p.to) return { from: p.from, to: p.to, label: p.from === p.to ? prettyDate(p.from) : prettyDate(p.from) + ' \u2013 ' + prettyDate(p.to) };
  const t = displayDateStr(); return { from: t, to: t, label: 'Today' };
}

function stopCardReplayTime() {
  if (typeof HISTORY === 'undefined' || HISTORY.mode !== 'history' || HISTORY.vis !== 'playback') return null;
  const pt = HISTORY.points[HISTORY.playback.idx];
  return pt ? new Date(pt.timestamp) : null;
}

async function stopCardData(routeKey, stopName, opts) {
  const r = (opts && opts.range) ? opts.range() : stopCardRange();
  const until = (opts && opts.range) ? null : stopCardReplayTime();
  // Round the replay time to the minute so scrubbing reuses responses.
  const untilIso = until ? new Date(Math.floor(until.getTime() / 60000) * 60000 + 59999).toISOString() : '';
  const key = [routeKey, stopName, r.from, r.to, untilIso].join('|');
  const hit = STOP_CARD_CACHE.get(key);
  if (hit && Date.now() - hit.t < 30000) return { data: hit.data, range: r, until };
  const data = await apiFetch('/api/stops/stop-detail', { route: routeKey, stop: stopName, from: r.from, to: r.to, until: untilIso || null });
  if (data) STOP_CARD_CACHE.set(key, { t: Date.now(), data });
  if (STOP_CARD_CACHE.size > 300) STOP_CARD_CACHE.delete(STOP_CARD_CACHE.keys().next().value);
  return { data, range: r, until };
}

function stopCardHtml(routeKey, stopName, color, res) {
  const head = `<div class="sc-head"><span class="sc-dot" style="background:${color}"></span><div><div class="sc-name">${escapeHtml(rsStopLabel ? rsStopLabel(stopName) : stopName)}</div><div class="sc-sub">Route ${escapeHtml(routeKey)} \u00b7 ${escapeHtml(res ? res.range.label : '')}</div></div></div>`;
  if (!res) return `<div class="stop-card">${head}<div class="sc-loading">Loading counts\u2026</div></div>`;
  const d = res.data;
  if (!d) return `<div class="stop-card">${head}<div class="sc-loading">Counts unavailable</div></div>`;
  const total = (d.boardings || 0) + (d.alightings || 0);
  let html = `<div class="stop-card">${head}
    <div class="sc-grid">
      <div><div class="sc-num">${(d.boardings || 0).toLocaleString()}</div><div class="sc-lbl">Boardings</div></div>
      <div><div class="sc-num">${(d.alightings || 0).toLocaleString()}</div><div class="sc-lbl">Alightings</div></div>
      <div><div class="sc-num">${total.toLocaleString()}</div><div class="sc-lbl">Total</div></div>
    </div>`;
  if (res.until && d.untilBoardings != null) {
    const t = res.until.toLocaleTimeString('en-GB', { timeZone: DISPLAY_TZ, hour: '2-digit', minute: '2-digit' });
    html += `<div class="sc-replay"><span class="sc-replay-tag">Replay ${t}</span> ${d.untilBoardings.toLocaleString()} on \u00b7 ${d.untilAlightings.toLocaleString()} off so far</div>`;
  }
  // Hour-by-hour sparkline (display time), replay hour highlighted.
  const byHour = new Array(24).fill(0);
  (d.hourly || []).forEach((h) => { byHour[utcHourToDisplayHour(h.hour)] += (h.boardings || 0) + (h.alightings || 0); });
  const first = byHour.findIndex((v) => v > 0), last = 23 - [...byHour].reverse().findIndex((v) => v > 0);
  if (first >= 0) {
    const lo = Math.min(first, 6), hi = Math.max(last, 20);
    const mx = Math.max(...byHour);
    const peakH = byHour.indexOf(mx);
    const rh = res.until ? parseInt(res.until.toLocaleString('en-US', { timeZone: DISPLAY_TZ, hour: '2-digit', hour12: false }), 10) % 24 : -1;
    let bars = '';
    for (let h = lo; h <= hi; h++) {
      const ht = mx ? Math.max(2, Math.round((byHour[h] / mx) * 30)) : 2;
      const cls = h === rh ? ' sc-bar-now' : (res.until && h > rh ? ' sc-bar-future' : '');
      bars += `<span class="sc-bar${cls}" style="height:${ht}px" title="${String(h).padStart(2, '0')}:00 \u00b7 ${byHour[h]}"></span>`;
    }
    html += `<div class="sc-spark">${bars}</div><div class="sc-axis"><span>${String(lo).padStart(2, '0')}:00</span><span>Busiest ${String(peakH).padStart(2, '0')}:00 \u00b7 ${mx}</span><span>${String(hi).padStart(2, '0')}:00</span></div>`;
  } else {
    html += `<div class="sc-loading">No passengers recorded in this period</div>`;
  }
  return html + '</div>';
}

function attachStopHoverCard(marker, routeKey, stopName, color, opts) {
  opts = opts || {};
  let token = 0;
  const open = async () => {
    const map = marker._map; if (!map) return;
    const my = ++token;
    if (!STOP_CARD_POPUP) STOP_CARD_POPUP = L.popup({ closeButton: false, autoPan: false, className: 'stop-card-popup', offset: [0, -6], maxWidth: 300 });
    STOP_CARD_POPUP.setLatLng(marker.getLatLng()).setContent(stopCardHtml(routeKey, stopName, color, null)).openOn(map);
    const res = await stopCardData(routeKey, stopName, opts);
    if (my !== token || !map.hasLayer(STOP_CARD_POPUP)) return;
    STOP_CARD_POPUP.setContent(stopCardHtml(routeKey, stopName, color, res));
    marker._stopCardRefresh = async () => {
      const r2 = await stopCardData(routeKey, stopName, opts);
      if (my === token && map.hasLayer(STOP_CARD_POPUP)) STOP_CARD_POPUP.setContent(stopCardHtml(routeKey, stopName, color, r2));
    };
    STOP_CARD_ACTIVE = marker;
  };
  const close = () => { token++; if (STOP_CARD_POPUP && marker._map) marker._map.closePopup(STOP_CARD_POPUP); if (STOP_CARD_ACTIVE === marker) STOP_CARD_ACTIVE = null; };
  marker.on('mouseover', open);
  marker.on('mouseout', close);
  if (!opts.keepClick) marker.on('click', open);   // touch screens
  // Also open from the permanent stop-name label.
  marker.on('tooltipopen', (e) => {
    const el = e.tooltip && e.tooltip.getElement && e.tooltip.getElement();
    if (el && !el._scWired) { el._scWired = true; el.style.pointerEvents = 'auto'; el.addEventListener('mouseenter', open); el.addEventListener('mouseleave', close); }
  });
}
let STOP_CARD_ACTIVE = null;

// Routes & Stops: cards follow the page's Period selection.
const RS_CARD_OPTS = { keepClick: true, range: () => ({ from: RS.from, to: RS.to, label: rsRangeLabel() }) };

// ----- Map readability helpers -------------------------------------------
// Route colour key (demo road routes) so stop labels don't need route ids.
const ROUTE_KEYS = {};
const ROUTE_LAYERS = {};   // mapKey -> routeKey -> { line, markers }
const ROUTE_FOCUS = {};    // mapKey -> focused routeKey (or null)

// Live Map (demo): an interactive route key. Each row shows the Manchester
// route name, its two end stops and where the bus is now; clicking a row
// zooms to that route and fades the other one.
function rkTermini(route) {
  const stops = (route.stops || []).map((x) => String(x.name || '')).filter((n) => !/\((return|rtn)\)\s*$/i.test(n));
  if (stops.length < 2) return '';
  const first = rsStopLabel(stops[0]), last = rsStopLabel(stops[stops.length - 1]);
  return first === last ? first : first + ' \u2194 ' + last;
}
function rkFocusRoute(map, mapKey, rk) {
  const layers = ROUTE_LAYERS[mapKey] || {};
  ROUTE_FOCUS[mapKey] = (ROUTE_FOCUS[mapKey] === rk) ? null : rk;
  const f = ROUTE_FOCUS[mapKey];
  Object.entries(layers).forEach(([k, l]) => {
    const on = !f || k === f;
    if (l.line && mapKey === 'liveMap') { l.line.setStyle({ opacity: f && on ? 0.55 : 0 }); }
    else if (l.line) { l.line.setStyle({ opacity: on ? 0.9 : 0.15, weight: f && on ? 6 : 4 }); if (f && on) l.line.bringToFront(); }
    l.markers.forEach((m) => { const el = m.getElement && m.getElement(); if (el) el.style.opacity = on ? '' : '0.2'; const t = m.getTooltip && m.getTooltip(); const te = t && t.getElement && t.getElement(); if (te) te.style.opacity = on ? '' : '0'; });
  });
  const box = ROUTE_KEYS[mapKey] && ROUTE_KEYS[mapKey].getContainer();
  if (box) {
    box.querySelectorAll('.rk-card').forEach((el) => { el.classList.toggle('active', el.dataset.rk === f); el.classList.toggle('dim', !!f && el.dataset.rk !== f); });
    const all = box.querySelector('.rk-all'); if (all) all.hidden = !f;
  }
  try {
    let b = null;
    Object.entries(layers).forEach(([k, l]) => { if (l.line && (!f || k === f)) { b = b ? b.extend(l.line.getBounds()) : L.latLngBounds(l.line.getBounds().getSouthWest(), l.line.getBounds().getNorthEast()); } });
    if (b) map.flyToBounds(b, { padding: [50, 50], maxZoom: 15, duration: 0.6 });
  } catch (e) { /* noop */ }
}
function rkLiveText(route, rk) {
  const ids = ((route.bus_ids && route.bus_ids.length) ? route.bus_ids : [rk]).map(String);
  const b = (BUS_POSITIONS || []).find((x) => ids.includes(String(x.id)) || ids.includes(String(x.id).slice(-3)));
  if (!b) return '<span class="rk-live off">No bus reporting</span>';
  const next = b.nextStopName ? rsStopLabel(String(b.nextStopName)) : '';
  const cap = b.capacity || CONFIG.busCapacity;
  return '<span class="rk-live"><i></i>' + (next ? 'Next: ' + escapeHtml(next) : 'In service') + '<small>' + (b.passengers || 0) + '/' + cap + ' onboard</small></span>';
}
function refreshRouteKeyLive() {
  const ctl = ROUTE_KEYS.liveMap; if (!ctl || !STOP_REGISTRY_CACHE) return;
  const box = ctl.getContainer(); if (!box) return;
  box.querySelectorAll('.rk-card').forEach((el) => { const r = STOP_REGISTRY_CACHE[el.dataset.rk]; const t = el.querySelector('.rk-live-wrap'); if (r && t) t.innerHTML = rkLiveText(r, el.dataset.rk); });
}
setInterval(() => { try { refreshRouteKeyLive(); } catch (e) { /* noop */ } }, 2000);
function addInteractiveRouteKey(map, mapKey, routes) {
  const cards = [];
  let idx = 0;
  for (const [rk, route] of Object.entries(routes)) {
    const line = routeLinePoints(route);
    const color = mapRouteHex(rk, idx);
    idx++;
    if (!line.roads) continue;
    const nStops = (route.stops || []).filter((x) => !/\((return|rtn)\)\s*$/i.test(String(x.name || ''))).length;
    cards.push(`<button type="button" class="rk-card" data-rk="${escapeHtml(rk)}" style="--rk:${color}" title="Show route ${escapeHtml(rk)} on the map">
      <span class="rk-badge">${escapeHtml(rk)}</span>
      <span class="rk-body"><b>${escapeHtml(rsRouteShortName(route) || ('Route ' + rk))}</b>
        <span class="rk-ends">${escapeHtml(rkTermini(route))} \u00b7 ${nStops} stops</span>
        <span class="rk-live-wrap">${rkLiveText(route, rk)}</span></span></button>`);
  }
  if (!cards.length) return false;
  const ctl = L.control({ position: 'topright' });
  ctl.onAdd = () => {
    const d = L.DomUtil.create('div', 'route-key route-key-live');
    d.innerHTML = `<div class="rk-head"><span>Bus routes <em>click to focus</em></span><button type="button" class="rk-all" hidden>Show all</button></div>` + cards.join('');
    L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
    d.querySelectorAll('.rk-card').forEach((el) => el.addEventListener('click', () => rkFocusRoute(map, mapKey, el.dataset.rk)));
    d.querySelector('.rk-all').addEventListener('click', () => { if (ROUTE_FOCUS[mapKey]) rkFocusRoute(map, mapKey, ROUTE_FOCUS[mapKey]); });
    return d;
  };
  ctl.addTo(map);
  ROUTE_KEYS[mapKey] = ctl;
  ROUTE_FOCUS[mapKey] = null;
  return true;
}
function addRouteKey(map, mapKey, routes) {
  if (!map || !routes) return;
  if (mapKey === 'liveMap' && DEMO) {
    if (ROUTE_KEYS[mapKey]) { try { map.removeControl(ROUTE_KEYS[mapKey]); } catch (e) { /* noop */ } delete ROUTE_KEYS[mapKey]; }
    if (addInteractiveRouteKey(map, mapKey, routes)) return;
  }
  const rows = [];
  let idx = 0;
  for (const [rk, route] of Object.entries(routes)) {
    const line = routeLinePoints(route);
    const color = mapRouteHex(rk, idx);
    idx++;
    if (!line.roads) continue;
    rows.push(`<div class="rk-row"><span class="rk-line" style="background:${color}"></span><span class="rk-id">${escapeHtml(rk)}</span><span>${escapeHtml(rsRouteShortName(route) || ('Route ' + rk))}</span></div>`);
  }
  if (ROUTE_KEYS[mapKey]) { try { map.removeControl(ROUTE_KEYS[mapKey]); } catch (e) { /* noop */ } delete ROUTE_KEYS[mapKey]; }
  if (!rows.length) return;
  const ctl = L.control({ position: 'topright' });
  ctl.onAdd = () => { const d = L.DomUtil.create('div', 'route-key'); d.innerHTML = rows.join(''); L.DomEvent.disableClickPropagation(d); return d; };
  ctl.addTo(map);
  ROUTE_KEYS[mapKey] = ctl;
}

// Hide permanent stop labels that would overlap another label or a bus.
// Terminal / earlier labels win; hidden ones still show via the hover card.
function declutterMapLabels(map) {
  const c = map && map.getContainer && map.getContainer();
  if (!c || !c.offsetParent) return;
  const kept = [];
  c.querySelectorAll('.live-bus-icon, .leaflet-control .route-key').forEach((el) => {
    const r = el.getBoundingClientRect(); if (r.width) kept.push(r);
    const nx = el.querySelector && el.querySelector('.bus-next'); if (nx) { const r2 = nx.getBoundingClientRect(); if (r2.width) kept.push(r2); }
  });
  const pad = 3;
  const hit = (a, b) => !(a.right + pad < b.left || a.left - pad > b.right || a.bottom + pad < b.top || a.top - pad > b.bottom);
  c.querySelectorAll('.leaflet-tooltip.stop-name-label').forEach((el) => {
    el.classList.remove('label-hidden');
    const r = el.getBoundingClientRect();
    if (kept.some((k) => hit(r, k))) el.classList.add('label-hidden');
    else kept.push(r);
  });
}
const DECLUTTER_T = new WeakMap();
function declutterSoon(map) {
  if (!map) return;
  if (!map._declutterWired) {
    map._declutterWired = true;
    map.on('zoomend moveend resize', () => declutterSoon(map));
  }
  clearTimeout(DECLUTTER_T.get(map));
  DECLUTTER_T.set(map, setTimeout(() => declutterMapLabels(map), 120));
}
// Buses move continuously, so re-check the Live Map once a second.
setInterval(() => { try { if (maps.liveMap) declutterMapLabels(maps.liveMap); if (maps.overview) declutterMapLabels(maps.overview); } catch (e) { /* noop */ } }, 1000);

async function renderStopsOnMap(map, mapKey) {
  if (!map) return;
  if (DEMO) map.options.zoomSnap = 0.25;   // frame the routes snugly
  const routes = await loadStopRegistry();
  if (!routes) return;
  // Clear existing stop markers for this map.
  (stopMarkers[mapKey] || []).forEach(m => map.removeLayer(m));
  stopMarkers[mapKey] = [];
  ROUTE_LAYERS[mapKey] = {};
  let idx = 0;
  for (const [routeKey, route] of Object.entries(routes)) {
    const line = routeLinePoints(route);
    const rl = ROUTE_LAYERS[mapKey][routeKey] = { line: null, markers: [] };
    // Road-path routes (demo) use the same per-route colours as the Route map.
    const color = mapRouteHex(routeKey, idx);
    idx++;
    if (line.roads && line.pts.length > 1) {
      // Live map: no permanent route lines (they cluttered the view); the
      // buses' trails show where they have been. The line stays as an
      // invisible layer for framing, and shows as a faint guide on focus.
      const live = mapKey === 'liveMap';
      rl.line = L.polyline(line.pts, live
        ? { color, weight: 3, opacity: 0, dashArray: '1 7', lineCap: 'round', interactive: false, lineJoin: 'round', className: 'route-guide' }
        : { color, weight: 4, opacity: 0.85, interactive: false, lineJoin: 'round' }).addTo(map);
      stopMarkers[mapKey].push(rl.line);
    }
    (route.stops || []).forEach((s, sIdx) => {
      const isTerminal = sIdx === 0 || sIdx === route.stops.length - 1;
      const dotIcon = L.divIcon({
        className: '',
        html: `<div class="stop-dot ${isTerminal ? 'stop-dot-terminal' : ''}" style="--stop-color:${color}" title="${s.name}"></div>`,
        iconSize: isTerminal ? [14, 14] : [10, 10],
        iconAnchor: isTerminal ? [7, 7] : [5, 5],
      });
      const isReturn = /\((return|rtn)\)\s*$/i.test(s.name || '');
      const showName = line.roads && !isReturn; // demo: name every stop on the map
      const m = L.marker([s.lat, s.lng], { icon: dotIcon }).addTo(map)
        .bindTooltip(showName
          ? `${escapeHtml(rsStopLabel(s.name))}`
          : `<strong>${s.name}</strong><br><span style="opacity:0.7">Route ${routeKey}</span>`,
          showName ? { permanent: true, direction: 'right', offset: [8, 0], className: 'stop-name-label' } : { direction: 'top', offset: [0, -6] });
      if (mapKey === 'liveMap') {
        // Both directions share one card; the return stop's plain hover tip
        // would sit on top of it, so drop that tip on demo road routes.
        if (isReturn && line.roads) m.unbindTooltip();
        attachStopHoverCard(m, routeKey, String(s.name).replace(/\s*\((return|rtn)\)\s*$/i, ''), color);
      }
      stopMarkers[mapKey].push(m);
      rl.markers.push(m);
    });
  }
  addRouteKey(map, mapKey, routes);
  declutterSoon(map);
  // Demo road routes: frame both whole routes once, so every stop is in view.
  if (DEMO && !mapAutoFitted[mapKey + ':routes']) {
    const lines = stopMarkers[mapKey].filter((l) => l instanceof L.Polyline);
    if (lines.length) {
      const b = lines[0].getBounds();
      lines.forEach((l) => b.extend(l.getBounds()));
      mapAutoFitted[mapKey + ':routes'] = true;
      mapAutoFitted[mapKey] = true; // the bus auto-fit must not zoom back in
      setTimeout(() => { try { map.invalidateSize(); map.fitBounds(b, { padding: [40, 40], maxZoom: 15 }); } catch (e) { /* noop */ } }, 150);
    }
  }
}

// Merge the server's resolved live state into BUS_POSITIONS so the map always
// has somewhere to draw each bus (current scheduled stop) until MQTT data
// arrives. Called on the same 30s cadence as the other API seeders.
async function seedBusPositionsFromAPI() {
  try {
    const res = await fetch(`${API_BASE}/api/live`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.buses)) return;
    SERVER_BUS_STATE = {};
    data.buses.forEach(b => { SERVER_BUS_STATE[b.busId] = b; });
    updateLiveBusPositions();
    if (currentView === 'overview' || currentView === 'live-map') updateLiveMapMarkers();
    if (currentView === 'overview' || currentView === 'fleet') updateLiveFleetList && updateLiveFleetList();
  } catch (e) { /* silent */ }
}

// Seed the frontend's continuous running-onboard from the server's persisted
// value (/api/live). Runs once per device: the server holds the authoritative
// running tally (carried across midnight & redeploys); the browser only sees
// deltas since it loaded, so it must adopt the server baseline before applying
// its own live deltas. Guarded by runningSeeded so we never clobber live counts.
async function seedRunningOnboardFromAPI() {
  try {
    const res = await fetch(`${API_BASE}/api/live`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.buses)) return;
    // Map server busId -> onboard, then apply to matching local devices by label.
    const byBus = {};
    data.buses.forEach(b => { byBus[b.busId] = b.onboard || 0; });
    const gws = (configStore && configStore.gateways) ? configStore.gateways : [];
    Object.keys(liveDeviceData).forEach(key => {
      const dev = liveDeviceData[key];
      if (dev.runningSeeded) return;
      // Resolve this device's label the same way updateLiveBusPositions does.
      const gw = gws.find(g => g.topic === key);
      const label = gw ? gw.label : null;
      if (label && byBus[label] != null) {
        dev.runningOnboard = byBus[label];
        dev.runningSeeded = true;
      }
    });
  } catch (e) { /* silent fail — live deltas still work without a seed */ }
}

function updateLiveKPIs() {
  const active = BUS_POSITIONS.filter(b => b.status === 'active');
  const totalIn = BUS_POSITIONS.reduce((s,b) => s + (b.lineIn || 0), 0);
  const totalOut = BUS_POSITIONS.reduce((s,b) => s + (b.lineOut || 0), 0);
  const avgOcc = active.length > 0 ? Math.round(active.reduce((s,b) => s+b.occupancy, 0)/active.length) : 0;

  // "Total Passengers Today" and "Alightings Today" reflect the authoritative daily DB
  // total (set by seedKPIsFromAPI). The live-fleet snapshot (totalIn/totalOut) can be 0
  // momentarily, so we only ever raise the card above the known daily total, never below it.
  if (dailyTotals.boardings !== null) {
    setKPI('kpi-total-passengers', Math.max(dailyTotals.boardings, totalIn).toLocaleString());
  } else {
    setKPI('kpi-total-passengers', totalIn > 0 ? totalIn.toLocaleString() : (mqttState.connected ? '0' : '—'));
  }
  if (dailyTotals.alightings !== null) {
    setKPI('kpi-alightings', Math.max(dailyTotals.alightings, totalOut).toLocaleString());
  } else {
    setKPI('kpi-alightings', totalOut > 0 ? totalOut.toLocaleString() : (mqttState.connected ? '0' : '—'));
  }
  setKPI('kpi-active-buses', BUS_POSITIONS.length > 0 ? active.length : (mqttState.connected ? '0' : '—'));
  setKPI('kpi-avg-occupancy', BUS_POSITIONS.length > 0 ? avgOcc + '%' : (mqttState.connected ? '0%' : '—'));
  const sub = document.getElementById('kpi-fleet-sub');
  if (sub) sub.textContent = BUS_POSITIONS.length > 0 ? `of ${BUS_POSITIONS.length} total fleet` : (mqttState.connected ? 'Waiting for bus data' : 'Waiting for MQTT data');

  // Current Onboard KPI — sum of live running occupancy across the fleet.
  const totalOnboard = BUS_POSITIONS.reduce((s, b) => s + (b.passengers || 0), 0);
  const totalCap = BUS_POSITIONS.reduce((s, b) => s + (b.capacity || CONFIG.busCapacity), 0);
  setKPI('kpi-onboard', BUS_POSITIONS.length > 0 ? totalOnboard.toLocaleString() : (mqttState.connected ? '0' : '—'));
  const onboardSub = document.getElementById('kpi-onboard-sub');
  if (onboardSub && totalCap > 0) onboardSub.textContent = `of ${totalCap} seats (${Math.round((totalOnboard/totalCap)*100)}%)`;

  // Refresh the live overview analytics (gauge + cumulative + net flow).
  updateOverviewAnalytics();
}

function setKPI(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }

function updateLiveFleetList() {
  if (document.getElementById('fleetList')) renderFleetList();
  if (document.getElementById('fleetTableBody') && currentView === 'fleet') { updateFleetKPIs(); renderFleetTable(); }
}

function updateLiveMapMarkers() {
  if (maps.overview) updateMapBusMarkers(maps.overview, 'overview');
  if (maps.liveMap) updateMapBusMarkers(maps.liveMap, 'liveMap');
}

// Tracks which maps have already auto-centred on a live bus, so we only do it once
// (and never fight the user's manual pan/zoom afterwards).
const mapAutoFitted = {};

// ----- Smooth bus motion + fading trail ----------------------------------
// Markers are kept per bus (not rebuilt each poll). When a new position
// arrives the marker glides to it over the poll interval, following the
// route's road path when one exists, and leaves a fading coloured trail.
const BUS_ANIM = {};           // mapKey -> busId -> { marker, trail[], segs[], from, path, t0, dur }
const BUS_ANIM_MS = 2500;      // matches the demo feed poll / GPS cadence
const TRAIL_MS = 3 * 60 * 1000; // backfill span on first sight
const TRAIL_MAX_MS = 8 * 60 * 1000; // hard cap on trail age
const TRAIL_M = 2400;          // trail length in metres (kept while the bus is stopped)
const TRAIL_SEGS = 16;         // trail drawn as segments of falling opacity
let busAnimRaf = null;
// Leaflet rounds marker positions to whole pixels; at city zoom a bus moves
// well under a pixel per frame, so that made it hop. Keep sub-pixel.
// Buses sit in their own pane above stop-name labels (tooltipPane is 650)
// but below popups (700), so a label never covers a bus.
function busPane(map) {
  if (!map.getPane('busPane')) { const p = map.createPane('busPane'); p.style.zIndex = 660; }
  return 'busPane';
}
const SmoothBusMarker = L.Marker.extend({
  update() {
    if (this._icon && this._map) {
      const pos = this._map.project(this._latlng)._subtract(this._map.getPixelOrigin());
      this._setPos(pos);
      // Leaflet derives z-index from pos.y; a fractional value is invalid CSS
      // and would drop the bus below stop markers, so round it.
      const z = Math.round(pos.y + (this.options.zIndexOffset || 0));
      this._icon.style.zIndex = z;
      if (this._shadow) this._shadow.style.zIndex = z;
    }
    return this;
  },
});

// Stop registry from either the Routes page or the map loader.
function busRouteFor(busId) {
  const reg = STOPS_REGISTRY || STOP_REGISTRY_CACHE;
  if (!reg) return null;
  for (const [k, r] of Object.entries(reg)) {
    if (String(k) === String(busId) || (r.bus_ids || []).map(String).includes(String(busId))) return r;
  }
  return null;
}

function geoDist(a, b) {
  return Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));
}

// Road path between two points along a route polyline (forward, wrapping
// the loop). Returns null when the points are not on the route or the hop
// is implausibly long, in which case we glide in a straight line.
function busRoadPath(busId, from, to) {
  const route = busRouteFor(busId);
  if (!route) return null;
  const line = routeLinePoints(route);
  if (!line.roads || line.pts.length < 2) return null;
  const pts = line.pts;
  const nearest = (p) => { let bi = 0, bd = Infinity; for (let i = 0; i < pts.length; i++) { const d = geoDist(p, pts[i]); if (d < bd) { bd = d; bi = i; } } return [bi, bd]; };
  const [i0, d0] = nearest(from), [i1, d1] = nearest(to);
  if (d0 > 80 || d1 > 80) return null;
  const out = [from]; let len = 0; let i = i0; let guard = 0;
  while (i !== i1 && guard++ < pts.length) { i = (i + 1) % pts.length; len += geoDist(out[out.length - 1], pts[i]); out.push(pts[i]); }
  out.push(to);
  if (len > 1500) return null;
  return out;
}

// On first sight, backfill the trail with the road the bus has just
// driven (one trail length behind it) so the trail is visible straight away.
function busBackfillTrail(busId, pos, now) {
  try {
    const route = busRouteFor(busId);
    const line = route && routeLinePoints(route);
    if (!line || !line.roads) return [[pos[0], pos[1], now]];
    const pts = line.pts; let bi = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = geoDist(pos, p); if (d < bd) { bd = d; bi = i; } });
    if (bd > 80) return [[pos[0], pos[1], now]];
    const back = [pos]; let len = 0, i = bi;
    for (let g = 0; g < pts.length && len < TRAIL_M; g++) { i = (i - 1 + pts.length) % pts.length; len += geoDist(back[back.length - 1], pts[i]); back.push(pts[i]); }
    const span = TRAIL_MS * 0.9; let acc = 0; const out = [[pos[0], pos[1], now]];
    for (let k = 1; k < back.length; k++) { acc += geoDist(back[k - 1], back[k]); out.push([back[k][0], back[k][1], now - span * (acc / Math.max(len, 1))]); }
    return out.reverse();
  } catch (e) { return [[pos[0], pos[1], now]]; }
}

function pathPointAt(path, f) {
  if (path.length < 2) return path[0];
  const seg = []; let total = 0;
  for (let i = 1; i < path.length; i++) { const d = geoDist(path[i - 1], path[i]); seg.push(d); total += d; }
  if (total === 0) return path[path.length - 1];
  let want = total * Math.max(0, Math.min(1, f));
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const k = seg[i] ? want / seg[i] : 1;
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * k, path[i][1] + (path[i + 1][1] - path[i][1]) * k];
    }
    want -= seg[i];
  }
  return path[path.length - 1];
}

// Trail in the bus's own route colour (same colours as the route key).
function busTrailColor(bus) {
  const reg = STOPS_REGISTRY || STOP_REGISTRY_CACHE;
  if (reg && bus) {
    let idx = 0;
    for (const [k, r] of Object.entries(reg)) {
      if (String(k) === String(bus.id) || (r.bus_ids || []).map(String).includes(String(bus.id))) return mapRouteHex(k, idx);
      idx++;
    }
  }
  return '#2563eb';
}

// Fading comet trail: the last ~2.4 km the bus drove, split by distance into
// segments that fade and taper towards the tail. Distance-based, so it stays
// put while the bus is paused instead of shrinking away.
function drawBusTrail(map, st, now) {
  const ll = st.marker.getLatLng();
  const head = [ll.lat, ll.lng, now];
  // Trim by distance from the head, then by a generous age cap.
  let acc = 0, cut = 0;
  for (let i = st.trail.length - 1; i > 0; i--) {
    acc += geoDist(st.trail[i], st.trail[i - 1]);
    if (acc > TRAIL_M) { cut = i - 1; break; }
  }
  if (cut > 0) st.trail = st.trail.slice(cut);
  st.trail = st.trail.filter((p) => now - p[2] <= TRAIL_MAX_MS);
  st.segs.forEach((l) => map.removeLayer(l)); st.segs = [];
  if (st.trail.length < 1) return;
  const pts = st.trail.concat([head]);
  // Cumulative distance from tail to head.
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + geoDist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  if (total < 5) return;
  const glow = L.polyline(pts.map((p) => [p[0], p[1]]), {
    color: st.color, weight: 16, opacity: 0.12, lineCap: 'round', lineJoin: 'round', interactive: false, className: 'bus-trail bus-trail-glow',
  }).addTo(map);
  st.segs.push(glow);
  let j = 0;
  for (let s = 0; s < TRAIL_SEGS; s++) {
    const d0 = total * s / TRAIL_SEGS, d1 = total * (s + 1) / TRAIL_SEGS;
    const chunk = [];
    while (j < pts.length - 1 && cum[j + 1] < d0) j++;
    const at = (d) => { let k = j; while (k < pts.length - 1 && cum[k + 1] < d) k++; const seg = cum[k + 1] - cum[k] || 1; const t = Math.max(0, Math.min(1, (d - cum[k]) / seg)); const q = pts[Math.min(k + 1, pts.length - 1)]; return [pts[k][0] + (q[0] - pts[k][0]) * t, pts[k][1] + (q[1] - pts[k][1]) * t]; };
    chunk.push(at(d0));
    for (let k = j + 1; k < pts.length && cum[k] < d1; k++) chunk.push([pts[k][0], pts[k][1]]);
    chunk.push(at(d1));
    const f = (s + 1) / TRAIL_SEGS;          // tail -> head: fainter/thinner -> solid
    const e = f * f;
    st.segs.push(L.polyline(chunk, {
      color: st.color, weight: 1.5 + 5 * f, opacity: 0.04 + 0.9 * e, lineCap: s === TRAIL_SEGS - 1 ? 'round' : 'butt', lineJoin: 'round', interactive: false, className: 'bus-trail',
    }).addTo(map));
  }
}

// Mark the bus marker as moving or stopped (pulse ring while stopped).
function busSetMoving(st, moving) {
  if (st.moving === moving) return;
  st.moving = moving;
  const el = st.marker.getElement && st.marker.getElement();
  if (el) { el.classList.toggle('bus-is-moving', moving); el.classList.toggle('bus-is-stopped', !moving); }
}

function busAnimFrame() {
  busAnimRaf = null;
  const now = performance.now(); let moving = false;
  Object.entries(BUS_ANIM).forEach(([mapKey, buses]) => {
    const map = maps[mapKey]; if (!map) return;
    Object.values(buses).forEach((st) => {
      if (!st.path) return;
      const f = Math.min(1, (now - st.t0) / st.dur);
      const p = pathPointAt(st.path, f);
      st.marker.setLatLng(p);
      if (now - (st.lastTrail || 0) > 250 || f >= 1) {
        const last = st.trail[st.trail.length - 1];
        if (!last || geoDist(last, p) > 4) st.trail.push([p[0], p[1], now]);
        st.lastTrail = now;
        drawBusTrail(map, st, now);
      }
      if (f >= 1) st.path = null; else moving = true;
    });
  });
  if (moving) busAnimRaf = requestAnimationFrame(busAnimFrame);
}

function busPopupHtml(bus) {
  const gpsLabelMap = { live: 'Live GPS', cached: 'Last known', stop: 'At scheduled stop', static: 'Depot (static)', depot: 'Depot fallback', unknown: 'Unknown' };
  const gpsLabel = gpsLabelMap[bus.gpsSource] || (bus.gpsValid ? 'Live GPS' : 'No fix');
  const stopLine = bus.currentStopName
    ? `<span class="popup-label">Current stop</span><span class="popup-value">${bus.currentStopName}</span>` +
      (bus.nextStopName ? `<span class="popup-label">Next stop</span><span class="popup-value">${bus.nextStopName}</span>` : '')
    : '';
  const routeHeader = bus.routeName ? ` — ${bus.routeName}` : (bus.route ? ' — Route ' + bus.route : '');
  return `
        <div class="bus-popup">
          <h4>${bus.id}${routeHeader}</h4>
          <div class="popup-grid">
            <span class="popup-label">Passengers</span><span class="popup-value">${bus.passengers}/${bus.capacity}</span>
            <span class="popup-label">Occupancy</span><span class="popup-value">${bus.occupancy}%</span>
            ${stopLine}
            <span class="popup-label">In (Total)</span><span class="popup-value">${bus.lineIn || 0}</span>
            <span class="popup-label">Out (Total)</span><span class="popup-value">${bus.lineOut || 0}</span>
            <span class="popup-label">Sensor</span><span class="popup-value">${bus.sensorStatus}</span>
            <span class="popup-label">GPS</span><span class="popup-value">${gpsLabel}${bus.gpsAge != null ? ' (' + formatAge(bus.gpsAge) + ')' : ''}</span>
            <span class="popup-label">Position</span><span class="popup-value">${bus.lat.toFixed(5)}, ${bus.lng.toFixed(5)}</span>
            <span class="popup-label">Last Update</span><span class="popup-value">${bus.lastUpdate}</span>
          </div>
        </div>
      `;
}

function updateMapBusMarkers(map, mapKey) {
  // A rebuilt map instance starts with fresh markers and trails.
  if (BUS_ANIM[mapKey] && BUS_ANIM[mapKey].__map !== map) delete BUS_ANIM[mapKey];
  if (!BUS_ANIM[mapKey]) { BUS_ANIM[mapKey] = {}; Object.defineProperty(BUS_ANIM[mapKey], '__map', { value: map, enumerable: false }); }
  const state = BUS_ANIM[mapKey];
  mapMarkers[mapKey] = [];

  const plotted = BUS_POSITIONS.filter(b => (b.status === 'active' || b.status === 'idle') && b.lat !== 0 && b.lng !== 0);
  const seen = new Set();
  const now = performance.now();
  plotted.forEach(bus => {
    seen.add(bus.id);
    const occClass = bus.occupancy > 75 ? 'high-occupancy' : bus.occupancy > 50 ? 'medium-occupancy' : '';
    const shortId = bus.id.length > 3 ? bus.id.slice(-3) : bus.id;
    let nextHtml = '';
    if (DEMO && bus.nextStopName && mapKey === 'liveMap') {
      const dest = rsStopLabel(String(bus.nextStopName));
      nextHtml = `<div class="bus-next"><span class="bus-next-arrow">&rarr;</span>${escapeHtml(dest)}</div>`;
    }
    const iconHtml = `<div class="bus-marker ${occClass}">${shortId}</div>${nextHtml}`;
    const target = [bus.lat, bus.lng];
    let st = state[bus.id];
    if (!st) {
      const marker = new SmoothBusMarker(target, { pane: busPane(map), icon: L.divIcon({ className: 'live-bus-icon', html: iconHtml, iconSize: [32, 32], iconAnchor: [16, 16] }), zIndexOffset: 1000 }).addTo(map);
      st = state[bus.id] = { marker, iconHtml, trail: busBackfillTrail(bus.id, target, now), backfilled: !!busRouteFor(bus.id), segs: [], path: null, color: busTrailColor(bus), target };
      busSetMoving(st, false);
      const ring = marker.getElement && marker.getElement(); if (ring) ring.style.setProperty('--bus-route', st.color);
      marker.bindPopup(busPopupHtml(bus));
      drawBusTrail(map, st, now);
    } else {
      if (st.iconHtml !== iconHtml) { st.marker.setIcon(L.divIcon({ className: 'live-bus-icon', html: iconHtml, iconSize: [32, 32], iconAnchor: [16, 16] })); st.iconHtml = iconHtml; const m0 = st.moving; st.moving = undefined; busSetMoving(st, !!m0); }
      st.marker.setPopupContent(busPopupHtml(bus));
      st.color = busTrailColor(bus);
      { const el = st.marker.getElement && st.marker.getElement(); if (el) el.style.setProperty('--bus-route', st.color); }
      if (!st.backfilled && busRouteFor(bus.id)) {
        const cur = st.marker.getLatLng();
        const bf = busBackfillTrail(bus.id, [cur.lat, cur.lng], now);
        if (bf.length > 1) st.trail = bf;
        st.backfilled = true;
      }
      busSetMoving(st, Number(bus.speed) > 0.3);
      if (!st.target || geoDist(st.target, target) > 1) {
        const cur = st.marker.getLatLng(); const from = [cur.lat, cur.lng];
        const hop = geoDist(from, target);
        if (hop > 3000) { st.marker.setLatLng(target); st.trail = [[target[0], target[1], now]]; st.path = null; }
        else if (hop < 1.5) { st.marker.setLatLng(target); }
        else {
          // Glide over the measured gap between updates (+15%) so the bus
          // never stalls waiting for the next fix when a poll runs late.
          if (st.lastFixAt) { const gap = now - st.lastFixAt; if (gap > 1000 && gap < 4500) st.fixGap = st.fixGap ? st.fixGap * 0.7 + gap * 0.3 : gap; }
          st.lastFixAt = now;
          st.path = busRoadPath(bus.id, from, target) || [from, target]; st.t0 = now; st.dur = (st.fixGap || BUS_ANIM_MS) * 1.15;
        }
        st.target = target;
      }
    }
    mapMarkers[mapKey].push(st.marker);
  });
  // Remove buses that are no longer plotted.
  Object.keys(state).forEach((id) => {
    if (seen.has(id)) return;
    map.removeLayer(state[id].marker); state[id].segs.forEach((l) => map.removeLayer(l)); delete state[id];
  });
  if (!busAnimRaf) busAnimRaf = requestAnimationFrame(busAnimFrame);

  // Auto-centre on the live bus the first time we have a real position.
  if (!mapAutoFitted[mapKey] && plotted.length > 0) {
    const bounds = L.latLngBounds(plotted.map(b => [b.lat, b.lng]));
    // Demo road routes: frame the whole routes so every stop is in view.
    const lines = (stopMarkers[mapKey] || []).filter((l) => l instanceof L.Polyline);
    if (DEMO && lines.length) {
      lines.forEach((l) => bounds.extend(l.getBounds()));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      mapAutoFitted[mapKey] = true;
      return;
    }
    if (plotted.length === 1) {
      map.setView([plotted[0].lat, plotted[0].lng], 14);
    } else {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    }
    mapAutoFitted[mapKey] = true;
  }
}


// ============================================
// CONNECTION UI
// ============================================

function updateConnectionUI(status) {
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');
  const badge = document.getElementById('liveBadge');
  if (!dot || !label) return;
  dot.className = 'status-dot ' + status;
  if (status === 'connected') { label.textContent = 'MQTT Connected'; if (badge) badge.style.display = ''; }
  else if (status === 'connecting') { label.textContent = 'Connecting...'; if (badge) badge.style.display = 'none'; }
  else { label.textContent = 'Disconnected'; if (badge) badge.style.display = 'none'; }
}

function updateMqttStatus(status, text) {
  const el = document.getElementById('mqttConnectionStatus');
  if (!el) return;
  const dot = el.querySelector('.status-dot');
  const span = el.querySelector('span:last-child');
  if (dot) dot.className = 'status-dot ' + (status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected');
  if (span) span.textContent = text;
}


// ============================================
// PASSWORD GATE
// ============================================

function initLoginGate() {
  const loginScreen = document.getElementById('loginScreen');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const dashboard = document.getElementById('dashboard');
  if (!loginForm) return;

  // Demo services can be opened without the password (DEMO_OPEN_ACCESS=true).
  if (DEMO && DEMO.openAccess) {
    loginScreen.classList.add('hidden');
    dashboard.style.display = '';
    initDashboard();
    return;
  }

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pwd = document.getElementById('loginPassword').value;
    if (!configStore.dashPassword || pwd === configStore.dashPassword) {
      loginScreen.classList.add('hidden');
      dashboard.style.display = '';
      initDashboard();
    } else {
      loginError.textContent = 'Incorrect password. Please try again.';
      document.getElementById('loginPassword').value = '';
      document.getElementById('loginPassword').focus();
    }
  });
}


// ============================================
// SETTINGS PANEL
// ============================================

function initSettings() {
  const modal = document.getElementById('settingsModal');
  const openBtn = document.getElementById('settingsBtn');
  const closeBtn = document.getElementById('settingsClose');
  const cancelBtn = document.getElementById('settingsCancelBtn');
  const saveBtn = document.getElementById('settingsSaveBtn');
  const connectBtn = document.getElementById('mqttConnectBtn');
  const addDeviceBtn = document.getElementById('addDeviceBtn');
  const savePassBtn = document.getElementById('savePasswordBtn');

  if (openBtn) openBtn.addEventListener('click', () => openSettings());
  if (closeBtn) closeBtn.addEventListener('click', () => closeSettings());
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeSettings());
  if (saveBtn) saveBtn.addEventListener('click', () => saveSettings());
  if (connectBtn) connectBtn.addEventListener('click', () => testMqttConnection());
  if (addDeviceBtn) addDeviceBtn.addEventListener('click', () => addGatewayRow());
  if (savePassBtn) savePassBtn.addEventListener('click', () => saveDashPassword());
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });
}

function openSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  // Populate from config
  document.getElementById('mqttHost').value = configStore.mqtt.host;
  document.getElementById('mqttPort').value = configStore.mqtt.port;
  document.getElementById('mqttUsername').value = configStore.mqtt.username;
  document.getElementById('mqttPassword').value = configStore.mqtt.password;
  document.getElementById('mqttUseTls').value = String(configStore.mqtt.useTls);
  document.getElementById('mqttBasePath').value = configStore.mqtt.path;
  document.getElementById('mqttTopicPattern').value = configStore.mqtt.topic;
  document.getElementById('dashPassword').value = configStore.dashPassword;
  renderGatewayList();
  modal.classList.add('open');
  lucide.createIcons();
}

function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.classList.remove('open');
}

function readSettingsFromForm() {
  configStore.mqtt.host = document.getElementById('mqttHost').value.trim();
  configStore.mqtt.port = parseInt(document.getElementById('mqttPort').value) || 8884;
  configStore.mqtt.username = document.getElementById('mqttUsername').value.trim();
  configStore.mqtt.password = document.getElementById('mqttPassword').value;
  configStore.mqtt.useTls = document.getElementById('mqttUseTls').value === 'true';
  configStore.mqtt.path = document.getElementById('mqttBasePath').value.trim() || '/mqtt';
  configStore.mqtt.topic = document.getElementById('mqttTopicPattern').value.trim() || '#';
  readGatewayRows();
}

function saveSettings() {
  readSettingsFromForm();
  closeSettings();
  if (configStore.mqtt.host) MQTT_CLIENT.connect();
}

function testMqttConnection() {
  readSettingsFromForm();
  MQTT_CLIENT.connect();
}

function saveDashPassword() {
  const newPass = document.getElementById('dashPassword').value;
  if (newPass) {
    configStore.dashPassword = newPass;
    updateMqttStatus('connected', 'Dashboard password updated.');
  }
}

function renderGatewayList() {
  const container = document.getElementById('deviceList');
  if (!container) return;
  container.innerHTML = configStore.gateways.map((gw, i) => `
    <div class="device-row" data-idx="${i}">
      <div>
        <label>Bus Label</label>
        <input type="text" class="gw-label" value="${gw.label || ''}" placeholder="e.g. 515">
      </div>
      <div>
        <label>MQTT Topic / ID</label>
        <input type="text" class="gw-topic" value="${gw.topic || ''}" placeholder="e.g. bus/001 or device SN">
      </div>
      <button class="device-remove" onclick="removeGatewayRow(${i})" title="Remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

function addGatewayRow() {
  configStore.gateways.push({ topic: '', label: '', route: '' });
  renderGatewayList();
}

window.removeGatewayRow = function(idx) {
  configStore.gateways.splice(idx, 1);
  renderGatewayList();
};

function readGatewayRows() {
  const rows = document.querySelectorAll('.device-row');
  const gateways = [];
  rows.forEach((row, i) => {
    const label = row.querySelector('.gw-label').value.trim();
    const topic = row.querySelector('.gw-topic').value.trim();
    if (label || topic) {
      gateways.push({ label, topic, route: '' });
    }
  });
  configStore.gateways = gateways;
}


// ============================================
// INIT
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  initLoginGate();
  initSettings();
});

function initDashboard() {
  initNavigation();
  initClock();
  initExportMenus();
  initView('overview');
  animateKPIs();
  lucide.createIcons();

  // Pre-probe backend so it's cached before any view needs it
  probeBackend().then(() => { seedKPIsFromAPI(); seedRunningOnboardFromAPI(); seedBusPositionsFromAPI(); });
  // Keep the authoritative daily totals fresh as new boardings accumulate.
  setInterval(() => seedKPIsFromAPI(), 30000);
  // Seed the continuous running-onboard from the server once each device is
  // known. Devices only appear after their first MQTT message, so retry on an
  // interval; the function is a no-op for devices already seeded.
  setInterval(() => seedRunningOnboardFromAPI(), 30000);
  // Refresh server-resolved bus positions (scheduled-stop fallback) so the
  // map advances buses along their routes even without MQTT.
  setInterval(() => seedBusPositionsFromAPI(), 20000);

  if (DEMO) {
    startDemoFeed();
    return;
  }

  // Auto-connect to MQTT broker if credentials are pre-configured
  if (configStore.mqtt.host) {
    setTimeout(() => MQTT_CLIENT.connect(), 500);
  }
}


// ============================================
// NAVIGATION
// ============================================

function initNavigation() {
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === currentView) return;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const viewEl = document.getElementById(`view-${view}`);
      if (viewEl) viewEl.classList.add('active');
      currentView = view;
      updateHeader(view);
      initView(view);
    });
  });
  document.getElementById('toggleSidebar').addEventListener('click', () => {
    const dashboard = document.getElementById('dashboard');
    const sidebar = document.getElementById('sidebar');
    if (window.innerWidth <= 768) sidebar.classList.toggle('mobile-open');
    else dashboard.classList.toggle('sidebar-collapsed');
  });
}

function updateHeader(view) {
  const titles = {
    'overview': ['Dashboard', 'Overview / Real-time'],
    'live-map': ['Live Fleet Map', 'Tracking / GPS'],
    'ridership': ['Ridership Analytics', 'Analytics / Historical'],
    'routes': ['Routes & Stops', 'Analytics / Route Detail'],
    'comparison': ['Period Comparison', 'Analytics / Compare'],
    'scorecard': ['Service Scorecard', 'Analytics / Productivity & Welfare'],
    'fleet': ['Fleet Status', 'Fleet / Management'],
    'reports': ['Reports', 'Output / Reports'],
    'data-table': ['Data Explorer', 'Output / Raw Data'],
    // Welfare development interface (see public/welfare.js)
    'welfare-console': ['Welfare Console', 'Welfare / Development'],
    'welfare-signals': ['Signal Delivery', 'Welfare / Delivery Status'],
    'welfare-health': ['Sensor Integrity', 'Welfare / Rule 12'],
    'welfare-log': ['Welfare Event Log', 'Welfare / Audit Trail'],
    'welfare-rules': ['Rules & Testing', 'Welfare / Configuration'],
    'welfare-drivers': ['Driver Screens', 'Welfare / In-cab Displays'],
  };
  const [title, breadcrumb] = titles[view] || ['Dashboard', 'Overview'];
  document.getElementById('headerTitle').textContent = title;
  document.getElementById('headerBreadcrumb').textContent = breadcrumb;
}


// ============================================
// VIEW INITIALIZATION
// ============================================

const viewInitialized = {};
function initView(view) {
  if (!viewInitialized[view]) {
    viewInitialized[view] = true;
    switch (view) {
      case 'overview': initOverview(); break;
      case 'live-map': initLiveMap(); break;
      case 'ridership': initRidership(); break;
      case 'routes': initRoutes(); break;
      case 'comparison': initComparison(); break;
      case 'scorecard': initScorecard(); break;
      case 'fleet': initFleet(); break;
      case 'reports': initReports(); break;
      case 'data-table': initDataTable(); break;
    }
  } else {
    // Refresh data-driven views when navigating back
    switch (view) {
      case 'ridership': loadRidershipData(); break;
      case 'routes': loadRoutesData(); break;
      case 'scorecard': scLoad(); break;
      case 'data-table': loadDataFromAPI(); break;
      case 'live-map': if (maps.liveMap) setTimeout(() => maps.liveMap.invalidateSize(), 100); break;
    }
  }
}


// ============================================
// CLOCK
// ============================================

function initClock() {
  function update() { document.getElementById('headerTime').textContent = new Date().toLocaleTimeString('en-US', { timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
  update(); setInterval(update, 1000);
}


// ============================================
// KPI ANIMATION
// ============================================

function animateKPIs() {
  updateLiveKPIs();
}

function animateValue(id, start, end, duration, suffix) {
  suffix = suffix || '';
  const el = document.getElementById(id); if (!el) return;
  const range = end - start; const startTime = performance.now();
  function update(ts) {
    const p = Math.min((ts - startTime) / duration, 1);
    el.textContent = Math.floor(start + range * (1 - Math.pow(1 - p, 3))).toLocaleString() + suffix;
    if (p < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}


// ============================================
// OVERVIEW
// ============================================

function initOverview() {
  initOverviewMap(); renderFleetList(); initHourlyFlowChart(); initOverviewAnalyticsCharts(); initPeriodTabs(); initMomChangeChart();
}

function initOverviewMap() {
  if (maps.overview) return;
  const map = L.map('overviewMap', { zoomControl: true, attributionControl: false }).setView(MAP_DEFAULT_CENTER, 12);
  addBaseLayer(map, 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
  renderStopsOnMap(map, 'overview');
  updateMapBusMarkers(map, 'overview');
  maps.overview = map;
  setTimeout(() => map.invalidateSize(), 100);
  const refreshBtn = document.getElementById('mapRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    updateMapBusMarkers(maps.overview, 'overview');
    renderFleetList();
  });
}

// One clean route line, e.g. "Oxford Road Hospital Link · Main Hospital ↔ Outpatient Centre"
// (route and routeName often carry the same text, which doubled it up).
function fleetRouteText(bus) {
  const raw = String(bus.routeName || bus.route || '');
  if (!raw) return '';
  const name = raw.replace(/^Bus\s+\S+\s*[—–-]\s*/i, '');
  const m = name.match(/^(.*?)\s*\((.*)\)\s*$/);
  return escapeHtml(m ? m[1] + ' \u00b7 ' + m[2] : name);
}

function renderFleetList() {
  const list = document.getElementById('fleetList');
  if (!list) return;
  const activeBuses = BUS_POSITIONS.filter(b => b.status === 'active').sort((a,b) => b.occupancy - a.occupancy);
  const countEl = document.getElementById('fleetCount');
  if (countEl) countEl.textContent = `${activeBuses.length} buses online`;
  if (activeBuses.length === 0) {
    list.innerHTML = '<div class="fleet-item" style="justify-content:center;color:var(--color-text-muted);padding:2rem">Waiting for live bus data via MQTT...</div>';
    return;
  }
  list.innerHTML = activeBuses.map(bus => {
    const occClass = bus.occupancy > 75 ? 'occupancy-high' : bus.occupancy > 50 ? 'occupancy-medium' : 'occupancy-low';
    return `<div class="fleet-item">
      <div class="fleet-badge" style="background:${bus.routeColor}">${bus.id.length > 3 ? bus.id.slice(-3) : bus.id}</div>
      <div class="fleet-info"><div class="fleet-name">${bus.id}</div><div class="fleet-route">${fleetRouteText(bus)}</div></div>
      <div class="fleet-stats"><div class="fleet-passengers">${bus.passengers} pax</div><div class="fleet-occupancy ${occClass}">${bus.occupancy}%</div></div>
    </div>`;
  }).join('');
}

function initHourlyFlowChart() {
  const labels24 = Array.from({length: 24}, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const zeros = new Array(24).fill(0);
  const ctx = document.getElementById('chartHourlyFlow').getContext('2d');
  charts.hourlyFlow = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels24,
      datasets: [
        // Per-bus boardings (515 = blue family, 419 = amber family). Stacked
        // within each bus group so the bar height reads as that bus's boardings.
        { label: 'Bus 515 · Boardings', data: [...zeros], backgroundColor: 'rgba(59, 130, 246, 0.85)', borderRadius: 4, barPercentage: 0.9, categoryPercentage: 0.7, stack: 'bus515' },
        { label: 'Bus 515 · Alightings', data: [...zeros], backgroundColor: 'rgba(59, 130, 246, 0.35)', borderRadius: 4, barPercentage: 0.9, categoryPercentage: 0.7, stack: 'bus515' },
        { label: 'Bus 419 · Boardings', data: [...zeros], backgroundColor: 'rgba(245, 158, 11, 0.9)', borderRadius: 4, barPercentage: 0.9, categoryPercentage: 0.7, stack: 'bus419' },
        { label: 'Bus 419 · Alightings', data: [...zeros], backgroundColor: 'rgba(245, 158, 11, 0.4)', borderRadius: 4, barPercentage: 0.9, categoryPercentage: 0.7, stack: 'bus419' },
        // Combined total boardings (both buses) — faint line overlay so the
        // overall trend stays visible above the per-bus bars.
        { type: 'line', label: 'Total Boardings', data: [...zeros], borderColor: 'rgba(226, 232, 240, 0.7)', backgroundColor: 'rgba(226, 232, 240, 0.7)', borderWidth: 2.5, borderDash: [5, 4], tension: 0.35, pointRadius: 0, fill: false, order: 0 },
      ],
    },
    options: {
      ...chartDefaults('Passengers'),
      // Sharper on high-DPI displays + a bit taller (lower ratio = bigger height).
      devicePixelRatio: Math.max(2, window.devicePixelRatio || 1),
      aspectRatio: 2.4,
    },
  });
  // Load data immediately and auto-refresh every 30s
  refreshHourlyFlowChart();
  setInterval(() => refreshHourlyFlowChart(), 30000);
}

// Display timezone for the whole dashboard (matches the header clock).
const DISPLAY_TZ = APP_TZ;

// Calendar date (YYYY-MM-DD) in DISPLAY_TZ. The backend buckets days by this same
// zone, so the frontend must ask for dates in Central time — not UTC — or it will
// query the wrong (often empty) day after UTC midnight.
function displayDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TZ }).format(d);
}

// The backend stores each record's hour in UTC (server uses getUTCHours()).
// This converts a UTC hour (0-23) into the equivalent hour in DISPLAY_TZ,
// automatically accounting for daylight saving (CST/CDT).
function utcHourToDisplayHour(utcHour) {
  // Build a UTC date at the given hour today, then read its hour in DISPLAY_TZ.
  const ref = new Date();
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), utcHour, 0, 0));
  const local = parseInt(d.toLocaleString('en-US', { timeZone: DISPLAY_TZ, hour: '2-digit', hour12: false }), 10);
  return ((local % 24) + 24) % 24;
}

// Currently selected period for the Hourly Passenger Flow chart (today | week | month).
let hourlyFlowPeriod = 'today';

async function refreshHourlyFlowChart() {
  if (!charts.hourlyFlow) return;
  const now = new Date();

  if (hourlyFlowPeriod === 'today') {
    // --- TODAY: one bar per hour (00:00 - 23:00) ---
    const today = displayDateStr(now); // Central calendar date, matches backend
    const apiData = await apiFetch('/api/hourly', { date: today });
    const labels = Array.from({length: 24}, (_, i) => `${String(i).padStart(2, '0')}:00`);
    // Per-bus hour maps keyed by bus label, so each bus gets its own series.
    const perBus = { '515': {}, '419': {} };
    let hasAny = false;
    if (apiData && apiData.hourly && apiData.hourly.length > 0) {
      hasAny = true;
      apiData.hourly.forEach(row => {
        // Remap backend UTC hours into the display timezone so bars line up with the clock.
        const dh = utcHourToDisplayHour(row.hour);
        const bus = perBus[row.bus_id] ? row.bus_id : null;
        if (!bus) return; // ignore unexpected labels
        if (!perBus[bus][dh]) perBus[bus][dh] = { boardings: 0, alightings: 0 };
        perBus[bus][dh].boardings += row.boardings || 0;
        perBus[bus][dh].alightings += row.alightings || 0;
      });
    }
    const series = (bus, key) => Array.from({length: 24}, (_, h) => perBus[bus][h]?.[key] || 0);
    let b515, a515, b419, a419;
    if (hasAny) {
      b515 = series('515', 'boardings'); a515 = series('515', 'alightings');
      b419 = series('419', 'boardings'); a419 = series('419', 'alightings');
    } else {
      // Fallback to live in-memory buckets (not bus-split): show under 515.
      b515 = labels.map(h => hourlyBuckets[h]?.boardings || 0);
      a515 = labels.map(h => hourlyBuckets[h]?.alightings || 0);
      b419 = new Array(24).fill(0); a419 = new Array(24).fill(0);
    }
    const totalBoardings = b515.map((v, i) => v + b419[i]);
    setHourlyFlowAxis('Hour of day');
    charts.hourlyFlow.data.labels = labels;
    charts.hourlyFlow.data.datasets[0].data = b515;
    charts.hourlyFlow.data.datasets[1].data = a515;
    charts.hourlyFlow.data.datasets[2].data = b419;
    charts.hourlyFlow.data.datasets[3].data = a419;
    charts.hourlyFlow.data.datasets[4].data = totalBoardings;
    charts.hourlyFlow.update('active');
    return;
  }

  if (hourlyFlowPeriod === 'year') {
    // --- YEAR: one bar per calendar month (Jan-Dec), zero-filled ---
    const year = now.getFullYear();
    const from = `${year}-01-01`;
    const to = displayDateStr(now);
    const dailyData = await apiFetch('/api/daily', { from, to });
    const perBus = { '515': {}, '419': {} };
    if (dailyData && dailyData.daily) {
      dailyData.daily.forEach(r => {
        const bus = perBus[r.bus_id] ? r.bus_id : null;
        if (!bus) return;
        const monthKey = r.date.slice(0, 7); // YYYY-MM
        if (!perBus[bus][monthKey]) perBus[bus][monthKey] = { boardings: 0, alightings: 0 };
        perBus[bus][monthKey].boardings += r.total_in || 0;
        perBus[bus][monthKey].alightings += r.total_out || 0;
      });
    }
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthKeys = monthNames.map((_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    const b515 = monthKeys.map(k => perBus['515'][k]?.boardings || 0);
    const a515 = monthKeys.map(k => perBus['515'][k]?.alightings || 0);
    const b419 = monthKeys.map(k => perBus['419'][k]?.boardings || 0);
    const a419 = monthKeys.map(k => perBus['419'][k]?.alightings || 0);
    const totalBoardings = b515.map((v, i) => v + b419[i]);

    setHourlyFlowAxis('Month');
    charts.hourlyFlow.data.labels = monthNames;
    charts.hourlyFlow.data.datasets[0].data = b515;
    charts.hourlyFlow.data.datasets[1].data = a515;
    charts.hourlyFlow.data.datasets[2].data = b419;
    charts.hourlyFlow.data.datasets[3].data = a419;
    charts.hourlyFlow.data.datasets[4].data = totalBoardings;
    charts.hourlyFlow.update('active');
    return;
  }

  // --- WEEK / MONTH: one bar per day ---
  const dayCount = hourlyFlowPeriod === 'month' ? 30 : 7;
  const dates = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(displayDateStr(d)); // Central calendar dates
  }
  const from = dates[0];
  const to = dates[dates.length - 1];

  const dailyData = await apiFetch('/api/daily', { from, to });
  // Per-bus per-day maps so week/month also splits 515 vs 419.
  const perBus = { '515': {}, '419': {} };
  if (dailyData && dailyData.daily) {
    dailyData.daily.forEach(r => {
      const bus = perBus[r.bus_id] ? r.bus_id : null;
      if (!bus) return;
      if (!perBus[bus][r.date]) perBus[bus][r.date] = { boardings: 0, alightings: 0 };
      perBus[bus][r.date].boardings += r.total_in || 0;
      perBus[bus][r.date].alightings += r.total_out || 0;
    });
  }

  // Day labels (calendar dates, no timezone shift).
  const labels = dates.map(dt => {
    const dd = new Date(dt + 'T12:00:00Z');
    return dd.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  });
  const b515 = dates.map(dt => perBus['515'][dt]?.boardings || 0);
  const a515 = dates.map(dt => perBus['515'][dt]?.alightings || 0);
  const b419 = dates.map(dt => perBus['419'][dt]?.boardings || 0);
  const a419 = dates.map(dt => perBus['419'][dt]?.alightings || 0);
  const totalBoardings = b515.map((v, i) => v + b419[i]);

  setHourlyFlowAxis('Day');
  charts.hourlyFlow.data.labels = labels;
  charts.hourlyFlow.data.datasets[0].data = b515;
  charts.hourlyFlow.data.datasets[1].data = a515;
  charts.hourlyFlow.data.datasets[2].data = b419;
  charts.hourlyFlow.data.datasets[3].data = a419;
  charts.hourlyFlow.data.datasets[4].data = totalBoardings;
  charts.hourlyFlow.update('active');
}

// Update the x-axis title on the Hourly Flow chart (Hour of day vs Day).
function setHourlyFlowAxis(xTitle) {
  const opts = charts.hourlyFlow.options;
  if (opts && opts.scales && opts.scales.x) {
    opts.scales.x.title = { display: true, text: xTitle, color: '#9094b2', font: { size: 13, weight: '600', family: 'Inter' }, padding: { top: 6 } };
  }
}

// ==========================================
// MONTHLY BOARDINGS — % CHANGE (month-over-month)
// Bar chart: one bar per calendar month showing % change in total
// boardings (both buses combined) vs the previous month. Green = growth,
// red = decline — matches the Net Load convention on the Ridership table.
// The first month with any data has no prior month to compare against, so
// it's excluded from the chart entirely.
// ==========================================
function initMomChangeChart() {
  const ctx = document.getElementById('chartMomChange');
  if (!ctx) return;
  charts.momChange = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: '% change vs previous month',
        data: [],
        backgroundColor: [],
        borderRadius: 6,
        borderSkipped: false,
        barPercentage: 0.6,
        categoryPercentage: 0.7,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: true, aspectRatio: 3.4,
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipDefaults(),
          callbacks: {
            label: (item) => {
              const raw = item.raw || {};
              const sign = item.parsed.y >= 0 ? '+' : '';
              return [
                `${sign}${item.parsed.y.toFixed(1)}% vs ${raw.prevLabel || 'previous month'}`,
                `${raw.current?.toLocaleString() ?? '—'} boardings (was ${raw.previous?.toLocaleString() ?? '—'})`,
              ];
            },
          },
        },
        datalabels: {
          display: true,
          color: '#c9cad8', font: { size: 11, weight: '600', family: 'Inter' }, anchor: 'end', align: (ctx) => ctx.parsed && ctx.parsed.y < 0 ? 'bottom' : 'top',
          formatter: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
        },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#b5b8d0', font: { size: 12, weight: '500' }, padding: 8 } },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#b5b8d0', font: { size: 12, weight: '500' }, padding: 8, callback: v => v + '%' },
          title: { display: true, text: '% change (MoM)', color: '#9094b2', font: { size: 12, weight: '600' }, padding: { bottom: 6 } },
        },
      },
    },
  });
  refreshMomChangeChart();
  setInterval(() => refreshMomChangeChart(), 60000);
}

async function refreshMomChangeChart() {
  if (!charts.momChange) return;
  const now = new Date();
  // Pull the last 13 full calendar months so we always have a prior month
  // to diff the earliest bar against.
  const from = new Date(now.getFullYear(), now.getMonth() - 12, 1);
  const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-01`;
  const toStr = displayDateStr(now);
  const dailyData = await apiFetch('/api/daily', { from: fromStr, to: toStr });
  const byMonth = {};
  if (dailyData && dailyData.daily) {
    dailyData.daily.forEach(r => {
      const monthKey = r.date.slice(0, 7); // YYYY-MM
      byMonth[monthKey] = (byMonth[monthKey] || 0) + (r.total_in || 0);
    });
  }
  const monthKeys = Object.keys(byMonth).sort();
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtLabel = (k) => { const [y, m] = k.split('-'); return `${monthNames[Number(m) - 1]} ${y}`; };

  const labels = [];
  const pctData = [];
  const colors = [];
  const rawPoints = [];
  for (let i = 1; i < monthKeys.length; i++) {
    const prevKey = monthKeys[i - 1];
    const curKey = monthKeys[i];
    const prev = byMonth[prevKey];
    const cur = byMonth[curKey];
    if (!prev) continue; // avoid divide-by-zero / meaningless % on an empty prior month
    const pct = ((cur - prev) / prev) * 100;
    labels.push(fmtLabel(curKey));
    pctData.push(Math.round(pct * 10) / 10);
    colors.push(pct >= 0 ? 'rgba(34, 197, 94, 0.85)' : 'rgba(239, 68, 68, 0.85)');
    rawPoints.push({ current: cur, previous: prev, prevLabel: fmtLabel(prevKey) });
  }

  const emptyState = document.getElementById('momChangeEmpty');
  if (labels.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
  } else if (emptyState) {
    emptyState.style.display = 'none';
  }

  // Chart.js bar charts want plain numbers for the y-scale; raw boardings
  // metadata for tooltips is kept in the parallel rawPoints array instead.
  charts.momChange.data.labels = labels;
  charts.momChange.data.datasets[0].data = pctData;
  charts.momChange.data.datasets[0].backgroundColor = colors;
  charts.momChange.options.plugins.tooltip.callbacks.label = (item) => {
    const raw = rawPoints[item.dataIndex] || {};
    const sign = item.parsed.y >= 0 ? '+' : '';
    return [
      `${sign}${item.parsed.y.toFixed(1)}% vs ${raw.prevLabel || 'previous month'}`,
      `${raw.current?.toLocaleString() ?? '—'} boardings (was ${raw.previous?.toLocaleString() ?? '—'})`,
    ];
  };
  charts.momChange.update('active');
}

// ==========================================
// OVERVIEW ANALYTICS (gauge + cumulative load + net flow)
// Single bus, rich counting data: these replace the empty "Top Routes" and
// the static occupancy pie with live, meaningful occupancy analytics.
// ==========================================
function initOverviewAnalyticsCharts() {
  // 1) Live Occupancy Gauge — a half-doughnut showing onboard vs free seats.
  const gctx = document.getElementById('chartOccGauge');
  if (gctx) {
    charts.occGauge = new Chart(gctx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Onboard', 'Free seats'],
        datasets: [{ data: [0, CONFIG.busCapacity], backgroundColor: ['#10b981', 'rgba(255,255,255,0.07)'], borderWidth: 0, borderRadius: 8 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '78%', animation: { duration: 600 },
        plugins: { legend: { display: false }, tooltip: { ...tooltipDefaults() } },
      },
    });
  }

  // 2) Cumulative Load Today — running onboard occupancy across the day.
  const cctx = document.getElementById('chartCumulativeLoad');
  if (cctx) {
    charts.cumulativeLoad = new Chart(cctx.getContext('2d'), {
      type: 'line',
      data: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`),
        datasets: [
          { label: 'Onboard', data: new Array(24).fill(null), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', borderWidth: 2, fill: true, tension: 0.35, pointRadius: 0, pointStyle: false, spanGaps: true },
          { label: 'Capacity', data: new Array(24).fill(CONFIG.busCapacity), borderColor: '#ef4444', borderDash: [8, 4], borderWidth: 1.5, pointRadius: 0, pointStyle: false, fill: false },
        ],
      },
      options: { ...chartDefaults('Onboard'), scales: { ...chartDefaults('Onboard').scales, y: { ...chartDefaults('Onboard').scales.y, beginAtZero: true, suggestedMax: CONFIG.busCapacity } } },
    });
    // Lines have no point markers, so show plain line swatches in the legend.
    try { const lg = charts.cumulativeLoad.options.plugins.legend; lg.labels = { ...(lg.labels || {}), usePointStyle: false, boxWidth: 18, boxHeight: 3 }; charts.cumulativeLoad.update('none'); } catch (e) { /* noop */ }
  }

  // 3) Net Passenger Flow by Hour — boardings minus alightings per hour.
  const nctx = document.getElementById('chartNetFlow');
  if (nctx) {
    charts.netFlow = new Chart(nctx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`),
        datasets: [{ label: 'Net flow', data: new Array(24).fill(0), backgroundColor: [], borderRadius: 4, barPercentage: 0.7 }],
      },
      options: chartDefaults('Net passengers'),
    });
  }

  // 4) Passenger On Counts — the dashboard's hero card for boardings.
  // Larger, taller, hi-DPI canvas with a purple gradient fill and crisp axes.
  const pctx = document.getElementById('chartPassengerOn');
  if (pctx) {
    const pctxCtx = pctx.getContext('2d');
    // Distinct colour per bus — matches the palette used on the Hourly
    // Passenger Flow chart: Bus 515 = blue, Bus 419 = amber.
    const bus515Color = '#3b82f6';
    const bus419Color = '#f59e0b';
    charts.passengerOn = new Chart(pctxCtx, {
      type: 'bar',
      data: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`),
        datasets: [
          {
            // First bus (515) — blue.
            label: 'Bus 515',
            data: new Array(24).fill(0),
            backgroundColor: bus515Color,
            hoverBackgroundColor: bus515Color,
            borderColor: bus515Color,
            borderWidth: 0,
            borderRadius: 5,
            borderSkipped: false,
            barPercentage: 0.78,
            categoryPercentage: 0.85,
          },
          {
            // Second bus (419) — amber.
            label: 'Bus 419',
            data: new Array(24).fill(0),
            backgroundColor: bus419Color,
            hoverBackgroundColor: bus419Color,
            borderColor: bus419Color,
            borderWidth: 0,
            borderRadius: 5,
            borderSkipped: false,
            barPercentage: 0.78,
            categoryPercentage: 0.85,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Render at the screen's native pixel density so bars and text stay crisp.
        devicePixelRatio: Math.max(2, window.devicePixelRatio || 1),
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 600, easing: 'easeOutCubic' },
        layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },
        plugins: {
          legend: {
            display: true,
            labels: { color: '#dbdce6', font: { size: 12, family: 'Inter', weight: '500' }, padding: 16, usePointStyle: true, pointStyle: 'circle', boxWidth: 10 },
          },
          tooltip: {
            ...tooltipDefaults(),
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()} boardings`,
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            grid: { display: false, drawBorder: false },
            border: { display: false },
            ticks: {
              color: '#8a8ea8',
              font: { size: 11, family: 'Inter', weight: '500' },
              maxRotation: 0,
              autoSkip: true,
              autoSkipPadding: 12,
            },
          },
          y: {
            stacked: true,
            beginAtZero: true,
            grid: { color: 'rgba(165, 142, 209, 0.07)', drawBorder: false, drawTicks: false },
            border: { display: false },
            ticks: {
              color: '#8a8ea8',
              font: { size: 11, family: 'Inter', weight: '500' },
              padding: 8,
              precision: 0,
              callback: (v) => Number(v).toLocaleString(),
            },
            title: {
              display: true,
              text: 'Boardings',
              color: '#6a6e8a',
              font: { size: 10, family: 'Inter', weight: '600' },
              padding: { bottom: 8 },
            },
          },
        },
      },
    });

    // Wire the per-bus and per-period selectors. The Passenger On chart owns
    // its own fetcher (refreshPassengerOnChart) because Weekly/Monthly use
    // /api/daily, not /api/hourly. Changes always re-fetch + re-render this
    // chart only; the other Overview charts are untouched.
    const busSelect = document.getElementById('passengerOnBusFilter');
    if (busSelect) {
      busSelect.addEventListener('change', () => {
        _passengerOnBusFilter = busSelect.value || 'all';
        refreshPassengerOnChart();
      });
    }
    const periodSelect = document.getElementById('passengerOnPeriodFilter');
    if (periodSelect) {
      periodSelect.addEventListener('change', () => {
        _passengerOnPeriod = periodSelect.value || 'daily';
        refreshPassengerOnChart();
      });
    }
  }

  // Initial paint + periodic refresh of the hour-based charts from the DB.
  refreshNetAndCumulativeCharts();
  setInterval(() => refreshNetAndCumulativeCharts(), 30000);

  // Separate refresh loop for the Passenger On chart (covers Daily/Weekly/Monthly).
  refreshPassengerOnChart();
  setInterval(() => refreshPassengerOnChart(), 30000);

  // Boardings by Stop premium panel.
  initStopBoardingsHome();
  refreshStopBoardingsHome();
  setInterval(() => refreshStopBoardingsHome(), 30000);
  refreshProTables(); setInterval(() => refreshProTables(), 30000);
}

// Update the live gauge from current fleet occupancy (called on every MQTT tick).
function occBand(pct) { return pct >= 80 ? 'full' : pct >= 50 ? 'busy' : 'ok'; }
const OCC_COL = { ok: '#10b981', busy: '#f59e0b', full: '#ef4444' };

function updateOverviewAnalytics() {
  const buses = BUS_POSITIONS.filter((b) => b.status === 'active' || b.status === 'idle');
  const onboard = buses.reduce((s, b) => s + (b.passengers || 0), 0);
  const cap = buses.reduce((s, b) => s + (b.capacity || CONFIG.busCapacity), 0) || CONFIG.busCapacity;
  const free = Math.max(0, cap - onboard);
  const pct = cap > 0 ? Math.round((onboard / cap) * 100) : 0;
  if (charts.occGauge) {
    charts.occGauge.data.datasets[0].data = [onboard, free];
    charts.occGauge.data.datasets[0].backgroundColor = [OCC_COL[occBand(pct)], 'rgba(255,255,255,0.07)'];
    charts.occGauge.update('none');
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('occGaugePct', pct + '%');
  set('occRingCap', onboard + ' of ' + cap + ' seats');
  set('occGaugeSub', buses.length + ' bus' + (buses.length === 1 ? '' : 'es') + ' in service \u00b7 ' + free + ' seats free');
  const list = document.getElementById('occBusList');
  if (list) {
    list.innerHTML = buses.length ? buses.map((b) => {
      const c = b.capacity || CONFIG.busCapacity; const p = c ? Math.round(((b.passengers || 0) / c) * 100) : 0; const band = occBand(p);
      const route = fleetRouteText(b).split(' \u00b7 ')[0];
      const next = b.nextStopName ? rsStopLabel(String(b.nextStopName)) : '';
      return `<div class="occ-row">
        <div class="occ-row-top"><span class="occ-bus" style="background:${b.routeColor || '#3b82f6'}">${escapeHtml(String(b.id).slice(-3))}</span>
          <div class="occ-row-name"><b>${route || 'Bus ' + escapeHtml(b.id)}</b><span>${next ? '\u2192 ' + escapeHtml(next) : (b.status === 'idle' ? 'Idle' : 'In service')}</span></div>
          <div class="occ-row-val"><b>${b.passengers || 0}<small>/${c}</small></b><span class="occ-pill ${band}">${p}%</span></div></div>
        <div class="occ-bar"><i class="${band}" style="width:${Math.min(100, p)}%"></i><em style="left:50%"></em><em style="left:80%"></em></div>
      </div>`;
    }).join('') : '<div class="occ-empty">No buses reporting yet</div>';
  }
  try { renderProFleetTable(); } catch (e) { /* table not on page */ }
}

// ----- Professional white tables (Dashboard) ---------------------------
let PRO_TODAY = { byBus: {}, stops: [], hourly: [], t: 0 };
async function refreshProTables() {
  const today = displayDateStr();
  const [daily, stops, hourly] = await Promise.all([
    apiFetch('/api/daily', { from: today, to: today }),
    apiFetch('/api/stops/boardings', { from: today, to: today }),
    apiFetch('/api/stops/hourly', { from: today, to: today }),
  ]);
  const byBus = {};
  ((daily && daily.daily) || []).forEach((r) => { byBus[String(r.bus_id)] = { in: r.total_in || 0, out: r.total_out || 0 }; });
  PRO_TODAY = { byBus, stops: (stops && stops.stops) || [], hourly: (hourly && hourly.rows) || [], t: Date.now() };
  renderProFleetTable();
  renderProStopTable();
}

function renderProFleetTable() {
  const tb = document.querySelector('#proFleetTable tbody'); if (!tb) return;
  const buses = BUS_POSITIONS.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  if (!buses.length) { tb.innerHTML = '<tr><td colspan="9" class="pro-empty">Waiting for fleet data\u2026</td></tr>'; return; }
  tb.innerHTML = buses.map((b) => {
    const c = b.capacity || CONFIG.busCapacity; const p = c ? Math.round(((b.passengers || 0) / c) * 100) : 0; const band = occBand(p);
    const t = PRO_TODAY.byBus[String(b.id)] || { in: b.lineIn || 0, out: b.lineOut || 0 };
    const status = b.status === 'active' ? '<span class="pro-status live">In service</span>' : b.status === 'idle' ? '<span class="pro-status idle">Idle</span>' : '<span class="pro-status off">Offline</span>';
    const route = fleetRouteText(b).split(' \u00b7 ')[0] || '\u2014';
    const next = b.nextStopName ? escapeHtml(rsStopLabel(String(b.nextStopName))) : '<span class="pro-muted">\u2014</span>';
    return `<tr>
      <td><span class="pro-bus" style="background:${b.routeColor || '#2563eb'}">${escapeHtml(String(b.id))}</span></td>
      <td class="pro-strong">${route}</td>
      <td>${status}</td>
      <td class="num pro-strong">${b.passengers || 0}<span class="pro-muted"> / ${c}</span></td>
      <td><div class="pro-bar"><i class="${band}" style="width:${Math.min(100, p)}%"></i></div><span class="pro-bar-lbl ${band}">${p}%</span></td>
      <td>${next}</td>
      <td class="num">${t.in.toLocaleString()}</td>
      <td class="num">${t.out.toLocaleString()}</td>
      <td class="num pro-muted">${escapeHtml(b.lastUpdate || '\u2014')}</td>
    </tr>`;
  }).join('');
  const sub = document.getElementById('proFleetSub');
  if (sub) sub.textContent = buses.filter((b) => b.status === 'active').length + ' of ' + buses.length + ' buses in service \u00b7 updates every few seconds';
}

function renderProStopTable() {
  const tb = document.querySelector('#proStopTable tbody'); const tf = document.querySelector('#proStopTable tfoot'); if (!tb) return;
  const groups = {};
  PRO_TODAY.stops.forEach((st) => {
    if (!st.stop || st.stop === '-') return;
    const k = rsKey(st.route, st.stop);
    if (!groups[k]) groups[k] = { key: k, route: String(st.route), name: rsStopLabel(st.stop), b: 0, a: 0, hours: {} };
    groups[k].b += st.boardings || 0; groups[k].a += st.alightings || 0;
  });
  PRO_TODAY.hourly.forEach((r) => {
    const g = groups[rsKey(r.route, r.stop)]; if (!g) return;
    const h = utcHourToDisplayHour(r.hour); g.hours[h] = (g.hours[h] || 0) + (r.boardings || 0) + (r.alightings || 0);
  });
  const rows = Object.values(groups).sort((x, y) => (y.b + y.a) - (x.b + x.a));
  const total = rows.reduce((s, g) => s + g.b + g.a, 0);
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="8" class="pro-empty">No stop activity recorded yet today</td></tr>'; if (tf) tf.innerHTML = ''; return; }
  const max = Math.max(...rows.map((g) => g.b + g.a));
  tb.innerHTML = rows.map((g, i) => {
    const t = g.b + g.a; const share = total ? Math.round((t / total) * 100) : 0;
    const hb = Object.entries(g.hours).sort((a, b) => b[1] - a[1])[0];
    const col = (typeof mapRouteHex === 'function') ? mapRouteHex(g.route) : '#2563eb';
    return `<tr>
      <td><span class="pro-rank${i < 3 ? ' top' : ''}">${i + 1}</span></td>
      <td class="pro-strong">${escapeHtml(g.name)}</td>
      <td><span class="pro-route" style="--rc:${col}">${escapeHtml(g.route)}</span></td>
      <td class="num">${g.b.toLocaleString()}</td>
      <td class="num">${g.a.toLocaleString()}</td>
      <td class="num pro-strong">${t.toLocaleString()}</td>
      <td><div class="pro-bar"><i class="share" style="width:${max ? Math.round((t / max) * 100) : 0}%"></i></div><span class="pro-bar-lbl">${share}%</span></td>
      <td class="num">${hb ? String(hb[0]).padStart(2, '0') + ':00' : '\u2014'}</td>
    </tr>`;
  }).join('');
  const tb2 = rows.reduce((s, g) => s + g.b, 0), ta2 = rows.reduce((s, g) => s + g.a, 0);
  if (tf) tf.innerHTML = `<tr><td></td><td>Total</td><td></td><td class="num">${tb2.toLocaleString()}</td><td class="num">${ta2.toLocaleString()}</td><td class="num">${total.toLocaleString()}</td><td>100%</td><td></td></tr>`;
  const sub = document.getElementById('proStopSub');
  if (sub) sub.textContent = rows.length + ' stops \u00b7 ' + total.toLocaleString() + ' passengers today \u00b7 both directions combined';
}

// Pull today's hourly data from the API and render the net-flow bars and the
// cumulative running-load line. Falls back to live MQTT buckets if API is down.
async function refreshNetAndCumulativeCharts() {
  if (!charts.netFlow && !charts.cumulativeLoad) return;
  const today = displayDateStr();
  const apiData = await apiFetch('/api/hourly', { date: today });
  const board = new Array(24).fill(0);
  const alight = new Array(24).fill(0);
  let hasAny = false;
  if (apiData && apiData.hourly && apiData.hourly.length > 0) {
    hasAny = true;
    apiData.hourly.forEach(row => {
      const dh = utcHourToDisplayHour(row.hour);
      board[dh] += row.boardings || 0;
      alight[dh] += row.alightings || 0;
    });
  } else {
    // Live fallback from in-browser hourly buckets.
    for (let h = 0; h < 24; h++) {
      const k = `${String(h).padStart(2, '0')}:00`;
      board[h] = hourlyBuckets[k]?.boardings || 0;
      alight[h] = hourlyBuckets[k]?.alightings || 0;
      if (board[h] || alight[h]) hasAny = true;
    }
  }

  // Cache today's hourly series so the Ridership occupancy bands can be
  // time-weighted from the same authoritative data.
  _occHourlyCache = { board: board.slice(), alight: alight.slice() };

  const cap = CONFIG.busCapacity;
  // Net flow per hour and the running cumulative load (clamped to [0, capacity]).
  const net = board.map((b, h) => b - alight[h]);
  let running = 0;
  const cumulative = [];
  let lastActiveHour = -1;
  for (let h = 0; h < 24; h++) {
    running = Math.max(0, Math.min(cap, running + net[h]));
    cumulative.push(running);
    if (board[h] || alight[h]) lastActiveHour = h;
  }

  if (charts.netFlow) {
    charts.netFlow.data.datasets[0].data = net;
    // Positive net = filling (blue), negative = emptying (green).
    charts.netFlow.data.datasets[0].backgroundColor = net.map(v => v >= 0 ? 'rgba(59,130,246,0.85)' : 'rgba(16,185,129,0.85)');
    charts.netFlow.update('active');
  }
  // Note: the Passenger On chart is driven by refreshPassengerOnChart() because
  // Weekly/Monthly periods use /api/daily rather than /api/hourly.
  if (charts.cumulativeLoad) {
    // Only draw the line up to the last hour with activity so the trailing
    // hours don't show a flat zero for a day still in progress.
    const series = cumulative.map((v, h) => (hasAny && lastActiveHour >= 0 && h <= lastActiveHour) ? v : null);
    charts.cumulativeLoad.data.datasets[0].data = series;
    charts.cumulativeLoad.update('active');
  }
}

function initPeriodTabs() {
  document.querySelectorAll('.period-tabs').forEach(group => {
    group.querySelectorAll('.period-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        group.querySelectorAll('.period-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const period = tab.dataset.period;
        if (group.dataset.chart === 'hourlyFlow') updateHourlyFlowChart(period);
      });
    });
  });
}

function updateHourlyFlowChart(period) {
  // Remember the selected period so auto-refresh keeps it, then refresh.
  if (period) hourlyFlowPeriod = period;
  refreshHourlyFlowChart();
}


// ============================================
// LIVE MAP
// ============================================

// ----- Footfall layer on the Live Map (demo road routes) -------------------
// Toggle button in the live filter bar; shows today's boardings + alightings
// per stop as street-level heat beneath the moving buses. Refreshes every
// minute while on and hides in History mode.
const LIVE_FF = { on: false, layer: null, timer: null, weights: {}, total: 0, registry: null };

async function liveFootfallLoad() {
  const today = displayDateStr();
  const payload = await apiFetch('/api/stops/boardings', { from: today, to: today });
  const w = {}; let total = 0;
  ((payload && payload.stops) || []).forEach((st) => {
    const k = rsKey(st.route, st.stop);
    const n = (st.boardings || 0) + (st.alightings || 0);
    w[k] = (w[k] || 0) + n; total += n;
  });
  LIVE_FF.weights = w; LIVE_FF.total = total;
}

function liveFootfallDraw() {
  const map = maps.liveMap;
  if (!map) return;
  if (LIVE_FF.layer) { map.removeLayer(LIVE_FF.layer); LIVE_FF.layer = null; }
  const legend = document.getElementById('liveFootfallLegend');
  const show = LIVE_FF.on && HISTORY.mode !== 'history' && LIVE_FF.registry;
  if (legend) legend.hidden = !show;
  if (!show) return;
  const { points } = ffHeatPoints(map, LIVE_FF.registry, Object.keys(LIVE_FF.registry), LIVE_FF.weights);
  LIVE_FF.layer = L.heatLayer(points, ffHeatOptions(map)).addTo(map);
  const lbl = document.getElementById('liveFootfallTotal');
  if (lbl) lbl.textContent = LIVE_FF.total.toLocaleString() + ' people today';
}

async function liveFootfallToggle(force) {
  LIVE_FF.on = typeof force === 'boolean' ? force : !LIVE_FF.on;
  const btn = document.getElementById('liveFootfallBtn');
  if (btn) { btn.classList.toggle('active', LIVE_FF.on); btn.setAttribute('aria-pressed', String(LIVE_FF.on)); }
  clearInterval(LIVE_FF.timer); LIVE_FF.timer = null;
  if (LIVE_FF.on) {
    await liveFootfallLoad();
    LIVE_FF.timer = setInterval(async () => { await liveFootfallLoad(); liveFootfallDraw(); }, 60000);
  }
  liveFootfallDraw();
}

async function initLiveFootfall(map) {
  const btn = document.getElementById('liveFootfallBtn');
  if (!btn || typeof L.heatLayer !== 'function') return;
  const reg = await loadStopRegistry();
  const hasRoads = reg && Object.values(reg).some((r) => routeLinePoints(r).roads);
  if (!hasRoads) return;              // live service: keep the button hidden
  LIVE_FF.registry = reg;
  btn.hidden = false;
  btn.addEventListener('click', () => liveFootfallToggle());
  map.on('zoomend', () => { if (LIVE_FF.on) liveFootfallDraw(); });
  const mapEl = document.getElementById('liveMapFull');
  if (mapEl && !document.getElementById('liveFootfallLegend')) {
    const lg = document.createElement('div');
    lg.id = 'liveFootfallLegend'; lg.className = 'ff-legend ff-legend-live'; lg.hidden = true;
    lg.innerHTML = '<strong>Footfall</strong><span id="liveFootfallTotal"></span><span>Fewer</span><span class="ff-legend-grad"></span><span>More</span>';
    mapEl.appendChild(lg);
  }
}

function initLiveMap() {
  if (maps.liveMap) return;
  const map = L.map('liveMapFull', { zoomControl: true, attributionControl: false }).setView(MAP_DEFAULT_CENTER, 12);
  addBaseLayer(map, 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
  renderStopsOnMap(map, 'liveMap');
  updateMapBusMarkers(map, 'liveMap');
  maps.liveMap = map;
  setTimeout(() => map.invalidateSize(), 100);
  initLiveFootfall(map);
  document.getElementById('centerMapBtn').addEventListener('click', () => {
    const active = BUS_POSITIONS.filter(b => b.lat !== 0 && b.lng !== 0);
    const lines = DEMO ? (stopMarkers.liveMap || []).filter((l) => l instanceof L.Polyline) : [];
    if (active.length > 0 || lines.length) {
      const b = active.length ? L.latLngBounds(active.map(x => [x.lat, x.lng])) : lines[0].getBounds();
      lines.forEach((l) => b.extend(l.getBounds()));
      map.fitBounds(b, { padding: [50, 50], maxZoom: 15 });
      return;
    }
    map.setView(MAP_DEFAULT_CENTER, 12);
  });
}


// ============================================
// RIDERSHIP ANALYTICS (Backend-powered)
// ============================================

function initRidership() {
  // Premium palette: white as the primary, indigo-amethyst & gold as accents
  const RID_WHITE = 'rgba(255,255,255,0.95)';
  const RID_PURPLE = 'rgba(139,116,209,0.85)';
  const RID_GOLD = 'rgba(212,175,55,0.95)';

  // Trend (hero): stacked route bars + 7-day average + previous period.
  initRidershipTrendChart();
  initRidershipHeat();
  initRouteShareChart();
  // Companion charts (no aspect ratio so they fill the larger panels)
  const companionOpts = (yLabel) => ({
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: { duration: 800, easing: 'easeOutQuart' },
    plugins: {
      legend: { labels: { color: '#dbdce6', font: { size: 14, family: 'Inter', weight: '500' }, padding: 20, usePointStyle: true, pointStyle: 'circle', boxWidth: 10, boxHeight: 10 } },
      tooltip: { ...tooltipDefaults(),
        titleFont: { family: 'Inter', size: 14, weight: '600' },
        bodyFont: { family: 'Inter', size: 13 },
        padding: 14,
        callbacks: { label: (c) => ' ' + c.dataset.label + ': ' + Number(c.parsed.y).toLocaleString() }
      }
    },
    scales: {
      x: { grid: { color: 'rgba(255,255,255,0.04)', drawTicks: false }, ticks: { color: '#c9cad8', font: { size: 12, family: 'Inter', weight: '500' }, padding: 10, autoSkip: true, autoSkipPadding: 16, maxRotation: 45, minRotation: 0 } },
      y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)', drawTicks: false }, ticks: { color: '#c9cad8', font: { size: 13, family: 'Inter', weight: '500' }, padding: 10, callback: (v) => Number(v).toLocaleString() }, title: { display: true, text: yLabel, color: '#a5a8c1', font: { size: 13, family: 'Inter', weight: '600' }, padding: { bottom: 8 } } }
    }
  });

  // Boardings vs Alightings (bar): white = boardings, gold = alightings
  const baCtx = document.getElementById('chartBoardAlightRidership').getContext('2d');
  charts.boardAlight = new Chart(baCtx, {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Boardings', data: [], backgroundColor: 'rgba(244,245,251,0.88)', hoverBackgroundColor: 'rgba(255,255,255,1)', borderRadius: 5, borderSkipped: false, maxBarThickness: 18, categoryPercentage: 0.7, barPercentage: 0.88 },
      { label: 'Alightings', data: [], backgroundColor: 'rgba(212,175,55,0.85)', hoverBackgroundColor: 'rgba(232,193,73,1)', borderRadius: 5, borderSkipped: false, maxBarThickness: 18, categoryPercentage: 0.7, barPercentage: 0.88 },
    ]},
    plugins: [{ id: 'ridBADensity', beforeUpdate(chart) {
      // Paired bars for short ranges; two smooth lines once there are many points.
      const line = (chart.data.labels || []).length > 14;
      chart.data.datasets.forEach((ds, i) => {
        const col = i === 0 ? 'rgba(244,245,251,0.92)' : 'rgba(212,175,55,0.9)';
        ds.type = line ? 'line' : 'bar';
        ds.borderColor = line ? col : undefined; ds.borderWidth = line ? 2.25 : 0;
        ds.tension = 0.35; ds.pointRadius = 0; ds.pointHoverRadius = 4; ds.fill = false;
        ds.pointBackgroundColor = col;
        if (line && i === 1) ds.borderDash = [5, 4]; else delete ds.borderDash;
      });
    } }],
    options: (() => { const o = companionOpts('Passengers'); o.scales.x.ticks.maxRotation = 0; o.scales.x.grid = { display: false };
      o.scales.y.title.display = false; o.scales.y.ticks.maxTicksLimit = 6; o.scales.y.ticks.font = { size: 12, family: 'Inter' }; o.scales.y.ticks.color = '#9a9cb0';
      o.plugins.legend.position = 'top'; o.plugins.legend.align = 'end'; o.plugins.legend.labels.font = { size: 12.5, family: 'Inter', weight: '500' }; o.plugins.legend.labels.boxWidth = 8; o.plugins.legend.labels.boxHeight = 8; o.plugins.legend.labels.padding = 14;
      return o; })(),
  });

  // Day of week: this period (accent) beside the previous period (muted)
  const dowCtx = document.getElementById('chartDayOfWeek').getContext('2d');
  charts.dayOfWeek = new Chart(dowCtx, {
    type: 'bar',
    data: { labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], datasets: [
      { label: 'This period', data: [0,0,0,0,0,0,0], backgroundColor: 'rgba(167,139,250,0.62)', borderRadius: 6, borderSkipped: false, maxBarThickness: 34, categoryPercentage: 0.72, barPercentage: 0.9, order: 1 },
      { label: 'Previous period', data: [], backgroundColor: 'rgba(201,202,216,0.22)', hoverBackgroundColor: 'rgba(201,202,216,0.32)', borderRadius: 6, borderSkipped: false, maxBarThickness: 34, categoryPercentage: 0.72, barPercentage: 0.9, order: 2, hidden: true },
    ] },
    options: { ...companionOpts('Avg boardings'),
      plugins: {
        legend: { display: false },
        datalabels: { display: (c) => c.datasetIndex === 0 && c.dataset.data[c.dataIndex] > 0, anchor: 'end', align: 'top', offset: 2, color: '#c9cad8', font: { family: 'Inter', size: 11, weight: '600' }, formatter: (v) => Number(v).toLocaleString() },
        tooltip: { ...tooltipDefaults(),
          callbacks: { label: (c) => ' ' + c.dataset.label + ': ' + (c.parsed.y == null ? 'no data' : Number(c.parsed.y).toLocaleString() + ' avg boardings') }
        }
      },
      scales: { ...companionOpts('').scales,
        x: { grid: { display: false }, border: { color: 'rgba(255,255,255,0.08)' }, ticks: { color: '#c9cad8', font: { size: 12, family: 'Inter', weight: '600' }, padding: 8 } },
        y: { beginAtZero: true, grace: '10%', grid: { color: 'rgba(255,255,255,0.05)', drawTicks: false }, border: { display: false }, ticks: { color: '#9a9cb0', font: { size: 12, family: 'Inter' }, padding: 8, maxTicksLimit: 6, callback: (v) => Number(v).toLocaleString() } } },
    },
  });

  // Wire up filter controls
  const periodSel = document.getElementById('ridershipPeriod');
  const routeSel = document.getElementById('ridershipRoute');
  const yearSel = document.getElementById('ridershipYear');
  if (periodSel) periodSel.addEventListener('change', () => loadRidershipData());
  if (routeSel) routeSel.addEventListener('change', () => loadRidershipData());
  if (yearSel) yearSel.addEventListener('change', () => loadRidershipData());

  // Wire up view tabs (daily/weekly/monthly/yearly)
  document.querySelectorAll('#ridershipViewTabs .period-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#ridershipViewTabs .period-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      // The Yearly view picks a single calendar year instead of a rolling
      // window, so swap the Period dropdown for a Year dropdown.
      const isYearly = tab.dataset.view === 'yearly';
      const periodGroup = document.getElementById('ridershipPeriodGroup');
      const yearGroup = document.getElementById('ridershipYearGroup');
      if (periodGroup) periodGroup.style.display = isYearly ? 'none' : '';
      if (yearGroup) yearGroup.style.display = isYearly ? '' : 'none';
      loadRidershipData();
    });
  });

  // Ensure backend probe completes, then populate bus/year dropdowns and load data
  probeBackend().then(() => Promise.all([populateBusDropdowns(), populateYearDropdown()])).then(() => loadRidershipData());
}

// ============================================
// RIDERSHIP: trend hero, busiest times, route share
// ============================================
const RID_ROUTE_PALETTE = ['rgba(139,116,209,0.95)', 'rgba(212,175,55,0.95)', 'rgba(125,211,252,0.95)', 'rgba(251,113,133,0.95)'];
function ridRouteColor(busId, i) {
  const c = ROUTE_COLOR[String(rsRouteKeyForBus ? rsRouteKeyForBus(busId) : busId)];
  return c ? c.hex : RID_ROUTE_PALETTE[i % RID_ROUTE_PALETTE.length];
}
function ridAlpha(hex, a) {
  if (hex.startsWith('rgba')) return hex.replace(/[\d.]+\)$/, a + ')');
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function ridFmtDate(dt) {
  return new Date(dt + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}
function ridPct(cur, prev) {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
}
function ridDelta(p) {
  if (p == null) return '';
  const cls = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
  const arrow = p > 0 ? '\u25B2' : p < 0 ? '\u25BC' : '\u2022';
  return `<span class="rid-delta ${cls}">${arrow} ${Math.abs(p)}%</span>`;
}

// Theme-aware accents: champagne gold on Glossy Platinum, violet on dark.
function ridIsGlossy() { return document.documentElement.getAttribute('data-skin') === 'glossy-platinum'; }
function ridAccent() { return ridIsGlossy() ? '#d9b866' : '#a78bfa'; }
const RID_MAIN = '#f4f5fb';          // "this period" line: near-white platinum
const RID_PREV = 'rgba(201,202,216,0.42)';
const RID_PREV_BAR = 'rgba(201,202,216,0.22)';
const RID_PANEL_BG = '#14151d';

// Average line with a pill label, drawn on top of the trend.
const ridAvgPlugin = {
  id: 'ridAvgLine',
  afterDatasetsDraw(chart) {
    const m = chart._ridMeta; if (!m || !m.avg) return;
    const { ctx, chartArea: a, scales: { y } } = chart; if (!a || !y) return;
    const py = y.getPixelForValue(m.avg); if (py < a.top || py > a.bottom) return;
    const col = ridAccent();
    ctx.save();
    ctx.strokeStyle = ridAlpha(col, 0.85); ctx.lineWidth = 1.5; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
    ctx.setLineDash([]);
    const txt = 'Avg ' + Math.round(m.avg).toLocaleString();
    ctx.font = '600 11.5px Inter, system-ui, sans-serif';
    const w = ctx.measureText(txt).width + 16, h = 22, x = a.right + 8, yy = Math.max(a.top - 4, py - h / 2);
    ctx.fillStyle = ridAlpha(col, 0.16); ctx.strokeStyle = ridAlpha(col, 0.6); ctx.lineWidth = 1;
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, yy, w, h, 11); else ctx.rect(x, yy, w, h); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.textBaseline = 'middle'; ctx.fillText(txt, x + 8, yy + h / 2 + 0.5);
    ctx.restore();
  },
};
// Soft vertical gradient under a line.
function ridGradient(hex, top, bottom) {
  return (c) => {
    const { ctx, chartArea } = c.chart; if (!chartArea) return 'transparent';
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, ridAlpha(hex, top)); g.addColorStop(1, ridAlpha(hex, bottom));
    return g;
  };
}

function initRidershipTrendChart() {
  const el = document.getElementById('chartRidershipTrend');
  if (!el) return;
  const tick = { color: '#9a9cb0', font: { size: 12, family: 'Inter', weight: '500' }, padding: 10 };
  charts.ridershipTrend = new Chart(el.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [] },
    plugins: [ridAvgPlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 26, right: 92, left: 4 } },
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 750, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        datalabels: {
          display: (c) => c.datasetIndex === 0 && (c.chart._ridMeta || {}).labels && c.dataset.data[c.dataIndex] != null,
          align: 'top', anchor: 'end', offset: 6, clamp: true,
          color: '#e6e7ef', font: { family: 'Inter', size: 11.5, weight: '600' },
          backgroundColor: 'rgba(14,15,22,0.88)', borderRadius: 6, padding: { top: 3, bottom: 2, left: 6, right: 6 },
          formatter: (v) => Number(v || 0).toLocaleString(),
        },
        tooltip: { ...tooltipDefaults(), padding: 12, displayColors: false,
          titleFont: { family: 'Inter', size: 13, weight: '600' }, bodyFont: { family: 'Inter', size: 12.5 }, footerFont: { family: 'Inter', size: 12, weight: '600' },
          filter: (i) => i.datasetIndex === 0 || i.datasetIndex === 1,
          callbacks: {
            title: (items) => { const m = charts.ridershipTrend._ridMeta || {}; const i = items[0] ? items[0].dataIndex : 0; return (m.titles && m.titles[i]) || (items[0] && items[0].label) || ''; },
            label: (c) => {
              const m = charts.ridershipTrend._ridMeta || {};
              if (c.datasetIndex === 0) return 'Boardings: ' + Number(c.parsed.y || 0).toLocaleString() + (m.partialIdx === c.dataIndex ? '  (so far)' : m.part && m.part.has(c.dataIndex) ? '  (part ' + (m.unit || 'period') + ')' : '');
              return 'Previous: ' + Number(c.parsed.y || 0).toLocaleString() + (m.prevTitles && m.prevTitles[c.dataIndex] ? '  (' + m.prevTitles[c.dataIndex] + ')' : '');
            },
            footer: (items) => {
              const m = charts.ridershipTrend._ridMeta || {};
              const cur = items.find((i) => i.datasetIndex === 0), prev = items.find((i) => i.datasetIndex === 1);
              if (!cur || !prev || m.partialIdx === cur.dataIndex) return '';
              const p = ridPct(cur.parsed.y || 0, prev.parsed.y || 0);
              return p == null ? '' : (p > 0 ? '\u25B2 ' : p < 0 ? '\u25BC ' : '') + Math.abs(p) + '% vs previous';
            },
          } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: 'rgba(255,255,255,0.08)' }, ticks: { ...tick, autoSkip: true, autoSkipPadding: 18, maxRotation: 0 } },
        y: { beginAtZero: true, grace: '12%', grid: { color: 'rgba(255,255,255,0.05)', drawTicks: false }, border: { display: false },
          ticks: { ...tick, maxTicksLimit: 6, callback: (v) => Number(v).toLocaleString() } },
      },
    },
  });
}

// Draws the trend: one clear line for this period, an optional faint
// previous-period line and a labelled average. `opts` = { titles, prev,
// prevTitles, partialIdx, avg, unit }.
function ridDrawTrend(labels, series, opts) {
  const ch = charts.ridershipTrend; if (!ch) return;
  opts = opts || {};
  const n = (series || []).length, pi = opts.partialIdx == null ? -1 : opts.partialIdx;
  const part = new Set([pi, ...(opts.partial || [])].filter((i) => i >= 0));
  const dense = n > 20;
  // A second line over many points is noise; compare via the chips instead.
  if (n > 14) opts.prev = null;
  const ds = [{
    label: 'This period', data: series || [], order: 1,
    borderColor: RID_MAIN, borderWidth: 2.75, tension: 0.35, cubicInterpolationMode: 'monotone',
    fill: 'origin', backgroundColor: ridGradient(ridAccent(), 0.32, 0.0),
    pointRadius: (series || []).map((_, i) => (dense ? (part.has(i) ? 4 : 0) : (part.has(i) ? 5 : 3.5))),
    pointHoverRadius: 6, pointBorderWidth: 2,
    pointBackgroundColor: (series || []).map((_, i) => (part.has(i) ? RID_PANEL_BG : RID_MAIN)),
    pointBorderColor: RID_MAIN,
    // Today's partial total is not joined to the line, so it doesn't read as a drop.
    segment: { borderColor: (c) => (part.has(c.p0DataIndex) || part.has(c.p1DataIndex) ? 'transparent' : undefined), backgroundColor: (c) => (part.has(c.p0DataIndex) || part.has(c.p1DataIndex) ? 'transparent' : undefined) },
  }];
  if (opts.prev) ds.push({
    label: 'Previous period', data: opts.prev, order: 2,
    borderColor: RID_PREV, borderWidth: 1.75, borderDash: [4, 4], tension: 0.35, cubicInterpolationMode: 'monotone',
    fill: false, pointRadius: 0, pointHoverRadius: 4, pointBackgroundColor: RID_PREV,
  });
  ch.data.labels = labels || [];
  ch.data.datasets = ds;
  ch._ridMeta = { partialIdx: pi, part, titles: opts.titles, prevTitles: opts.prevTitles, avg: opts.avg, unit: opts.unit, labels: n > 0 && n <= 14 };
  ch.update('active');
  const lg = document.getElementById('ridTrendLegend');
  if (lg) lg.innerHTML = n ? '<span class="rid-lg"><i class="rid-lg-line"></i>This period</span>'
    + (opts.prev ? '<span class="rid-lg"><i class="rid-lg-dash"></i>Previous period</span>' : '')
    + (opts.avg ? `<span class="rid-lg"><i class="rid-lg-avg" style="border-color:${ridAccent()}"></i>Average</span>` : '')
    + (part.size ? '<span class="rid-lg"><i class="rid-lg-open"></i>' + (pi >= 0 && part.size === 1 ? 'In progress' : 'Incomplete') + '</span>' : '') : '';
}

// Single-series fallback (yearly / live-only).
function ridTrendSimple(labels, series, subtitle, partialIdx) {
  const vals = (series || []).filter((v, i) => i !== partialIdx && v > 0);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  ridDrawTrend(labels || [], series || [], { partialIdx, avg, unit: 'month' });
  const chips = document.getElementById('ridTrendChips'); if (chips) chips.innerHTML = '';
  if (subtitle) { const s = document.getElementById('ridershipTrendSubtitle'); if (s) s.textContent = subtitle; }
}

// Buckets for a date range: daily / weekly (Mon start) / monthly.
function ridBucketsFor(dates, viewMode) {
  const keyOf = (dt) => {
    if (viewMode === 'daily') return dt;
    if (viewMode === 'monthly' || viewMode === 'yearly') return dt.slice(0, 7);
    const d = new Date(dt + 'T12:00:00Z'); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - (day - 1)); return d.toISOString().slice(0, 10);
  };
  const keys = [...new Set(dates.map(keyOf))];
  const idxOf = {}; keys.forEach((k, i) => { idxOf[k] = i; });
  const fmt = (k, long) => {
    if (viewMode === 'daily') return new Date(k + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: long || dates.length <= 14 ? 'short' : undefined, day: 'numeric', month: 'short' });
    if (viewMode === 'weekly') return (long ? 'Week of ' : 'w/c ') + new Date(k + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
    return new Date(k + '-15T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', month: long ? 'long' : 'short', year: 'numeric' });
  };
  return { keys, keyOf, bucketOf: (dt) => idxOf[keyOf(dt)], labels: keys.map((k) => fmt(k, false)), titles: keys.map((k) => fmt(k, true)) };
}

function renderRidershipHero(allRows, viewMode, fromDate, now, windowDays) {
  const ch = charts.ridershipTrend; if (!ch) return;
  const from = displayDateStr(fromDate), to = displayDateStr(now);
  const byDate = {};
  allRows.forEach((r) => { byDate[r.date] = (byDate[r.date] || 0) + (r.total_in || 0); });
  const dates = []; for (const d = new Date(fromDate); d <= now; d.setDate(d.getDate() + 1)) dates.push(displayDateStr(d));
  const shift = (dt) => { const d = new Date(dt + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - windowDays); return d.toISOString().slice(0, 10); };
  const prevDates = dates.map(shift);
  const B = ridBucketsFor(dates, viewMode);
  const cur = B.keys.map(() => 0), prev = B.keys.map(() => 0), daysIn = B.keys.map(() => 0);
  const prevFirst = B.keys.map(() => null);
  dates.forEach((dt, i) => {
    const b = B.bucketOf(dt);
    cur[b] += byDate[dt] || 0; daysIn[b]++;
    if (dt !== to) { prev[b] += byDate[prevDates[i]] || 0; if (!prevFirst[b]) prevFirst[b] = prevDates[i]; }
  });
  // Latest bucket is still filling up while it contains today.
  const partialIdx = B.bucketOf(to);
  const fullLen = (k) => (viewMode === 'weekly' ? 7 : viewMode === 'monthly' ? new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)).getUTCDate() : 1);
  const partial = B.keys.map((k, i) => (daysIn[i] < fullLen(k) ? i : -1)).filter((i) => i >= 0);
  // Compare only when the previous period was (almost) fully counted.
  const prevFull = prevDates.filter((_, i) => dates[i] !== to);
  const prevCovered = prevFull.filter((dt) => (byDate[dt] || 0) > 0).length;
  const prevOk = prevFull.length > 0 && prevCovered >= prevFull.length * 0.8;
  const prevTitles = prevFirst.map((dt) => (dt ? (viewMode === 'daily' ? ridFmtDate(dt) : 'from ' + ridFmtDate(dt)) : ''));
  // Average per bucket, over complete buckets.
  const complete = cur.filter((_, i) => i !== partialIdx && !partial.includes(i));
  const avg = complete.length ? complete.reduce((a, b) => a + b, 0) / complete.length : 0;
  const unit = viewMode === 'daily' ? 'day' : viewMode === 'weekly' ? 'week' : 'month';
  ridDrawTrend(B.labels.map((l, i) => (viewMode === 'daily' && i === partialIdx ? 'Today' : l)), cur,
    { titles: B.titles, prev: prevOk ? prev.map((v, i) => (i === partialIdx || partial.includes(i) ? null : v)) : null, prevTitles, partialIdx, partial, avg, unit });

  // Insight chips (complete days only, so today's partial count doesn't skew them)
  const full = dates.filter((dt) => dt !== to);
  const curAvg = full.length ? Math.round(full.reduce((a, dt) => a + (byDate[dt] || 0), 0) / full.length) : 0;
  const prevAvg = prevFull.length ? Math.round(prevFull.reduce((a, dt) => a + (byDate[dt] || 0), 0) / prevFull.length) : 0;
  let best = null, worst = null;
  full.forEach((dt) => { const v = byDate[dt] || 0; if (!best || v > best.v) best = { dt, v }; if (v > 0 && (!worst || v < worst.v)) worst = { dt, v }; });
  const chips = [];
  chips.push(`<div class="rid-chip"><div class="rid-chip-lbl">Average per day</div><div class="rid-chip-val">${curAvg.toLocaleString()} ${prevOk ? ridDelta(ridPct(curAvg, prevAvg)) : ''}</div><div class="rid-chip-sub">${prevOk ? `vs ${prevAvg.toLocaleString()} in the previous ${windowDays} days` : 'no full previous period to compare'}</div></div>`);
  if (best && best.v > 0) chips.push(`<div class="rid-chip"><div class="rid-chip-lbl">Busiest day</div><div class="rid-chip-val">${best.v.toLocaleString()}</div><div class="rid-chip-sub">${ridFmtDate(best.dt)}</div></div>`);
  if (worst) chips.push(`<div class="rid-chip"><div class="rid-chip-lbl">Quietest day</div><div class="rid-chip-val">${worst.v.toLocaleString()}</div><div class="rid-chip-sub">${ridFmtDate(worst.dt)}</div></div>`);
  if (dates.includes(to)) chips.push(`<div class="rid-chip rid-chip-live"><div class="rid-chip-lbl"><span class="rid-live-dot"></span>Today so far</div><div class="rid-chip-val">${(byDate[to] || 0).toLocaleString()}</div><div class="rid-chip-sub">day in progress</div></div>`);
  const cEl = document.getElementById('ridTrendChips'); if (cEl) cEl.innerHTML = chips.join('');
  const sub = document.getElementById('ridershipTrendSubtitle');
  const fmtY = (dt) => new Date(dt + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  if (sub) sub.textContent = 'Total boardings per ' + unit + ' \u00b7 ' + (windowDays > 60 ? fmtY(from) + ' \u2013 ' + fmtY(to) : ridFmtDate(from) + ' \u2013 ' + ridFmtDate(to));
}

// ---- Route trends: one card per route with its own sparkline ----
function renderRouteTrends(allRows, from, to, viewMode, windowDays, noPrev) {
  const host = document.getElementById('ridRouteTrends'); if (!host) return;
  (charts._ridRT || []).forEach((c) => { try { c.destroy(); } catch (e) { /* noop */ } });
  charts._ridRT = [];
  const dates = []; for (let d = new Date(from + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  const mode = viewMode === 'yearly' ? 'monthly' : viewMode;
  const B = ridBucketsFor(dates, mode);
  const prevFrom = (() => { const d = new Date(from + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - windowDays); return d.toISOString().slice(0, 10); })();
  const cur = {}, prev = {}, series = {}, byBusDate = {};
  allRows.forEach((r) => {
    const b = String(r.bus_id), v = r.total_in || 0;
    if (r.date >= from && r.date <= to) {
      cur[b] = (cur[b] || 0) + v;
      (series[b] = series[b] || B.keys.map(() => 0))[B.bucketOf(r.date)] += v;
      (byBusDate[b] = byBusDate[b] || {})[r.date] = ((byBusDate[b] || {})[r.date] || 0) + v;
    } else if (r.date >= prevFrom && r.date < from) prev[b] = (prev[b] || 0) + v;
  });
  const prevDays = new Set(allRows.filter((r) => r.date >= prevFrom && r.date < from && (r.total_in || 0) > 0).map((r) => r.date)).size;
  if (prevDays < windowDays * 0.8) noPrev = true;
  const today = displayDateStr();
  const fullDays = dates.filter((d) => d !== today).length || 1;
  const buses = Object.keys(cur).sort((a, b) => cur[b] - cur[a]);
  const total = buses.reduce((a, b) => a + cur[b], 0);
  const sub = document.getElementById('ridRouteTrendsSubtitle');
  if (sub) sub.textContent = 'Boardings per ' + (mode === 'daily' ? 'day' : mode === 'weekly' ? 'week' : 'month') + ' for each route \u00b7 same scale';
  if (!buses.length) { host.innerHTML = '<div class="rid-empty">No boardings in this period</div>'; return; }
  const ymax = Math.max(1, ...buses.flatMap((b) => series[b]));
  host.innerHTML = buses.map((b, i) => {
    const rk = rsRouteKeyForBus ? rsRouteKeyForBus(b) : b;
    const reg = (STOPS_REGISTRY || STOP_REGISTRY_CACHE || {})[rk];
    const name = reg ? rsRouteShortName(reg) : 'Bus ' + b;
    const col = ridRouteColor(b, i);
    const share = total ? Math.round((cur[b] / total) * 100) : 0;
    const todayV = (byBusDate[b] || {})[today] || 0;
    const avgDay = Math.round((cur[b] - todayV) / fullDays);
    let best = null; Object.entries(byBusDate[b] || {}).forEach(([dt, v]) => { if (dt !== today && (!best || v > best.v)) best = { dt, v }; });
    return `<div class="rid-rt-card" style="--rc:${col}">
      <div class="rid-rt-head"><span class="rid-rt-badge">${escapeHtml(b)}</span>
        <div class="rid-rt-name"><b>${escapeHtml(name)}</b><span>Bus ${escapeHtml(b)} \u00b7 ${share}% of boardings</span></div>
        ${noPrev ? '' : ridDelta(ridPct(cur[b], prev[b]))}</div>
      <div class="rid-rt-stats">
        <div><b>${cur[b].toLocaleString()}</b><span>boardings</span></div>
        <div><b>${avgDay.toLocaleString()}</b><span>avg per day</span></div>
        <div><b>${best ? best.v.toLocaleString() : '\u2014'}</b><span>${best ? 'best \u00b7 ' + ridFmtDate(best.dt) : 'best day'}</span></div>
      </div>
      <div class="rid-rt-spark"><canvas></canvas></div></div>`;
  }).join('');
  const partialIdx = B.bucketOf(today);
  const daysIn = B.keys.map(() => 0); dates.forEach((d) => { daysIn[B.bucketOf(d)]++; });
  const fullLen = (k) => (mode === 'weekly' ? 7 : mode === 'monthly' ? new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)).getUTCDate() : 1);
  const part = new Set(B.keys.map((k, i) => (daysIn[i] < fullLen(k) || i === partialIdx ? i : -1)).filter((i) => i >= 0));
  host.querySelectorAll('.rid-rt-card').forEach((card, i) => {
    const b = buses[i], col = ridRouteColor(b, i), data = series[b];
    const cv = card.querySelector('canvas');
    charts._ridRT.push(new Chart(cv.getContext('2d'), {
      type: 'line',
      data: { labels: B.labels, datasets: [{ data, borderColor: col, borderWidth: 2.25, tension: 0.35, cubicInterpolationMode: 'monotone',
        fill: 'origin', backgroundColor: ridGradient(col, 0.35, 0.0),
        pointRadius: data.map((_, j) => (part.has(j) || j === data.length - 1 ? 3.5 : 0)), pointHoverRadius: 4,
        pointBackgroundColor: data.map((_, j) => (part.has(j) ? RID_PANEL_BG : col)), pointBorderColor: col, pointBorderWidth: 2,
        segment: { borderColor: (c) => (part.has(c.p0DataIndex) || part.has(c.p1DataIndex) ? 'transparent' : undefined), backgroundColor: (c) => (part.has(c.p0DataIndex) || part.has(c.p1DataIndex) ? 'transparent' : undefined) } }] },
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 600 },
        layout: { padding: { top: 6, right: 6, bottom: 0, left: 0 } },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, datalabels: { display: false },
          tooltip: { ...tooltipDefaults(), displayColors: false, padding: 10,
            callbacks: { title: (it) => (B.titles[it[0].dataIndex] || ''), label: (c) => Number(c.parsed.y || 0).toLocaleString() + ' boardings' + (c.dataIndex === partialIdx ? ' (so far)' : part.has(c.dataIndex) ? ' (part period)' : '') } } },
        scales: { x: { display: true, grid: { display: false }, border: { display: false }, ticks: { color: '#7d8098', font: { size: 10.5, family: 'Inter' }, maxTicksLimit: 4, maxRotation: 0, autoSkip: true } },
          y: { display: false, beginAtZero: true, max: Math.ceil(ymax * 1.1) } } },
    }));
  });
}

// ---- Day of week: this period vs previous period, side by side ----
function renderDowCompare(allRows, from, to, windowDays) {
  const ch = charts.dayOfWeek; if (!ch) return;
  const today = displayDateStr();
  const prevFrom = (() => { const d = new Date(from + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - windowDays); return d.toISOString().slice(0, 10); })();
  const sum = (lo, hi) => {
    const byDate = {};
    allRows.forEach((r) => { if (r.date >= lo && r.date <= hi && r.date !== today) byDate[r.date] = (byDate[r.date] || 0) + (r.total_in || 0); });
    const t = [0, 0, 0, 0, 0, 0, 0], n = [0, 0, 0, 0, 0, 0, 0];
    // Count every calendar day in the window so a zero day still counts.
    for (let d = new Date(lo + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= hi; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = d.toISOString().slice(0, 10); if (k === today) continue;
      const i = (d.getUTCDay() + 6) % 7; t[i] += byDate[k] || 0; n[i]++;
    }
    return { avg: t.map((v, i) => (n[i] ? Math.round(v / n[i]) : null)), days: Object.keys(byDate).length };
  };
  const prevTo = (() => { const d = new Date(from + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const c = sum(from, to), p = sum(prevFrom, prevTo);
  const prevOk = p.days >= windowDays * 0.8;
  ridSetDow(c.avg, prevOk ? p.avg : null, windowDays);
}
function ridSetDow(curAvg, prevAvg, windowDays) {
  const ch = charts.dayOfWeek; if (!ch) return;
  const acc = ridAccent();
  const mx = Math.max(0, ...curAvg.map((v) => v || 0));
  ch.data.datasets[0].data = curAvg;
  ch.data.datasets[0].backgroundColor = curAvg.map((v) => (v === mx && mx > 0 ? acc : ridAlpha(acc, 0.62)));
  ch.data.datasets[0].hoverBackgroundColor = acc;
  ch.data.datasets[0].label = 'This period';
  ch.data.datasets[1].data = prevAvg || [];
  ch.data.datasets[1].hidden = !prevAvg;
  ch.update('active');
  const lg = document.getElementById('ridDowLegend');
  if (lg) lg.innerHTML = `<span class="rid-lg"><i style="background:${ridAlpha(acc, 0.62)}"></i>This period</span>` + (prevAvg ? `<span class="rid-lg"><i style="background:${RID_PREV_BAR}"></i>Previous ${windowDays ? windowDays + ' days' : 'period'}</span>` : '');
  const best = curAvg.indexOf(mx);
  const sub = document.getElementById('ridDowSubtitle');
  if (sub) sub.textContent = mx > 0 ? 'Average boardings on each weekday \u00b7 busiest: ' + ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][best] + ' (' + mx.toLocaleString() + ')' : 'Average boardings on each weekday';
}

// ---- Busiest times: weekday x hour, average boardings ----
const RID_DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function initRidershipHeat() {
  const el = document.getElementById('chartRidHeat');
  if (!el || typeof Chart === 'undefined') return;
  charts.ridHeat = new Chart(el.getContext('2d'), {
    type: 'matrix',
    data: { datasets: [{ label: 'Avg boardings', data: [], borderWidth: 2, borderColor: '#14151d', borderRadius: 4,
      backgroundColor(c) {
        const r = c.raw; const max = (c.dataset && c.dataset._max) || 1;
        if (!r || !r.v) return 'rgba(255,255,255,0.03)';
        const t = Math.min(1, r.v / max);
        // purple (quiet) -> gold (busy)
        const a = [91, 73, 168], b = [212, 175, 55];
        const m = (i) => Math.round(a[i] + (b[i] - a[i]) * Math.pow(t, 1.2));
        return 'rgba(' + m(0) + ',' + m(1) + ',' + m(2) + ',' + (0.25 + 0.75 * t).toFixed(2) + ')';
      },
      width: (c) => { const ar = c.chart.chartArea; const n = (c.dataset && c.dataset._cols) || 19; return ar ? Math.max(4, ar.width / n - 3) : 20; },
      height: (c) => { const ar = c.chart.chartArea; return ar ? Math.max(4, ar.height / 7 - 3) : 20; },
    }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 2, right: 6, bottom: 0, left: 2 } },
      scales: {
        x: { type: 'category', position: 'top', offset: true, labels: [], grid: { display: false }, border: { display: false },
          ticks: { color: '#8b8ea5', font: { size: 11, family: 'Inter', weight: '500' }, autoSkip: false, maxRotation: 0 } },
        y: { type: 'category', offset: true, reverse: false, labels: RID_DOW, grid: { display: false }, border: { display: false },
          ticks: { color: '#c9cad8', font: { size: 12, family: 'Inter', weight: '600' } } },
      },
      plugins: { legend: { display: false },
        tooltip: { ...tooltipDefaults(), callbacks: {
          title: (items) => { const r = items[0] && items[0].raw; return r ? r.y + ' ' + r.x : ''; },
          label: (item) => { const r = item.raw || {}; return ' Avg ' + Number(r.v || 0).toLocaleString() + ' boardings (' + (r.n || 0) + ' day' + (r.n === 1 ? '' : 's') + ')'; },
        } } },
    },
  });
}

function renderRidershipHeat(rows, from, to) {
  const ch = charts.ridHeat; if (!ch) return;
  rows = (rows || []).filter((r) => r.date >= from && r.date <= to);
  // Count how many of each weekday are in the window (for a fair average).
  const dowCount = [0, 0, 0, 0, 0, 0, 0];
  for (const d = new Date(from + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) dowCount[(d.getUTCDay() + 6) % 7]++;
  const sum = {}; let minH = 23, maxH = 0;
  rows.forEach((r) => {
    const dow = (new Date(r.date + 'T12:00:00Z').getUTCDay() + 6) % 7;
    const h = utcHourToDisplayHour(r.hour);
    if ((r.boardings || 0) > 0) { minH = Math.min(minH, h); maxH = Math.max(maxH, h); }
    const k = dow + '#' + h; sum[k] = (sum[k] || 0) + (r.boardings || 0);
  });
  if (minH > maxH) { minH = 6; maxH = 22; }
  minH = Math.min(minH, 6); maxH = Math.max(maxH, 20);
  const hours = []; for (let h = minH; h <= maxH; h++) hours.push(String(h).padStart(2, '0') + ':00');
  const data = []; let max = 0, best = null;
  RID_DOW.forEach((dn, dow) => {
    hours.forEach((hl, i) => {
      const h = minH + i; const n = dowCount[dow];
      const v = n ? Math.round((sum[dow + '#' + h] || 0) / n) : 0;
      if (v > max) max = v;
      if (!best || v > best.v) best = { v, dn, hl };
      data.push({ x: hl, y: dn, v, n });
    });
  });
  ch.options.scales.x.labels = hours;
  ch.data.datasets[0].data = data; ch.data.datasets[0]._max = max || 1; ch.data.datasets[0]._cols = hours.length;
  ch.update('active');
  const sub = document.getElementById('ridHeatSubtitle');
  if (sub) sub.textContent = 'Average boardings by day and hour \u00b7 ' + ridFmtDate(from) + ' \u2013 ' + ridFmtDate(to)
    + (best && best.v ? ' \u00b7 busiest: ' + best.dn + ' ' + best.hl + ' (avg ' + best.v + ')' : '');
}

// ---- Route share doughnut ----
function initRouteShareChart() {
  const el = document.getElementById('chartRouteShare');
  if (!el) return;
  charts.routeShare = new Chart(el.getContext('2d'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: '#14151d', borderWidth: 3, hoverOffset: 6 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '68%', animation: { duration: 700 },
      plugins: { legend: { display: false }, tooltip: { ...tooltipDefaults(), callbacks: { label: (c) => ' ' + c.label + ': ' + Number(c.parsed).toLocaleString() } } } },
  });
}

function renderRouteShare(allRows, from, to, windowDays, noPrev) {
  const ch = charts.routeShare; if (!ch) return;
  const prevTo = (() => { const d = new Date(from + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const prevFrom = (() => { const d = new Date(from + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - windowDays); return d.toISOString().slice(0, 10); })();
  const cur = {}, prev = {};
  allRows.forEach((r) => {
    const b = String(r.bus_id);
    if (r.date >= from && r.date <= to) cur[b] = (cur[b] || 0) + (r.total_in || 0);
    else if (r.date >= prevFrom && r.date <= prevTo) prev[b] = (prev[b] || 0) + (r.total_in || 0);
  });
  // Skip the "vs previous" arrows when the previous period wasn't (almost) fully counted.
  const prevDays = new Set(allRows.filter((r) => r.date >= prevFrom && r.date <= prevTo && (r.total_in || 0) > 0).map((r) => r.date)).size;
  if (prevDays < windowDays * 0.8) noPrev = true;
  const buses = Object.keys(cur).sort((a, b) => cur[b] - cur[a]);
  const total = buses.reduce((a, b) => a + cur[b], 0);
  ch.data.labels = buses.map((b) => 'Bus ' + b);
  ch.data.datasets[0].data = buses.map((b) => cur[b]);
  ch.data.datasets[0].backgroundColor = buses.map((b, i) => ridRouteColor(b, i));
  ch.update('active');
  const centre = document.getElementById('ridShareCentre');
  if (centre) centre.innerHTML = `<div class="rid-share-total">${total.toLocaleString()}</div><div class="rid-share-cap">boardings</div>`;
  const list = document.getElementById('ridShareList');
  if (list) list.innerHTML = buses.map((b, i) => {
    const share = total ? Math.round((cur[b] / total) * 100) : 0;
    const rk = rsRouteKeyForBus ? rsRouteKeyForBus(b) : b;
    const reg = (STOPS_REGISTRY || STOP_REGISTRY_CACHE || {})[rk];
    const name = reg ? rsRouteShortName(reg) : '';
    return `<div class="rid-share-row"><span class="rid-share-sw" style="background:${ridRouteColor(b, i)}"></span>
      <div class="rid-share-name"><b>Bus ${escapeHtml(b)}</b>${name ? '<span>' + escapeHtml(name) + '</span>' : ''}</div>
      <div class="rid-share-num"><b>${share}%</b><span>${cur[b].toLocaleString()} ${noPrev ? '' : ridDelta(ridPct(cur[b], prev[b]))}</span></div>
      <div class="rid-share-bar"><i style="width:${share}%;background:${ridRouteColor(b, i)}"></i></div></div>`;
  }).join('') || '<div class="rid-empty">No boardings in this period</div>';
}

// "Avg Boardings/Day" KPI over finished days only (today is still in
// progress), so it matches the Ridership Trend's "Average per day".
function ridSetAvgKpi(dailyRows, from, to) {
  const today = displayDateStr();
  const end = to >= today ? (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })() : to;
  // Start counting from the first day that has data, so a period that begins
  // before counting started (e.g. a new install) isn't averaged over empty days.
  const firstData = (dailyRows || []).filter((r) => r.date >= from && (r.total_in || 0) > 0).reduce((m, r) => (m && m < r.date ? m : r.date), null);
  // Only shift when counting clearly began later (over a week in), not for a quiet first day.
  const start = firstData && firstData > from && (new Date(firstData) - new Date(from)) > 7 * 86400000 ? firstData : from;
  let days = 0;
  for (const d = new Date(start + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) days++;
  const sum = (dailyRows || []).filter((r) => r.date >= from && r.date <= end).reduce((a, r) => a + (r.total_in || 0), 0);
  const avg = days ? Math.round(sum / days) : 0;
  setKPI('ridership-kpi-avg', avg.toLocaleString());
  const sub = document.getElementById('ridership-kpi-avg-sub');
  if (sub) sub.textContent = days ? 'over ' + days + ' finished day' + (days === 1 ? '' : 's') + (start !== from ? ' since counting began' : '') + (end !== to ? ' (today excluded)' : '') : 'no finished days yet';
}

function ridHighlightBusiestDay(dowAvg) {
  if (!charts.dayOfWeek || !dowAvg) return;
  ridSetDow(dowAvg.map((v) => v || null), null);
}

/** Populate the Yearly tab's year selector from the backend (falls back to a
 *  simple 5-year window ending this year if the API/DB has no data yet). */
async function populateYearDropdown() {
  const sel = document.getElementById('ridershipYear');
  if (!sel) return;
  const currentYear = new Date().getFullYear();
  let years = [];
  try {
    const data = await apiFetch('/api/ridership/years');
    if (data && Array.isArray(data.years) && data.years.length > 0) years = data.years;
  } catch (e) { /* fall through to default range */ }
  if (years.length === 0) {
    years = [currentYear, currentYear - 1, currentYear - 2, currentYear - 3, currentYear - 4];
  }
  sel.innerHTML = '';
  years.forEach(y => {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  });
  sel.value = String(currentYear);
}

async function populateBusDropdowns() {
  const data = await apiFetch('/api/buses');
  let busList = (data && data.buses) ? data.buses : [];
  // Fallback: derive bus list from live MQTT data
  if (busList.length === 0 && configStore.gateways.length > 0) {
    busList = configStore.gateways.map(gw => gw.label || gw.topic);
  }
  if (busList.length === 0) return;
  // routeSelect (Routes & Stops) builds its own labelled options from the stop registry.
  const selectors = ['ridershipRoute', 'compareRoute', 'dataRoute', 'dataBus'];
  selectors.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const existingOpts = sel.querySelectorAll('option[data-dynamic]');
    existingOpts.forEach(o => o.remove());
    busList.forEach(busId => {
      const opt = document.createElement('option');
      opt.value = busId;
      opt.textContent = busId;
      opt.dataset.dynamic = '1';
      sel.appendChild(opt);
    });
  });
}

async function loadRidershipData() {
  const period = document.getElementById('ridershipPeriod')?.value || '7d';
  const busId = document.getElementById('ridershipRoute')?.value;
  const activeTab = document.querySelector('#ridershipViewTabs .period-tab.active');
  const viewMode = activeTab ? activeTab.dataset.view : 'daily';

  if (viewMode === 'yearly') {
    await loadYearlyRidershipData(busId);
    return;
  }

  // Calculate date range
  const now = new Date();
  let fromDate;
  switch (period) {
    case '7d': fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - 6); break;
    case '30d': fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - 29); break;
    case '90d': fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - 89); break;
    case '1y': fromDate = new Date(now); fromDate.setFullYear(fromDate.getFullYear() - 1); break;
    default: fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - 6);
  }
  const from = displayDateStr(fromDate);
  const to = displayDateStr(now);

  // Number of days in the selected window (inclusive of both ends)
  const windowDays = Math.max(1, Math.round((now - fromDate) / 86400000) + 1);

  // Fetch summary KPIs from API; fall back to live MQTT data
  const summary = await apiFetch('/api/summary', { period: from, bus_id: busId && busId !== 'all' ? busId : null });
  if (summary && summary.totals) {
    const t = summary.totals;
    setKPI('ridership-kpi-total', t.total_boardings > 0 ? t.total_boardings.toLocaleString() : '0');
    // Avg per day across the WHOLE selected window (not only days that had data)
    const avgPerDay = windowDays > 0 ? Math.round(t.total_boardings / windowDays) : 0;
    setKPI('ridership-kpi-avg', avgPerDay > 0 ? avgPerDay.toLocaleString() : '0');
    setKPI('ridership-kpi-buses', t.bus_count > 0 ? t.bus_count : '0');
    const ph = summary.peakHour;
    if (ph && ph.total > 0) {
      setKPI('ridership-kpi-peak', `${String(utcHourToDisplayHour(ph.hour)).padStart(2,'0')}:00`);
      const peakSub = document.getElementById('ridership-kpi-peak-sub');
      if (peakSub) peakSub.textContent = `${ph.total.toLocaleString()} boardings at peak`;
    } else {
      setKPI('ridership-kpi-peak', '\u2014');
    }
    const totalSub = document.getElementById('ridership-kpi-total-sub');
    if (totalSub) totalSub.textContent = `${from} to ${to}`;
    const avgSub = document.getElementById('ridership-kpi-avg-sub');
    if (avgSub) {
      const dataDaysNote = (t.days_count && t.days_count < windowDays) ? ` (data on ${t.days_count}/${windowDays} days)` : '';
      avgSub.textContent = `over ${windowDays} day${windowDays !== 1 ? 's' : ''}${dataDaysNote}`;
    }
  } else {
    // --- MQTT live fallback for KPIs ---
    updateRidershipKPIsFromLive(from, to);
  }

  // Fetch daily data for trend charts from API; fall back to live data
  // One request covers this period plus the previous one (for comparison
  // and the 7-day average), so slice it into current / previous here.
  const prevFromDate = new Date(fromDate); prevFromDate.setDate(prevFromDate.getDate() - Math.max(windowDays, 6));
  const prevFrom = displayDateStr(prevFromDate);
  const [dailyAll, hourlyData] = await Promise.all([
    apiFetch('/api/daily', { from: prevFrom, to, bus_id: busId !== 'all' ? busId : null }),
    apiFetch('/api/hourly', { from, to, bus_id: busId !== 'all' ? busId : null }),
  ]);
  const dailyData = dailyAll && dailyAll.daily ? { daily: dailyAll.daily.filter((r) => r.date >= from) } : null;
  if (dailyData && dailyData.daily) {
    const rows = dailyData.daily;
    renderRidershipCharts(rows, viewMode, fromDate, now);
    try {
      renderRidershipHero(dailyAll.daily, viewMode, fromDate, now, windowDays);
      ridSetAvgKpi(dailyAll.daily, from, to);
      renderRouteShare(dailyAll.daily, from, to, windowDays);
      renderRouteTrends(dailyAll.daily, from, to, viewMode, windowDays);
      renderDowCompare(dailyAll.daily, from, to, windowDays);
      renderRidershipHeat(hourlyData && hourlyData.hourly, from, to);
    } catch (e) { console.warn('[ridership] chart render failed', e); }
  } else {
    // --- MQTT live fallback for charts ---
    renderRidershipChartsFromLive(viewMode, fromDate, now);
  }

  // Ridership vs Weather panel (public/weather.js) — same window and bus filter.
  if (window.SUSWeather) window.SUSWeather.loadRidership(from, to, busId);
}

/** Yearly view: shows Jan-Dec totals for one selected calendar year. KPIs
 *  reuse the same /api/summary endpoint as Daily/Weekly/Monthly (scoped to
 *  the full year via the `to` override) so Peak Hour stays a real time-of-day
 *  value; the month-by-month chart uses the dedicated /api/ridership/yearly
 *  endpoint (server-side aggregation), and the Day-of-Week chart is built
 *  from the same /api/daily rows used across every other view. */
async function loadYearlyRidershipData(busId) {
  const year = Number(document.getElementById('ridershipYear')?.value) || new Date().getFullYear();
  const currentYear = new Date().getFullYear();
  const from = `${year}-01-01`;
  const to = year < currentYear ? `${year}-12-31` : displayDateStr(new Date());
  const windowDays = Math.max(1, Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1);

  // --- KPIs ---
  const summary = await apiFetch('/api/summary', { period: from, to, bus_id: busId && busId !== 'all' ? busId : null });
  if (summary && summary.totals) {
    const t = summary.totals;
    setKPI('ridership-kpi-total', t.total_boardings > 0 ? t.total_boardings.toLocaleString() : '0');
    const avgPerDay = windowDays > 0 ? Math.round(t.total_boardings / windowDays) : 0;
    setKPI('ridership-kpi-avg', avgPerDay > 0 ? avgPerDay.toLocaleString() : '0');
    setKPI('ridership-kpi-buses', t.bus_count > 0 ? t.bus_count : '0');
    const ph = summary.peakHour;
    if (ph && ph.total > 0) {
      setKPI('ridership-kpi-peak', `${String(utcHourToDisplayHour(ph.hour)).padStart(2, '0')}:00`);
      const peakSub = document.getElementById('ridership-kpi-peak-sub');
      if (peakSub) peakSub.textContent = `${ph.total.toLocaleString()} boardings at peak`;
    } else {
      setKPI('ridership-kpi-peak', '\u2014');
    }
    const totalSub = document.getElementById('ridership-kpi-total-sub');
    if (totalSub) totalSub.textContent = `Jan - Dec ${year}`;
    const avgSub = document.getElementById('ridership-kpi-avg-sub');
    if (avgSub) {
      const dataDaysNote = (t.days_count && t.days_count < windowDays) ? ` (data on ${t.days_count}/${windowDays} days)` : '';
      avgSub.textContent = `over ${windowDays} day${windowDays !== 1 ? 's' : ''}${dataDaysNote}`;
    }
  } else {
    updateRidershipKPIsFromLive(from, to);
  }

  // --- Day-of-week chart: same per-day source every other view uses ---
  const dailyData = await apiFetch('/api/daily', { from, to, bus_id: busId !== 'all' ? busId : null });
  const byDate = {};
  if (dailyData && dailyData.daily) {
    dailyData.daily.forEach(r => {
      if (!byDate[r.date]) byDate[r.date] = { boardings: 0, alightings: 0 };
      byDate[r.date].boardings += r.total_in;
      byDate[r.date].alightings += r.total_out;
    });
  }
  updateDayOfWeekChart(byDate);

  // --- Ridership Trend + Boardings vs Alightings: Jan-Dec month totals ---
  const yearlyData = await apiFetch('/api/ridership/yearly', { year, bus_id: busId !== 'all' ? busId : null });
  if (yearlyData && Array.isArray(yearlyData.months)) {
    renderRidershipChartsYearly(yearlyData.months, year);
    try {
      ridTrendSimple(yearlyData.months.map((m) => m.month), yearlyData.months.map((m, i) => (year === currentYear && i > new Date().getMonth() ? null : m.boardings)), 'Total boardings per month \u00b7 ' + year + (year === currentYear ? ' \u00b7 ' + yearlyData.months[new Date().getMonth()].month + ' still in progress' : ''), year === currentYear ? new Date().getMonth() : -1);
      if (dailyData && dailyData.daily) { renderRouteShare(dailyData.daily, from, to, windowDays, true); renderRouteTrends(dailyData.daily, from, to, 'yearly', windowDays, true); ridSetAvgKpi(dailyData.daily, from, to); }
      const hy = await apiFetch('/api/hourly', { from, to, bus_id: busId !== 'all' ? busId : null });
      renderRidershipHeat(hy && hy.hourly, from, to);
    } catch (e) { console.warn('[ridership] yearly render failed', e); }
  } else if (dailyData && dailyData.daily) {
    // Fallback: derive month totals from /api/daily if the dedicated endpoint
    // is unavailable (e.g. an older backend deploy that hasn't redeployed yet).
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const months = monthNames.map((name, i) => ({ month: name, month_num: i + 1, boardings: 0, alightings: 0, days_count: 0 }));
    const seenByMonth = monthNames.map(() => new Set());
    dailyData.daily.forEach(r => {
      const m = Number(r.date.slice(5, 7)) - 1;
      months[m].boardings += r.total_in;
      months[m].alightings += r.total_out;
      seenByMonth[m].add(r.date);
    });
    months.forEach((m, i) => { m.days_count = seenByMonth[i].size; });
    renderRidershipChartsYearly(months, year);
  }

  // Ridership vs Weather panel (public/weather.js) for the whole year.
  if (window.SUSWeather) window.SUSWeather.loadRidership(from, to, busId);
}

/** Render the Ridership Trend + Boardings vs Alightings charts for the Yearly
 *  tab: fixed Jan-Dec x-axis for the selected year, zero-filled. */
function renderRidershipChartsYearly(months, year) {
  const setSubtitle = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const labels = months.map(m => m.month);
  const boardings = months.map(m => m.boardings);
  const alightings = months.map(m => m.alightings);

  charts.boardAlight.data.labels = labels;
  charts.boardAlight.data.datasets[0].data = boardings;
  charts.boardAlight.data.datasets[1].data = alightings;
  charts.boardAlight.update('active');

  const monthsWithData = months.filter(m => m.days_count > 0).length;
  setSubtitle('ridershipTrendSubtitle', `${year} boardings by month - ${monthsWithData}/12 month${monthsWithData !== 1 ? 's' : ''} with data`);
  setSubtitle('boardAlightSubtitle', `${year} boardings vs alightings by month`);
}

/** Populate ridership KPIs from live MQTT state */
function updateRidershipKPIsFromLive(from, to) {
  void to;
  const totalIn = BUS_POSITIONS.reduce((s, b) => s + (b.lineIn || 0), 0);
  const totalOut = BUS_POSITIONS.reduce((s, b) => s + (b.lineOut || 0), 0);
  const activeBuses = BUS_POSITIONS.filter(b => b.status === 'active').length;
  setKPI('ridership-kpi-total', totalIn > 0 ? totalIn.toLocaleString() : (mqttState.connected ? '0' : '\u2014'));
  // Live view is today only — average per day = today's total (single-day window)
  setKPI('ridership-kpi-avg', totalIn > 0 ? totalIn.toLocaleString() : (mqttState.connected ? '0' : '\u2014'));
  setKPI('ridership-kpi-buses', BUS_POSITIONS.length > 0 ? activeBuses : (mqttState.connected ? '0' : '\u2014'));
  // Peak hour from hourlyBuckets
  let peakHour = null, peakVal = 0;
  Object.entries(hourlyBuckets).forEach(([hr, bucket]) => {
    if (bucket.boardings > peakVal) { peakVal = bucket.boardings; peakHour = hr; }
  });
  if (peakHour && peakVal > 0) {
    setKPI('ridership-kpi-peak', peakHour);
    const peakSub = document.getElementById('ridership-kpi-peak-sub');
    if (peakSub) peakSub.textContent = `${peakVal} boardings`;
  } else {
    setKPI('ridership-kpi-peak', mqttState.connected ? '\u2014' : '\u2014');
  }
  const totalSub = document.getElementById('ridership-kpi-total-sub');
  if (totalSub) totalSub.textContent = `Live data — today (${from || 'now'})`;
  const avgSub = document.getElementById('ridership-kpi-avg-sub');
  if (avgSub) avgSub.textContent = totalOut > 0 ? `${totalOut.toLocaleString()} alightings` : 'live session';
}

/** Render ridership trend charts from API daily rows.
 *  Weekly + monthly views zero-fill gap buckets across the full selected
 *  window and use friendly date-range labels. Day-of-week chart aggregates
 *  by unique calendar date (not per-bus-day) so the average is correct. */
function renderRidershipCharts(rows, viewMode, fromDate, now) {
  const setSubtitle = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  // Aggregate rows by unique date FIRST. Each /api/daily row is per-bus-per-day,
  // so two buses on the same day would double-count buckets/days otherwise.
  const byDate = {};
  rows.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = { boardings: 0, alightings: 0 };
    byDate[r.date].boardings += r.total_in;
    byDate[r.date].alightings += r.total_out;
  });

  if (viewMode === 'daily') {
    const allDates = [];
    const d = new Date(fromDate);
    while (d <= now) {
      allDates.push(displayDateStr(d));
      d.setDate(d.getDate() + 1);
    }
    const labels = allDates.map(dt => {
      const dd = new Date(dt + 'T12:00:00Z');
      return dd.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: allDates.length <= 14 ? 'short' : undefined, day: 'numeric', month: 'short' });
    });
    const boardings = allDates.map(dt => byDate[dt] ? byDate[dt].boardings : 0);
    const alightings = allDates.map(dt => byDate[dt] ? byDate[dt].alightings : 0);
    charts.boardAlight.data.labels = labels;
    charts.boardAlight.data.datasets[0].data = boardings;
    charts.boardAlight.data.datasets[1].data = alightings;
    charts.boardAlight.update('active');
    setSubtitle('ridershipTrendSubtitle', 'Daily boardings');
    setSubtitle('boardAlightSubtitle', 'Daily boardings vs alightings');
  } else if (viewMode === 'weekly') {
    // Build every ISO week between fromDate and now, then sum daily into each.
    const startOfWeek = (date) => {
      const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() - (day - 1));
      return d;
    };
    const fromUtc = new Date(Date.UTC(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()));
    const toUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const weeks = [];
    let cur = startOfWeek(fromUtc);
    while (cur <= toUtc) {
      const weekStart = new Date(cur);
      const weekEnd = new Date(cur);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      weeks.push({ start: weekStart, end: weekEnd, boardings: 0, alightings: 0 });
      cur.setUTCDate(cur.getUTCDate() + 7);
    }
    Object.entries(byDate).forEach(([dateStr, v]) => {
      const d = new Date(dateStr + 'T12:00:00Z');
      const ws = startOfWeek(d).getTime();
      const bucket = weeks.find(w => w.start.getTime() === ws);
      if (bucket) { bucket.boardings += v.boardings; bucket.alightings += v.alightings; }
    });
    const fmt = { timeZone: 'UTC', day: 'numeric', month: 'short' };
    const labels = weeks.map(w => {
      const s = w.start.toLocaleDateString('en-US', fmt);
      const e = w.end.toLocaleDateString('en-US', fmt);
      return s + ' - ' + e;
    });
    charts.boardAlight.data.labels = labels;
    charts.boardAlight.data.datasets[0].data = weeks.map(w => w.boardings);
    charts.boardAlight.data.datasets[1].data = weeks.map(w => w.alightings);
    charts.boardAlight.update('active');
    setSubtitle('ridershipTrendSubtitle', 'Weekly boardings - ' + weeks.length + ' week' + (weeks.length === 1 ? '' : 's'));
    setSubtitle('boardAlightSubtitle', 'Weekly boardings vs alightings');
  } else if (viewMode === 'monthly') {
    // Build every YYYY-MM month between fromDate and now, then sum daily into each.
    const months = [];
    const cur = new Date(Date.UTC(fromDate.getFullYear(), fromDate.getMonth(), 1));
    const end = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    while (cur <= end) {
      const key = cur.getUTCFullYear() + '-' + String(cur.getUTCMonth() + 1).padStart(2, '0');
      months.push({ key, year: cur.getUTCFullYear(), month: cur.getUTCMonth(), boardings: 0, alightings: 0 });
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    Object.entries(byDate).forEach(([dateStr, v]) => {
      const key = dateStr.slice(0, 7);
      const bucket = months.find(m => m.key === key);
      if (bucket) { bucket.boardings += v.boardings; bucket.alightings += v.alightings; }
    });
    const labels = months.map(m => new Date(Date.UTC(m.year, m.month, 15))
      .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' }));
    charts.boardAlight.data.labels = labels;
    charts.boardAlight.data.datasets[0].data = months.map(m => m.boardings);
    charts.boardAlight.data.datasets[1].data = months.map(m => m.alightings);
    charts.boardAlight.update('active');
    setSubtitle('ridershipTrendSubtitle', 'Monthly boardings - ' + months.length + ' month' + (months.length === 1 ? '' : 's'));
    setSubtitle('boardAlightSubtitle', 'Monthly boardings vs alightings');
  }

  // Day-of-week chart - aggregate by UNIQUE date (not per-bus-row).
  updateDayOfWeekChart(byDate);
}

/** Shared by every Ridership view (Daily/Weekly/Monthly/Yearly): averages
 *  boardings per weekday across a map of { 'YYYY-MM-DD': { boardings, alightings } }. */
function updateDayOfWeekChart(byDate) {
  if (!charts.dayOfWeek) return;
  const dowTotals = [0,0,0,0,0,0,0];
  const dowCounts = [0,0,0,0,0,0,0];
  const todayStr = displayDateStr();
  Object.entries(byDate).forEach(([dateStr, v]) => {
    if (dateStr === todayStr) return;   // today is still in progress
    const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
    const idx = dow === 0 ? 6 : dow - 1;
    dowTotals[idx] += v.boardings;
    dowCounts[idx]++;
  });
  const dowAvg = dowTotals.map((t, i) => dowCounts[i] > 0 ? Math.round(t / dowCounts[i]) : 0);
  charts.dayOfWeek.data.datasets[0].data = dowAvg;
  ridHighlightBusiestDay(dowAvg);
  charts.dayOfWeek.update('active');
}

/** Render ridership trend charts from live MQTT hourly buckets */
function renderRidershipChartsFromLive(viewMode, fromDate, now) {
  try { ridTrendSimple(); } catch (e) { /* noop */ }
  void viewMode; void fromDate;
  // Use hourly buckets for trend (today only)
  const hours = Array.from({length: 24}, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const boardings = hours.map(h => hourlyBuckets[h] ? hourlyBuckets[h].boardings : 0);
  const alightings = hours.map(h => hourlyBuckets[h] ? hourlyBuckets[h].alightings : 0);
  const todayLabel = now.toLocaleDateString('en-US', { timeZone: APP_TZ, weekday: 'short', day: 'numeric', month: 'short' });

  // Trend chart — show hourly breakdown for today

  // Board/alight chart
  charts.boardAlight.data.labels = hours;
  charts.boardAlight.data.datasets[0].data = boardings;
  charts.boardAlight.data.datasets[1].data = alightings;
  charts.boardAlight.update('active');

  // Day of week — just show today's total
  const dowIdx = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const dowData = [0,0,0,0,0,0,0];
  const totalIn = BUS_POSITIONS.reduce((s, b) => s + (b.lineIn || 0), 0);
  dowData[dowIdx] = totalIn;
  charts.dayOfWeek.data.datasets[0].data = dowData;
  charts.dayOfWeek.update('active');
}

function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

// Cache of the day's hourly board/alight series, refreshed from the API by
// refreshNetAndCumulativeCharts(). Used to time-weight the occupancy bands.
let _occHourlyCache = null;

// Currently selected bus filter for the Passenger On Counts chart. 'all' shows
// the fleet-wide series; any other value filters rows by bus_id.
let _passengerOnBusFilter = 'all';

// Currently selected period for the Passenger On Counts chart.
// 'daily'   — 24 hourly bars for today (uses /api/hourly).
// 'weekly'  — 7 daily bars for the last 7 days (uses /api/daily).
// 'monthly' — ~30 daily bars for the last 30 days (uses /api/daily).
// 'yearly'  — 12 monthly bars (Jan-Dec) for the current year (uses /api/daily).
let _passengerOnPeriod = 'daily';

// Shift a YYYY-MM-DD date string in DISPLAY_TZ by N days (negative = past).
function shiftDisplayDate(daysOffset) {
  const today = displayDateStr();
  const [y, m, d] = today.split('-').map(Number);
  // Use UTC math on a date constructed from the display-zone Y/M/D to avoid
  // off-by-one issues when the local zone differs from the display zone.
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + daysOffset);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Build a short label for a YYYY-MM-DD date, e.g. '9 Jun'.
function shortDateLabel(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// Refresh the Passenger On Counts chart based on the current period + bus filter.
// Daily → hourly bars from /api/hourly. Weekly/Monthly/Yearly → daily bars from /api/daily,
// aggregated to day (Weekly/Monthly) or month (Yearly) buckets.
async function refreshPassengerOnChart() {
  if (!charts.passengerOn) return;
  const period = _passengerOnPeriod || 'daily';
  const busSel = _passengerOnBusFilter || 'all';
  const busFilterArg = busSel === 'all' ? null : busSel;

  let labels = [];
  // One bucket per bus: '515' is the first (blue) series, '419' the second (amber).
  let series515 = [];
  let series419 = [];

  if (period === 'daily') {
    // Hourly bars for today.
    const today = displayDateStr();
    const apiData = await apiFetch('/api/hourly', { date: today });
    labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    series515 = new Array(24).fill(0);
    series419 = new Array(24).fill(0);
    if (apiData && Array.isArray(apiData.hourly)) {
      apiData.hourly.forEach(row => {
        if (busFilterArg && row.bus_id !== busFilterArg) return;
        const dh = utcHourToDisplayHour(row.hour);
        const v = row.boardings || 0;
        if (String(row.bus_id) === '419') series419[dh] += v;
        else series515[dh] += v;
      });
    }
  } else if (period === 'yearly') {
    // Current calendar year, Jan-Dec, zero-filled — same pattern used by
    // the Hourly Passenger Flow chart's Year tab.
    const year = new Date().getFullYear();
    const from = `${year}-01-01`;
    const to = displayDateStr();
    const params = { from, to };
    if (busFilterArg) params.bus_id = busFilterArg;
    const apiData = await apiFetch('/api/daily', params);
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthKeys = monthNames.map((_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    const totals515 = {}; const totals419 = {};
    monthKeys.forEach(k => { totals515[k] = 0; totals419[k] = 0; });
    if (apiData && Array.isArray(apiData.daily)) {
      apiData.daily.forEach(row => {
        if (busFilterArg && row.bus_id !== busFilterArg) return;
        const monthKey = row.date.slice(0, 7);
        if (!(monthKey in totals515)) return;
        const v = row.total_in || 0;
        if (String(row.bus_id) === '419') totals419[monthKey] += v;
        else totals515[monthKey] += v;
      });
    }
    labels = monthNames;
    series515 = monthKeys.map(k => totals515[k]);
    series419 = monthKeys.map(k => totals419[k]);
  } else {
    // Weekly = last 7 days incl. today; Monthly = last 30 days incl. today.
    const span = period === 'weekly' ? 7 : 30;
    const from = shiftDisplayDate(-(span - 1));
    const to = displayDateStr();
    const params = { from, to };
    if (busFilterArg) params.bus_id = busFilterArg;
    const apiData = await apiFetch('/api/daily', params);
    // Pre-fill every day in the window so empty days show as 0 rather than gaps.
    const totals515 = {};
    const totals419 = {};
    for (let i = 0; i < span; i++) {
      const dstr = shiftDisplayDate(-(span - 1 - i));
      totals515[dstr] = 0;
      totals419[dstr] = 0;
    }
    if (apiData && Array.isArray(apiData.daily)) {
      apiData.daily.forEach(row => {
        if (busFilterArg && row.bus_id !== busFilterArg) return;
        if (!(row.date in totals515)) return;
        const v = row.total_in || 0;
        if (String(row.bus_id) === '419') totals419[row.date] += v;
        else totals515[row.date] += v;
      });
    }
    labels = Object.keys(totals515).map(shortDateLabel);
    series515 = Object.values(totals515);
    series419 = Object.values(totals419);
  }

  // Honour the bus filter: hide the series for a bus that isn't selected.
  charts.passengerOn.data.labels = labels;
  charts.passengerOn.data.datasets[0].data = series515;
  charts.passengerOn.data.datasets[1].data = series419;
  charts.passengerOn.getDatasetMeta(0).hidden = (busSel === '419');
  charts.passengerOn.getDatasetMeta(1).hidden = (busSel === '515');
  charts.passengerOn.update('active');

  // Update title + subtitle to reflect the current period and bus.
  const titleEl = document.getElementById('passengerOnTitle');
  const subEl = document.getElementById('passengerOnSubtitle');
  const titleByPeriod = {
    daily: 'Passenger On Counts by Hour',
    weekly: 'Passenger On Counts — Last 7 Days',
    monthly: 'Passenger On Counts — Last 30 Days',
    yearly: 'Passenger On Counts — This Year',
  };
  const subPeriod = {
    daily: 'Boardings only',
    weekly: 'Boardings only — last 7 days',
    monthly: 'Boardings only — last 30 days',
    yearly: 'Boardings only — Jan–Dec this year',
  };
  if (titleEl) titleEl.textContent = titleByPeriod[period] || titleByPeriod.daily;
  if (subEl) {
    const busPart = busSel === 'all' ? 'all buses' : `Bus ${busSel}`;
    subEl.textContent = `${subPeriod[period] || subPeriod.daily} — ${busPart}`;
  }
}

// Fetch today's hourly board/alight series from the API into _occHourlyCache.
async function refreshOccHourlyCache() {
  try {
    const today = displayDateStr();
    const apiData = await apiFetch('/api/hourly', { date: today });
    if (apiData && apiData.hourly && apiData.hourly.length > 0) {
      const board = new Array(24).fill(0), alight = new Array(24).fill(0);
      apiData.hourly.forEach(row => {
        const dh = utcHourToDisplayHour(row.hour);
        board[dh] += row.boardings || 0;
        alight[dh] += row.alightings || 0;
      });
      _occHourlyCache = { board, alight };
    }
  } catch (e) { /* keep prior cache / live fallback */ }
}

// Time-weighted occupancy distribution for the (single) bus: how many active
// hours today the running load sat in each band. This is meaningful for one
// vehicle, unlike the old "count buses per band" which always showed 1 slice.
function computeOccupancyBands() {
  const cap = CONFIG.busCapacity || 16;
  const bands = [0, 0, 0, 0]; // 0-25, 26-50, 51-75, 76-100 (% of capacity)

  // Build board/alight per hour from the API cache, else live buckets.
  const board = new Array(24).fill(0);
  const alight = new Array(24).fill(0);
  if (_occHourlyCache) {
    for (let h = 0; h < 24; h++) { board[h] = _occHourlyCache.board[h] || 0; alight[h] = _occHourlyCache.alight[h] || 0; }
  } else {
    for (let h = 0; h < 24; h++) {
      const k = `${String(h).padStart(2, '0')}:00`;
      board[h] = hourlyBuckets[k]?.boardings || 0;
      alight[h] = hourlyBuckets[k]?.alightings || 0;
    }
  }

  // Walk the running load hour-by-hour; count hours that had activity into bands.
  let running = 0, anyActive = false;
  for (let h = 0; h < 24; h++) {
    running = Math.max(0, Math.min(cap, running + board[h] - alight[h]));
    if (board[h] || alight[h]) {
      anyActive = true;
      const pct = cap > 0 ? (running / cap) * 100 : 0;
      if (pct <= 25) bands[0]++;
      else if (pct <= 50) bands[1]++;
      else if (pct <= 75) bands[2]++;
      else bands[3]++;
    }
  }
  return anyActive ? bands : [1, 0, 0, 0];
}

function updateRidershipKPIs() {
  // Called from live MQTT updates — refresh KPIs + charts from live data
  if (currentView !== 'ridership') return;
  // Refresh KPIs from live data if backend is not available
  if (!backendAvailable) {
    updateRidershipKPIsFromLive(displayDateStr(), displayDateStr());
    renderRidershipChartsFromLive('daily', new Date(), new Date());
  }
  // Always refresh occupancy doughnut from live data
  if (charts.occDist) {
    const bands = computeOccupancyBands();
    charts.occDist.data.datasets[0].data = bands;
    charts.occDist.update('active');
  }
}


// ============================================
// ROUTES & STOPS (Backend-powered, per-stop)
// ============================================

// Module-scoped palette mirrors the Ridership premium look.
const ROUTE_WHITE = 'rgba(255,255,255,0.95)';
const ROUTE_PURPLE = 'rgba(139,116,209,0.85)';
const ROUTE_PURPLE_SOFT = 'rgba(139,116,209,0.45)';
const ROUTE_GOLD = 'rgba(212,175,55,0.95)';
const ROUTE_GOLD_SOFT = 'rgba(212,175,55,0.50)';
const ROUTE_COLOR = {
  '515': { solid: ROUTE_PURPLE, soft: ROUTE_PURPLE_SOFT, hex: '#8b74d1' },
  '419': { solid: ROUTE_GOLD, soft: ROUTE_GOLD_SOFT, hex: '#d4af37' },
};
const routeColorFor = (route) => ROUTE_COLOR[String(route)] || { solid: ROUTE_WHITE, soft: 'rgba(255,255,255,0.4)', hex: '#ffffff' };

// Cached stops registry (route -> stop list with lat/lng)
let STOPS_REGISTRY = null;
let ROUTE_MAP = null;
let ROUTE_MAP_LAYER = null;
let CURRENT_STOPS_PAYLOAD = null; // last fetched /api/stops/boardings payload
let STOP_HOUR_CHART = null; // Chart.js matrix instance for the Hourly Activity by Stop heatmap

async function fetchStopsRegistry() {
  if (STOPS_REGISTRY) return STOPS_REGISTRY;
  const r = await apiFetch('/api/stops');
  STOPS_REGISTRY = (r && r.routes) || {};
  return STOPS_REGISTRY;
}

function shortStopName(s) {
  if (!s) return '';
  // Pretty-print "A -> B" stop segments and shorten common Mayo Clinic suffixes.
  return String(s)
    .replace(/\(return\)/g, '(rtn)')
    .replace(/\s+\(([^)]{20,})\)/g, '') // drop long parenthetical addresses
    .replace(/\s+-\>\s+/g, '  ->  ');
}

// Draws the actual value at the end of each bar so exact numbers are visible
// at a glance instead of requiring a hover. Scoped to this one chart instance
// only (passed via the chart's own `plugins` array), so it never affects any
// other chart on the dashboard.
const stopBarValueLabels = {
  id: 'stopBarValueLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    chart.data.datasets.forEach((dataset, dsIndex) => {
      const meta = chart.getDatasetMeta(dsIndex);
      if (meta.hidden) return;
      meta.data.forEach((bar, index) => {
        const value = dataset.data[index];
        if (!value) return;
        ctx.save();
        ctx.font = "600 11px Inter, sans-serif";
        ctx.fillStyle = dsIndex === 0 ? 'rgba(255,255,255,0.95)' : 'rgba(232,193,73,1)';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(Number(value).toLocaleString(), bar.x + 6, bar.y);
        ctx.restore();
      });
    });
  },
};

// ----- Routes & Stops state -----------------------------------------------
// Return-direction visits ("Main Hospital (return)") are combined with the
// outbound stop so each physical stop appears once.
const RS = { route: 'all', stop: 'all', preset: '7', from: null, to: null, groups: [], daily: [], hourly: [], wired: false };
let STOP_DAILY_CHART = null;
let STOP_HOURLY_CHART = null;

function rsBaseStop(name) {
  return String(name || '')
    .replace(/\s*\((return|rtn)\)\s*$/i, '')
    .replace(/\s*\(\d[^)]*\)/g, '')      // street addresses, e.g. "(200 1st St SW)"
    .replace(/\s+/g, ' ')
    .trim();
}
function rsKey(route, name) { return String(route) + '|' + rsBaseStop(name); }
function rsStopLabel(name) { return shortStopName(rsBaseStop(name)); }
function rsRouteShortName(route) {
  // "Bus 515 — Downtown Inter-Campus Loop (A ↔ B)" -> "Downtown Inter-Campus Loop"
  const raw = String((route && route.name) || '');
  return raw.replace(/^Bus\s+\S+\s*[—–-]\s*/i, '').replace(/\s*\(.*\)\s*$/, '').trim();
}
function rsRouteOptions() {
  const out = [];
  Object.entries(STOPS_REGISTRY || {}).forEach(([k, r]) => {
    const busId = (r.bus_ids && r.bus_ids[0]) || k;
    out.push({ value: String(busId), routeKey: k, label: 'Route ' + k + (rsRouteShortName(r) ? ' \u00b7 ' + rsRouteShortName(r) : '') });
  });
  return out.sort((a, b) => a.routeKey.localeCompare(b.routeKey, undefined, { numeric: true }));
}
function rsDaysBetween(from, to) {
  return Math.max(1, Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000) + 1);
}
function rsDateList(from, to) {
  const out = []; const d = new Date(from + 'T12:00:00Z'); const end = Date.parse(to + 'T12:00:00Z');
  while (d.getTime() <= end && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
function rsSetText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function rsRangeLabel() {
  return RS.from === RS.to ? prettyDate(RS.from) : (prettyDate(RS.from) + ' \u2013 ' + prettyDate(RS.to));
}
function rsApplyPreset(preset) {
  RS.preset = preset;
  const today = displayDateStr();
  const fromEl = document.getElementById('routeFromDate');
  const toEl = document.getElementById('routeToDate');
  if (preset !== 'custom') {
    const days = parseInt(preset, 10) || 7;
    const f = new Date(); f.setDate(f.getDate() - (days - 1));
    RS.from = displayDateStr(f); RS.to = today;
    if (fromEl) fromEl.value = RS.from;
    if (toEl) toEl.value = RS.to;
  } else {
    let f = (fromEl && fromEl.value) || RS.from || today;
    let t = (toEl && toEl.value) || RS.to || today;
    if (t > today) t = today;
    if (f > t) { const x = f; f = t; t = x; }
    RS.from = f; RS.to = t;
    if (fromEl) fromEl.value = f;
    if (toEl) toEl.value = t;
  }
  document.querySelectorAll('#routePresetGroup [data-route-preset]').forEach((b) => {
    const on = b.getAttribute('data-route-preset') === preset;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const custom = document.getElementById('routeCustomRange');
  if (custom) custom.hidden = preset !== 'custom';
}

function initRoutes() {
  // ----- Passengers by stop bar chart (click a bar to open the stop) -----
  const stopCtx = document.getElementById('chartStopBoardings').getContext('2d');
  charts.stopBoardings = new Chart(stopCtx, {
    type: 'bar',
    plugins: [stopBarValueLabels],
    data: { labels: [], datasets: [
      { label: 'Boardings', data: [], backgroundColor: ROUTE_WHITE, hoverBackgroundColor: 'rgba(255,255,255,1)', borderRadius: 6, borderSkipped: false, maxBarThickness: 22 },
      { label: 'Alightings', data: [], backgroundColor: ROUTE_GOLD, hoverBackgroundColor: 'rgba(232,193,73,1)', borderRadius: 6, borderSkipped: false, maxBarThickness: 22 },
    ]},
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 500, easing: 'easeOutQuart' },
      layout: { padding: { right: 48 } },
      onClick: (evt, els) => {
        if (!els || !els.length) return;
        const g = charts.stopBoardings._rsKeys && charts.stopBoardings._rsKeys[els[0].index];
        if (g) rsSelectStop(g);
      },
      onHover: (evt, els) => { if (evt.native && evt.native.target) evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
      plugins: {
        legend: { labels: { color: '#dbdce6', font: { size: 12, family: 'Inter', weight: '500' }, padding: 16, usePointStyle: true, pointStyle: 'circle', boxWidth: 10 } },
        tooltip: { ...tooltipDefaults(), padding: 12, callbacks: { label: (c) => ' ' + c.dataset.label + ': ' + Number(c.parsed.x).toLocaleString() } },
      },
      scales: {
        x: { beginAtZero: true, grace: '15%', grid: { color: 'rgba(255,255,255,0.05)', drawTicks: false }, ticks: { color: '#c9cad8', font: { size: 12, family: 'Inter', weight: '500' }, padding: 6, callback: (v) => Number(v).toLocaleString() } },
        y: { grid: { display: false }, ticks: { color: '#c9cad8', font: { size: 11, family: 'Inter', weight: '500' }, padding: 6, autoSkip: false } },
      },
    },
  });

  initStopHourMatrixChart();

  // ----- Leaflet route map -----
  const mapEl = document.getElementById('routeMap');
  if (mapEl && window.L) {
    ROUTE_MAP = L.map('routeMap', { zoomControl: true, attributionControl: false, scrollWheelZoom: false, zoomSnap: DEMO ? 0.25 : 1 })
      .setView(MAP_DEFAULT_CENTER, 13);
    addBaseLayer(ROUTE_MAP, 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    });
    ROUTE_MAP_LAYER = L.layerGroup().addTo(ROUTE_MAP);
  }

  // ----- Filters -----
  const today = displayDateStr();
  const fromEl = document.getElementById('routeFromDate');
  const toEl = document.getElementById('routeToDate');
  if (fromEl) fromEl.max = today;
  if (toEl) toEl.max = today;
  rsApplyPreset('7');

  const onCustomDate = () => { rsApplyPreset('custom'); loadRoutesData(); };
  if (fromEl) fromEl.addEventListener('change', onCustomDate);
  if (toEl) toEl.addEventListener('change', onCustomDate);

  document.querySelectorAll('#routePresetGroup [data-route-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-route-preset');
      rsApplyPreset(p);
      if (p === 'custom') { if (fromEl) fromEl.focus(); return; }
      loadRoutesData();
    });
  });

  const routeSel = document.getElementById('routeSelect');
  if (routeSel) routeSel.addEventListener('change', () => {
    RS.route = routeSel.value || 'all';
    // Keep the chosen stop only if it belongs to the new route.
    if (RS.stop !== 'all' && RS.route !== 'all' && RS.stop.split('|')[0] !== rsRouteKeyForBus(RS.route)) RS.stop = 'all';
    loadRoutesData();
  });
  const stopSel = document.getElementById('routeStopSelect');
  if (stopSel) stopSel.addEventListener('change', () => { rsSelectStop(stopSel.value || 'all'); });

  const back = document.getElementById('stopDetailBack');
  if (back) back.addEventListener('click', () => rsSelectStop('all'));

  const tbody = document.getElementById('stopLeaderBody');
  if (tbody) tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) rsSelectStop(tr.getAttribute('data-key'));
  });
  if (tbody) tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('tr[data-key]');
    if (tr) { e.preventDefault(); rsSelectStop(tr.getAttribute('data-key')); }
  });

  const det = document.getElementById('stopHourDetails');
  if (det) det.addEventListener('toggle', () => {
    if (det.open) { rsRenderHeatmap(); setTimeout(() => { try { STOP_HOUR_CHART && STOP_HOUR_CHART.resize(); } catch (e) {} }, 50); }
  });

  const csvBtn = document.getElementById('routeExportCsv');
  if (csvBtn) csvBtn.addEventListener('click', exportRoutesCsv);

  RS.wired = true;
  loadRoutesData();
}

function rsRouteKeyForBus(busId) {
  for (const [k, r] of Object.entries(STOPS_REGISTRY || {})) {
    if (String(k) === String(busId) || (r.bus_ids || []).map(String).includes(String(busId))) return String(k);
  }
  return String(busId);
}

function rsSelectStop(key) {
  RS.stop = key || 'all';
  const stopSel = document.getElementById('routeStopSelect');
  if (stopSel && stopSel.value !== RS.stop) stopSel.value = RS.stop;
  rsRender();
}

function rsPopulateRouteSelect() {
  const sel = document.getElementById('routeSelect');
  if (!sel) return;
  const opts = rsRouteOptions();
  const want = RS.route;
  sel.innerHTML = '<option value="all">All routes</option>' + opts.map((o) => '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>').join('');
  sel.value = opts.some((o) => o.value === want) ? want : 'all';
  RS.route = sel.value;
}

function rsPopulateStopSelect() {
  const sel = document.getElementById('routeStopSelect');
  if (!sel) return;
  // Registry order (the order buses drive), then any extra observed stops.
  const routeKeys = RS.route === 'all' ? Object.keys(STOPS_REGISTRY || {}) : [rsRouteKeyForBus(RS.route)];
  routeKeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let html = '<option value="all">All stops</option>';
  const valid = new Set(['all']);
  routeKeys.forEach((rk) => {
    const seen = new Set();
    const items = [];
    ((STOPS_REGISTRY[rk] && STOPS_REGISTRY[rk].stops) || []).forEach((st) => {
      const key = rsKey(rk, st.name);
      if (!seen.has(key)) { seen.add(key); items.push({ key, label: rsStopLabel(st.name) }); }
    });
    RS.groups.filter((g) => g.route === rk && !seen.has(g.key)).forEach((g) => { seen.add(g.key); items.push({ key: g.key, label: g.label }); });
    if (!items.length) return;
    html += '<optgroup label="Route ' + escapeHtml(rk) + '">' + items.map((i) => { valid.add(i.key); return '<option value="' + escapeHtml(i.key) + '">' + escapeHtml(i.label) + '</option>'; }).join('') + '</optgroup>';
  });
  sel.innerHTML = html;
  if (!valid.has(RS.stop)) RS.stop = 'all';
  sel.value = RS.stop;
}

async function loadRoutesData() {
  if (!RS.from || !RS.to) rsApplyPreset(RS.preset || '7');
  await fetchStopsRegistry();
  rsPopulateRouteSelect();

  const params = { from: RS.from, to: RS.to };
  if (RS.route !== 'all') params.bus_id = RS.route;
  const reqId = (RS._req = (RS._req || 0) + 1);
  const [payload, daily, hourly] = await Promise.all([
    apiFetch('/api/stops/boardings', params),
    apiFetch('/api/stops/daily', params),
    apiFetch('/api/stops/hourly', params),
  ]);
  if (reqId !== RS._req) return; // a newer request superseded this one
  CURRENT_STOPS_PAYLOAD = payload;

  const rk = RS.route === 'all' ? null : rsRouteKeyForBus(RS.route);
  const keep = (r) => !rk || String(r.route) === rk;
  RS.daily = ((daily && daily.rows) || []).filter(keep);
  RS.hourly = ((hourly && hourly.rows) || []).filter(keep);

  const byKey = {};
  ((payload && payload.stops) || []).filter(keep).forEach((s) => {
    const key = rsKey(s.route, s.stop);
    if (!byKey[key]) byKey[key] = { key, route: String(s.route), label: rsStopLabel(s.stop), boardings: 0, alightings: 0 };
    byKey[key].boardings += s.boardings || 0;
    byKey[key].alightings += s.alightings || 0;
  });
  RS.groups = Object.values(byKey).sort((a, b) => (b.boardings - a.boardings) || (b.alightings - a.alightings));

  rsPopulateStopSelect();
  rsRender();
  spLoad();
}

function rsRender() {
  const overview = document.getElementById('routesOverview');
  const detail = document.getElementById('stopDetail');
  const one = RS.stop !== 'all';
  if (overview) overview.hidden = one;
  if (detail) detail.hidden = !one;
  const head = document.getElementById('stopDetailHead');
  if (head) head.hidden = !one;
  if (one) rsRenderStopDetail(); else rsRenderOverview();
}

function rsRenderOverview() {
  const groups = RS.groups;
  const totalBoard = groups.reduce((a, g) => a + g.boardings, 0);
  const totalAlight = groups.reduce((a, g) => a + g.alightings, 0);
  const active = groups.filter((g) => g.boardings + g.alightings > 0);
  const busiest = groups[0];
  const scope = RS.route === 'all' ? 'all routes' : ('Route ' + rsRouteKeyForBus(RS.route));
  const range = rsRangeLabel();

  rsSetText('routeKpiBoard', totalBoard.toLocaleString());
  rsSetText('routeKpiBoardSub', range + ' \u00b7 ' + scope);
  rsSetText('routeKpiAlight', totalAlight.toLocaleString());
  rsSetText('routeKpiAlightSub', totalBoard ? (Math.round((totalAlight / totalBoard) * 1000) / 10) + '% of boardings' : range);
  rsSetText('routeKpi3Label', 'Busiest stop');
  rsSetText('routeKpiBusiest', busiest && busiest.boardings ? busiest.label : 'No data');
  rsSetText('routeKpiBusiestSub', busiest && busiest.boardings ? busiest.boardings.toLocaleString() + ' boardings \u00b7 Route ' + busiest.route : '--');
  rsSetText('routeKpi4Label', 'Stops served');
  rsSetText('routeKpiStops', String(active.length));
  rsSetText('routeKpiStopsSub', 'with passengers \u00b7 ' + range);

  // Bar chart: every stop (they are few), busiest first.
  const top = groups.slice(0, 12);
  charts.stopBoardings._rsKeys = top.map((g) => g.key);
  charts.stopBoardings.data.labels = top.map((g) => RS.route === 'all' ? g.label + ' \u00b7 ' + g.route : g.label);
  charts.stopBoardings.data.datasets[0].data = top.map((g) => g.boardings);
  charts.stopBoardings.data.datasets[1].data = top.map((g) => g.alightings);
  charts.stopBoardings.data.datasets[1].backgroundColor = RS.route === 'all' ? ROUTE_GOLD : routeColorFor(rsRouteKeyForBus(RS.route)).solid;
  charts.stopBoardings.update('active');
  rsSetText('stopRankSubtitle', range + ' \u00b7 ' + scope + ' \u00b7 click a bar to open that stop');

  // Table
  const tbody = document.getElementById('stopLeaderBody');
  if (tbody) {
    if (!groups.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:#8b8ea5">No passengers counted in this period.</td></tr>';
    } else {
      tbody.innerHTML = groups.map((g, i) => {
        const net = g.boardings - g.alightings;
        const netColor = net > 0 ? '#4ade80' : (net < 0 ? '#f87171' : '#c9cad8');
        const share = totalBoard ? Math.round((g.boardings / totalBoard) * 1000) / 10 : 0;
        return '<tr class="rs-row" data-key="' + escapeHtml(g.key) + '" tabindex="0" title="Open per-stop analysis">'
          + '<td><span class="stop-rank-pill' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</span></td>'
          + '<td style="color:#dbdce6;font-weight:500">' + escapeHtml(g.label) + '</td>'
          + '<td><span class="route-pill r-' + escapeHtml(g.route) + '">' + escapeHtml(g.route) + '</span></td>'
          + '<td style="text-align:right;color:#fff;font-weight:600">' + g.boardings.toLocaleString() + '</td>'
          + '<td style="text-align:right;color:#f0d175">' + g.alightings.toLocaleString() + '</td>'
          + '<td style="text-align:right;color:' + netColor + ';font-weight:600">' + (net > 0 ? '+' : '') + net.toLocaleString() + '</td>'
          + '<td style="text-align:right"><span class="rs-share"><span style="width:' + Math.min(100, share) + '%"></span></span>' + share + '%</td>'
          + '<td style="text-align:right;color:#8b8ea5">View &rarr;</td>'
          + '</tr>';
      }).join('');
    }
  }
  rsSetText('stopLeaderSubtitle', groups.length + ' stops \u00b7 ' + range + ' \u00b7 both directions combined \u00b7 click a row for the per-stop analysis');

  renderRouteMap();
  try { rsRenderFootfall(); } catch (e) { console.warn('Footfall heatmap failed:', e); }
  rsSetText('routeMapSubtitle', 'Circle size = boardings \u00b7 ' + range + ' \u00b7 click a stop to open it');

  const det = document.getElementById('stopHourDetails');
  if (det && det.open) rsRenderHeatmap();
}

function rsRenderStopDetail() {
  const key = RS.stop;
  const [route] = key.split('|');
  const g = RS.groups.find((x) => x.key === key) || { key, route, label: key.split('|').slice(1).join('|'), boardings: 0, alightings: 0 };
  const days = rsDaysBetween(RS.from, RS.to);
  const range = rsRangeLabel();
  const routeObj = STOPS_REGISTRY && STOPS_REGISTRY[route];

  rsSetText('stopDetailName', g.label);
  rsSetText('stopDetailSub', 'Route ' + route + (routeObj && rsRouteShortName(routeObj) ? ' \u00b7 ' + rsRouteShortName(routeObj) : '') + ' \u00b7 ' + range + ' \u00b7 both directions combined');

  // Per-day and per-hour series for this stop
  const dates = rsDateList(RS.from, RS.to);
  const perDay = {}; dates.forEach((d) => { perDay[d] = { b: 0, a: 0 }; });
  RS.daily.forEach((r) => {
    if (rsKey(r.route, r.stop) !== key) return;
    if (!perDay[r.date]) perDay[r.date] = { b: 0, a: 0 };
    perDay[r.date].b += r.boardings || 0;
    perDay[r.date].a += r.alightings || 0;
  });
  const perHour = Array.from({ length: 24 }, () => ({ b: 0, a: 0 }));
  RS.hourly.forEach((r) => {
    if (rsKey(r.route, r.stop) !== key) return;
    const h = utcHourToDisplayHour(r.hour);
    perHour[h].b += r.boardings || 0;
    perHour[h].a += r.alightings || 0;
  });
  const busiestHour = perHour.reduce((best, v, h) => (v.b > perHour[best].b ? h : best), 0);
  const activeDays = dates.filter((d) => perDay[d].b + perDay[d].a > 0).length || 0;
  const net = g.boardings - g.alightings;

  rsSetText('routeKpiBoard', g.boardings.toLocaleString());
  rsSetText('routeKpiBoardSub', 'got on here \u00b7 ' + range);
  rsSetText('routeKpiAlight', g.alightings.toLocaleString());
  rsSetText('routeKpiAlightSub', 'got off here \u00b7 net ' + (net > 0 ? '+' : '') + net.toLocaleString());
  rsSetText('routeKpi3Label', 'Busiest hour');
  rsSetText('routeKpiBusiest', perHour[busiestHour].b ? String(busiestHour).padStart(2, '0') + ':00\u2013' + String((busiestHour + 1) % 24).padStart(2, '0') + ':00' : 'No data');
  rsSetText('routeKpiBusiestSub', perHour[busiestHour].b ? perHour[busiestHour].b.toLocaleString() + ' boardings in that hour' : '--');
  rsSetText('routeKpi4Label', 'Avg boardings / day');
  rsSetText('routeKpiStops', activeDays ? (Math.round((g.boardings / activeDays) * 10) / 10).toLocaleString() : '0');
  rsSetText('routeKpiStopsSub', activeDays + ' of ' + days + ' days with passengers');

  // Daily chart
  const dLabels = dates.map((d) => prettyDate(d));
  if (!STOP_DAILY_CHART) {
    STOP_DAILY_CHART = new Chart(document.getElementById('chartStopDaily').getContext('2d'), {
      type: 'bar',
      data: { labels: [], datasets: [
        { label: 'Boardings', data: [], backgroundColor: ROUTE_WHITE, borderRadius: 4, maxBarThickness: 18 },
        { label: 'Alightings', data: [], backgroundColor: ROUTE_GOLD, borderRadius: 4, maxBarThickness: 18 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#dbdce6', usePointStyle: true, pointStyle: 'circle', boxWidth: 10 } }, tooltip: tooltipDefaults() },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#c9cad8', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#c9cad8', precision: 0 } },
        },
      },
    });
  }
  STOP_DAILY_CHART.data.labels = dLabels;
  STOP_DAILY_CHART.data.datasets[0].data = dates.map((d) => perDay[d].b);
  STOP_DAILY_CHART.data.datasets[1].data = dates.map((d) => perDay[d].a);
  STOP_DAILY_CHART.update();
  rsSetText('stopDailySubtitle', 'Boardings and alightings per day \u00b7 ' + range);

  // Hourly chart: show the service span only (first..last hour with activity)
  let h0 = perHour.findIndex((v) => v.b + v.a > 0);
  let h1 = 23 - perHour.slice().reverse().findIndex((v) => v.b + v.a > 0);
  if (h0 < 0) { h0 = 5; h1 = 23; }
  const hours = []; for (let h = h0; h <= h1; h++) hours.push(h);
  const div = activeDays || 1;
  if (!STOP_HOURLY_CHART) {
    STOP_HOURLY_CHART = new Chart(document.getElementById('chartStopHourly').getContext('2d'), {
      type: 'bar',
      data: { labels: [], datasets: [
        { label: 'Boardings', data: [], backgroundColor: ROUTE_WHITE, borderRadius: 4, maxBarThickness: 16 },
        { label: 'Alightings', data: [], backgroundColor: ROUTE_GOLD, borderRadius: 4, maxBarThickness: 16 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#dbdce6', usePointStyle: true, pointStyle: 'circle', boxWidth: 10 } }, tooltip: { ...tooltipDefaults(), callbacks: { label: (c) => ' ' + c.dataset.label + ': ' + c.parsed.y + ' per day' } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#c9cad8', maxRotation: 0 } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#c9cad8' } },
        },
      },
    });
  }
  STOP_HOURLY_CHART.data.labels = hours.map((h) => String(h).padStart(2, '0') + ':00');
  STOP_HOURLY_CHART.data.datasets[0].data = hours.map((h) => Math.round((perHour[h].b / div) * 10) / 10);
  STOP_HOURLY_CHART.data.datasets[1].data = hours.map((h) => Math.round((perHour[h].a / div) * 10) / 10);
  STOP_HOURLY_CHART.update();
  rsSetText('stopHourlySubtitle', activeDays > 1 ? 'Average per day across ' + activeDays + ' days' : 'Counts by hour');

  // Day-by-day table (newest first)
  const body = document.getElementById('stopDailyBody');
  if (body) {
    body.innerHTML = dates.slice().reverse().map((d) => {
      const v = perDay[d]; const n = v.b - v.a;
      const nc = n > 0 ? '#4ade80' : (n < 0 ? '#f87171' : '#c9cad8');
      return '<tr><td style="color:#dbdce6">' + escapeHtml(prettyDate(d)) + '</td>'
        + '<td style="text-align:right;color:#fff;font-weight:600">' + v.b.toLocaleString() + '</td>'
        + '<td style="text-align:right;color:#f0d175">' + v.a.toLocaleString() + '</td>'
        + '<td style="text-align:right;color:' + nc + '">' + (n > 0 ? '+' : '') + n.toLocaleString() + '</td></tr>';
    }).join('') || '<tr><td colspan="4" style="text-align:center;padding:24px;color:#8b8ea5">No data</td></tr>';
  }
  setTimeout(() => { try { STOP_DAILY_CHART.resize(); STOP_HOURLY_CHART.resize(); } catch (e) {} }, 30);
}

function prettyDate(yyyyMmDd) {
  if (!yyyyMmDd) return '';
  const d = new Date(yyyyMmDd + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRouteMap() {
  if (!ROUTE_MAP || !ROUTE_MAP_LAYER) return;
  ROUTE_MAP_LAYER.clearLayers();
  if (!STOPS_REGISTRY) return;
  const routesToShow = RS.route === 'all' ? Object.keys(STOPS_REGISTRY) : [rsRouteKeyForBus(RS.route)];
  const byKey = {}; RS.groups.forEach((g) => { byKey[g.key] = g; });
  const allLatLngs = [];
  routesToShow.forEach((rk) => {
    const route = STOPS_REGISTRY[rk];
    if (!route) return;
    const col = { hex: mapRouteHex(rk, Object.keys(STOPS_REGISTRY || {}).indexOf(rk)) };
    const line = routeLinePoints(route);
    const pts = line.pts;
    if (pts.length >= 2) L.polyline(pts, line.roads ? { color: col.hex, weight: 4, opacity: 0.9, lineJoin: 'round' } : { color: col.hex, weight: 3, opacity: 0.7, dashArray: '6 6' }).addTo(ROUTE_MAP_LAYER);
    if (line.roads) pts.forEach((p) => allLatLngs.push(p));
    const seen = new Set();
    const uniq = (route.stops || []).filter((st) => { const k = rsKey(rk, st.name); if (seen.has(k)) return false; seen.add(k); return true; });
    const routeMax = Math.max(1, ...uniq.map((st) => (byKey[rsKey(rk, st.name)] || {}).boardings || 0));
    uniq.forEach((st) => {
      const key = rsKey(rk, st.name);
      const g = byKey[key] || { boardings: 0, alightings: 0 };
      const r = 6 + Math.sqrt((g.boardings || 0) / routeMax) * 18;
      const marker = L.circleMarker([st.lat, st.lng], { radius: r, color: '#ffffff', weight: 2, fillColor: col.hex, fillOpacity: 0.8 });
      if (line.roads) {
        // Demo: name always visible next to the circle.
        marker.bindTooltip(escapeHtml(rsStopLabel(st.name)),
          { permanent: true, direction: 'right', offset: [r, 0], className: 'stop-name-label' });
      } else {
        marker.bindTooltip('<b>' + escapeHtml(rsStopLabel(st.name)) + '</b><br>Route ' + escapeHtml(rk)
          + '<br>On ' + (g.boardings || 0).toLocaleString() + ' \u00b7 Off ' + (g.alightings || 0).toLocaleString(), { direction: 'top' });
      }
      marker.on('click', () => rsSelectStop(key));
      if (!line.roads) marker.unbindTooltip();   // the hover card replaces the plain tip
      attachStopHoverCard(marker, rk, rsBaseStop(st.name), col.hex, RS_CARD_OPTS);
      marker.addTo(ROUTE_MAP_LAYER);
      allLatLngs.push([st.lat, st.lng]);
    });
  });
  if (allLatLngs.length) { try { ROUTE_MAP.fitBounds(L.latLngBounds(allLatLngs), { padding: [36, 36], maxZoom: 15 }); } catch (e) { /* noop */ } }
  if (STOPS_REGISTRY) addRouteKey(ROUTE_MAP, 'routeMap', RS.route === 'all' ? STOPS_REGISTRY : { [rsRouteKeyForBus(RS.route)]: STOPS_REGISTRY[rsRouteKeyForBus(RS.route)] });
  declutterSoon(ROUTE_MAP);
  setTimeout(() => { try { ROUTE_MAP.invalidateSize(); } catch (e) {} }, 100);
}

// ----- Street-level footfall heatmap (demo road routes) -------------------
// Each stop's footfall (boardings, alightings or both, optionally for one
// part of the day) is drawn at the stop and spread along the road path on
// either side, fading over ~200 m, so the heat sits on the actual streets.
let FOOTFALL_MAP = null, FOOTFALL_HEAT = null, FOOTFALL_LABELS = null, FOOTFALL_FITTED = false;
const FF = { measure: 'both', time: 'all' };

function ffDensify(path, stepM) {
  const out = [];
  const d = (p, q) => Math.hypot((q[0] - p[0]) * 111320, (q[1] - p[1]) * 111320 * Math.cos(p[0] * Math.PI / 180));
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]; const n = Math.max(1, Math.round(d(a, b) / stepM));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
  }
  if (path.length) out.push(path[path.length - 1]);
  return out;
}

function ffWeights() {
  // key -> people, for the chosen measure and time of day
  const w = {};
  const pick = (b, a) => (FF.measure === 'on' ? b : FF.measure === 'off' ? a : b + a);
  if (FF.time === 'all') {
    RS.groups.forEach((g) => { w[g.key] = pick(g.boardings, g.alightings); });
  } else {
    const [h0, h1] = FF.time.split('-').map(Number);
    RS.hourly.forEach((r) => {
      const h = utcHourToDisplayHour(r.hour);
      if (h < h0 || h >= h1) return;
      const k = rsKey(r.route, r.stop);
      w[k] = (w[k] || 0) + pick(r.boardings || 0, r.alightings || 0);
    });
  }
  return w;
}

function initFootfallMap() {
  const panel = document.getElementById('footfallPanel');
  const el = document.getElementById('footfallMap');
  if (!panel || !el || !window.L || FOOTFALL_MAP) return;
  FOOTFALL_MAP = L.map('footfallMap', { zoomControl: true, attributionControl: false, scrollWheelZoom: false, zoomSnap: DEMO ? 0.25 : 1 }).setView(MAP_DEFAULT_CENTER, 14);
  addBaseLayer(FOOTFALL_MAP, 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
  FOOTFALL_LABELS = L.layerGroup().addTo(FOOTFALL_MAP);
  FOOTFALL_MAP.on('zoomend', () => { if (FOOTFALL_HEAT) rsRenderFootfall(); });
  document.querySelectorAll('#footfallMeasure [data-ff-measure]').forEach((b) => b.addEventListener('click', () => {
    FF.measure = b.getAttribute('data-ff-measure');
    document.querySelectorAll('#footfallMeasure [data-ff-measure]').forEach((x) => x.classList.toggle('active', x === b));
    rsRenderFootfall();
  }));
  const t = document.getElementById('footfallTime');
  if (t) t.addEventListener('change', () => { FF.time = t.value || 'all'; rsRenderFootfall(); });
}

function ffMetresPerPx(map) {
  const m = map || FOOTFALL_MAP;
  const z = m ? m.getZoom() : 14;
  return 156543.03 * Math.cos(53.48 * Math.PI / 180) / Math.pow(2, z);
}
function ffRadiusPx(map) { return Math.max(18, Math.min(60, Math.round(70 / ffMetresPerPx(map)))); }

function ffHeatOptions(map) {
  // Grow the blob with zoom so it stays street-sized (~120 m) on screen.
  const m = map || FOOTFALL_MAP;
  const z = m ? m.getZoom() : 14;
  const radius = ffRadiusPx(m);
  // maxZoom = current zoom stops leaflet.heat fading intensity when zoomed out.
  return { radius, blur: Math.round(radius * 0.8), maxZoom: z, max: 1, minOpacity: 0.2,
    gradient: { 0.15: '#1e3a8a', 0.3: '#2563eb', 0.45: '#22d3ee', 0.62: '#facc15', 0.8: '#f97316', 1.0: '#dc2626' } };
}

// Heat points for a set of routes: each stop's footfall at the stop and
// spread along the road either side (fading over ~200 m). Shared by the
// Routes & Stops panel and the Live Map layer.
function ffHeatPoints(map, registry, routeKeys, w) {
  const maxW = Math.max(1, ...Object.values(w));
  const points = []; const stopsSeen = new Map(); const bounds = [];
  routeKeys.forEach((rk) => {
    const route = registry[rk]; if (!route) return;
    // Sample the road at ~half a heat radius so overlap (and colour) is
    // the same at every zoom level.
    const step = Math.max(8, Math.min(150, ffMetresPerPx(map) * ffRadiusPx(map) * 0.5));
    const road = ffDensify(routeLinePoints(route).pts, step);
    const mine = new Map();
    (route.stops || []).forEach((st) => {
      const key = rsKey(rk, st.name);
      if (!stopsSeen.has(key)) { stopsSeen.set(key, { st, rk }); mine.set(key, st); }
    });
    mine.forEach((st, key) => {
      const f = (w[key] || 0) / maxW;
      if (f <= 0) return;
      points.push([st.lat, st.lng, f * 0.4]);
      road.forEach((p) => {
        const dm = Math.hypot((p[0] - st.lat) * 111320, (p[1] - st.lng) * 111320 * Math.cos(st.lat * Math.PI / 180));
        if (dm <= 220) points.push([p[0], p[1], f * Math.exp(-Math.pow(dm / 110, 2)) * 0.2]);
      });
    });
    road.forEach((p) => bounds.push(p));
  });
  return { points, stopsSeen, bounds };
}

function rsRenderFootfall() {
  const panel = document.getElementById('footfallPanel');
  if (!panel) return;
  const routesToShow = RS.route === 'all' ? Object.keys(STOPS_REGISTRY || {}) : [rsRouteKeyForBus(RS.route)];
  const hasRoads = routesToShow.some((rk) => STOPS_REGISTRY[rk] && routeLinePoints(STOPS_REGISTRY[rk]).roads);
  panel.hidden = !hasRoads || typeof L.heatLayer !== 'function';
  if (panel.hidden) return;
  initFootfallMap();
  if (!FOOTFALL_MAP) return;

  const w = ffWeights();
  const { points, stopsSeen, bounds } = ffHeatPoints(FOOTFALL_MAP, STOPS_REGISTRY, routesToShow, w);

  if (FOOTFALL_HEAT) { FOOTFALL_MAP.removeLayer(FOOTFALL_HEAT); FOOTFALL_HEAT = null; }
  FOOTFALL_HEAT = L.heatLayer(points, ffHeatOptions(FOOTFALL_MAP)).addTo(FOOTFALL_MAP);

  // Stop labels with the counted number
  FOOTFALL_LABELS.clearLayers();
  const unit = FF.measure === 'on' ? 'on' : FF.measure === 'off' ? 'off' : 'people';
  stopsSeen.forEach(({ st, rk }, key) => {
    const n = w[key] || 0;
    const mk = L.circleMarker([st.lat, st.lng], { radius: 4.5, color: '#ffffff', weight: 2, fillColor: '#111827', fillOpacity: 1 });
    attachStopHoverCard(mk, rk, rsBaseStop(st.name), mapRouteHex(rk), RS_CARD_OPTS);
    mk
      .bindTooltip(escapeHtml(rsStopLabel(st.name)),
        { permanent: true, direction: 'right', offset: [8, 0], className: 'stop-name-label' })
      .on('click', () => rsSelectStop(key))
      .addTo(FOOTFALL_LABELS);
  });

  const timeLabel = (document.getElementById('footfallTime') || {}).selectedOptions ? document.getElementById('footfallTime').selectedOptions[0].textContent : 'All day';
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  rsSetText('footfallSubtitle', total.toLocaleString() + ' ' + (unit === 'people' ? 'boardings + alightings' : unit === 'on' ? 'boardings' : 'alightings')
    + ' \u00b7 ' + timeLabel + ' \u00b7 ' + rsRangeLabel() + ' \u00b7 click a stop to open it');

  setTimeout(() => {
    try {
      FOOTFALL_MAP.invalidateSize();
      if (!FOOTFALL_FITTED && bounds.length) { FOOTFALL_MAP.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom: 16 }); FOOTFALL_FITTED = true; }
      declutterSoon(FOOTFALL_MAP);
    } catch (e) { /* noop */ }
  }, 80);
}

// Builds the Chart.js "matrix" heatmap once. Data is refreshed separately by
// renderStopHourMatrix() every time filters change, using real per-stop,
// per-hour counts from /api/stops/hourly (no more proportional guessing).
function initStopHourMatrixChart() {
  const canvas = document.getElementById('chartStopHourMatrix');
  if (!canvas || typeof Chart === 'undefined') return;
  // Guarded: if the chartjs-chart-matrix CDN script failed to load for any
  // reason, fail quietly here instead of throwing and breaking the rest of
  // initRoutes() (map, filters, other charts on this page).
  try {
    buildStopHourMatrixChart(canvas);
  } catch (err) {
    console.warn('Hourly Activity by Stop heatmap unavailable:', err);
    const wrap = document.getElementById('stopHourMatrixWrap');
    const emptyEl = document.getElementById('stopHourMatrixEmpty');
    if (wrap) wrap.style.display = 'none';
    if (emptyEl) { emptyEl.style.display = 'block'; emptyEl.textContent = 'Heatmap chart failed to load.'; }
  }
}

function buildStopHourMatrixChart(canvas) {
  const ctx = canvas.getContext('2d');
  const hourLabels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0') + ':00');

  STOP_HOUR_CHART = new Chart(ctx, {
    type: 'matrix',
    data: {
      datasets: [{
        label: 'Boardings',
        data: [],
        borderWidth: 1,
        borderColor: 'rgba(10,11,18,0.85)',
        backgroundColor(c) {
          const raw = c.raw;
          const max = (c.dataset && c.dataset._max) || 1;
          if (!raw) return 'rgba(139,116,209,0.06)';
          const intensity = Math.min(1, raw.v / max);
          const alpha = 0.08 + intensity * 0.87;
          return 'rgba(139,116,209,' + alpha.toFixed(2) + ')';
        },
        width: (c) => {
          const area = c.chart.chartArea;
          return area ? Math.max(2, area.width / 24 - 2) : 18;
        },
        height: (c) => {
          const area = c.chart.chartArea;
          const rows = (c.dataset && c.dataset._rowCount) || 1;
          return area ? Math.max(2, area.height / rows - 2) : 18;
        },
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 4, right: 4, bottom: 0, left: 4 } },
      scales: {
        x: {
          type: 'category', position: 'top', offset: true,
          labels: hourLabels,
          grid: { display: false },
          ticks: { color: '#8b8ea5', font: { size: 10, family: 'Inter', weight: '500' }, autoSkip: false, maxRotation: 0 },
        },
        y: {
          type: 'category', offset: true,
          labels: [],
          grid: { display: false },
          ticks: { color: '#c9cad8', font: { size: 12, family: 'Inter', weight: '500' } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipDefaults(),
          callbacks: {
            title: (items) => (items[0] && items[0].raw) ? items[0].raw.y : '',
            label: (item) => {
              const r = item.raw || {};
              return r.x + ' \u2014 ' + Number(r.v || 0).toLocaleString() + ' boardings, ' + Number(r.a || 0).toLocaleString() + ' alightings';
            },
          },
        },
      },
    },
  });
}

// Heatmap for the busiest stops, using the already-fetched hourly rows.
function rsRenderHeatmap() {
  const wrap = document.getElementById('stopHourMatrixWrap');
  const emptyEl = document.getElementById('stopHourMatrixEmpty');
  if (!STOP_HOUR_CHART) return;
  const top = RS.groups.filter((g) => g.boardings + g.alightings > 0).slice(0, 10);
  if (!top.length) { if (wrap) wrap.style.display = 'none'; if (emptyEl) emptyEl.style.display = 'block'; return; }
  if (wrap) wrap.style.display = '';
  if (emptyEl) emptyEl.style.display = 'none';
  const cells = {};
  RS.hourly.forEach((r) => {
    const k = rsKey(r.route, r.stop) + '#' + utcHourToDisplayHour(r.hour);
    if (!cells[k]) cells[k] = { b: 0, a: 0 };
    cells[k].b += r.boardings || 0; cells[k].a += r.alightings || 0;
  });
  const labels = top.map((g) => g.label + ' \u00b7 Route ' + g.route);
  const points = []; let maxVal = 0;
  top.forEach((g, i) => {
    for (let h = 0; h < 24; h++) {
      const c = cells[g.key + '#' + h] || { b: 0, a: 0 };
      if (c.b > maxVal) maxVal = c.b;
      points.push({ x: String(h).padStart(2, '0') + ':00', y: labels[i], v: c.b, a: c.a });
    }
  });
  if (wrap) wrap.style.height = Math.max(140, labels.length * 40 + 50) + 'px';
  const ds = STOP_HOUR_CHART.data.datasets[0];
  ds.data = points; ds._max = maxVal || 1; ds._rowCount = labels.length;
  STOP_HOUR_CHART.options.scales.y.labels = labels;
  STOP_HOUR_CHART.resize();
  STOP_HOUR_CHART.update();
  rsSetText('heatmapSubtitle', 'Boardings by hour for the ' + labels.length + ' busiest stops \u00b7 ' + rsRangeLabel());
}

function exportRoutesCsv() {
  const q = (c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';
  let lines; let name;
  if (RS.stop !== 'all') {
    const [route] = RS.stop.split('|');
    const g = RS.groups.find((x) => x.key === RS.stop);
    const label = g ? g.label : RS.stop.split('|').slice(1).join('|');
    const perDay = {}; rsDateList(RS.from, RS.to).forEach((d) => { perDay[d] = { b: 0, a: 0 }; });
    RS.daily.forEach((r) => { if (rsKey(r.route, r.stop) === RS.stop && perDay[r.date]) { perDay[r.date].b += r.boardings || 0; perDay[r.date].a += r.alightings || 0; } });
    lines = [['date', 'route', 'stop', 'boardings', 'alightings', 'net'].join(',')];
    Object.entries(perDay).forEach(([d, v]) => lines.push([d, route, label, v.b, v.a, v.b - v.a].map(q).join(',')));
    name = 'stop_' + label.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '_' + RS.from + '_to_' + RS.to + '.csv';
  } else {
    if (!RS.groups.length) { alert('No stop data to export.'); return; }
    const total = RS.groups.reduce((a, g) => a + g.boardings, 0) || 1;
    lines = [['route', 'stop', 'boardings', 'alightings', 'net', 'share_of_boardings_pct'].join(',')];
    RS.groups.forEach((g) => lines.push([g.route, g.label, g.boardings, g.alightings, g.boardings - g.alightings, Math.round((g.boardings / total) * 1000) / 10].map(q).join(',')));
    name = 'stops_' + RS.from + '_to_' + RS.to + '.csv';
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}


// ============================================
// COMPARISON (Backend-powered)
// ============================================

function initComparison() {
  const hours = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);
  const zeros24 = hours.map(() => 0);
  const hCtx = document.getElementById('chartCompareHourly').getContext('2d');
  charts.compareHourly = new Chart(hCtx, {
    type: 'line', data: { labels: hours, datasets: [
      { label: 'Period A', data: [...zeros24], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 3 },
      { label: 'Period B', data: [...zeros24], borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.4, pointRadius: 3 },
    ]}, options: chartDefaults('Passengers'),
  });
  const rCtx = document.getElementById('chartCompareRoutes').getContext('2d');
  charts.compareRoutes = new Chart(rCtx, {
    type: 'bar', data: { labels: ['No data yet'], datasets: [
      { label: 'Period A', data: [0], backgroundColor: 'rgba(59,130,246,0.8)', borderRadius: 4 },
      { label: 'Period B', data: [0], backgroundColor: 'rgba(16,185,129,0.8)', borderRadius: 4 },
    ]}, options: chartDefaults('Passengers'),
  });

  // Wire up compare button
  const runBtn = document.getElementById('runComparison');
  if (runBtn) runBtn.addEventListener('click', () => runComparison());

  // Populate available dates
  apiFetch('/api/dates').then(data => {
    const dateA = document.getElementById('compareA');
    const dateB = document.getElementById('compareB');
    if (data && data.dates && data.dates.length > 0) {
      if (dateA && data.dates[0]) dateA.value = data.dates[0];
      if (dateB && data.dates.length > 1) dateB.value = data.dates[1];
      else if (dateB) dateB.value = data.dates[0];
    } else {
      // Fallback: set both to today
      const today = displayDateStr();
      if (dateA) dateA.value = today;
      if (dateB) dateB.value = today;
    }
  });

  // Auto-run comparison on load
  setTimeout(() => runComparison(), 500);
}

async function runComparison() {
  const dateA = document.getElementById('compareA')?.value;
  const dateB = document.getElementById('compareB')?.value;
  if (!dateA || !dateB) return;

  const data = await apiFetch('/api/compare', { date_a: dateA, date_b: dateB });
  if (data) {
    // Backend available — use API data
    const a = data.a;
    const b = data.b;
    setKPI('compare-kpi-a', a.boardings > 0 ? a.boardings.toLocaleString() : '0');
    setKPI('compare-kpi-b', b.boardings > 0 ? b.boardings.toLocaleString() : '0');
    const subA = document.getElementById('compare-kpi-a-sub');
    const subB = document.getElementById('compare-kpi-b-sub');
    if (subA) subA.textContent = dateA;
    if (subB) subB.textContent = dateB;
    const diff = a.boardings - b.boardings;
    const diffPct = b.boardings > 0 ? Math.round((diff / b.boardings) * 100) : (a.boardings > 0 ? 100 : 0);
    const diffSign = diff > 0 ? '+' : '';
    setKPI('compare-kpi-diff', `${diffSign}${diff.toLocaleString()}`);
    const diffSub = document.getElementById('compare-kpi-diff-sub');
    if (diffSub) diffSub.textContent = `${diffSign}${diffPct}% change`;

    const hours = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);
    const hourMapA = {};
    const hourMapB = {};
    (a.hourly || []).forEach(h => { hourMapA[h.hour] = h.boardings; });
    (b.hourly || []).forEach(h => { hourMapB[h.hour] = h.boardings; });
    charts.compareHourly.data.datasets[0].label = `Period A (${dateA})`;
    charts.compareHourly.data.datasets[0].data = hours.map((_, i) => hourMapA[i] || 0);
    charts.compareHourly.data.datasets[1].label = `Period B (${dateB})`;
    charts.compareHourly.data.datasets[1].data = hours.map((_, i) => hourMapB[i] || 0);
    charts.compareHourly.update('active');

    const busesA = await apiFetch('/api/daily', { from: dateA, to: dateA });
    const busesB = await apiFetch('/api/daily', { from: dateB, to: dateB });
    if (busesA && busesB) {
      const allBuses = [...new Set([...(busesA.daily || []).map(r => r.bus_id), ...(busesB.daily || []).map(r => r.bus_id)])];
      if (allBuses.length > 0) {
        const mapA = {}; (busesA.daily || []).forEach(r => { mapA[r.bus_id] = r.total_in; });
        const mapB = {}; (busesB.daily || []).forEach(r => { mapB[r.bus_id] = r.total_in; });
        charts.compareRoutes.data.labels = allBuses;
        charts.compareRoutes.data.datasets[0].label = `Period A (${dateA})`;
        charts.compareRoutes.data.datasets[0].data = allBuses.map(b => mapA[b] || 0);
        charts.compareRoutes.data.datasets[1].label = `Period B (${dateB})`;
        charts.compareRoutes.data.datasets[1].data = allBuses.map(b => mapB[b] || 0);
        charts.compareRoutes.update('active');
      }
    }
  } else {
    // --- MQTT live fallback for Comparison ---
    const totalIn = BUS_POSITIONS.reduce((s, b) => s + (b.lineIn || 0), 0);
    const totalOut = BUS_POSITIONS.reduce((s, b) => s + (b.lineOut || 0), 0);
    setKPI('compare-kpi-a', totalIn > 0 ? totalIn.toLocaleString() : (mqttState.connected ? '0' : '\u2014'));
    setKPI('compare-kpi-b', '\u2014');
    const subA = document.getElementById('compare-kpi-a-sub');
    const subB = document.getElementById('compare-kpi-b-sub');
    if (subA) subA.textContent = 'Today (live)';
    if (subB) subB.textContent = 'No historical data';
    setKPI('compare-kpi-diff', '\u2014');
    const diffSub = document.getElementById('compare-kpi-diff-sub');
    if (diffSub) diffSub.textContent = 'Backend offline';

    // Hourly chart from live buckets
    const hours = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);
    charts.compareHourly.data.datasets[0].label = 'Today (live)';
    charts.compareHourly.data.datasets[0].data = hours.map(h => hourlyBuckets[h] ? hourlyBuckets[h].boardings : 0);
    charts.compareHourly.data.datasets[1].label = 'No comparison';
    charts.compareHourly.data.datasets[1].data = hours.map(() => 0);
    charts.compareHourly.update('active');

    // Route chart from live buses
    if (BUS_POSITIONS.length > 0) {
      const busLabels = BUS_POSITIONS.map(b => b.id);
      charts.compareRoutes.data.labels = busLabels;
      charts.compareRoutes.data.datasets[0].label = 'Today (live)';
      charts.compareRoutes.data.datasets[0].data = BUS_POSITIONS.map(b => b.lineIn || 0);
      charts.compareRoutes.data.datasets[1].label = 'No comparison';
      charts.compareRoutes.data.datasets[1].data = busLabels.map(() => 0);
      charts.compareRoutes.update('active');
    }
  }
}


// ============================================
// FLEET STATUS
// ============================================

function initFleet() {
  updateFleetKPIs();
  renderFleetTable(); initFleetCharts();
  document.getElementById('fleetSearch').addEventListener('input', (e) => renderFleetTable(e.target.value));
}

function updateFleetKPIs() {
  const activeCount = BUS_POSITIONS.filter(b=>b.status==='active').length;
  const idleCount = BUS_POSITIONS.filter(b=>b.status==='idle').length;
  const maintCount = BUS_POSITIONS.filter(b=>b.status==='maintenance').length;
  const onlineEl = document.getElementById('fleet-kpi-online');
  const idleEl = document.getElementById('fleet-kpi-idle');
  const maintEl = document.getElementById('fleet-kpi-maint');
  const subEl = document.getElementById('fleet-subtitle');
  if (onlineEl) onlineEl.textContent = BUS_POSITIONS.length > 0 ? activeCount : '\u2014';
  if (idleEl) idleEl.textContent = BUS_POSITIONS.length > 0 ? idleCount : '\u2014';
  if (maintEl) maintEl.textContent = BUS_POSITIONS.length > 0 ? maintCount : '\u2014';
  if (subEl) subEl.textContent = BUS_POSITIONS.length > 0 ? `${BUS_POSITIONS.length} vehicles \u2014 ${DEMO ? 'parallel connection' : 'live via MQTT'}` : (DEMO ? 'Starting parallel connection' : 'Waiting for MQTT data');
}

function renderFleetTable(search) {
  search = search || '';
  const tbody = document.getElementById('fleetTableBody'); if (!tbody) return;
  const filtered = BUS_POSITIONS.filter(b => b.id.toLowerCase().includes(search.toLowerCase()) || (b.route&&b.route.includes(search)) || b.status.includes(search.toLowerCase()));
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--color-text-muted);padding:2rem">Waiting for live bus data via MQTT...</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map(bus => {
    const statusClass = bus.status==='active'?'active':bus.status==='idle'?'inactive':'alert';
    const occColor = bus.occupancy>75?'#ef4444':bus.occupancy>50?'#f59e0b':'#10b981';
    const sensorClass = bus.sensorStatus==='Online'?'active':'alert';
    return `<tr>
      <td><strong>${bus.id}</strong></td>
      <td><span style="color:${bus.routeColor}">● </span>${bus.route?bus.route+' — '+bus.routeName:'-'}</td>
      <td><span class="status-badge ${statusClass}">${bus.status}</span></td>
      <td class="number">${bus.passengers}/${bus.capacity}</td>
      <td><span class="occupancy-bar"><span class="occupancy-bar-fill" style="width:${bus.occupancy}%;background:${occColor}"></span></span><span class="number">${bus.occupancy}%</span></td>
      <td class="number">${bus.speed} km/h</td>
      <td style="color:var(--color-text-muted)">${bus.lastUpdate}</td>
      <td><span class="status-badge ${sensorClass}">${bus.sensorStatus}</span></td>
    </tr>`;
  }).join('');
}

function initFleetCharts() {
  const activeBuses = BUS_POSITIONS.filter(b=>b.status==='active').slice(0,12);
  const utilCtx = document.getElementById('chartFleetUtil').getContext('2d');
  charts.fleetUtil = new Chart(utilCtx, {
    type: 'bar', data: { labels: activeBuses.map(b=>b.id.length>3?b.id.slice(-3):b.id), datasets: [{
      label: 'Occupancy %', data: activeBuses.map(b=>b.occupancy),
      backgroundColor: activeBuses.map(b=>b.occupancy>75?'#ef4444cc':b.occupancy>50?'#f59e0bcc':'#10b981cc'), borderRadius: 4,
    }]},
    options: { ...chartDefaults('Occupancy %'), scales: { x:{grid:{display:false},ticks:{color:'#8b8ea5',font:{size:10}}}, y:{max:100,grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8b8ea5',font:{size:10},callback:v=>v+'%'}} } },
  });
  const activeCount = BUS_POSITIONS.filter(b=>b.status==='active').length;
  const idleCount = BUS_POSITIONS.filter(b=>b.status==='idle').length;
  const maintCount = BUS_POSITIONS.filter(b=>b.status==='maintenance').length;
  const statCtx = document.getElementById('chartFleetStatus').getContext('2d');
  charts.fleetStatus = new Chart(statCtx, {
    type: 'doughnut', data: { labels: ['Active','Idle','Maintenance'], datasets: [{ data: [activeCount,idleCount,maintCount], backgroundColor: ['#10b981','#f59e0b','#ef4444'], borderWidth: 0, spacing: 3 }] },
    options: { responsive:true, maintainAspectRatio:true, cutout:'60%', plugins:{ legend:{position:'bottom',labels:{color:'#8b8ea5',font:{size:11,family:'Inter'},padding:16,usePointStyle:true}}, tooltip:{...tooltipDefaults()} } },
  });
}


// ============================================
// REPORTS
// ============================================

async function initReports() {
  const today = displayDateStr();
  const reportFrom = document.getElementById('reportFrom');
  const reportTo = document.getElementById('reportTo');
  const reportBus = document.getElementById('reportBus');
  const reportType = document.getElementById('reportType');
  const reportFormat = document.getElementById('reportFormat');
  const reportStatus = document.getElementById('reportStatus');
  const generateBtn = document.getElementById('generateReport');

  // Find the latest date that actually has data, fall back to today
  let latestDataDate = today;
  let availableDates = [];
  try {
    const res = await apiFetch('/api/dates');
    if (res && Array.isArray(res.dates) && res.dates.length) {
      availableDates = res.dates.slice().sort();
      latestDataDate = availableDates[availableDates.length - 1];
    }
  } catch (e) { /* ignore */ }

  // Cap inputs at today, default empty to latest data date
  if (reportFrom) { reportFrom.max = today; if (!reportFrom.value) reportFrom.value = latestDataDate; }
  if (reportTo) { reportTo.max = today; if (!reportTo.value) reportTo.value = latestDataDate; }

  // Populate bus selector from /api/daily across available range
  if (reportBus) {
    try {
      const from = availableDates[0] || latestDataDate;
      const data = await apiFetch('/api/daily', { from, to: latestDataDate });
      const buses = Array.from(new Set((data?.daily || []).map(r => String(r.bus_id)))).sort();
      buses.forEach(id => {
        const opt = document.createElement('option');
        opt.value = id; opt.textContent = 'Bus ' + id;
        reportBus.appendChild(opt);
      });
    } catch (e) { /* ignore */ }
  }

  // Map report-card to a sensible default date range
  const cardRangeFor = (key) => {
    const end = latestDataDate;
    if (key === 'welfare-incident-audit') return { from: shiftDateStr(end, -6), to: end };
    if (key === 'monthly-value-summary') return prevCalendarMonthRange(end);
    if (key === 'weekly-analysis') return { from: shiftDateStr(end, -6), to: end };
    if (key === 'monthly-performance') return { from: shiftDateStr(end, -29), to: end };
    if (key === 'custom-report') return null; // keep current range
    return { from: end, to: end };
  };

  // Monthly Value Summary is a fleet-wide, client-facing report by design —
  // disable the per-bus filter while it's selected so the numbers in the
  // narrative always match the headline totals.
  const busGroup = reportBus ? reportBus.closest('.filter-group') : null;
  const syncBusFilterState = (key) => {
    const isMvs = key === 'monthly-value-summary';
    if (reportBus) { reportBus.disabled = isMvs; if (isMvs) reportBus.value = ''; }
    if (busGroup) busGroup.style.opacity = isMvs ? '0.45' : '1';
  };

  document.querySelectorAll('.report-card').forEach(card => {
    card.addEventListener('click', () => {
      const key = card.dataset.report;
      const name = card.querySelector('.report-name')?.textContent;
      if (name && reportType) {
        const exists = Array.from(reportType.options).some(o => o.textContent === name);
        if (exists) reportType.value = name;
      }
      const range = cardRangeFor(key);
      if (range) {
        if (reportFrom) reportFrom.value = range.from;
        if (reportTo) reportTo.value = range.to;
      }
      syncBusFilterState(key);
      document.querySelectorAll('.report-card').forEach(c => c.classList.remove('report-card-selected'));
      card.classList.add('report-card-selected');
    });
  });

  // Pre-select the default card — Monthly Value Summary, since it's the
  // report most clients want to see first.
  const preselect = document.querySelector('.report-card[data-report="monthly-value-summary"]');
  if (preselect) {
    preselect.classList.add('report-card-selected');
    const range = cardRangeFor('monthly-value-summary');
    if (range) { if (reportFrom) reportFrom.value = range.from; if (reportTo) reportTo.value = range.to; }
    syncBusFilterState('monthly-value-summary');
  }

  if (generateBtn) {
    generateBtn.addEventListener('click', async () => {
      const format = reportFormat.value;
      const type = reportType.value;
      let from = reportFrom.value;
      let to = reportTo.value;
      const busId = reportBus ? reportBus.value : '';
      const clientNameEl = document.getElementById('reportClientName');
      const clientName = clientNameEl ? clientNameEl.value.trim() : '';

      if (!from || !to) {
        if (reportStatus) reportStatus.textContent = 'Please choose both From and To dates.';
        return;
      }
      if (from > to) { const tmp = from; from = to; to = tmp; }
      if (from > today || to > today) {
        if (reportStatus) reportStatus.textContent = 'Dates cannot be in the future.';
        return;
      }

      generateBtn.disabled = true;
      const busLabel = busId ? ', Bus ' + busId : '';
      if (reportStatus) reportStatus.textContent = 'Generating ' + format.toUpperCase() + ' for ' + type + ' (' + from + ' to ' + to + busLabel + ')...';
      try {
        if (type === 'Welfare & Safeguarding Audit') {
          if (format === 'pdf') await exportWelfareAuditPDF(from, to, busId, clientName);
          else if (format === 'csv') await exportWelfareAuditCSV(from, to, busId);
          else await exportToExcel(type, from, to, busId);
        } else if (type === 'Monthly Value Summary') {
          if (format === 'pdf') await exportMonthlyValueSummaryPDF(from, to, clientName);
          else if (format === 'excel') await exportMonthlyValueSummaryExcel(from, to, clientName);
          else await exportMonthlyValueSummaryCSV(from, to, clientName);
        } else if (format === 'pdf') await exportToPDF(type, from, to, busId);
        else if (format === 'excel') await exportToExcel(type, from, to, busId);
        else await exportToCSV(type, from, to, busId);
        if (reportStatus) reportStatus.textContent = 'Downloaded ' + format.toUpperCase() + ' for ' + from + ' to ' + to + (busId ? ' (Bus ' + busId + ')' : '') + '.';
      } catch (err) {
        console.error('Report generation failed:', err);
        if (reportStatus) reportStatus.textContent = 'Failed to generate report: ' + (err.message || err);
      } finally {
        generateBtn.disabled = false;
      }
    });
  }
}

// Full previous calendar month relative to a YYYY-MM-DD reference date.
function prevCalendarMonthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const lastOfPrevMonth = new Date(Date.UTC(y, m - 1, 0));
  const firstOfPrevMonth = new Date(Date.UTC(lastOfPrevMonth.getUTCFullYear(), lastOfPrevMonth.getUTCMonth(), 1));
  return { from: firstOfPrevMonth.toISOString().slice(0, 10), to: lastOfPrevMonth.toISOString().slice(0, 10) };
}

// Add/subtract days from a YYYY-MM-DD string
function shiftDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}


// ============================================
// DATA EXPLORER (Backend-powered)
// ============================================

let dataTotal = 0; // Total records from API

async function initDataTable() {
  const dateInput = document.getElementById('dataDate');
  const routeSelect = document.getElementById('dataRoute');
  const busSelect = document.getElementById('dataBus');
  const searchInput = document.getElementById('dataSearch');
  if (dateInput) dateInput.addEventListener('change', () => { dataCurrentPage = 1; loadDataFromAPI(); });
  if (routeSelect) routeSelect.addEventListener('change', () => { dataCurrentPage = 1; loadDataFromAPI(); });
  if (busSelect) busSelect.addEventListener('change', () => { dataCurrentPage = 1; loadDataFromAPI(); });
  if (searchInput) searchInput.addEventListener('input', () => { dataCurrentPage = 1; loadDataFromAPI(); });

  // Ensure backend probe completes before first data load
  await probeBackend();

  // Populate available dates in date picker, then load data
  const datesData = await apiFetch('/api/dates');
  if (datesData && datesData.dates && datesData.dates.length > 0 && dateInput) {
    dateInput.value = datesData.dates[0];
  } else if (dateInput) {
    dateInput.value = displayDateStr();
  }

  // Also populate bus dropdown for Data Explorer
  await populateBusDropdowns();

  // Now load the data
  await loadDataFromAPI();
}

async function loadDataFromAPI() {
  const date = document.getElementById('dataDate')?.value;
  const busId = document.getElementById('dataBus')?.value;
  const offset = (dataCurrentPage - 1) * DATA_PER_PAGE;
  const searchTerm = (document.getElementById('dataSearch')?.value || '').toLowerCase();

  const data = await apiFetch('/api/records', {
    date: date || undefined,
    bus_id: (busId && busId !== 'all') ? busId : undefined,
    limit: DATA_PER_PAGE,
    offset: offset,
  });

  let records;
  let source = 'Database';
  if (data) {
    dataTotal = data.total || 0;
    records = data.records || [];
  } else {
    // --- MQTT live fallback for Data Explorer ---
    source = 'Live MQTT';
    let allRecords = liveRecords.slice().reverse(); // newest first
    if (busId && busId !== 'all') {
      allRecords = allRecords.filter(r => r.busId === busId);
    }
    if (searchTerm) {
      allRecords = allRecords.filter(r =>
        (r.busId || '').toLowerCase().includes(searchTerm) ||
        (r.route || '').includes(searchTerm) ||
        (r.stop || '').toLowerCase().includes(searchTerm)
      );
    }
    dataTotal = allRecords.length;
    records = allRecords.slice(offset, offset + DATA_PER_PAGE).map(r => ({
      timestamp: r.timestamp || '', bus_id: r.busId || '', route: r.route || '-', stop: r.stop || '-',
      boardings: r.boardings || 0, alightings: r.alightings || 0, onboard: r.onboard || 0,
      occupancy: r.occupancy || 0, lat: r.lat || '0', lng: r.lng || '0',
    }));
  }

  const tbody = document.getElementById('dataTableBody');
  if (!tbody) return;

  // Apply client-side search filter (only for API data; MQTT fallback already filtered)
  const filtered = (source === 'Database' && searchTerm)
    ? records.filter(r => r.bus_id.toLowerCase().includes(searchTerm) || r.route.includes(searchTerm) || r.stop.toLowerCase().includes(searchTerm))
    : records;

  tbody.innerHTML = filtered.map(r => {
    const occColor = r.occupancy > 75 ? '#ef4444' : r.occupancy > 50 ? '#f59e0b' : '#10b981';
    const ts = (r.timestamp || '').replace('T', ' ').slice(0, 16);
    return `<tr>
      <td class="number">${ts}</td><td><strong>${r.bus_id}</strong></td><td>${r.route || '-'}</td><td>${r.stop || '-'}</td>
      <td class="number">${r.boardings}</td><td class="number">${r.alightings}</td><td class="number">${r.onboard}</td>
      <td><span class="occupancy-bar"><span class="occupancy-bar-fill" style="width:${r.occupancy}%;background:${occColor}"></span></span><span class="number">${r.occupancy}%</span></td>
      <td class="number">${Number(r.lat).toFixed(5)}</td><td class="number">${Number(r.lng).toFixed(5)}</td>
    </tr>`;
  }).join('');

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--color-text-muted);padding:2rem">${dataTotal === 0 ? (mqttState.connected ? 'Waiting for data...' : 'No records available') : 'No matching records'}</td></tr>`;
  }

  const infoEl = document.getElementById('dataPageInfo');
  const totalPages = Math.ceil(dataTotal / DATA_PER_PAGE);
  if (infoEl) {
    if (dataTotal > 0) {
      infoEl.textContent = `Showing ${offset + 1}-${Math.min(offset + DATA_PER_PAGE, dataTotal)} of ${dataTotal.toLocaleString()} records (${source})`;
    } else {
      infoEl.textContent = source === 'Live MQTT' ? 'Waiting for live records...' : 'No records found';
    }
  }
  renderPagination(totalPages);
}

function renderDataTable() {
  // Called from MQTT live updates — if on data-table view, refresh from API
  if (currentView === 'data-table') loadDataFromAPI();
}

function renderPagination(totalPages) {
  const c = document.getElementById('dataPagination'); if (!c) return;
  if (totalPages <= 1) { c.innerHTML = ''; return; }
  let html = `<button class="page-btn" onclick="changePage(${dataCurrentPage-1})" ${dataCurrentPage===1?'disabled':''}>&lsaquo;</button>`;
  const maxVisible = 7;
  let startPage = Math.max(1, dataCurrentPage - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);
  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="page-btn ${i===dataCurrentPage?'active':''}" onclick="changePage(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="changePage(${dataCurrentPage+1})" ${dataCurrentPage>=totalPages?'disabled':''}>&rsaquo;</button>`;
  c.innerHTML = html;
}

window.changePage = changePage;
function changePage(page) {
  const totalPages = Math.ceil(dataTotal / DATA_PER_PAGE);
  if (page < 1 || page > totalPages) return;
  dataCurrentPage = page;
  loadDataFromAPI();
  const w = document.querySelector('.table-wrapper'); if (w) w.scrollTop = 0;
}


// ============================================
// EXPORT
// ============================================

function initExportMenus() {
  document.getElementById('exportBtn').addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('exportMenu').classList.toggle('open'); });
  const deb = document.getElementById('dataExportBtn');
  if (deb) deb.addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('dataExportMenu').classList.toggle('open'); });
  document.addEventListener('click', () => document.querySelectorAll('.export-menu').forEach(m => m.classList.remove('open')));
  document.querySelectorAll('.export-menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const today = displayDateStr();
      const f = item.dataset.format;
      if (f==='pdf') exportToPDF('Dashboard Summary',today,today);
      else if (f==='excel') exportToExcel('Dashboard Data',today,today);
      else exportToCSV('Dashboard Data',today,today);
      document.querySelectorAll('.export-menu').forEach(m => m.classList.remove('open'));
    });
  });
}

async function exportToPDF(title, from, to, busId) {
  const { jsPDF } = window.jspdf; const doc = new jsPDF();
  doc.setFillColor(15,17,23); doc.rect(0,0,210,40,'F');
  doc.setTextColor(255,255,255); doc.setFontSize(18); doc.text('Smart Urban Sensing Ltd',14,18);
  doc.setFontSize(10); doc.text(`${title} — ${from} to ${to}${busId ? ' — Bus ' + busId : ''}`,14,28);
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`,14,34);

  // Aggregate KPIs from /api/daily so the To date is honoured (and bus filter respected)
  const dailyForKpis = await apiFetch('/api/daily', { from, to, ...(busId ? { bus_id: busId } : {}) });
  const rows = (dailyForKpis && dailyForKpis.daily) || [];
  const totals = {
    total_boardings: rows.reduce((s,r)=>s+(r.total_in||0),0),
    total_alightings: rows.reduce((s,r)=>s+(r.total_out||0),0),
    peak_onboard: rows.reduce((m,r)=>Math.max(m, r.peak_onboard||0), 0),
    bus_count: new Set(rows.map(r=>r.bus_id)).size,
    avg_occupancy: rows.length ? (rows.reduce((s,r)=>s+(r.avg_occupancy||0),0)/rows.length) : 0,
  };
  const summary = rows.length ? { totals } : null;
  const totalPax = totals.total_boardings || BUS_POSITIONS.reduce((s,b)=>s+(b.lineIn||b.passengers),0);
  const totalAlight = totals.total_alightings || BUS_POSITIONS.reduce((s,b)=>s+(b.lineOut||0),0);
  const busCount = totals.bus_count || BUS_POSITIONS.filter(b=>b.status==='active').length;
  const active = BUS_POSITIONS.filter(b => b.status === 'active');
  const avgOcc = totals.avg_occupancy || (active.length > 0 ? Math.round(active.reduce((s,b)=>s+b.occupancy,0)/active.length) : 0);
  const dataSource = summary ? 'Database' : 'Live MQTT';

  doc.setTextColor(0,0,0); doc.setFontSize(14); doc.text('Key Performance Indicators',14,52);
  doc.autoTable({ startY:58, head:[['Metric','Value','Source']], body:[
    ['Total Boardings', totalPax.toLocaleString(), dataSource],
    ['Total Alightings', totalAlight.toLocaleString(), dataSource],
    ['Active Buses', String(busCount), dataSource],
    ['Peak Onboard', String(totals.peak_onboard || Math.max(0, ...BUS_POSITIONS.map(b=>b.passengers))), dataSource],
    ['Avg Occupancy', avgOcc.toFixed ? avgOcc.toFixed(1) + '%' : avgOcc + '%', dataSource],
  ], theme:'grid', headStyles:{fillColor:[59,130,246]} });

  // Fetch daily breakdown (already in `dailyForKpis`, but re-use as `daily`)
  const daily = dailyForKpis;
  if (daily && daily.daily && daily.daily.length > 0) {
    doc.text('Daily Breakdown',14,doc.lastAutoTable.finalY+14);
    doc.autoTable({ startY:doc.lastAutoTable.finalY+20, head:[['Date','Bus','Boardings','Alightings','Peak Onboard','Avg Occupancy']],
      body: daily.daily.map(r=>[r.date, r.bus_id, r.total_in, r.total_out, r.peak_onboard, r.avg_occupancy.toFixed(1)+'%']),
      theme:'grid', headStyles:{fillColor:[59,130,246]} });
  }

  // Fleet status from live data
  if (BUS_POSITIONS.length > 0) {
    doc.text('Live Fleet Status',14,doc.lastAutoTable.finalY+14);
    doc.autoTable({ startY:doc.lastAutoTable.finalY+20, head:[['Bus ID','Status','Passengers','Occupancy','Sensor']],
      body: BUS_POSITIONS.map(b=>[b.id,b.status,`${b.passengers}/${b.capacity}`,b.occupancy+'%',b.sensorStatus]),
      theme:'grid', headStyles:{fillColor:[59,130,246]} });
  }

  // Dashboard charts — snapshot every graph on the home page as an image so
  // the PDF export mirrors what's on screen, not just the underlying tables.
  const homeCharts = [
    { key: 'hourlyFlow', title: 'Hourly Passenger Flow' },
    { key: 'passengerOn', title: 'Passenger On Counts by Hour' },
    { key: 'occGauge', title: 'Live Occupancy' },
    { key: 'cumulativeLoad', title: 'Cumulative Load Today' },
    { key: 'netFlow', title: 'Net Passenger Flow by Hour' },
    { key: 'stopBoardingsHome', title: 'Boardings by Stop' },
    { key: 'momChange', title: 'Monthly Boardings — % Change' },
  ];
  const availableCharts = homeCharts
    .map(c => ({ ...c, chart: charts[c.key] }))
    .filter(c => c.chart && typeof c.chart.toBase64Image === 'function' && c.chart.canvas && c.chart.canvas.width > 0);

  // Chart canvases render at devicePixelRatio (often 2-3x), so grabbing them
  // at native resolution can produce a 30MB+ PDF. Downscale onto an offscreen
  // canvas (capped width, matched to a white background since JPEG has no
  // alpha channel) and compress to JPEG so file size stays reasonable for
  // emailing/sharing while charts remain sharp enough to read.
  function chartToCompressedImage(chart, maxWidthPx) {
    const src = chart.canvas;
    const scale = Math.min(1, maxWidthPx / src.width);
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, w, h);
    tctx.drawImage(src, 0, 0, w, h);
    return tmp.toDataURL('image/jpeg', 0.85);
  }

  if (availableCharts.length > 0) {
    doc.addPage();
    doc.setFontSize(14); doc.setTextColor(0,0,0); doc.text('Dashboard Charts',14,20);
    const margin = 14, maxImgWidth = 210 - margin * 2, maxImgHeight = 110, pageBottom = 280;
    let y = 30;
    availableCharts.forEach(({ title, chart }) => {
      let imgWidth = maxImgWidth;
      let imgHeight = imgWidth * (chart.canvas.height / chart.canvas.width);
      if (imgHeight > maxImgHeight) { imgHeight = maxImgHeight; imgWidth = imgHeight * (chart.canvas.width / chart.canvas.height); }
      if (y + 8 + imgHeight > pageBottom) { doc.addPage(); y = 20; }
      doc.setFontSize(11); doc.setTextColor(30,30,30); doc.text(title, margin, y);
      try {
        const imgData = chartToCompressedImage(chart, 1400);
        doc.addImage(imgData, 'JPEG', margin, y + 4, imgWidth, imgHeight);
      } catch (err) {
        doc.setFontSize(9); doc.setTextColor(150); doc.text('(chart image unavailable)', margin, y + 12);
      }
      y += imgHeight + 16;
    });
  }

  const pc = doc.internal.getNumberOfPages();
  for (let i=1;i<=pc;i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(150); doc.text('Smart Urban Sensing Ltd — APC',14,287); doc.text(`Page ${i}/${pc}`,180,287); }
  doc.save(`SUS_Report_${from}_${to}.pdf`);
}

async function exportToExcel(title, from, to, busId) {
  const wb = XLSX.utils.book_new();

  // Summary sheet — aggregate KPIs from /api/daily so To date and bus filter are honoured
  const dailyForKpis = await apiFetch('/api/daily', { from, to, ...(busId ? { bus_id: busId } : {}) });
  const rowsAgg = (dailyForKpis && dailyForKpis.daily) || [];
  const totals = {
    total_boardings: rowsAgg.reduce((s,r)=>s+(r.total_in||0),0),
    total_alightings: rowsAgg.reduce((s,r)=>s+(r.total_out||0),0),
    peak_onboard: rowsAgg.reduce((m,r)=>Math.max(m, r.peak_onboard||0), 0),
    bus_count: new Set(rowsAgg.map(r=>r.bus_id)).size,
    avg_occupancy: rowsAgg.length ? (rowsAgg.reduce((s,r)=>s+(r.avg_occupancy||0),0)/rowsAgg.length) : 0,
  };
  const summary = rowsAgg.length ? { totals } : null;
  const totalBoardings = totals.total_boardings || BUS_POSITIONS.reduce((s,b)=>s+(b.lineIn||0),0);
  const totalAlightings = totals.total_alightings || BUS_POSITIONS.reduce((s,b)=>s+(b.lineOut||0),0);
  const busCount = totals.bus_count || BUS_POSITIONS.filter(b=>b.status==='active').length;
  const active = BUS_POSITIONS.filter(b=>b.status==='active');
  const avgOcc = totals.avg_occupancy || (active.length > 0 ? Math.round(active.reduce((s,b)=>s+b.occupancy,0)/active.length) : 0);
  const dataSource = summary ? 'Database + Live MQTT' : 'Live MQTT only';

  const ws1 = XLSX.utils.aoa_to_sheet([
    ['Smart Urban Sensing Ltd — APC Report'],[`${title} — ${from} to ${to}${busId ? ' — Bus ' + busId : ''}`],
    ['Generated:',new Date().toLocaleString('en-GB')],['Data Source:', dataSource],[],
    ['Metric','Value'],
    ['Total Boardings', totalBoardings],
    ['Total Alightings', totalAlightings],
    ['Active Buses', busCount],
    ['Peak Onboard', totals.peak_onboard || Math.max(0, ...BUS_POSITIONS.map(b=>b.passengers))],
    ['Avg Occupancy %', typeof avgOcc === 'number' && avgOcc.toFixed ? avgOcc.toFixed(1) : String(avgOcc)],
  ]);
  XLSX.utils.book_append_sheet(wb,ws1,'Summary');

  // Daily summary sheet
  const daily = dailyForKpis;
  if (daily && daily.daily) {
    const ws2 = XLSX.utils.aoa_to_sheet([
      ['Date','Bus ID','Boardings','Alightings','Peak Onboard','Peak Hour','First Seen','Last Seen','Avg Occupancy %'],
      ...daily.daily.map(r=>[r.date, r.bus_id, r.total_in, r.total_out, r.peak_onboard, r.peak_hour, r.first_seen, r.last_seen, r.avg_occupancy.toFixed(1)])
    ]);
    XLSX.utils.book_append_sheet(wb,ws2,'Daily');
  }

  // Raw records sheet — API or live MQTT fallback
  const recordParams = { limit: 10000, ...(busId ? { bus_id: busId } : {}) };
  if (from === to) recordParams.date = from; else { recordParams.from = from; recordParams.to = to; }
  const apiRecords = await apiFetch('/api/records', recordParams);
  if (apiRecords && apiRecords.records) {
    const ws3 = XLSX.utils.aoa_to_sheet([
      ['Timestamp','Bus ID','Route','Stop','Boardings','Alightings','Onboard','Occupancy %','Lat','Lng','Type'],
      ...apiRecords.records.map(r=>[r.timestamp, r.bus_id, r.route, r.stop, r.boardings, r.alightings, r.onboard, r.occupancy, r.lat, r.lng, r.msg_type])
    ]);
    XLSX.utils.book_append_sheet(wb,ws3,'Raw Data');
  } else if (liveRecords.length > 0) {
    const ws3 = XLSX.utils.aoa_to_sheet([
      ['Timestamp','Bus ID','Route','Stop','Boardings','Alightings','Onboard','Occupancy %','Lat','Lng'],
      ...liveRecords.map(r=>[r.timestamp, r.busId, r.route, r.stop, r.boardings, r.alightings, r.onboard, r.occupancy, r.lat, r.lng])
    ]);
    XLSX.utils.book_append_sheet(wb,ws3,'Raw Data (Live)');
  }

  // Live fleet sheet
  if (BUS_POSITIONS.length > 0) {
    const ws4 = XLSX.utils.aoa_to_sheet([
      ['Bus ID','Status','Passengers','Capacity','Occupancy %','Sensor','Last Update'],
      ...BUS_POSITIONS.map(b=>[b.id,b.status,b.passengers,b.capacity,b.occupancy,b.sensorStatus,b.lastUpdate])
    ]);
    XLSX.utils.book_append_sheet(wb,ws4,'Fleet');
  }

  XLSX.writeFile(wb,`SUS_Report_${from}_${to}.xlsx`);
}

async function exportToCSV(title, from, to, busId) {
  void title;
  // Fetch records from API, with live MQTT fallback
  const recordParams = { limit: 50000, ...(busId ? { bus_id: busId } : {}) };
  if (from === to) recordParams.date = from; else { recordParams.from = from; recordParams.to = to; }
  const data = await apiFetch('/api/records', recordParams);
  let records, h, rows;
  if (data && data.records) {
    records = data.records;
    h = ['Timestamp','Bus ID','Route','Stop','Boardings','Alightings','Onboard','Occupancy %','Lat','Lng','Type'];
    rows = records.map(r=>[r.timestamp,r.bus_id,r.route,r.stop,r.boardings,r.alightings,r.onboard,r.occupancy,r.lat,r.lng,r.msg_type].join(','));
  } else {
    // Live MQTT fallback
    h = ['Timestamp','Bus ID','Route','Stop','Boardings','Alightings','Onboard','Occupancy %','Lat','Lng'];
    rows = liveRecords.map(r=>[r.timestamp,r.busId,r.route,r.stop,r.boardings,r.alightings,r.onboard,r.occupancy,r.lat,r.lng].join(','));
  }
  const csv = [h.join(','),...rows].join('\n');
  const blob = new Blob([csv],{type:'text/csv'}); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `SUS_Data_${from}_${to || new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
}

// ============================================
// MONTHLY VALUE SUMMARY — client-facing narrative report
// ============================================

// Builds the full dataset for a Monthly Value Summary report: current-period
// totals, a comparison against the immediately preceding period of equal
// length (MoM when `from`/`to` span a full calendar month, which is the
// default), busiest day, peak hour, and a plain-English narrative.
// True when [from, to] exactly spans one calendar month (used to pick a
// real previous calendar month for comparison instead of an equal-length
// lookback, which drifts when adjacent months have different day counts).
function isFullCalendarMonth(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fd !== 1 || fy !== ty || fm !== tm) return false;
  const lastDay = new Date(Date.UTC(fy, fm, 0)).getUTCDate();
  return td === lastDay;
}

async function computeMonthlyValueSummaryData(from, to, clientName) {
  const spanDays = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
  let prevFrom, prevTo;
  if (isFullCalendarMonth(from, to)) {
    const prevRange = prevCalendarMonthRange(from);
    prevFrom = prevRange.from; prevTo = prevRange.to;
  } else {
    prevTo = shiftDateStr(from, -1);
    prevFrom = shiftDateStr(prevTo, -(spanDays - 1));
  }

  const [current, previous] = await Promise.all([
    apiFetch('/api/summary', { period: from, to }),
    apiFetch('/api/summary', { period: prevFrom, to: prevTo }).catch(() => null),
  ]);

  const curTotals = (current && current.totals) || {};
  const prevTotals = (previous && previous.totals) || {};
  const curBoardings = curTotals.total_boardings || 0;
  const prevBoardings = prevTotals.total_boardings || 0;
  const hasPrev = !!(previous && previous.totals && prevBoardings > 0);
  const pctChange = hasPrev ? ((curBoardings - prevBoardings) / prevBoardings) * 100 : null;

  const breakdown = (current && current.dailyBreakdown) || [];
  let busiestDay = null;
  breakdown.forEach(d => {
    const val = d.boardings || 0;
    if (!busiestDay || val > busiestDay.value) busiestDay = { date: d.date, value: val };
  });

  const daysCount = curTotals.days_count || breakdown.length || spanDays;
  const avgDaily = daysCount ? curBoardings / daysCount : 0;

  const ph = current && current.peakHour;
  const peakHourLabel = ph && ph.hour != null ? `${String(utcHourToDisplayHour(ph.hour)).padStart(2, '0')}:00` : 'N/A';

  const monthLabel = new Date(from + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const trendWord = pctChange == null ? '' : (pctChange >= 0 ? 'up' : 'down');
  const trendPhrase = pctChange == null
    ? 'no prior-period data is available yet for a direct comparison.'
    : `${trendWord} ${Math.abs(pctChange).toFixed(1)}% compared with the previous period (${prevFrom} to ${prevTo}).`;

  const narrative = `${clientName ? clientName + '’s' : 'Your'} shuttle service carried ${curBoardings.toLocaleString()} passengers in ${monthLabel}, ${trendPhrase} `
    + `The busiest day was ${busiestDay ? busiestDay.date : 'N/A'}${busiestDay ? ' with ' + busiestDay.value.toLocaleString() + ' boardings' : ''}, and the busiest hour of the day was typically around ${peakHourLabel}. `
    + `On average, the service moved ${Math.round(avgDaily).toLocaleString()} people per day across ${daysCount} day${daysCount === 1 ? '' : 's'} of operation.`;

  return {
    from, to, clientName, monthLabel,
    curTotals, prevTotals, curBoardings, prevBoardings, pctChange, hasPrev,
    prevFrom, prevTo, busiestDay, daysCount, avgDaily, peakHourLabel, breakdown, narrative,
  };
}

async function exportMonthlyValueSummaryPDF(from, to, clientName) {
  const d = await computeMonthlyValueSummaryData(from, to, clientName);
  const { jsPDF } = window.jspdf; const doc = new jsPDF();

  doc.setFillColor(15,17,23); doc.rect(0,0,210,40,'F');
  doc.setTextColor(255,255,255); doc.setFontSize(18); doc.text('Smart Urban Sensing Ltd',14,18);
  doc.setFontSize(12); doc.text(`Monthly Value Summary — ${d.monthLabel}`,14,28);
  doc.setFontSize(9);
  doc.text(`${d.clientName ? 'Prepared for: ' + d.clientName + '  |  ' : ''}Generated: ${new Date().toLocaleString('en-GB')}`,14,35);

  doc.setTextColor(0,0,0); doc.setFontSize(14); doc.text('Summary',14,52);
  doc.setFontSize(10.5);
  const narrativeLines = doc.splitTextToSize(d.narrative, 182);
  doc.text(narrativeLines,14,60);
  let y = 60 + narrativeLines.length * 5.5 + 8;

  doc.setFontSize(14); doc.text('Highlights',14,y); y += 6;
  const changeCell = d.pctChange == null ? 'N/A (no prior period)' : `${d.pctChange >= 0 ? '+' : ''}${d.pctChange.toFixed(1)}% vs previous period`;
  doc.autoTable({ startY:y, head:[['Metric','This Period','Previous Period']], body:[
    ['Total Boardings', (d.curBoardings||0).toLocaleString(), d.hasPrev ? d.prevBoardings.toLocaleString() : 'N/A'],
    ['Total Alightings', (d.curTotals.total_alightings||0).toLocaleString(), d.hasPrev ? (d.prevTotals.total_alightings||0).toLocaleString() : 'N/A'],
    ['Month-over-Month Change', changeCell, ''],
    ['Busiest Day', d.busiestDay ? `${d.busiestDay.date} (${d.busiestDay.value.toLocaleString()} boardings)` : 'N/A', ''],
    ['Typical Peak Hour', d.peakHourLabel, ''],
    ['Avg Daily Boardings', Math.round(d.avgDaily).toLocaleString(), ''],
    ['Peak Onboard (single trip)', String(d.curTotals.peak_onboard || 0), ''],
    ['Avg Occupancy', (d.curTotals.avg_occupancy != null ? d.curTotals.avg_occupancy.toFixed(1) : '0.0') + '%', ''],
  ], theme:'grid', headStyles:{fillColor:[245,158,11]} });

  if (d.breakdown && d.breakdown.length) {
    doc.setFontSize(14); doc.text('Daily Breakdown',14,doc.lastAutoTable.finalY+14);
    doc.autoTable({ startY:doc.lastAutoTable.finalY+20, head:[['Date','Boardings','Alightings','Avg Occupancy']],
      body: d.breakdown.map(r => [r.date, r.boardings||0, r.alightings||0, (r.avg_occ!=null ? r.avg_occ.toFixed(1) : '0.0') + '%']),
      theme:'grid', headStyles:{fillColor:[245,158,11]} });
  }

  const pc = doc.internal.getNumberOfPages();
  for (let i=1;i<=pc;i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(150); doc.text('Smart Urban Sensing Ltd — Monthly Value Summary',14,287); doc.text(`Page ${i}/${pc}`,180,287); }
  doc.save(`SUS_MonthlyValueSummary_${from}_${to}.pdf`);
}

async function exportMonthlyValueSummaryExcel(from, to, clientName) {
  const d = await computeMonthlyValueSummaryData(from, to, clientName);
  const wb = XLSX.utils.book_new();
  const changeCell = d.pctChange == null ? 'N/A (no prior period)' : `${d.pctChange >= 0 ? '+' : ''}${d.pctChange.toFixed(1)}%`;

  const ws1 = XLSX.utils.aoa_to_sheet([
    ['Smart Urban Sensing Ltd — Monthly Value Summary'],
    [`${d.monthLabel}`],
    d.clientName ? ['Prepared for:', d.clientName] : [],
    ['Generated:', new Date().toLocaleString('en-GB')],
    [],
    ['Summary'],
    [d.narrative],
    [],
    ['Metric','This Period','Previous Period'],
    ['Total Boardings', d.curBoardings||0, d.hasPrev ? d.prevBoardings : ''],
    ['Total Alightings', d.curTotals.total_alightings||0, d.hasPrev ? (d.prevTotals.total_alightings||0) : ''],
    ['Month-over-Month Change', changeCell, ''],
    ['Busiest Day', d.busiestDay ? d.busiestDay.date : 'N/A', ''],
    ['Busiest Day Boardings', d.busiestDay ? d.busiestDay.value : '', ''],
    ['Typical Peak Hour', d.peakHourLabel, ''],
    ['Avg Daily Boardings', Math.round(d.avgDaily), ''],
    ['Peak Onboard (single trip)', d.curTotals.peak_onboard || 0, ''],
    ['Avg Occupancy %', d.curTotals.avg_occupancy != null ? d.curTotals.avg_occupancy.toFixed(1) : '0.0', ''],
  ].filter(r => r.length));
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  if (d.breakdown && d.breakdown.length) {
    const ws2 = XLSX.utils.aoa_to_sheet([
      ['Date','Boardings','Alightings','Avg Occupancy %'],
      ...d.breakdown.map(r => [r.date, r.boardings||0, r.alightings||0, r.avg_occ!=null ? Number(r.avg_occ.toFixed(1)) : 0])
    ]);
    XLSX.utils.book_append_sheet(wb, ws2, 'Daily Breakdown');
  }

  XLSX.writeFile(wb, `SUS_MonthlyValueSummary_${from}_${to}.xlsx`);
}

async function exportMonthlyValueSummaryCSV(from, to, clientName) {
  const d = await computeMonthlyValueSummaryData(from, to, clientName);
  const changeCell = d.pctChange == null ? 'N/A' : `${d.pctChange >= 0 ? '+' : ''}${d.pctChange.toFixed(1)}%`;
  const lines = [
    `Smart Urban Sensing Ltd - Monthly Value Summary`,
    `${d.monthLabel}${d.clientName ? ' - Prepared for: ' + d.clientName : ''}`,
    `Generated: ${new Date().toLocaleString('en-GB')}`,
    '',
    'Metric,This Period,Previous Period',
    `Total Boardings,${d.curBoardings||0},${d.hasPrev ? d.prevBoardings : ''}`,
    `Total Alightings,${d.curTotals.total_alightings||0},${d.hasPrev ? (d.prevTotals.total_alightings||0) : ''}`,
    `Month-over-Month Change,${changeCell},`,
    `Busiest Day,${d.busiestDay ? d.busiestDay.date : 'N/A'},`,
    `Typical Peak Hour,${d.peakHourLabel},`,
    `Avg Daily Boardings,${Math.round(d.avgDaily)},`,
    '',
    'Date,Boardings,Alightings,Avg Occupancy %',
    ...(d.breakdown || []).map(r => `${r.date},${r.boardings||0},${r.alightings||0},${r.avg_occ!=null ? r.avg_occ.toFixed(1) : '0.0'}`),
  ];
  const csv = lines.join('\n');
  const blob = new Blob([csv],{type:'text/csv'}); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `SUS_MonthlyValueSummary_${from}_${to}.csv`; a.click(); URL.revokeObjectURL(url);
}

// ============================================
// CHART DEFAULTS
// ============================================

function chartDefaults(yLabel) {
  return {
    responsive:true, maintainAspectRatio:true, interaction:{mode:'index',intersect:false},
    animation:{duration:800,easing:'easeOutQuart'},
    plugins:{ legend:{labels:{color:'#b5b8d0',font:{size:13,family:'Inter',weight:'500'},padding:18,usePointStyle:true,boxWidth:10,boxHeight:10}}, tooltip:{...tooltipDefaults()} },
    scales:{ x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#b5b8d0',font:{size:12,weight:'500'},padding:8}}, y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#b5b8d0',font:{size:12,weight:'500'},padding:8},title:{display:true,text:yLabel,color:'#9094b2',font:{size:12,weight:'600'},padding:{bottom:6}}} },
  };
}

function tooltipDefaults() {
  return { backgroundColor:'#1c1e2e', titleColor:'#ffffff', bodyColor:'#c9cad8', borderColor:'#323554', borderWidth:1, padding:14, cornerRadius:8,
    titleFont:{family:'Inter',size:14,weight:600}, bodyFont:{family:'Inter',size:13}, displayColors:true, boxPadding:5 };
}


// ============================================
// BOARDINGS BY STOP — premium dashboard home panel
// ============================================
// Horizontal bar chart of per-stop boardings + alightings with a live
// GPS-vs-scheduled attribution chip in the header. Data: /api/stops/boardings.
let _stopBoardingsBus = 'all';
let _stopBoardingsRange = 'today';

function initStopBoardingsHome() {
  const ctx = document.getElementById('chartStopBoardingsHome');
  if (!ctx) return;
  // Flat glossy white for boardings (matches Passenger On treatment);
  // gold accent for alightings — palette-consistent.
  charts.stopBoardingsHome = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Boardings',
          data: [],
          backgroundColor: '#ffffff',
          hoverBackgroundColor: '#ffffff',
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.78,
          categoryPercentage: 0.78,
        },
        {
          label: 'Alightings',
          data: [],
          backgroundColor: 'rgba(212,175,55,0.95)',
          hoverBackgroundColor: 'rgba(212,175,55,1)',
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.78,
          categoryPercentage: 0.78,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 4, right: 14, bottom: 4, left: 4 } },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            color: '#c8cad8',
            font: { size: 12, weight: '500' },
            usePointStyle: true,
            pointStyle: 'rectRounded',
            boxWidth: 10,
            boxHeight: 10,
            padding: 14,
          },
        },
        tooltip: {
          ...tooltipDefaults(),
          callbacks: {
            title: (items) => items[0]?.label || '',
            label: (item) => `${item.dataset.label}: ${item.parsed.x}`,
            afterBody: (items) => {
              const row = items[0]?.raw?._meta;
              if (!row) return '';
              const gps = row.evt_gps || 0;
              const sched = row.evt_scheduled || 0;
              const total = gps + sched;
              if (!total) return '';
              const pct = Math.round((gps / total) * 100);
              return `GPS-verified: ${pct}%  ·  Events: ${row.event_count}`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false },
          ticks: { color: '#8b8ea5', font: { size: 12 }, precision: 0 },
        },
        y: {
          grid: { display: false, drawBorder: false },
          ticks: { color: '#e4e5ed', font: { size: 13, weight: '500' }, padding: 6 },
        },
      },
    },
  });

  const busSel = document.getElementById('stopBoardingsBus');
  if (busSel) busSel.addEventListener('change', () => {
    _stopBoardingsBus = busSel.value || 'all';
    refreshStopBoardingsHome();
  });
  const rangeSel = document.getElementById('stopBoardingsRange');
  if (rangeSel) rangeSel.addEventListener('change', () => {
    _stopBoardingsRange = rangeSel.value || 'today';
    refreshStopBoardingsHome();
  });
}

async function refreshStopBoardingsHome() {
  const chart = charts.stopBoardingsHome;
  if (!chart) return;
  const params = {};
  if (_stopBoardingsBus && _stopBoardingsBus !== 'all') params.bus_id = _stopBoardingsBus;
  if (_stopBoardingsRange === '7' || _stopBoardingsRange === '30') {
    const days = parseInt(_stopBoardingsRange, 10);
    const to = displayDateStr();
    const fromDate = new Date(Date.now() - (days - 1) * 86400000);
    params.from = fromDate.toISOString().slice(0, 10);
    params.to = to;
  }
  try {
    const data = await apiFetch('/api/stops/boardings', params);
    const empty = document.getElementById('stopBoardingsEmpty');
    const subtitle = document.getElementById('stopBoardingsSubtitle');
    const rows = (data && data.stops) ? data.stops : [];

    let totalGps = 0, totalSched = 0;
    for (const r of rows) {
      totalGps += (r.evt_gps || 0);
      totalSched += (r.evt_scheduled || 0);
    }
    const totalEvt = totalGps + totalSched;
    const gpsPct = totalEvt ? Math.round((totalGps / totalEvt) * 100) : 0;
    const schedPct = totalEvt ? (100 - gpsPct) : 0;
    const gpsEl = document.getElementById('stopAttrGps');
    const schedEl = document.getElementById('stopAttrSched');
    if (gpsEl) gpsEl.textContent = gpsPct + '%';
    if (schedEl) schedEl.textContent = schedPct + '%';

    if (subtitle) {
      const label = _stopBoardingsRange === 'today' ? 'today'
        : _stopBoardingsRange === '7' ? 'over the last 7 days'
        : 'over the last 30 days';
      const busLabel = (_stopBoardingsBus && _stopBoardingsBus !== 'all') ? ` · Bus ${_stopBoardingsBus}` : '';
      subtitle.textContent = `Top stops by passenger activity ${label}${busLabel}`;
    }

    const top = rows
      .map(r => ({ ...r, _total: (r.boardings || 0) + (r.alightings || 0) }))
      .filter(r => r._total > 0)
      .sort((a, b) => b._total - a._total)
      .slice(0, 10);

    if (!top.length) {
      if (empty) empty.style.display = 'flex';
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      chart.data.datasets[1].data = [];
      chart.update('none');
      return;
    }
    if (empty) empty.style.display = 'none';

    const shortLabel = (name) => {
      if (!name) return '—';
      const cleaned = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
      return cleaned.length > 32 ? cleaned.slice(0, 30) + '…' : cleaned;
    };

    chart.data.labels = top.map(r => shortLabel(r.stop));
    chart.data.datasets[0].data = top.map((r, i) => ({ x: r.boardings || 0, y: i, _meta: r }));
    chart.data.datasets[1].data = top.map((r, i) => ({ x: r.alightings || 0, y: i, _meta: r }));
    chart.update('active');
  } catch (err) {
    console.warn('[stopBoardingsHome] refresh failed:', err);
  }
}


// ============================================
// HISTORY PLAYBACK — Live Map view
// ============================================
// Three modes share the same #liveMapFull Leaflet instance:
//   1. breadcrumbs — coloured dots + polyline of every GPS sample in range
//   2. heatmap     — Leaflet.heat overlay showing density of bus positions
//   3. playback    — animated bus marker scrubbed via slider
// All driven by /api/history-locations.

const HISTORY = {
  mode: 'live',          // 'live' | 'history'
  vis: 'breadcrumbs',    // 'breadcrumbs' | 'heatmap' | 'playback'
  preset: 'today',       // 'today' | 'yesterday' | '7' | 'custom'
  busFilter: 'all',
  customFrom: null,
  customTo: null,
  points: [],            // raw rows from API
  layers: {},            // active Leaflet layers, keyed by name
  // playback state
  playback: {
    playing: false,
    idx: 0,
    speed: 4,
    timer: null,
    markers: {},         // busId -> Leaflet marker
    trails: {},          // busId -> Leaflet polyline
  },
};

const BUS_COLORS = {
  '515': '#8b74d1',  // purple
  '419': '#d4af37',  // gold
};
const BUS_COLOR_FALLBACK = '#7dd3fc';

function busColor(busId) { return BUS_COLORS[busId] || BUS_COLOR_FALLBACK; }

function initHistoryControls() {
  // Mode tabs
  document.querySelectorAll('.map-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      document.querySelectorAll('.map-mode-tab').forEach(b => b.classList.toggle('active', b === btn));
      HISTORY.mode = mode;
      if (maps.liveMap) maps.liveMap.getContainer().classList.toggle('history-on', mode === 'history');
      const liveBar = document.getElementById('liveFilterBar');
      const histBar = document.getElementById('historyFilterBar');
      const scrubber = document.getElementById('playbackScrubber');
      if (mode === 'live') {
        liveBar.style.display = '';
        histBar.style.display = 'none';
        scrubber.style.display = 'none';
        clearHistoryLayers();
        liveFootfallDraw();
      } else {
        liveBar.style.display = 'none';
        histBar.style.display = 'flex';
        liveFootfallDraw();
        // auto-load on first switch
        loadHistory();
      }
      if (window.lucide) window.lucide.createIcons();
    });
  });

  // Preset buttons
  document.querySelectorAll('.history-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.history-preset').forEach(b => b.classList.toggle('active', b === btn));
      HISTORY.preset = btn.dataset.preset;
      const custom = document.getElementById('historyCustomRange');
      custom.style.display = (HISTORY.preset === 'custom') ? 'flex' : 'none';
      if (HISTORY.preset !== 'custom') loadHistory();
    });
  });

  // Custom date inputs
  const today = displayDateStr();
  const fromInput = document.getElementById('historyFrom');
  const toInput = document.getElementById('historyTo');
  if (fromInput) { fromInput.max = today; fromInput.value = today; }
  if (toInput)   { toInput.max = today;   toInput.value = today; }

  // Bus filter
  const busSel = document.getElementById('historyBusFilter');
  if (busSel) busSel.addEventListener('change', () => {
    HISTORY.busFilter = busSel.value || 'all';
    loadHistory();
  });

  // Vis mode toggle
  document.querySelectorAll('.history-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.history-mode').forEach(b => b.classList.toggle('active', b === btn));
      HISTORY.vis = btn.dataset.vis;
      renderHistory();
    });
  });

  // Load button (mainly for custom date ranges)
  const loadBtn = document.getElementById('historyLoadBtn');
  if (loadBtn) loadBtn.addEventListener('click', loadHistory);

  // Playback controls
  const playBtn = document.getElementById('playbackPlayBtn');
  if (playBtn) playBtn.addEventListener('click', togglePlayback);
  const slider = document.getElementById('playbackSlider');
  if (slider) slider.addEventListener('input', () => seekPlayback(parseInt(slider.value, 10)));
  const speedSel = document.getElementById('playbackSpeed');
  if (speedSel) speedSel.addEventListener('change', () => {
    HISTORY.playback.speed = parseInt(speedSel.value, 10) || 4;
  });
}

function historyParams() {
  const params = {};
  if (HISTORY.busFilter && HISTORY.busFilter !== 'all') params.bus_id = HISTORY.busFilter;
  if (HISTORY.preset === 'today') {
    // backend defaults to today
  } else if (HISTORY.preset === 'yesterday') {
    const d = new Date(Date.now() - 86400000);
    params.date = d.toISOString().slice(0, 10);
  } else if (HISTORY.preset === '7') {
    const to = displayDateStr();
    const fromDate = new Date(Date.now() - 6 * 86400000);
    params.from = fromDate.toISOString().slice(0, 10);
    params.to = to;
  } else if (HISTORY.preset === 'custom') {
    const f = document.getElementById('historyFrom');
    const t = document.getElementById('historyTo');
    if (f && f.value) params.from = f.value;
    if (t && t.value) params.to = t.value;
  }
  return params;
}

async function loadHistory() {
  if (!maps.liveMap) return; // map not initialised yet
  const status = document.getElementById('historyStatus');
  if (status) status.textContent = 'Loading…';
  try {
    const data = await apiFetch('/api/history-locations', historyParams());
    HISTORY.points = (data && data.points) ? data.points : [];
    if (status) {
      const n = data.returned || 0;
      const tot = data.total_available || 0;
      const ds = data.downsampled ? ` (downsampled from ${tot})` : '';
      status.textContent = `${n.toLocaleString()} GPS points${ds}`;
    }
    renderHistory();
  } catch (err) {
    console.warn('[history] load failed:', err);
    if (status) status.textContent = 'Failed to load';
  }
}

function clearHistoryLayers() {
  const map = maps.liveMap;
  if (!map) return;
  for (const k of Object.keys(HISTORY.layers)) {
    try { map.removeLayer(HISTORY.layers[k]); } catch (e) {}
    delete HISTORY.layers[k];
  }
  // also clear playback markers/trails
  for (const k of Object.keys(HISTORY.playback.markers)) {
    try { map.removeLayer(HISTORY.playback.markers[k]); } catch (e) {}
    delete HISTORY.playback.markers[k];
  }
  for (const k of Object.keys(HISTORY.playback.trails)) {
    try { map.removeLayer(HISTORY.playback.trails[k]); } catch (e) {}
    delete HISTORY.playback.trails[k];
  }
  HISTORY.playback.trailLines = {};
  HISTORY.playback.stops = {};
  HISTORY.playback.byBus = null;
  HISTORY.playback.t0 = null;
  stopPlayback();
  const scrubber = document.getElementById('playbackScrubber');
  if (scrubber) scrubber.style.display = 'none';
}

function renderHistory() {
  clearHistoryLayers();
  const map = maps.liveMap;
  if (!map || !HISTORY.points.length) return;

  if (HISTORY.vis === 'breadcrumbs')  renderBreadcrumbs();
  else if (HISTORY.vis === 'heatmap') renderHeatmap();
  else if (HISTORY.vis === 'playback') renderPlayback();

  // Auto-fit bounds across all loaded points.
  const bounds = L.latLngBounds(HISTORY.points.map(p => [p.lat, p.lng]));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
}

function renderBreadcrumbs() {
  const map = maps.liveMap;
  // Group points by bus so each bus has its own coloured trail.
  const byBus = {};
  for (const p of HISTORY.points) {
    if (!byBus[p.bus_id]) byBus[p.bus_id] = [];
    byBus[p.bus_id].push(p);
  }
  Object.keys(byBus).forEach(busId => {
    const pts = byBus[busId];
    const color = busColor(busId);
    // Polyline connecting all points in time order.
    const line = L.polyline(pts.map(p => [p.lat, p.lng]), {
      color, weight: 3, opacity: 0.55, smoothFactor: 1.5,
    }).addTo(map);
    HISTORY.layers['line-' + busId] = line;
    // Dots — small circle markers per sample.
    const group = L.layerGroup();
    pts.forEach((p, i) => {
      // Slightly stronger opacity for first and last point so the trail has direction.
      const isEnd = (i === 0 || i === pts.length - 1);
      const m = L.circleMarker([p.lat, p.lng], {
        radius: isEnd ? 6 : 3.5,
        color,
        weight: isEnd ? 2 : 1,
        fillColor: isEnd ? '#ffffff' : color,
        fillOpacity: isEnd ? 1 : 0.85,
      });
      m.bindTooltip(
        `<strong>Bus ${p.bus_id}</strong><br>` +
        `${new Date(p.timestamp).toLocaleString()}<br>` +
        `Stop: ${p.stop || '—'}<br>` +
        `Speed: ${p.speed ? p.speed.toFixed(1) : 0} · Onboard: ${p.onboard || 0}`,
        { direction: 'top', sticky: true }
      );
      group.addLayer(m);
    });
    group.addTo(map);
    HISTORY.layers['dots-' + busId] = group;
  });
}

function renderHeatmap() {
  const map = maps.liveMap;
  if (typeof L.heatLayer !== 'function') {
    console.warn('[history] L.heatLayer missing — Leaflet.heat plugin not loaded');
    return;
  }
  // Slight weight by onboard so busier moments glow brighter.
  const points = HISTORY.points.map(p => [p.lat, p.lng, Math.max(0.2, Math.min(1.0, (p.onboard || 0) / 20 + 0.3))]);
  const heat = L.heatLayer(points, {
    radius: 22,
    blur: 18,
    maxZoom: 17,
    minOpacity: 0.35,
    gradient: { 0.2: '#5b49a8', 0.45: '#8b74d1', 0.65: '#d4af37', 0.85: '#fb7185', 1.0: '#ffffff' },
  }).addTo(map);
  HISTORY.layers['heat'] = heat;
}

// ----- Playback: smooth replay clock, road-following buses, comet trails ---
// The replay runs on its own clock (replay ms per real ms = speed x 30), so
// buses glide continuously between recorded points instead of hopping from
// stop to stop. Between two points a bus dwells briefly, then follows the
// route's road path with eased acceleration. Each bus leaves a high-contrast
// trail (white casing + route-colour core, fading towards the tail), and the
// stops it visits light up as it passes them.
const PB_RATE = 30;               // replay speed at "1x" (30x real time)
const PB_GAP_PARK_MS = 30 * 60000; // gaps longer than this: bus is parked
const PB_TRAIL_WINDOW = 20 * 60000; // replay time sampled for the trail
const PB_TRAIL_M = 2600;           // trail length (metres)
const PB_TRAIL_SEGS = 14;

function pbColor(busId) { return busTrailColor({ id: busId }) || busColor(busId); }

// Forward road path between two points along the bus's route loop (no length
// cap, unlike the live helper). Cached per point pair.
const PB_PATH_CACHE = new Map();
function pbRoadPath(busId, from, to) {
  const key = busId + '|' + from[0].toFixed(5) + ',' + from[1].toFixed(5) + '|' + to[0].toFixed(5) + ',' + to[1].toFixed(5);
  if (PB_PATH_CACHE.has(key)) return PB_PATH_CACHE.get(key);
  let out = null;
  try {
    const route = busRouteFor(busId);
    const line = route && routeLinePoints(route);
    if (line && line.roads && line.pts.length > 1) {
      const pts = line.pts;
      const nearest = (p) => { let bi = 0, bd = Infinity; for (let i = 0; i < pts.length; i++) { const d = geoDist(p, pts[i]); if (d < bd) { bd = d; bi = i; } } return [bi, bd]; };
      const [i0, d0] = nearest(from), [i1, d1] = nearest(to);
      if (d0 < 120 && d1 < 120 && i0 !== i1) {
        out = [from]; let i = i0, g = 0, len = 0;
        while (i !== i1 && g++ < pts.length) { i = (i + 1) % pts.length; len += geoDist(out[out.length - 1], pts[i]); out.push(pts[i]); }
        out.push(to);
        const direct = geoDist(from, to);
        if (len > Math.max(12000, direct * 6)) out = null;   // wrong way round
      }
    }
  } catch (e) { out = null; }
  if (!out) out = [from, to];
  // Precompute cumulative lengths for fast lookup.
  const cum = [0];
  for (let i = 1; i < out.length; i++) cum.push(cum[i - 1] + geoDist(out[i - 1], out[i]));
  const res = { pts: out, cum, len: cum[cum.length - 1] };
  PB_PATH_CACHE.set(key, res);
  if (PB_PATH_CACHE.size > 2000) PB_PATH_CACHE.delete(PB_PATH_CACHE.keys().next().value);
  return res;
}
function pbPointOn(path, f) {
  if (path.len <= 0) return path.pts[path.pts.length - 1];
  const want = path.len * Math.max(0, Math.min(1, f));
  let lo = 0, hi = path.cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (path.cum[mid] <= want) lo = mid; else hi = mid; }
  const seg = path.cum[hi] - path.cum[lo] || 1, k = (want - path.cum[lo]) / seg;
  const p = path.pts[lo], q = path.pts[hi];
  return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
}

// Where bus `busId` is at replay time t. Returns { pos, moving, at }.
function pbPositionAt(busId, t) {
  const arr = HISTORY.playback.byBus[busId];
  if (!arr || !arr.length) return null;
  if (t <= arr[0].t) return { pos: [arr[0].lat, arr[0].lng], moving: false, at: arr[0] };
  let lo = 0, hi = arr.length - 1;
  if (t >= arr[hi].t) return { pos: [arr[hi].lat, arr[hi].lng], moving: false, at: arr[hi] };
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) lo = mid; else hi = mid; }
  const a = arr[lo], b = arr[hi];
  const gap = b.t - a.t;
  if (gap > PB_GAP_PARK_MS || (a.lat === b.lat && a.lng === b.lng)) return { pos: [a.lat, a.lng], moving: false, at: a };
  // Dwell at the stop for a short share of the gap, then drive.
  const dwell = Math.min(gap * 0.12, 45000);
  if (t < a.t + dwell) return { pos: [a.lat, a.lng], moving: false, at: a };
  const u = (t - a.t - dwell) / Math.max(1, gap - dwell);
  const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;   // ease in-out
  const path = pbRoadPath(busId, [a.lat, a.lng], [b.lat, b.lng]);
  return { pos: pbPointOn(path, e), moving: true, at: null };
}

function renderPlayback() {
  const map = maps.liveMap;
  const scrubber = document.getElementById('playbackScrubber');
  if (scrubber) scrubber.style.display = 'flex';
  const pb = HISTORY.playback;
  // Per-bus, time-sorted points (depot resets excluded from motion).
  pb.byBus = {};
  for (const p of HISTORY.points) {
    if (!p.lat || !p.lng || p.stop === '-') continue;
    (pb.byBus[p.bus_id] = pb.byBus[p.bus_id] || []).push({ ...p, t: new Date(p.timestamp).getTime() });
  }
  Object.values(pb.byBus).forEach((a) => a.sort((x, y) => x.t - y.t));
  const all = Object.values(pb.byBus).flat();
  pb.t0 = Math.min(...all.map((p) => p.t));
  pb.t1 = Math.max(...all.map((p) => p.t));
  pb.t = pb.t0;

  // Stops visited in this range: a ring that lights up once a bus has been
  // there, and pulses while a bus is dwelling at it.
  const stopsGroup = L.layerGroup().addTo(map);
  HISTORY.layers['pb-stops'] = stopsGroup;
  pb.stops = {};
  Object.entries(pb.byBus).forEach(([busId, arr]) => {
    const color = pbColor(busId);
    arr.forEach((p) => {
      const k = busId + '|' + p.lat.toFixed(4) + ',' + p.lng.toFixed(4);
      if (pb.stops[k]) { pb.stops[k].visits.push(p.t); return; }
      const m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: 'pb-stop', html: `<div class="pb-stop-ring" style="--c:${color}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: true, zIndexOffset: 500,
      }).addTo(stopsGroup);
      m.bindTooltip(`<strong>${escapeHtml(rsStopLabel(String(p.stop || 'Stop')))}</strong><br><span style="opacity:.75">Bus ${escapeHtml(busId)}</span>`, { direction: 'top', offset: [0, -8] });
      pb.stops[k] = { marker: m, busId, visits: [p.t], state: '' };
    });
  });

  Object.keys(pb.byBus).forEach((busId) => {
    const color = pbColor(busId);
    const first = pb.byBus[busId][0];
    // Trail: white casing for contrast, then route-colour core segments.
    const group = L.layerGroup().addTo(map);
    const casing = [], core = [];
    for (let i = 0; i < PB_TRAIL_SEGS; i++) {
      casing.push(L.polyline([], { color: '#ffffff', weight: 8, opacity: 0, lineCap: 'butt', lineJoin: 'round', interactive: false, className: 'pb-trail-casing' }).addTo(group));
    }
    for (let i = 0; i < PB_TRAIL_SEGS; i++) {
      core.push(L.polyline([], { color, weight: 4, opacity: 0, lineCap: i === PB_TRAIL_SEGS - 1 ? 'round' : 'butt', lineJoin: 'round', interactive: false, className: 'pb-trail' }).addTo(group));
    }
    pb.trails[busId] = group;
    pb.trailLines = pb.trailLines || {};
    pb.trailLines[busId] = { casing, core };
    const marker = new SmoothBusMarker([first.lat, first.lng], {
      pane: busPane(map),
      icon: L.divIcon({ className: 'pb-bus', html: `<div class="pb-bus-dot" style="--c:${color}">${escapeHtml(String(busId).slice(-3))}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      zIndexOffset: 1200,
    }).addTo(map);
    pb.markers[busId] = marker;
  });

  const slider = document.getElementById('playbackSlider');
  if (slider) { slider.min = 0; slider.max = 1000; slider.step = 1; slider.value = 0; }
  pb.idx = 0;
  pb.playing = false;
  updatePlaybackUI();
  pbRender();
}

// Draw everything for the current replay time.
function pbRender() {
  const pb = HISTORY.playback;
  if (!pb.byBus || pb.t0 == null) return;
  const t = pb.t;
  const slider = document.getElementById('playbackSlider');
  const span = Math.max(1, pb.t1 - pb.t0);
  if (slider) slider.value = Math.round(((t - pb.t0) / span) * 1000);
  const time = document.getElementById('playbackTime');
  if (time) time.textContent = new Date(t).toLocaleString();
  // Keep idx (used by the stop card) on the latest point at or before t.
  const pts = HISTORY.points;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (new Date(pts[mid].timestamp).getTime() <= t) lo = mid; else hi = mid - 1; }
  pb.idx = lo;
  if (STOP_CARD_ACTIVE && STOP_CARD_ACTIVE._stopCardRefresh && Date.now() - (pbRender._cardT || 0) > 400) {
    pbRender._cardT = Date.now(); STOP_CARD_ACTIVE._stopCardRefresh();
  }
  const dwelling = new Set();
  Object.keys(pb.byBus).forEach((busId) => {
    const cur = pbPositionAt(busId, t);
    if (!cur) return;
    const marker = pb.markers[busId];
    if (marker) {
      marker.setLatLng(cur.pos);
      const el = marker.getElement && marker.getElement();
      if (el) el.classList.toggle('pb-bus-stopped', !cur.moving);
    }
    if (!cur.moving && cur.at) dwelling.add(busId + '|' + cur.at.lat.toFixed(4) + ',' + cur.at.lng.toFixed(4));
    // Trail: sample positions back in replay time, trim to a set distance.
    const samples = [cur.pos];
    let dist = 0;
    const N = 120, dt = PB_TRAIL_WINDOW / N;
    for (let k = 1; k <= N && dist < PB_TRAIL_M; k++) {
      const q = pbPositionAt(busId, t - k * dt);
      if (!q) break;
      const last = samples[samples.length - 1];
      const d = geoDist(last, q.pos);
      if (d < 0.5) continue;
      if (d > 3000) break;                 // parked overnight / jump: stop the trail
      samples.push(q.pos); dist += d;
    }
    samples.reverse();                       // tail -> head
    const lines = pb.trailLines && pb.trailLines[busId];
    if (!lines) return;
    const cum = [0];
    for (let i = 1; i < samples.length; i++) cum.push(cum[i - 1] + geoDist(samples[i - 1], samples[i]));
    const total = cum[cum.length - 1];
    for (let sIdx = 0; sIdx < PB_TRAIL_SEGS; sIdx++) {
      if (total < 5) { lines.casing[sIdx].setStyle({ opacity: 0 }); lines.core[sIdx].setStyle({ opacity: 0 }); continue; }
      const d0 = total * sIdx / PB_TRAIL_SEGS, d1 = total * (sIdx + 1) / PB_TRAIL_SEGS;
      const chunk = [];
      const at = (d) => { let k = 0; while (k < cum.length - 2 && cum[k + 1] < d) k++; const seg = cum[k + 1] - cum[k] || 1; const f = Math.max(0, Math.min(1, (d - cum[k]) / seg)); const q = samples[Math.min(k + 1, samples.length - 1)]; return [samples[k][0] + (q[0] - samples[k][0]) * f, samples[k][1] + (q[1] - samples[k][1]) * f]; };
      chunk.push(at(d0));
      for (let k = 1; k < samples.length - 1; k++) if (cum[k] > d0 && cum[k] < d1) chunk.push(samples[k]);
      chunk.push(at(d1));
      const f = (sIdx + 1) / PB_TRAIL_SEGS, e = f * f;
      lines.casing[sIdx].setLatLngs(chunk).setStyle({ opacity: 0.15 + 0.75 * e, weight: 4 + 6 * f });
      lines.core[sIdx].setLatLngs(chunk).setStyle({ opacity: 0.12 + 0.88 * e, weight: 2 + 4 * f });
    }
  });
  // Stop rings: visited / bus dwelling here now.
  Object.entries(pb.stops || {}).forEach(([k, st]) => {
    const visited = st.visits[0] <= t;
    const state = dwelling.has(k) ? 'here' : visited ? 'visited' : '';
    if (state === st.state) return;
    st.state = state;
    const el = st.marker.getElement && st.marker.getElement();
    if (el) { el.classList.toggle('pb-stop-visited', state === 'visited'); el.classList.toggle('pb-stop-here', state === 'here'); }
  });
}

function updatePlaybackUI() {
  const btn = document.getElementById('playbackPlayBtn');
  if (btn) {
    btn.innerHTML = HISTORY.playback.playing
      ? '<i data-lucide="pause" style="width:16px;height:16px"></i>'
      : '<i data-lucide="play"  style="width:16px;height:16px"></i>';
    if (window.lucide) window.lucide.createIcons();
  }
}

function togglePlayback() {
  const pb = HISTORY.playback;
  if (!HISTORY.points.length || pb.t0 == null) return;
  pb.playing = !pb.playing;
  updatePlaybackUI();
  if (!pb.playing) { stopPlayback(); return; }
  if (pb.t >= pb.t1) pb.t = pb.t0;
  let last = performance.now();
  const frame = (now) => {
    if (!pb.playing) return;
    const dtReal = Math.min(100, now - last); last = now;
    let next = pb.t + dtReal * PB_RATE * (pb.speed || 4);
    // Skip long idle gaps (overnight) when every bus is parked.
    const ahead = Object.values(pb.byBus).map((arr) => { const n = arr.find((p) => p.t > pb.t); return n ? n.t : Infinity; });
    const soonest = Math.min(...ahead);
    const allParked = Object.values(pb.byBus).every((arr) => { const n = arr.find((p) => p.t > pb.t); const prev = [...arr].reverse().find((p) => p.t <= pb.t); return !n || !prev || n.t - prev.t > PB_GAP_PARK_MS; });
    if (allParked && isFinite(soonest) && soonest - next > 60000) next = soonest - 60000;
    pb.t = Math.min(pb.t1, next);
    pbRender();
    if (pb.t >= pb.t1) { pb.playing = false; updatePlaybackUI(); return; }
    pb.timer = requestAnimationFrame(frame);
  };
  pb.timer = requestAnimationFrame(frame);
}

function stopPlayback() {
  if (HISTORY.playback.timer) cancelAnimationFrame(HISTORY.playback.timer);
  HISTORY.playback.timer = null;
  HISTORY.playback.playing = false;
}

// Slider: 0..1000 across the loaded time range.
function seekPlayback(v) {
  const pb = HISTORY.playback;
  if (!HISTORY.points.length || pb.t0 == null) return;
  pb.t = pb.t0 + (Math.max(0, Math.min(1000, v)) / 1000) * (pb.t1 - pb.t0);
  pbRender();
}

// Wire history controls once after the page loads. Safe to run before
// initLiveMap fires — it just attaches listeners to the History toolbar.
document.addEventListener('DOMContentLoaded', () => {
  if (HISTORY._controlsWired) return;
  initHistoryControls();
  HISTORY._controlsWired = true;
});
// And immediately, in case DOMContentLoaded already fired (script loads at end of body).
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  if (!HISTORY._controlsWired) {
    initHistoryControls();
    HISTORY._controlsWired = true;
  }
}

async function exportWelfareAuditPDF(from, to, busId, clientName) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const org = 'Smart Urban Sensing Ltd';
  const site = clientName || (DEMO_WHITE_LABEL ? 'Client Shuttle Fleet (Fleet Welfare)' : 'Mayo Clinic Shuttle (Fleet Welfare)');

  // Header banner
  doc.setFillColor(15, 23, 42); // slate-900
  doc.rect(0, 0, 210, 42, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Smart Urban Sensing Ltd — Welfare & Safeguarding Audit', 14, 18);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Site / Operation: ${site}${busId ? ' — Bus ' + busId : ' — Fleetwide'}`, 14, 27);
  doc.text(`Period: ${from} to ${to}  |  Generated: ${new Date().toLocaleString('en-GB')}`, 14, 34);

  // Fetch real welfare data
  let evts = [];
  try {
    const q = new URLSearchParams({ from, to: to + 'T23:59:59Z', limit: 200 });
    if (busId) q.append('busId', busId);
    const res = await fetch(`/api/welfare/events?${q.toString()}`);
    if (res.ok) {
      const data = await res.json();
      evts = data.events || [];
    }
  } catch (err) {
    console.error('Failed to fetch welfare events for report:', err);
  }

  // Summary Metrics
  const totalAlerts = evts.length;
  const escalations = evts.filter(e => e.severity === 4).length;
  const warnings = evts.filter(e => e.severity === 3).length;
  const resolved = evts.filter(e => e.resolved || e.acknowledged).length;
  const compliancePct = totalAlerts ? Math.round((resolved / totalAlerts) * 100) : 100;

  doc.setTextColor(28, 36, 52);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Executive Safeguarding Summary', 14, 52);

  doc.autoTable({
    startY: 56,
    head: [['Metric', 'Observed Value', 'Benchmark / Target', 'Compliance Status']],
    body: [
      ['Total Recorded Incidents', String(totalAlerts), 'All recorded telemetry', 'Audited'],
      ['Critical Escalations (Sev 4)', String(escalations), '< 5 per week', escalations > 5 ? 'Review Needed' : 'Good'],
      ['Welfare Alerts (Sev 3)', String(warnings), '< 15 per week', 'Within Limits'],
      ['Acknowledged / Resolved', `${resolved} / ${totalAlerts}`, '100% within SLA', `${compliancePct}% Compliant`],
      ['Emergency SLA Response Time', '< 300s (5 min)', '5 min Keyworker SLA', '100% on target'],
    ],
    theme: 'grid',
    headStyles: { fillColor: [212, 32, 44] },
    styles: { fontSize: 9 },
  });

  // Table of recent incidents
  const finalY = doc.lastAutoTable.finalY + 12;
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Welfare Incident Audit Trail', 14, finalY);

  const rows = evts.slice(0, 25).map(e => [
    e.detected_at ? e.detected_at.replace('T', ' ').slice(0, 19) : '—',
    'Bus ' + e.bus_id,
    e.event_type.replace(/_/g, ' '),
    e.severity === 4 ? 'ESCALATE' : (e.severity === 3 ? 'ALERT' : 'NOTIFY'),
    e.resolved ? 'RESOLVED' : (e.acknowledged ? 'ACK' : 'OPEN'),
    e.reason || e.rule || '—'
  ]);

  if (rows.length === 0) {
    rows.push(['No incidents recorded in this date range', '—', '—', '—', '—', 'Clean sheet']);
  }

  doc.autoTable({
    startY: finalY + 4,
    head: [['Timestamp (UTC)', 'Bus', 'Event Type', 'Severity', 'State', 'Operational Detail']],
    body: rows,
    theme: 'grid',
    headStyles: { fillColor: [30, 41, 59] },
    styles: { fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 32 },
      1: { cellWidth: 16 },
      2: { cellWidth: 34 },
      3: { cellWidth: 20 },
      4: { cellWidth: 20 },
      5: { cellWidth: 'auto' },
    }
  });

  // Footer Note
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text(`Smart Urban Sensing Ltd — BGH Innovation Grant WP3 Deliverable — Page ${i} of ${pageCount}`, 14, 290);
  }

  doc.save(`SUS-Welfare-Audit-${from}-to-${to}.pdf`);
}

async function exportWelfareAuditCSV(from, to, busId) {
  let evts = [];
  const q = new URLSearchParams({ from, to: to + 'T23:59:59Z', limit: 1000 });
  if (busId) q.append('busId', busId);
  const res = await fetch(`/api/welfare/events?${q.toString()}`);
  if (res.ok) {
    const data = await res.json();
    evts = data.events || [];
  }
  const headers = ['event_id', 'detected_at', 'bus_id', 'source', 'event_type', 'severity', 'rule', 'acknowledged', 'resolved', 'reason'];
  const csvRows = [headers.join(',')];
  for (const e of evts) {
    csvRows.push([
      `"${e.event_id}"`,
      `"${e.detected_at}"`,
      `"${e.bus_id}"`,
      `"${e.source}"`,
      `"${e.event_type}"`,
      e.severity,
      `"${e.rule || ''}"`,
      e.acknowledged ? 1 : 0,
      e.resolved ? 1 : 0,
      `"${(e.reason || '').replace(/"/g, '""')}"`
    ].join(','));
  }
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `SUS-Welfare-Audit-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}


// Theme selector (dark / Glossy Platinum). Reloads so charts pick up colours.
(function wireThemeToggle() {
  const sel = document.getElementById('themeToggle'); if (!sel) return;
  const d = document.documentElement;
  const cur = d.getAttribute('data-skin') === 'glossy-platinum' ? 'glossy' : 'dark';
  sel.value = cur;
  sel.addEventListener('change', () => {
    if (sel.value === cur) return;
    try { localStorage.setItem('sus-theme', sel.value); } catch (e) { /* noop */ }
    location.reload();
  });
})();

// ============================================
// SERVICE PERFORMANCE (Routes & Stops): load profile, crowding, time between buses
// ============================================
// Data: /api/service-analytics (analytics/service.js). One route at a time,
// picked with the tabs in the section header; follows the page's period.
const SP = { data: null, route: null, req: 0 };

function spStopLabel(name) {
  const ret = /\((return|rtn)\)\s*$/i.test(name || '');
  return shortStopName(rsBaseStop(name)) + (ret ? ' (return)' : '');
}
function spMin(v) { return v == null ? '--' : (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString(); }
function spSetHtml(id, v) { const el = document.getElementById(id); if (el) el.innerHTML = v; }
function spTone(id, tone) {
  const el = document.getElementById(id);
  const card = el && el.closest('.sp-kpi');
  if (card) { card.classList.remove('tone-good', 'tone-warn', 'tone-bad'); if (tone) card.classList.add('tone-' + tone); }
}

// Capacity line drawn straight onto the load chart (no annotation plugin needed).
const spCapacityPlugin = {
  id: 'spCapacity',
  afterDatasetsDraw(chart) {
    const cap = chart.$spCap;
    const y = chart.scales.y;
    if (!cap || !y) return;
    const { ctx, chartArea } = chart;
    const py = y.getPixelForValue(cap);
    if (py < chartArea.top - 1) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(248,113,113,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '600 11px Inter, sans-serif'; ctx.fillStyle = '#fca5a5'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('Capacity ' + cap, chartArea.right - 4, py - 4);
    ctx.restore();
  },
};
// Dashed target line on the gap-by-hour chart.
const spTargetPlugin = {
  id: 'spTarget',
  afterDatasetsDraw(chart) {
    const t = chart.$spTarget;
    const y = chart.scales.y;
    if (!t || !y) return;
    const { ctx, chartArea } = chart;
    const py = y.getPixelForValue(t);
    ctx.save();
    ctx.strokeStyle = 'rgba(74,222,128,0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '600 11px Inter, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    const label = (chart.$spTargetLabel || 'Timetable') + ' ' + spMin(t) + ' min';
    const w = ctx.measureText(label).width;
    // Dark pill behind the label so it stays readable over the bars.
    ctx.fillStyle = 'rgba(15,16,24,0.88)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(chartArea.right - w - 10, py - 19, w + 8, 16, 4); else ctx.rect(chartArea.right - w - 10, py - 19, w + 8, 16);
    ctx.fill();
    ctx.fillStyle = '#86efac';
    ctx.fillText(label, chartArea.right - 6, py - 5);
    ctx.restore();
  },
};

function spInitCharts() {
  if (charts.loadProfile || !window.Chart) return;
  const tick = { color: '#c9cad8', font: { size: 11, family: 'Inter', weight: '500' } };
  const grid = { color: 'rgba(255,255,255,0.06)', drawTicks: false };
  const lp = document.getElementById('chartLoadProfile');
  if (lp) {
    charts.loadProfile = new Chart(lp.getContext('2d'), {
      type: 'bar',
      plugins: [spCapacityPlugin],
      data: { labels: [], datasets: [
        { type: 'line', label: 'Average on board', data: [], order: 0, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.16)', fill: true, tension: 0.25, cubicInterpolationMode: 'monotone', borderWidth: 3, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#38bdf8', pointBorderColor: '#0b0c12', pointBorderWidth: 2, yAxisID: 'y' },
        { type: 'line', label: 'Highest on board', data: [], order: 1, borderColor: 'rgba(251,191,36,0.9)', borderDash: [5, 4], borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#fbbf24', fill: false, tension: 0, yAxisID: 'y' },
        { label: 'Got on (avg per visit)', data: [], order: 2, backgroundColor: ROUTE_WHITE, borderRadius: 5, maxBarThickness: 26, yAxisID: 'y' },
        { label: 'Got off (avg per visit)', data: [], order: 3, backgroundColor: ROUTE_GOLD, borderRadius: 5, maxBarThickness: 26, yAxisID: 'y' },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 450 },
        plugins: {
          legend: { labels: { color: '#dbdce6', font: { size: 12, family: 'Inter', weight: '500' }, usePointStyle: true, pointStyle: 'circle', boxWidth: 10, padding: 14 } },
          tooltip: { ...tooltipDefaults(), callbacks: {
            label: (c) => ' ' + c.dataset.label + ': ' + (Math.round(c.parsed.y * 10) / 10).toLocaleString(),
            afterBody: (items) => {
              const s = SP.cur && SP.cur.load.stops[items[0].dataIndex];
              return s ? ['', s.visits.toLocaleString() + ' stop visits', 'Left 80%+ full on ' + s.busy_share + '% of visits'] : [];
            },
          } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { ...tick, maxRotation: 0, autoSkip: false } },
          y: { beginAtZero: true, grid, ticks: { ...tick, padding: 6 }, title: { display: true, text: 'Passengers', color: '#8b8ea5', font: { size: 11, family: 'Inter' } } },
        },
      },
    });
  }
  const gh = document.getElementById('chartGapByHour');
  if (gh) {
    charts.gapByHour = new Chart(gh.getContext('2d'), {
      type: 'bar',
      plugins: [spTargetPlugin],
      data: { labels: [], datasets: [{ label: 'Average gap (min)', data: [], backgroundColor: [], borderRadius: 4, maxBarThickness: 22 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltipDefaults(), callbacks: { title: (it) => it[0].label + ':00', label: (c) => ' Average gap: ' + spMin(c.parsed.y) + ' min' } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { ...tick, maxRotation: 0 } },
          y: { beginAtZero: true, grid, ticks: { ...tick, callback: (v) => v + 'm' } },
        },
      },
    });
  }
}

async function spLoad() {
  if (!document.getElementById('servicePerf')) return;
  spInitCharts();
  const id = ++SP.req;
  const data = await apiFetch('/api/service-analytics', { from: RS.from, to: RS.to });
  if (id !== SP.req) return;
  SP.data = data;
  const routes = (data && data.routes) || [];
  routes.sort((a, b) => (b.visits || 0) - (a.visits || 0));
  if (RS.route && RS.route !== 'all') SP.route = rsRouteKeyForBus(RS.route);
  if (!routes.some((r) => r.route === SP.route)) SP.route = routes.length ? routes[0].route : null;
  spRenderTabs();
  spRender();
}

function spRenderTabs() {
  const wrap = document.getElementById('spRouteTabs');
  if (!wrap) return;
  const routes = (SP.data && SP.data.routes) || [];
  wrap.hidden = routes.length < 2;
  wrap.innerHTML = routes.map((r) => '<button type="button" class="period-tab' + (r.route === SP.route ? ' active' : '') + '" data-sp-route="' + escapeHtml(r.route) + '" role="tab" aria-selected="' + (r.route === SP.route) + '">Route ' + escapeHtml(r.route) + '</button>').join('');
  wrap.querySelectorAll('[data-sp-route]').forEach((b) => b.addEventListener('click', () => {
    SP.route = b.getAttribute('data-sp-route');
    spRenderTabs(); spRender();
  }));
}

function spHeatColor(p) {
  if (p == null) return 'rgba(255,255,255,0.04)';
  const t = Math.max(0, Math.min(1, p / 100));
  // light blue -> blue -> amber -> red
  const stops = [[0, [56, 189, 248, 0.18]], [0.35, [56, 189, 248, 0.85]], [0.7, [251, 191, 36, 0.95]], [1, [239, 68, 68, 1]]];
  let a = stops[0]; let b = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { a = stops[i - 1]; b = stops[i]; break; }
  const k = (t - a[0]) / ((b[0] - a[0]) || 1);
  const c = a[1].map((v, i) => v + (b[1][i] - v) * k);
  return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + c[3].toFixed(2) + ')';
}

function spRender() {
  const r = ((SP.data && SP.data.routes) || []).find((x) => x.route === SP.route);
  SP.cur = r || null;
  const range = rsRangeLabel();
  const section = document.getElementById('servicePerf');
  if (!section) return;
  if (!r || !r.visits) {
    rsSetText('spSubtitle', 'No stop visits recorded for ' + (r ? 'Route ' + r.route : 'any route') + ' \u00b7 ' + range);
    if (charts.loadProfile) { charts.loadProfile.data.labels = []; charts.loadProfile.data.datasets.forEach((d) => { d.data = []; }); charts.loadProfile.update(); }
    if (charts.gapByHour) { charts.gapByHour.data.labels = []; charts.gapByHour.data.datasets[0].data = []; charts.gapByHour.update(); }
    spSetHtml('spHeat', '<div class="sp-empty">No data in this period</div>');
    spSetHtml('spGapBody', '');
    ['spPlf', 'spFull', 'spBusy', 'spGapTyp', 'spWait', 'spOnTarget'].forEach((id) => rsSetText(id, '--'));
    const bc = document.getElementById('spBusiest'); if (bc) bc.hidden = true;
    return;
  }
  const cap = r.load.capacity;
  rsSetText('spSubtitle', 'Route ' + r.route + (rsRouteShortName(STOPS_REGISTRY && STOPS_REGISTRY[r.route] || {}) ? ' \u00b7 ' + rsRouteShortName(STOPS_REGISTRY[r.route]) : '') + ' \u00b7 ' + range + ' \u00b7 ' + r.visits.toLocaleString() + ' stop visits');

  // ---- Load profile ----
  const st = r.load.stops;
  if (charts.loadProfile) {
    const ch = charts.loadProfile;
    ch.$spCap = cap;
    ch.data.labels = st.map((s) => {
      const l = spStopLabel(s.name);
      if (l.length <= 18) return l;
      const ret = /\(return\)$/.test(l);
      const base = l.replace(/ \(return\)$/, '');
      // Break at an em dash if there is one, otherwise before the last word.
      const parts = base.includes(' \u2014 ') ? base.split(' \u2014 ') : base.split(/\s+(?=\S+$)/);
      return parts.concat(ret ? ['(return)'] : []);
    });
    ch.data.datasets[0].data = st.map((s) => s.avg_load);
    ch.data.datasets[1].data = st.map((s) => s.max_load);
    ch.data.datasets[2].data = st.map((s) => s.avg_on);
    ch.data.datasets[3].data = st.map((s) => s.avg_off);
    ch.options.scales.y.suggestedMax = cap + 2;
    ch.update();
  }
  const b = r.load.stops[r.load.busiest];
  const bc = document.getElementById('spBusiest');
  if (bc && b) {
    const next = st[(r.load.busiest + 1) % st.length];
    bc.hidden = false;
    bc.innerHTML = 'Busiest point: leaving <b>' + escapeHtml(spStopLabel(b.name)) + '</b>' + (next ? ' towards ' + escapeHtml(spStopLabel(next.name)) : '')
      + '<br>' + (Math.round(b.avg_load * 10) / 10) + ' on board on average (' + Math.round((b.avg_load / cap) * 100) + '% of ' + cap + ' seats), up to ' + b.max_load;
  }
  rsSetText('spLoadSub', 'Average on board leaving each stop, in the order the bus drives \u00b7 bars show people getting on and off per visit');

  // ---- Crowding ----
  const c = r.crowding;
  spSetHtml('spPlf', c.peak_load_factor == null ? '--' : c.peak_load_factor + '<small>%</small>');
  rsSetText('spPlfSub', 'fullest point of each loop \u00b7 ' + c.loops.toLocaleString() + ' loops');
  spTone('spPlf', c.peak_load_factor >= 85 ? 'bad' : c.peak_load_factor >= 65 ? 'warn' : 'good');
  spSetHtml('spFull', c.loops_full.toLocaleString());
  rsSetText('spFullSub', c.loops ? Math.round((c.loops_full / c.loops) * 100) + '% of loops \u00b7 ' + c.loops_busy + ' reached 80%+' : '--');
  spTone('spFull', c.loops && c.loops_full / c.loops > 0.1 ? 'bad' : c.loops_full ? 'warn' : 'good');
  spSetHtml('spBusy', c.busy_hours == null ? '--' : spMin(c.busy_hours) + '<small>h</small>');
  rsSetText('spBusySub', c.busy_share == null ? '--' : c.busy_share + '% of ' + spMin(c.service_hours) + 'h in service');
  spTone('spBusy', c.busy_share >= 20 ? 'bad' : c.busy_share >= 5 ? 'warn' : 'good');
  rsSetText('spCrowdSub', 'Against a capacity of ' + cap + ' \u00b7 ' + range);
  const hours = c.heat.hours;
  const heat = document.getElementById('spHeat');
  if (heat) {
    heat.style.gridTemplateColumns = '34px repeat(' + hours.length + ', minmax(0, 1fr))';
    let h = '<div></div>' + hours.map((x) => '<div class="h-lab">' + (x % 3 === 0 ? String(x).padStart(2, '0') : '') + '</div>').join('');
    c.heat.days.forEach((d, di) => {
      h += '<div class="d-lab">' + d + '</div>';
      hours.forEach((hr) => {
        const v = c.heat.avg[di][hr]; const pk = c.heat.peak[di][hr];
        const tip = d + ' ' + String(hr).padStart(2, '0') + ':00 \u2013 ' + (v == null ? 'no service' : 'average ' + v + '% full, fullest ' + pk + '%');
        h += '<div class="cell" style="background:' + spHeatColor(v) + '" title="' + tip + '">' + (v == null ? '' : v) + '</div>';
      });
    });
    heat.innerHTML = h;
  }

  // ---- Time between buses ----
  const g = r.gaps;
  spSetHtml('spGapTyp', g.median == null ? '--' : spMin(g.median) + '<small>min</small>');
  rsSetText('spGapTypSub', g.partial
    ? 'tracked bus every ' + spMin(g.target) + ' min \u00b7 route every ' + spMin(g.headway)
    : (g.target ? 'timetable every ' + spMin(g.target) + ' min' : 'no timetable set'));
  spTone('spGapTyp', g.target && g.median != null ? (g.median <= g.target + 2 ? 'good' : g.median <= g.target + 5 ? 'warn' : 'bad') : null);
  // With only some of the route's buses tracked, observed gaps overstate the
  // wait, so show the timetable figure and keep the tracked-bus wait as context.
  const waitV = g.partial ? g.timetable_wait : g.wait;
  spSetHtml('spWait', waitV == null ? '--' : spMin(waitV) + '<small>min</small>');
  rsSetText('spWaitSub', g.partial
    ? 'if all ' + g.buses_in_service + ' buses keep to time \u00b7 tracked bus alone ' + spMin(g.wait) + ' min'
    : 'for someone arriving at random');
  spTone('spWait', null);
  spSetHtml('spOnTarget', g.on_target == null ? '--' : g.on_target + '<small>%</small>');
  rsSetText('spOnTargetSub', g.target ? 'within ' + spMin(g.target + 5) + ' min \u00b7 ' + g.count.toLocaleString() + ' gaps' : '--');
  spTone('spOnTarget', g.on_target == null ? null : g.on_target >= 90 ? 'good' : g.on_target >= 75 ? 'warn' : 'bad');
  if (g.partial) rsSetText('spGapSub', 'Route timetable every ' + spMin(g.headway) + ' min with ' + g.buses_in_service + ' buses \u00b7 ' + g.buses + ' has sensors, so gaps shown are for the tracked bus (every ' + spMin(g.target) + ' min) \u00b7 loop takes ' + spMin(r.loops.median) + ' min typically (timetable ' + spMin(r.loops.scheduled) + ')');
  else rsSetText('spGapSub', (g.buses > 1 ? g.buses + ' buses' : 'One bus') + ' on this route \u00b7 ' + (g.buses > 1 && g.bunched != null ? g.bunched + ' bunched arrivals \u00b7 ' : '') + 'loop takes ' + spMin(r.loops.median) + ' min typically (timetable ' + spMin(r.loops.scheduled) + ')');
  if (charts.gapByHour) {
    const ch = charts.gapByHour;
    const hrs = []; for (let i = 0; i < 24; i++) if (g.by_hour[i] != null) hrs.push(i);
    ch.$spTarget = g.target;
    ch.$spTargetLabel = g.partial ? 'Tracked bus' : 'Timetable';
    ch.data.labels = hrs.map((x) => String(x).padStart(2, '0'));
    ch.data.datasets[0].data = hrs.map((x) => g.by_hour[x]);
    ch.data.datasets[0].backgroundColor = hrs.map((x) => {
      const v = g.by_hour[x];
      if (!g.target) return 'rgba(56,189,248,0.8)';
      return v <= g.target + 2 ? 'rgba(74,222,128,0.75)' : v <= g.target + 5 ? 'rgba(251,191,36,0.85)' : 'rgba(248,113,113,0.9)';
    });
    ch.options.scales.y.suggestedMax = g.target ? g.target * 1.4 : undefined;
    ch.update();
  }
  spSetHtml('spGapBody', g.by_stop.map((s) => {
    const tone = s.on_target == null ? '' : s.on_target >= 90 ? '#4ade80' : s.on_target >= 75 ? '#fbbf24' : '#f87171';
    return '<tr><td style="color:var(--color-text);font-weight:500">' + escapeHtml(spStopLabel(s.name)) + '</td>'
      + '<td style="text-align:right">' + (s.median == null ? '--' : spMin(s.median) + 'm') + '</td>'
      + '<td style="text-align:right">' + (s.p90 == null ? '--' : spMin(s.p90) + 'm') + '</td>'
      + '<td style="text-align:right">' + (s.wait == null ? '--' : spMin(s.wait) + 'm') + '</td>'
      + '<td style="text-align:right;color:' + tone + ';font-weight:600">' + (s.on_target == null ? '--' : s.on_target + '%') + '</td></tr>';
  }).join(''));
}

// ============================================
// SERVICE SCORECARD — productivity, service quality, passenger welfare
// ============================================
// Data: /api/scorecard (analytics/scorecard.js). Fleet or one route, this
// period against the one before, with status against target.
const SC = { days: '30', route: 'fleet', data: null, trend: 'pax_per_hour', req: 0 };
const SC_TYPE_LABELS = {
  fall: 'Possible fall', violence: 'Possible altercation', violence_disruption: 'Altercation (heard too)',
  sound_classification: 'Unusual sound', overcrowding: 'Overcrowding', dwell_exceeded: 'Long time on board',
  dwell_distress_unresponsive: 'Unresponsive passenger', lone_traveller: 'Lone traveller',
  lone_traveller_late_night: 'Lone traveller, late', end_of_service_occupancy: 'On board at end of service',
  terminus_occupancy: 'On board at terminus', stationary_with_occupants: 'Parked, people on board',
  dwell_no_alighting: 'Nobody getting off', panic_button: 'Panic button', driver_help: 'Driver asked for help',
};
const SC_COST_KEY = 'sus-cost-per-hour:' + location.host;

function scCurrency() { return APP_TZ === 'Europe/London' ? '\u00a3' : '$'; }
function scRange() {
  const today = displayDateStr();
  if (SC.days === 'month') {
    const [y, m] = today.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 2, 1));
    const last = new Date(Date.UTC(y, m - 1, 0));
    return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
  }
  const n = parseInt(SC.days, 10) || 30;
  const f = new Date(); f.setDate(f.getDate() - (n - 1));
  return { from: displayDateStr(f), to: today };
}
function scFmtDate(d) {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function scNum(v, dp = 0) {
  if (v == null || !isFinite(v)) return '--';
  return Number(v).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

// Measure definitions: label, how to read the value, format, target text.
const SC_MEASURES = {
  prod: [
    { k: 'passengers', g: 'productivity', label: 'Passengers', fmt: (v) => scNum(v), up: true },
    { k: 'service_hours', g: 'productivity', label: 'Hours in service', fmt: (v) => scNum(v), up: true },
    { k: 'pax_per_hour', g: 'productivity', label: 'Passengers per hour', fmt: (v) => scNum(v, 1), up: true, target: true },
    { k: 'pax_per_loop', g: 'productivity', label: 'Passengers per loop', fmt: (v) => scNum(v, 1), up: true },
    { k: 'seat_use', g: 'productivity', label: 'Seats used on average', fmt: (v) => v == null ? '--' : v + '%', up: true, target: true },
    { k: 'cost_total', g: 'derived', label: 'Cost to run', fmt: (v) => v == null ? '--' : scCurrency() + scNum(v), up: false, hint: 'Add cost per hour' },
    { k: 'cost_per_pax', g: 'derived', label: 'Cost per passenger', fmt: (v) => v == null ? '--' : scCurrency() + scNum(v, 2), up: false, hint: 'Add cost per hour' },
  ],
  serv: [
    { k: 'gap_median', g: 'service', label: 'Typical gap between buses', fmt: (v) => v == null ? '--' : scNum(v, 1) + ' min', up: false },
    { k: 'on_target', g: 'service', label: 'Gaps on target', fmt: (v) => v == null ? '--' : v + '%', up: true, target: true },
    { k: 'wait', g: 'service', label: 'Average wait', fmt: (v) => v == null ? '--' : scNum(v, 1) + ' min', up: false, rag: 'wait_vs_timetable' },
    { k: 'peak_load', g: 'service', label: 'Fullest point of each loop', fmt: (v) => v == null ? '--' : v + '%', up: false, target: true },
    { k: 'loops_full', g: 'service', label: 'Loops that filled up', fmt: (v) => v == null ? '--' : scNum(v, 1) + '%', up: false, target: true },
  ],
  welf: [
    { k: 'incidents', g: 'welfare', label: 'Welfare incidents', fmt: (v) => scNum(v), up: false },
    { k: 'incidents_per_k', g: 'welfare', label: 'Incidents per 1,000 passengers', fmt: (v) => scNum(v, 1), up: false, target: true },
    { k: 'serious_per_k', g: 'welfare', label: 'Serious per 1,000 passengers', fmt: (v) => scNum(v, 2), up: false, target: true },
    { k: 'response_median', g: 'welfare', label: 'Time to first response', fmt: (v) => v == null ? '--' : scNum(v, 1) + ' min', up: false, target: true },
    { k: 'urgent_in_sla', g: 'welfare', label: 'Urgent alerts answered in 5 min', fmt: (v) => v == null ? '--' : v + '%', up: true, target: true },
    { k: 'close_median', g: 'welfare', label: 'Time to close', fmt: (v) => v == null ? '--' : scNum(v) + ' min', up: false, target: true },
    { k: 'passenger_ok', g: 'welfare', label: 'Driver checks: passenger OK', fmt: (v) => v == null ? '--' : v + '%', up: true },
  ],
};

function scTargetText(key, targets, cur) {
  if (key === 'wait_vs_timetable') {
    const tw = cur && cur.service.timetable_wait;
    return tw == null ? '--' : '\u2264 ' + scNum(tw + targets.wait_vs_timetable.green, 1) + ' min';
  }
  const t = targets[key];
  if (!t) return '';
  if (t.mode === 'trend') return 'not worse than before';
  const sign = t.dir === 'up' ? '\u2265 ' : '\u2264 ';
  const unit = t.unit === '%' ? '%' : t.unit === 'min' ? ' min' : t.unit === '/h' ? ' / h' : '';
  return sign + t.green + unit;
}

function scCostRate() {
  const v = parseFloat(localStorage.getItem(SC_COST_KEY));
  return v > 0 ? v : null;
}

// Cost summary line under the title: makes the cost per hour visibly do something.
function scRenderCost(d, s) {
  const el = document.getElementById('scCostStrip');
  if (!el) return;
  const rate = scCostRate();
  const cur = scCurrency();
  if (!rate) {
    el.className = 'sc-cost-strip empty';
    el.innerHTML = 'Enter the operating cost per bus hour above to see what the service costs to run and the cost per passenger. '
      + (cur === '\u00a3' ? 'For reference, the average in Great Britain outside London is about \u00a360 an hour (CPT, Feb 2026).' : 'For reference, contracted US shuttle buses typically run about $130\u2013150 an hour.');
    return;
  }
  const defs = { tot: SC_MEASURES.prod.find((x) => x.k === 'cost_total'), pp: SC_MEASURES.prod.find((x) => x.k === 'cost_per_pax') };
  const tot = scValue(s.cur, defs.tot); const pp = scValue(s.cur, defs.pp); const ppPrev = scValue(s.prev, defs.pp);
  const routes = SC.route === 'fleet' ? d.routes.map((r) => {
    const v = scValue(r.current, defs.pp);
    return '<span class="sc-cost-route">Route ' + escapeHtml(r.route) + ' <b>' + defs.pp.fmt(v) + '</b></span>';
  }).join('') : '';
  el.className = 'sc-cost-strip';
  el.innerHTML = '<span class="sc-cost-lead">At ' + cur + scNum(rate, rate % 1 ? 2 : 0) + ' an hour</span>'
    + '<span>Cost to run <b>' + defs.tot.fmt(tot) + '</b> over ' + scNum(s.cur.productivity.service_hours) + ' hours</span>'
    + '<span>Cost per passenger <b>' + defs.pp.fmt(pp) + '</b> ' + scChange(pp, ppPrev, defs.pp) + '</span>'
    + routes;
}

function scValue(m, def) {
  if (!m) return null;
  if (def.g === 'derived') {
    const cost = scCostRate();
    if (!cost) return null;
    if (def.k === 'cost_total') return m.productivity.service_hours ? cost * m.productivity.service_hours : null;
    return m.productivity.pax_per_hour ? cost / m.productivity.pax_per_hour : null;
  }
  return m[def.g] ? m[def.g][def.k] : null;
}

function scChange(cur, prev, def) {
  if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return '';
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return '<span class="sc-chg flat">no change</span>';
  const better = def.up ? d > 0 : d < 0;
  const pct = prev !== 0 ? Math.round((d / Math.abs(prev)) * 100) : null;
  const arrow = d > 0 ? '\u25b2' : '\u25bc';
  return '<span class="sc-chg ' + (better ? 'good' : 'bad') + '">' + arrow + ' ' + (pct != null ? Math.abs(pct) + '%' : '') + '</span>';
}

function scPill(r) {
  if (!r) return '<span class="sc-pill none">--</span>';
  const t = { green: 'On target', amber: 'Watch', red: 'Off target' }[r];
  return '<span class="sc-pill ' + r + '"><i class="sc-dot ' + r + '"></i>' + t + '</span>';
}

function initScorecard() {
  document.getElementById('scCurrency').textContent = scCurrency();
  const cost = document.getElementById('scCost');
  cost.value = localStorage.getItem(SC_COST_KEY) || '';
  ['input', 'change'].forEach((ev) => cost.addEventListener(ev, () => {
    const v = parseFloat(cost.value);
    if (v > 0) localStorage.setItem(SC_COST_KEY, String(v)); else localStorage.removeItem(SC_COST_KEY);
    scRender();
  }));
  document.querySelectorAll('#scPeriod [data-sc-days]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#scPeriod .period-tab').forEach((x) => x.classList.toggle('active', x === b));
    SC.days = b.getAttribute('data-sc-days');
    scLoad();
  }));
  document.querySelectorAll('#scTrendTabs [data-sc-trend]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#scTrendTabs .period-tab').forEach((x) => x.classList.toggle('active', x === b));
    SC.trend = b.getAttribute('data-sc-trend');
    scRenderTrend();
  }));
  document.getElementById('scRoute').addEventListener('change', (e) => { SC.route = e.target.value; scRender(); });
  document.getElementById('scPrint').addEventListener('click', () => { document.body.classList.add('sc-printing'); window.print(); setTimeout(() => document.body.classList.remove('sc-printing'), 500); });
  document.getElementById('scExport').addEventListener('click', scExport);
  scLoad();
}

async function scLoad() {
  const id = ++SC.req;
  const { from, to } = scRange();
  document.getElementById('scSubtitle').textContent = 'Loading\u2026';
  const data = await apiFetch('/api/scorecard', { from, to });
  if (id !== SC.req) return;
  SC.data = data;
  const sel = document.getElementById('scRoute');
  const routes = (data && data.routes) || [];
  const keep = SC.route;
  sel.innerHTML = '<option value="fleet">Whole fleet</option>' + routes.map((r) => '<option value="' + escapeHtml(r.route) + '">Route ' + escapeHtml(r.route) + ' \u2014 ' + escapeHtml(rsRouteShortName(r) || r.name) + '</option>').join('');
  SC.route = routes.some((r) => r.route === keep) ? keep : 'fleet';
  sel.value = SC.route;
  scRender();
}

function scSelected() {
  const d = SC.data;
  if (!d) return null;
  if (SC.route === 'fleet') return { label: 'Whole fleet', cur: d.fleet.current, prev: d.fleet.previous };
  const r = d.routes.find((x) => x.route === SC.route);
  return r ? { label: 'Route ' + r.route + ' \u2014 ' + (rsRouteShortName(r) || r.name), cur: r.current, prev: r.previous } : null;
}

function scRender() {
  const d = SC.data;
  const s = scSelected();
  if (!d || !s) {
    document.getElementById('scSubtitle').textContent = 'No data available for this period';
    ['scHero', 'scProd', 'scServ', 'scWelf', 'scRoutes', 'scTypes'].forEach((id) => { document.getElementById(id).innerHTML = ''; });
    return;
  }
  const { cur, prev } = s;
  document.getElementById('scTitle').textContent = 'Service scorecard \u00b7 ' + s.label;
  document.getElementById('scSubtitle').textContent = scFmtDate(d.from) + ' \u2013 ' + scFmtDate(d.to) + ' ' + d.to.slice(0, 4)
    + ' (' + d.days + ' days) \u00b7 compared with ' + scFmtDate(d.previous.from) + ' \u2013 ' + scFmtDate(d.previous.to);

  // ---- headline cards ----
  const hero = [
    { label: 'Passengers per hour', def: SC_MEASURES.prod[2], key: 'pax_per_hour', sub: scNum(cur.productivity.passengers) + ' passengers over ' + scNum(cur.productivity.service_hours) + ' hours' },
    { label: 'Gaps on target', def: SC_MEASURES.serv[1], key: 'on_target', sub: cur.service.headway ? 'timetable every ' + scNum(cur.service.headway, 0) + ' min' : 'no timetable set' },
    { label: 'Incidents per 1,000 passengers', def: SC_MEASURES.welf[1], key: 'incidents_per_k', sub: scNum(cur.welfare.incidents) + ' incidents, ' + scNum(cur.welfare.serious) + ' serious' },
    { label: 'Urgent alerts answered in 5 min', def: SC_MEASURES.welf[4], key: 'urgent_in_sla', sub: cur.welfare.urgent ? scNum(cur.welfare.urgent) + ' urgent alerts' : 'no urgent alerts' },
  ];
  document.getElementById('scHero').innerHTML = hero.map((h) => {
    const v = scValue(cur, h.def); const pv = scValue(prev, h.def); const r = cur.rag[h.key];
    return '<div class="sc-card ' + (r || 'none') + '"><div class="sc-card-top"><span class="sc-card-l">' + h.label + '</span>' + scPill(r) + '</div>'
      + '<div class="sc-card-v">' + h.def.fmt(v) + '</div>'
      + '<div class="sc-card-s">' + scChange(v, pv, h.def) + ' <span>vs ' + h.def.fmt(pv) + ' before</span></div>'
      + '<div class="sc-card-s muted">' + escapeHtml(h.sub) + ' \u00b7 target ' + escapeHtml(scTargetText(h.key, d.targets, cur)) + '</div></div>';
  }).join('');

  // ---- measure tables ----
  const rows = (defs) => defs.map((def) => {
    const v = scValue(cur, def); const pv = scValue(prev, def);
    const rk = def.rag || (def.target ? def.k : null);
    const tgt = rk ? scTargetText(rk, d.targets, cur) : '';
    const valHtml = v == null && def.hint ? '<span class="sc-hint">' + def.hint + '</span>' : def.fmt(v);
    return '<tr><td class="sc-m">' + def.label + '</td>'
      + '<td class="sc-v"><div>' + valHtml + ' ' + scChange(v, pv, def) + '</div><div class="sc-was">was ' + def.fmt(pv) + '</div></td>'
      + '<td class="sc-s">' + (rk ? scPill(cur.rag[rk]) + '<div class="sc-t">' + escapeHtml(tgt) + '</div>' : '') + '</td></tr>';
  }).join('');
  document.getElementById('scProd').innerHTML = rows(SC_MEASURES.prod);
  document.getElementById('scServ').innerHTML = rows(SC_MEASURES.serv);
  document.getElementById('scWelf').innerHTML = rows(SC_MEASURES.welf);

  scRenderCost(d, s);

  // ---- incidents by type ----
  const types = cur.welfare.by_type || [];
  const maxN = Math.max(1, ...types.map((t) => t.n));
  document.getElementById('scTypesSub').textContent = types.length ? scNum(cur.welfare.incidents) + ' passenger welfare incidents \u00b7 ' + scNum(cur.welfare.open) + ' still open' : 'No passenger welfare incidents in this period';
  document.getElementById('scTypes').innerHTML = types.slice(0, 8).map((t) => {
    const label = SC_TYPE_LABELS[t.type] || t.type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    return '<div class="sc-type"><span class="sc-type-l">' + escapeHtml(label) + '</span><span class="sc-type-bar"><i style="width:' + Math.round((t.n / maxN) * 100) + '%"></i></span><span class="sc-type-n">' + scNum(t.n) + '</span></div>';
  }).join('') || '<div class="sp-empty">Nothing to show</div>';

  // ---- routes side by side ----
  const cell = (v, r) => '<td class="sc-rc ' + (r || '') + '">' + v + '</td>';
  document.getElementById('scRoutes').innerHTML = d.routes.map((r) => {
    const c = r.current;
    return '<tr' + (r.route === SC.route ? ' class="sel"' : '') + '><td class="sc-m">Route ' + escapeHtml(r.route) + '<div class="sc-sub">' + escapeHtml(rsRouteShortName(r) || r.name) + '</div></td>'
      + cell(scNum(c.productivity.passengers))
      + cell(scNum(c.productivity.pax_per_hour, 1), c.rag.pax_per_hour)
      + cell(SC_MEASURES.prod.find((x) => x.k === 'cost_per_pax').fmt(scValue(c, { g: 'derived', k: 'cost_per_pax' })))
      + cell(c.productivity.seat_use == null ? '--' : c.productivity.seat_use + '%', c.rag.seat_use)
      + cell(c.service.on_target == null ? '--' : c.service.on_target + '%', c.rag.on_target)
      + cell(c.service.wait == null ? '--' : scNum(c.service.wait, 1) + ' min', c.rag.wait_vs_timetable)
      + cell(c.service.peak_load == null ? '--' : c.service.peak_load + '%', c.rag.peak_load)
      + cell(scNum(c.welfare.incidents_per_k, 1), c.rag.incidents_per_k)
      + cell(c.welfare.response_median == null ? '--' : scNum(c.welfare.response_median, 1) + ' min', c.rag.response_median)
      + cell(c.welfare.urgent_in_sla == null ? '--' : c.welfare.urgent_in_sla + '%', c.rag.urgent_in_sla) + '</tr>';
  }).join('');
  document.getElementById('scRoutesPanel').hidden = d.routes.length < 2;

  scRenderTrend();
}

function scRenderTrend() {
  const d = SC.data;
  if (!d || !window.Chart) return;
  const k = SC.trend;
  const unit = d.trend[0] ? d.trend[0].unit : 'day';
  const labels = d.trend.map((b) => unit === 'month' ? new Date(b.from + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : unit === 'week' ? 'w/c ' + scFmtDate(b.from) : scFmtDate(b.from));
  const vals = d.trend.map((b) => b[k]);
  const meta = {
    pax_per_hour: { label: 'Passengers per hour', target: d.targets.pax_per_hour.green, suffix: '' },
    on_target: { label: 'Gaps on target (%)', target: d.targets.on_target.green, suffix: '%' },
    incidents_per_k: { label: 'Incidents per 1,000 passengers', target: null, suffix: '' },
    response_median: { label: 'Time to first response (min)', target: d.targets.response_median.green, suffix: ' min' },
  }[k];
  document.getElementById('scTrendSub').textContent = meta.label + ' by ' + unit + ', whole fleet' + (meta.target != null ? ' \u00b7 dashed line is the target' : '');
  const tick = { color: '#c9cad8', font: { size: 11, family: 'Inter', weight: '500' } };
  const ds = [
    { type: 'bar', label: 'Passengers', data: d.trend.map((b) => b.passengers), backgroundColor: 'rgba(255,255,255,0.10)', borderRadius: 4, yAxisID: 'y2', order: 2 },
    { type: 'line', label: meta.label, data: vals, borderColor: '#38bdf8', backgroundColor: '#38bdf8', borderWidth: 3, pointRadius: 4, tension: 0.3, cubicInterpolationMode: 'monotone', spanGaps: true, yAxisID: 'y', order: 0 },
  ];
  if (meta.target != null) ds.push({ type: 'line', label: 'Target', data: vals.map(() => meta.target), borderColor: 'rgba(74,222,128,0.9)', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, yAxisID: 'y', order: 1 });
  if (charts.scTrend) charts.scTrend.destroy();
  charts.scTrend = new Chart(document.getElementById('chartScTrend').getContext('2d'), {
    data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#dbdce6', font: { size: 12, family: 'Inter', weight: '500' }, usePointStyle: true, boxWidth: 10, padding: 14 } },
        tooltip: { ...tooltipDefaults(), callbacks: { label: (c) => ' ' + c.dataset.label + ': ' + (c.parsed.y == null ? '--' : scNum(c.parsed.y, c.dataset.yAxisID === 'y2' ? 0 : 1) + (c.dataset.yAxisID === 'y' ? meta.suffix : '')) } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { ...tick, maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: tick, suggestedMax: k === 'on_target' ? 100 : undefined },
        y2: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { ...tick, color: '#8b8ea5' }, title: { display: true, text: 'Passengers', color: '#8b8ea5', font: { size: 11, family: 'Inter' } } },
      },
    },
  });
}

function scExport() {
  const d = SC.data;
  if (!d) return;
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['Scope', 'Group', 'Measure', 'This period', 'Previous period', 'Target', 'Status'].map(q).join(',')];
  const scopes = [{ label: 'Whole fleet', cur: d.fleet.current, prev: d.fleet.previous }].concat(d.routes.map((r) => ({ label: 'Route ' + r.route, cur: r.current, prev: r.previous })));
  const groups = { prod: 'Productivity', serv: 'Service quality', welf: 'Passenger welfare' };
  for (const s of scopes) {
    for (const [gk, defs] of Object.entries(SC_MEASURES)) {
      for (const def of defs) {
        const rk = def.rag || (def.target ? def.k : null);
        const v = scValue(s.cur, def); const pv = scValue(s.prev, def);
        lines.push([s.label, groups[gk], def.label, v == null ? '' : round2(v), pv == null ? '' : round2(pv), rk ? scTargetText(rk, d.targets, s.cur) : '', rk ? (s.cur.rag[rk] || '') : ''].map(q).join(','));
      }
    }
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'scorecard_' + d.from + '_' + d.to + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
