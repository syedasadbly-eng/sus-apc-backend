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
  busCapacity: 55,
  // VS125 JSON payload field mappings (supports real VS125 + flat formats)
  vs125Fields: {
    // Running daily totals (from line_total_data — best source for KPI counts)
    totalIn: ['line_total_data.0.total.in_counted'],
    totalOut: ['line_total_data.0.total.out_counted'],
    totalCapacity: ['line_total_data.0.total.capacity_counted'],
    // Periodic window totals (line_periodic_data — per-minute summary)
    periodicIn: ['line_periodic_data.0.total.in'],
    periodicOut: ['line_periodic_data.0.total.out'],
    // Trigger events (line_trigger_data — individual door events, 0 or 1)
    triggerIn: ['line_trigger_data.0.total.in'],
    triggerOut: ['line_trigger_data.0.total.out'],
    // Legacy / flat format fallbacks
    lineIn: ['line.0.total.in', 'linePeriod.0.total.in', 'line1_in', 'total.in'],
    lineOut: ['line.0.total.out', 'linePeriod.0.total.out', 'line1_out', 'total.out'],
    capacity: ['capacity', 'lineTotal.capacity'],
    passersby: ['passersby'],
    // UR35 GPS format: data.latitude = "53.48076 N", data.longitude = "2.23743 W"
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
  // Gateway-to-bus mapping: [{topic: 'bus/001', label: 'SUS-001', route: '101'}, ...]
  gateways: [
    { topic: 'bus/001', label: 'SUS-001', route: '' },
  ],
};

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
const MANCHESTER_CENTER = [53.4808, -2.2426];
// Last known GPS position from UR35 (used as fallback when GPS has no fix, status 52)
const LAST_KNOWN_GPS = { lat: 53.507731, lng: -2.229141 };

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
    };
  }
  const dev = liveDeviceData[gatewayKey];

  // Update GPS — use valid coordinates, fall back to last known position
  if (lat != null && Number(lat) !== 0) dev.lat = Number(lat) || dev.lat;
  if (lng != null && Number(lng) !== 0) dev.lng = Number(lng) || dev.lng;
  // If device has never had GPS and we have a last-known position, use it
  if ((!dev.lat || dev.lat === 0) && LAST_KNOWN_GPS.lat) dev.lat = LAST_KNOWN_GPS.lat;
  if ((!dev.lng || dev.lng === 0) && LAST_KNOWN_GPS.lng) dev.lng = LAST_KNOWN_GPS.lng;
  if (speed != null) dev.speed = Number(speed) || 0;
  if (capacity != null) dev.capacity = Number(capacity) || CONFIG.busCapacity;
  if (passersby != null) dev.passersby = Number(passersby) || 0;

  // Update passenger counts based on message type
  if (hasDailyTotals) {
    // line_total_data: absolute running totals for the day — use directly as headline
    const dIn = Number(dailyIn);
    const dOut = Number(dailyOut);
    if (!isNaN(dIn) && dIn >= 0) dev.lineIn = dIn;
    if (!isNaN(dOut) && dOut >= 0) dev.lineOut = dOut;
    dev._hasDailyTotals = true;
    console.log('[MQTT] Updated daily totals:', { lineIn: dev.lineIn, lineOut: dev.lineOut });
  } else if (hasPeriodic && !dev._hasDailyTotals) {
    // line_periodic_data: totals within the periodic window — only if no daily totals yet
    const pIn = Number(periodicIn) || 0;
    const pOut = Number(periodicOut) || 0;
    dev.lineIn += pIn;
    dev.lineOut += pOut;
  } else if (hasTrigger) {
    // line_trigger_data: individual door events (0 or 1 per event)
    const tIn = Number(triggerIn) || 0;
    const tOut = Number(triggerOut) || 0;
    dev.triggerAccumIn += tIn;
    dev.triggerAccumOut += tOut;
    // If we also received daily totals, don't override headline numbers
    if (!dev._hasDailyTotals) {
      dev.lineIn += tIn;
      dev.lineOut += tOut;
    }
  } else if (hasLegacy) {
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

  if (hasTrigger) {
    const tIn = Number(triggerIn) || 0;
    const tOut = Number(triggerOut) || 0;
    if (tIn > 0) hourlyBuckets[hourKey].boardings += tIn;
    if (tOut > 0) hourlyBuckets[hourKey].alightings += tOut;
  } else if (hasDailyTotals) {
    // Daily totals: set the current hour bucket to the running daily total
    // This gives visual feedback on the hourly chart showing total activity
    hourlyBuckets[hourKey].boardings = Number(dailyIn) || 0;
    hourlyBuckets[hourKey].alightings = Number(dailyOut) || 0;
  } else if (hasPeriodic) {
    const pIn = Number(periodicIn) || 0;
    const pOut = Number(periodicOut) || 0;
    if (pIn > 0) hourlyBuckets[hourKey].boardings += pIn;
    if (pOut > 0) hourlyBuckets[hourKey].alightings += pOut;
  }

  // --- Append to live history ---
  liveHistory.push({ ts: now, lineIn: dev.lineIn, lineOut: dev.lineOut, gatewayKey, lat: dev.lat, lng: dev.lng });
  if (liveHistory.length > 10000) liveHistory = liveHistory.slice(-5000);

  // --- Append to live records for Data Explorer ---
  const gwConfig = configStore.gateways.find(g => g.topic === gatewayKey || g.label === gatewayKey);
  const busId = gwConfig ? gwConfig.label : gatewayKey;
  const routeId = gwConfig ? (gwConfig.route || '-') : '-';
  const passengers = Math.max(0, dev.lineIn - dev.lineOut);
  const occ = dev.capacity > 0 ? Math.min(100, Math.round((passengers / dev.capacity) * 100)) : 0;
  const evtIn = hasDailyTotals ? dev.lineIn : (hasTrigger ? (Number(triggerIn) || 0) : (hasPeriodic ? (Number(periodicIn) || 0) : 0));
  const evtOut = hasDailyTotals ? dev.lineOut : (hasTrigger ? (Number(triggerOut) || 0) : (hasPeriodic ? (Number(periodicOut) || 0) : 0));

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
  // Extract bus base from topic: bus/001/gps -> bus/001, bus/001/telemetry -> bus/001
  const topicParts = topic.split('/');
  if (topicParts.length >= 2 && topicParts[0] === 'bus') {
    const busBase = topicParts.slice(0, 2).join('/');
    // Check if this matches a configured gateway
    for (const gw of configStore.gateways) {
      if (gw.topic && busBase.includes(gw.topic)) return gw.topic;
    }
    return busBase; // e.g. "bus/001"
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
    const passengers = Math.max(0, data.lineIn - data.lineOut);
    const capacity = data.capacity || CONFIG.busCapacity;
    const occupancy = capacity > 0 ? Math.min(100, Math.round((passengers / capacity) * 100)) : 0;
    const ageSeconds = data.ts ? Math.round((Date.now() - data.ts) / 1000) : 999;

    liveBuses.push({
      id: gw.label || key,
      route: gw.route || '', routeName: gw.route || '', routeColor: color,
      lat: data.lat || 0, lng: data.lng || 0,
      passengers, capacity, occupancy,
      speed: data.speed || 0, status: ageSeconds < 300 ? 'active' : 'idle',
      sensorStatus: ageSeconds < 300 ? 'Online' : ageSeconds < 600 ? 'Degraded' : 'Offline',
      lastUpdate: formatAge(ageSeconds),
      lineIn: data.lineIn, lineOut: data.lineOut,
    });
  });

  BUS_POSITIONS = liveBuses;
}

function formatAge(s) {
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function updateLiveKPIs() {
  const active = BUS_POSITIONS.filter(b => b.status === 'active');
  const totalIn = BUS_POSITIONS.reduce((s,b) => s + (b.lineIn || 0), 0);
  const totalOut = BUS_POSITIONS.reduce((s,b) => s + (b.lineOut || 0), 0);
  const avgOcc = active.length > 0 ? Math.round(active.reduce((s,b) => s+b.occupancy, 0)/active.length) : 0;

  setKPI('kpi-total-passengers', totalIn > 0 ? totalIn.toLocaleString() : (mqttState.connected ? '0' : '—'));
  setKPI('kpi-active-buses', BUS_POSITIONS.length > 0 ? active.length : (mqttState.connected ? '0' : '—'));
  setKPI('kpi-avg-occupancy', BUS_POSITIONS.length > 0 ? avgOcc + '%' : (mqttState.connected ? '0%' : '—'));
  setKPI('kpi-alightings', totalOut > 0 ? totalOut.toLocaleString() : (mqttState.connected ? '0' : '—'));
  const sub = document.getElementById('kpi-fleet-sub');
  if (sub) sub.textContent = BUS_POSITIONS.length > 0 ? `of ${BUS_POSITIONS.length} total fleet` : (mqttState.connected ? 'Waiting for bus data' : 'Waiting for MQTT data');
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

function updateMapBusMarkers(map, mapKey) {
  if (mapMarkers[mapKey]) mapMarkers[mapKey].forEach(m => map.removeLayer(m));
  mapMarkers[mapKey] = [];

  BUS_POSITIONS.filter(b => (b.status === 'active' || b.status === 'idle') && b.lat !== 0 && b.lng !== 0).forEach(bus => {
    const occClass = bus.occupancy > 75 ? 'high-occupancy' : bus.occupancy > 50 ? 'medium-occupancy' : '';
    const shortId = bus.id.length > 3 ? bus.id.slice(-3) : bus.id;
    const icon = L.divIcon({
      className: '',
      html: `<div class="bus-marker ${occClass}">${shortId}</div>`,
      iconSize: [32, 32], iconAnchor: [16, 16],
    });
    const marker = L.marker([bus.lat, bus.lng], { icon })
      .addTo(map)
      .bindPopup(`
        <div class="bus-popup">
          <h4>${bus.id}${bus.route ? ' — Route ' + bus.route : ''}</h4>
          <div class="popup-grid">
            <span class="popup-label">Passengers</span><span class="popup-value">${bus.passengers}/${bus.capacity}</span>
            <span class="popup-label">Occupancy</span><span class="popup-value">${bus.occupancy}%</span>
            <span class="popup-label">In (Total)</span><span class="popup-value">${bus.lineIn || 0}</span>
            <span class="popup-label">Out (Total)</span><span class="popup-value">${bus.lineOut || 0}</span>
            <span class="popup-label">Sensor</span><span class="popup-value">${bus.sensorStatus}</span>
            <span class="popup-label">Last Update</span><span class="popup-value">${bus.lastUpdate}</span>
          </div>
        </div>
      `);
    mapMarkers[mapKey].push(marker);
  });
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

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pwd = document.getElementById('loginPassword').value;
    if (pwd === configStore.dashPassword) {
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
        <input type="text" class="gw-label" value="${gw.label || ''}" placeholder="e.g. SUS-001">
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
  probeBackend();

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
    'fleet': ['Fleet Status', 'Fleet / Management'],
    'reports': ['Reports', 'Output / Reports'],
    'data-table': ['Data Explorer', 'Output / Raw Data'],
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
      case 'fleet': initFleet(); break;
      case 'reports': initReports(); break;
      case 'data-table': initDataTable(); break;
    }
  } else {
    // Refresh data-driven views when navigating back
    switch (view) {
      case 'ridership': loadRidershipData(); break;
      case 'routes': loadRoutesData(); break;
      case 'data-table': loadDataFromAPI(); break;
      case 'live-map': if (maps.liveMap) setTimeout(() => maps.liveMap.invalidateSize(), 100); break;
    }
  }
}


// ============================================
// CLOCK
// ============================================

function initClock() {
  function update() { document.getElementById('headerTime').textContent = new Date().toLocaleTimeString('en-GB'); }
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
  initOverviewMap(); renderFleetList(); initHourlyFlowChart(); initTopRoutesChart(); initPeriodTabs();
}

function initOverviewMap() {
  if (maps.overview) return;
  const map = L.map('overviewMap', { zoomControl: true, attributionControl: false }).setView(MANCHESTER_CENTER, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
  updateMapBusMarkers(map, 'overview');
  maps.overview = map;
  setTimeout(() => map.invalidateSize(), 100);
  const refreshBtn = document.getElementById('mapRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    updateMapBusMarkers(maps.overview, 'overview');
    renderFleetList();
  });
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
      <div class="fleet-info"><div class="fleet-name">${bus.id}</div><div class="fleet-route">${bus.route ? 'Route '+bus.route+' — '+bus.routeName : ''}</div></div>
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
        { label: 'Boardings', data: [...zeros], backgroundColor: 'rgba(59, 130, 246, 0.8)', borderRadius: 4, barPercentage: 0.7 },
        { label: 'Alightings', data: [...zeros], backgroundColor: 'rgba(16, 185, 129, 0.8)', borderRadius: 4, barPercentage: 0.7 },
      ],
    },
    options: chartDefaults('Passengers'),
  });
  // Load data immediately and auto-refresh every 30s
  refreshHourlyFlowChart();
  setInterval(() => refreshHourlyFlowChart(), 30000);
}

async function refreshHourlyFlowChart() {
  if (!charts.hourlyFlow) return;
  const today = new Date().toISOString().slice(0, 10);
  const apiData = await apiFetch('/api/hourly', { date: today });

  // Always use full 24-hour range: 00:00 through 23:00
  const labels = Array.from({length: 24}, (_, i) => `${String(i).padStart(2, '0')}:00`);
  let boardings, alightings;

  if (apiData && apiData.hourly && apiData.hourly.length > 0) {
    const hourMap = {};
    apiData.hourly.forEach(row => { hourMap[row.hour] = row; });
    boardings = Array.from({length: 24}, (_, h) => hourMap[h]?.boardings || 0);
    alightings = Array.from({length: 24}, (_, h) => hourMap[h]?.alightings || 0);
  } else {
    // Fallback to live MQTT hourly buckets
    boardings = labels.map(h => hourlyBuckets[h]?.boardings || 0);
    alightings = labels.map(h => hourlyBuckets[h]?.alightings || 0);
  }

  charts.hourlyFlow.data.labels = labels;
  charts.hourlyFlow.data.datasets[0].data = boardings;
  charts.hourlyFlow.data.datasets[1].data = alightings;
  charts.hourlyFlow.update('active');
}

function initTopRoutesChart() {
  const ctx = document.getElementById('chartTopRoutes').getContext('2d');
  // Populated from live data; starts empty
  const busLabels = BUS_POSITIONS.map(b => b.id);
  const busData = BUS_POSITIONS.map(b => b.lineIn || b.passengers || 0);
  const busColors = BUS_POSITIONS.map((b, i) => (b.routeColor || ROUTE_COLORS[i % ROUTE_COLORS.length]) + 'cc');
  charts.topRoutes = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: busLabels.length > 0 ? busLabels : ['No data yet'],
      datasets: [{ label: 'Passengers', data: busData.length > 0 ? busData : [0], backgroundColor: busColors.length > 0 ? busColors : ['#3b82f6cc'], borderRadius: 4 }],
    },
    options: { ...chartDefaults('Passengers'), indexAxis: 'y' },
  });
  // Auto-refresh every 30s from live data
  setInterval(() => {
    if (charts.topRoutes) {
      const labels = BUS_POSITIONS.map(b => b.id);
      const data = BUS_POSITIONS.map(b => b.lineIn || b.passengers || 0);
      const colors = BUS_POSITIONS.map((b, i) => (b.routeColor || ROUTE_COLORS[i % ROUTE_COLORS.length]) + 'cc');
      if (labels.length > 0) {
        charts.topRoutes.data.labels = labels;
        charts.topRoutes.data.datasets[0].data = data;
        charts.topRoutes.data.datasets[0].backgroundColor = colors;
        charts.topRoutes.update('active');
      }
    }
  }, 30000);
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

function updateHourlyFlowChart() {
  // Refresh from backend API (or MQTT fallback)
  refreshHourlyFlowChart();
}


// ============================================
// LIVE MAP
// ============================================

function initLiveMap() {
  if (maps.liveMap) return;
  const map = L.map('liveMapFull', { zoomControl: true, attributionControl: false }).setView(MANCHESTER_CENTER, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
  updateMapBusMarkers(map, 'liveMap');
  maps.liveMap = map;
  setTimeout(() => map.invalidateSize(), 100);
  document.getElementById('centerMapBtn').addEventListener('click', () => {
    const active = BUS_POSITIONS.filter(b => b.lat !== 0 && b.lng !== 0);
    if (active.length > 0) { map.fitBounds(L.latLngBounds(active.map(b => [b.lat, b.lng])), { padding: [50, 50] }); return; }
    map.setView(MANCHESTER_CENTER, 12);
  });
}


// ============================================
// RIDERSHIP ANALYTICS (Backend-powered)
// ============================================

function initRidership() {
  // Create empty charts — will be populated from API
  const trendCtx = document.getElementById('chartRidershipTrend').getContext('2d');
  charts.ridershipTrend = new Chart(trendCtx, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Boardings', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 4, pointHoverRadius: 6 }] },
    options: chartDefaults('Passengers'),
  });
  const baCtx = document.getElementById('chartBoardAlightRidership').getContext('2d');
  charts.boardAlight = new Chart(baCtx, {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Boardings', data: [], backgroundColor: 'rgba(59,130,246,0.8)', borderRadius: 4 },
      { label: 'Alightings', data: [], backgroundColor: 'rgba(16,185,129,0.8)', borderRadius: 4 },
    ]},
    options: chartDefaults('Passengers'),
  });
  const dowCtx = document.getElementById('chartDayOfWeek').getContext('2d');
  charts.dayOfWeek = new Chart(dowCtx, {
    type: 'bar',
    data: { labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], datasets: [{ label: 'Avg Passengers', data: [0,0,0,0,0,0,0], backgroundColor: ['#3b82f6cc','#3b82f6cc','#3b82f6cc','#3b82f6cc','#3b82f6cc','#f59e0bcc','#f59e0bcc'], borderRadius: 6 }] },
    options: chartDefaults('Avg Passengers'),
  });
  const occCtx = document.getElementById('chartOccupancyDist').getContext('2d');
  charts.occDist = new Chart(occCtx, {
    type: 'doughnut',
    data: { labels: ['0-25%','26-50%','51-75%','76-100%'], datasets: [{ data: [1,0,0,0], backgroundColor: ['#10b981','#3b82f6','#f59e0b','#ef4444'], borderWidth: 0, spacing: 2 }] },
    options: { responsive: true, maintainAspectRatio: true, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { color:'#8b8ea5', font:{size:11,family:'Inter'}, padding:16, usePointStyle:true } }, tooltip: {...tooltipDefaults()} } },
  });

  // Wire up filter controls
  const periodSel = document.getElementById('ridershipPeriod');
  const routeSel = document.getElementById('ridershipRoute');
  if (periodSel) periodSel.addEventListener('change', () => loadRidershipData());
  if (routeSel) routeSel.addEventListener('change', () => loadRidershipData());

  // Wire up view tabs (daily/weekly/monthly)
  document.querySelectorAll('#ridershipViewTabs .period-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#ridershipViewTabs .period-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      loadRidershipData();
    });
  });

  // Ensure backend probe completes, then populate bus dropdown and load data
  probeBackend().then(() => populateBusDropdowns()).then(() => loadRidershipData());
}

async function populateBusDropdowns() {
  const data = await apiFetch('/api/buses');
  let busList = (data && data.buses) ? data.buses : [];
  // Fallback: derive bus list from live MQTT data
  if (busList.length === 0 && configStore.gateways.length > 0) {
    busList = configStore.gateways.map(gw => gw.label || gw.topic);
  }
  if (busList.length === 0) return;
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
  const from = fromDate.toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);

  // Fetch summary KPIs from API; fall back to live MQTT data
  const summary = await apiFetch('/api/summary', { period: from });
  if (summary && summary.totals) {
    const t = summary.totals;
    setKPI('ridership-kpi-total', t.total_boardings > 0 ? t.total_boardings.toLocaleString() : '0');
    const avgPerDay = t.days_count > 0 ? Math.round(t.total_boardings / t.days_count) : 0;
    setKPI('ridership-kpi-avg', avgPerDay > 0 ? avgPerDay.toLocaleString() : '0');
    setKPI('ridership-kpi-buses', t.bus_count > 0 ? t.bus_count : '0');
    const ph = summary.peakHour;
    if (ph && ph.total > 0) {
      setKPI('ridership-kpi-peak', `${String(ph.hour).padStart(2,'0')}:00`);
      const peakSub = document.getElementById('ridership-kpi-peak-sub');
      if (peakSub) peakSub.textContent = `${ph.total} boardings`;
    } else {
      setKPI('ridership-kpi-peak', '\u2014');
    }
    const totalSub = document.getElementById('ridership-kpi-total-sub');
    if (totalSub) totalSub.textContent = `${from} to ${to}`;
    const avgSub = document.getElementById('ridership-kpi-avg-sub');
    if (avgSub) avgSub.textContent = `over ${t.days_count} day${t.days_count !== 1 ? 's' : ''}`;
  } else {
    // --- MQTT live fallback for KPIs ---
    updateRidershipKPIsFromLive(from, to);
  }

  // Fetch daily data for trend charts from API; fall back to live data
  const dailyData = await apiFetch('/api/daily', { from, to, bus_id: busId !== 'all' ? busId : null });
  if (dailyData && dailyData.daily) {
    const rows = dailyData.daily;
    renderRidershipCharts(rows, viewMode, fromDate, now);
  } else {
    // --- MQTT live fallback for charts ---
    renderRidershipChartsFromLive(viewMode, fromDate, now);
  }

  // Occupancy distribution from live data
  const bands = computeOccupancyBands();
  charts.occDist.data.datasets[0].data = bands;
  charts.occDist.update('active');
}

/** Populate ridership KPIs from live MQTT state */
function updateRidershipKPIsFromLive(from, to) {
  const totalIn = BUS_POSITIONS.reduce((s, b) => s + (b.lineIn || 0), 0);
  const totalOut = BUS_POSITIONS.reduce((s, b) => s + (b.lineOut || 0), 0);
  const activeBuses = BUS_POSITIONS.filter(b => b.status === 'active').length;
  setKPI('ridership-kpi-total', totalIn > 0 ? totalIn.toLocaleString() : (mqttState.connected ? '0' : '\u2014'));
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

/** Render ridership trend charts from API daily rows */
function renderRidershipCharts(rows, viewMode, fromDate, now) {
  if (viewMode === 'daily') {
    const allDates = [];
    const d = new Date(fromDate);
    while (d <= now) {
      allDates.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    const dataMap = {};
    rows.forEach(r => { dataMap[r.date] = r; });
    const labels = allDates.map(dt => {
      const dd = new Date(dt + 'T00:00:00');
      return dd.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    });
    const boardings = allDates.map(dt => dataMap[dt] ? dataMap[dt].total_in : 0);
    const alightings = allDates.map(dt => dataMap[dt] ? dataMap[dt].total_out : 0);
    charts.ridershipTrend.data.labels = labels;
    charts.ridershipTrend.data.datasets[0].data = boardings;
    charts.ridershipTrend.update('active');
    charts.boardAlight.data.labels = labels;
    charts.boardAlight.data.datasets[0].data = boardings;
    charts.boardAlight.data.datasets[1].data = alightings;
    charts.boardAlight.update('active');
  } else if (viewMode === 'weekly') {
    const weekMap = {};
    rows.forEach(r => {
      const d = new Date(r.date + 'T00:00:00');
      const week = getISOWeek(d);
      const key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
      if (!weekMap[key]) weekMap[key] = { boardings: 0, alightings: 0 };
      weekMap[key].boardings += r.total_in;
      weekMap[key].alightings += r.total_out;
    });
    const weeks = Object.keys(weekMap).sort();
    charts.ridershipTrend.data.labels = weeks;
    charts.ridershipTrend.data.datasets[0].data = weeks.map(w => weekMap[w].boardings);
    charts.ridershipTrend.update('active');
    charts.boardAlight.data.labels = weeks;
    charts.boardAlight.data.datasets[0].data = weeks.map(w => weekMap[w].boardings);
    charts.boardAlight.data.datasets[1].data = weeks.map(w => weekMap[w].alightings);
    charts.boardAlight.update('active');
  } else if (viewMode === 'monthly') {
    const monthMap = {};
    rows.forEach(r => {
      const key = r.date.slice(0, 7);
      if (!monthMap[key]) monthMap[key] = { boardings: 0, alightings: 0 };
      monthMap[key].boardings += r.total_in;
      monthMap[key].alightings += r.total_out;
    });
    const months = Object.keys(monthMap).sort();
    const monthLabels = months.map(m => {
      const [y, mo] = m.split('-');
      return new Date(y, mo - 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    });
    charts.ridershipTrend.data.labels = monthLabels;
    charts.ridershipTrend.data.datasets[0].data = months.map(m => monthMap[m].boardings);
    charts.ridershipTrend.update('active');
    charts.boardAlight.data.labels = monthLabels;
    charts.boardAlight.data.datasets[0].data = months.map(m => monthMap[m].boardings);
    charts.boardAlight.data.datasets[1].data = months.map(m => monthMap[m].alightings);
    charts.boardAlight.update('active');
  }
  // Day of week chart
  const dowTotals = [0,0,0,0,0,0,0];
  const dowCounts = [0,0,0,0,0,0,0];
  rows.forEach(r => {
    const dow = new Date(r.date + 'T00:00:00').getDay();
    const idx = dow === 0 ? 6 : dow - 1;
    dowTotals[idx] += r.total_in;
    dowCounts[idx]++;
  });
  const dowAvg = dowTotals.map((t, i) => dowCounts[i] > 0 ? Math.round(t / dowCounts[i]) : 0);
  charts.dayOfWeek.data.datasets[0].data = dowAvg;
  charts.dayOfWeek.update('active');
}

/** Render ridership trend charts from live MQTT hourly buckets */
function renderRidershipChartsFromLive(viewMode, fromDate, now) {
  void viewMode; void fromDate;
  // Use hourly buckets for trend (today only)
  const hours = Array.from({length: 24}, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const boardings = hours.map(h => hourlyBuckets[h] ? hourlyBuckets[h].boardings : 0);
  const alightings = hours.map(h => hourlyBuckets[h] ? hourlyBuckets[h].alightings : 0);
  const todayLabel = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  // Trend chart — show hourly breakdown for today
  charts.ridershipTrend.data.labels = hours;
  charts.ridershipTrend.data.datasets[0].data = boardings;
  charts.ridershipTrend.update('active');

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

function computeOccupancyBands() {
  const bands = [0,0,0,0]; // 0-25, 26-50, 51-75, 76-100
  BUS_POSITIONS.forEach(b => {
    if (b.occupancy <= 25) bands[0]++;
    else if (b.occupancy <= 50) bands[1]++;
    else if (b.occupancy <= 75) bands[2]++;
    else bands[3]++;
  });
  return bands.some(v => v > 0) ? bands : [1,0,0,0];
}

function updateRidershipKPIs() {
  // Called from live MQTT updates — refresh KPIs + charts from live data
  if (currentView !== 'ridership') return;
  // Refresh KPIs from live data if backend is not available
  if (!backendAvailable) {
    updateRidershipKPIsFromLive(new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
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
// ROUTES & STOPS (Backend + Live hybrid)
// ============================================

function initRoutes() {
  const stopCtx = document.getElementById('chartStopBoardings').getContext('2d');
  charts.stopBoardings = new Chart(stopCtx, {
    type: 'bar',
    data: { labels: ['Loading...'], datasets: [
      { label: 'Boardings', data: [0], backgroundColor: 'rgba(59,130,246,0.8)', borderRadius: 4 },
      { label: 'Alightings', data: [0], backgroundColor: 'rgba(239,68,68,0.6)', borderRadius: 4 },
    ]},
    options: chartDefaults('Count'),
  });
  const loadCtx = document.getElementById('chartLoadProfile').getContext('2d');
  charts.loadProfile = new Chart(loadCtx, {
    type: 'line',
    data: { labels: ['Loading...'], datasets: [
      { label: 'Passengers Onboard', data: [0], borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.15)', fill: true, tension: 0.4, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#8b5cf6' },
      { label: 'Capacity', data: [CONFIG.busCapacity], borderColor: '#ef4444', borderDash: [8,4], pointRadius: 0, borderWidth: 1.5, fill: false },
    ]},
    options: chartDefaults('Passengers'),
  });
  initHeatmapChart();
  loadRoutesData();
}

async function loadRoutesData() {
  const today = new Date().toISOString().slice(0, 10);

  // Fetch today's daily data per bus
  const dailyData = await apiFetch('/api/daily', { from: today, to: today });
  if (dailyData && dailyData.daily && dailyData.daily.length > 0) {
    const rows = dailyData.daily;
    const busLabels = rows.map(r => r.bus_id);
    const busIn = rows.map(r => r.total_in);
    const busOut = rows.map(r => r.total_out);
    const busOnboard = rows.map(r => Math.max(0, r.total_in - r.total_out));

    charts.stopBoardings.data.labels = busLabels;
    charts.stopBoardings.data.datasets[0].data = busIn;
    charts.stopBoardings.data.datasets[1].data = busOut;
    charts.stopBoardings.update('active');

    charts.loadProfile.data.labels = busLabels;
    charts.loadProfile.data.datasets[0].data = busOnboard;
    charts.loadProfile.data.datasets[1].data = busLabels.map(() => CONFIG.busCapacity);
    charts.loadProfile.update('active');
  } else if (BUS_POSITIONS.length > 0) {
    // Fallback to live data
    const busLabels = BUS_POSITIONS.map(b => b.id);
    charts.stopBoardings.data.labels = busLabels;
    charts.stopBoardings.data.datasets[0].data = BUS_POSITIONS.map(b => b.lineIn || 0);
    charts.stopBoardings.data.datasets[1].data = BUS_POSITIONS.map(b => b.lineOut || 0);
    charts.stopBoardings.update('active');
    charts.loadProfile.data.labels = busLabels;
    charts.loadProfile.data.datasets[0].data = BUS_POSITIONS.map(b => Math.max(0, (b.lineIn||0) - (b.lineOut||0)));
    charts.loadProfile.data.datasets[1].data = busLabels.map(() => CONFIG.busCapacity);
    charts.loadProfile.update('active');
  }

  // Fetch today's hourly data for heatmap
  const hourlyData = await apiFetch('/api/hourly', { date: today });
  if (hourlyData && hourlyData.hourly && hourlyData.hourly.length > 0) {
    const hours = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);
    const hourMap = {};
    hourlyData.hourly.forEach(h => { hourMap[h.hour] = (hourMap[h.hour] || 0) + h.boardings; });
    const hourData = hours.map((_, i) => hourMap[i] || 0);
    charts.heatmap.data.labels = hours;
    charts.heatmap.data.datasets[0].data = hourData;
    charts.heatmap.update('active');
  } else {
    // Fallback: use live hourlyBuckets from MQTT
    const hours = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);
    const hourData = hours.map(h => hourlyBuckets[h] ? hourlyBuckets[h].boardings : 0);
    charts.heatmap.data.labels = hours;
    charts.heatmap.data.datasets[0].data = hourData;
    charts.heatmap.update('active');
  }
}

function initHeatmapChart() {
  const hours = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);
  const ctx = document.getElementById('chartHeatmap').getContext('2d');
  charts.heatmap = new Chart(ctx, {
    type: 'bar', data: { labels: hours, datasets: [{
      label: 'Boardings', data: hours.map(() => 0),
      backgroundColor: 'rgba(59,130,246,0.7)', borderRadius: 2, barPercentage: 0.9, categoryPercentage: 0.8,
    }] },
    options: { ...chartDefaults('Boardings'),
      plugins: { legend: { position:'right', labels:{color:'#8b8ea5',font:{size:10,family:'Inter'},padding:8,boxWidth:12,usePointStyle:true} }, tooltip:{...tooltipDefaults()} },
      scales: { x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8b8ea5',font:{size:10}}}, y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8b8ea5',font:{size:10}}} },
    },
  });
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
      const today = new Date().toISOString().slice(0, 10);
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
  if (subEl) subEl.textContent = BUS_POSITIONS.length > 0 ? `${BUS_POSITIONS.length} vehicles \u2014 live via MQTT` : 'Waiting for MQTT data';
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

function initReports() {
  document.querySelectorAll('.report-card').forEach(card => {
    card.addEventListener('click', () => {
      const t = card.querySelector('.report-name');
      if (t) document.getElementById('reportType').value = t.textContent;
      card.style.borderColor = 'var(--color-primary)';
      setTimeout(() => { card.style.borderColor = ''; }, 1000);
    });
  });
  document.getElementById('generateReport').addEventListener('click', () => {
    const format = document.getElementById('reportFormat').value;
    const type = document.getElementById('reportType').value;
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    if (format === 'pdf') exportToPDF(type, from, to);
    else if (format === 'excel') exportToExcel(type, from, to);
    else exportToCSV(type, from, to);
  });
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
    dateInput.value = new Date().toISOString().slice(0, 10);
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
      const today = new Date().toISOString().slice(0,10);
      const f = item.dataset.format;
      if (f==='pdf') exportToPDF('Dashboard Summary',today,today);
      else if (f==='excel') exportToExcel('Dashboard Data',today,today);
      else exportToCSV('Dashboard Data',today,today);
      document.querySelectorAll('.export-menu').forEach(m => m.classList.remove('open'));
    });
  });
}

async function exportToPDF(title, from, to) {
  const { jsPDF } = window.jspdf; const doc = new jsPDF();
  doc.setFillColor(15,17,23); doc.rect(0,0,210,40,'F');
  doc.setTextColor(255,255,255); doc.setFontSize(18); doc.text('Smart Urban Sensing Ltd',14,18);
  doc.setFontSize(10); doc.text(`${title} — ${from} to ${to}`,14,28);
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`,14,34);

  // Fetch summary from backend, with live MQTT fallback
  const summary = await apiFetch('/api/summary', { period: from });
  const totals = summary?.totals || {};
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

  // Fetch daily breakdown
  const daily = await apiFetch('/api/daily', { from, to });
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

  const pc = doc.internal.getNumberOfPages();
  for (let i=1;i<=pc;i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(150); doc.text('Smart Urban Sensing Ltd — APC',14,287); doc.text(`Page ${i}/${pc}`,180,287); }
  doc.save(`SUS_Report_${from}_${to}.pdf`);
}

async function exportToExcel(title, from, to) {
  const wb = XLSX.utils.book_new();

  // Summary sheet — backend or live MQTT fallback
  const summary = await apiFetch('/api/summary', { period: from });
  const totals = summary?.totals || {};
  const totalBoardings = totals.total_boardings || BUS_POSITIONS.reduce((s,b)=>s+(b.lineIn||0),0);
  const totalAlightings = totals.total_alightings || BUS_POSITIONS.reduce((s,b)=>s+(b.lineOut||0),0);
  const busCount = totals.bus_count || BUS_POSITIONS.filter(b=>b.status==='active').length;
  const active = BUS_POSITIONS.filter(b=>b.status==='active');
  const avgOcc = totals.avg_occupancy || (active.length > 0 ? Math.round(active.reduce((s,b)=>s+b.occupancy,0)/active.length) : 0);
  const dataSource = summary ? 'Database + Live MQTT' : 'Live MQTT only';

  const ws1 = XLSX.utils.aoa_to_sheet([
    ['Smart Urban Sensing Ltd — APC Report'],[`${title} — ${from} to ${to}`],
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
  const daily = await apiFetch('/api/daily', { from, to });
  if (daily && daily.daily) {
    const ws2 = XLSX.utils.aoa_to_sheet([
      ['Date','Bus ID','Boardings','Alightings','Peak Onboard','Peak Hour','First Seen','Last Seen','Avg Occupancy %'],
      ...daily.daily.map(r=>[r.date, r.bus_id, r.total_in, r.total_out, r.peak_onboard, r.peak_hour, r.first_seen, r.last_seen, r.avg_occupancy.toFixed(1)])
    ]);
    XLSX.utils.book_append_sheet(wb,ws2,'Daily');
  }

  // Raw records sheet — API or live MQTT fallback
  const apiRecords = await apiFetch('/api/records', { date: from === to ? from : undefined, limit: 10000 });
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

async function exportToCSV(title, from, to) {
  void title;
  // Fetch records from API, with live MQTT fallback
  const data = await apiFetch('/api/records', { date: from === to ? from : undefined, limit: 50000 });
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
// CHART DEFAULTS
// ============================================

function chartDefaults(yLabel) {
  return {
    responsive:true, maintainAspectRatio:true, interaction:{mode:'index',intersect:false},
    animation:{duration:800,easing:'easeOutQuart'},
    plugins:{ legend:{labels:{color:'#8b8ea5',font:{size:11,family:'Inter'},padding:16,usePointStyle:true}}, tooltip:{...tooltipDefaults()} },
    scales:{ x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8b8ea5',font:{size:10}}}, y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8b8ea5',font:{size:10}},title:{display:true,text:yLabel,color:'#5a5d76',font:{size:10}}} },
  };
}

function tooltipDefaults() {
  return { backgroundColor:'#1c1e2e', titleColor:'#e4e5ed', bodyColor:'#8b8ea5', borderColor:'#323554', borderWidth:1, padding:12, cornerRadius:8,
    titleFont:{family:'Inter',size:12,weight:600}, bodyFont:{family:'Inter',size:11}, displayColors:true, boxPadding:4 };
}
