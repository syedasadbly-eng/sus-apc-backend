/* ============================================
   SMART URBAN SENSING — APC Backend Server
   MQTT Subscriber → SQLite → REST API
   ============================================ */

const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const mqtt = require('mqtt');

// ============================================
// CONFIGURATION
// ============================================

const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'apc_data.db');
const BUS_CAPACITY = Number(process.env.BUS_CAPACITY) || 55;

const MQTT_CONFIG = {
  host: process.env.MQTT_HOST || '492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud',
  port: Number(process.env.MQTT_PORT) || 8883,
  username: process.env.MQTT_USER || 'sus-dashboard',
  password: process.env.MQTT_PASS || 'SuS-Mqtt#2026!Secure',
  topic: process.env.MQTT_TOPIC || 'bus/#',
};

// Gateway / bus mapping — multiple topics can map to the same bus (multi-door)
// bus/001 = door 1, bus/002 = door 2, both on SUS-001
const GATEWAYS = [
  { topic: 'bus/001', label: 'SUS-001', route: '' },
  { topic: 'bus/002', label: 'SUS-001', route: '' },
];

// Last-known GPS fallback (UR35 indoors, status 52)
const LAST_KNOWN_GPS = { lat: 53.507731, lng: -2.229141 };

// VS125 field extraction paths (same as dashboard)
const FIELD_PATHS = {
  totalIn:      ['line_total_data.0.total.in_counted'],
  totalOut:     ['line_total_data.0.total.out_counted'],
  periodicIn:   ['line_periodic_data.0.total.in'],
  periodicOut:  ['line_periodic_data.0.total.out'],
  triggerIn:    ['line_trigger_data.0.total.in'],
  triggerOut:   ['line_trigger_data.0.total.out'],
  lineIn:       ['line.0.total.in', 'linePeriod.0.total.in', 'line1_in', 'total.in'],
  lineOut:      ['line.0.total.out', 'linePeriod.0.total.out', 'line1_out', 'total.out'],
  latitude:     ['data.latitude', 'latitude', 'gps.latitude'],
  longitude:    ['data.longitude', 'longitude', 'gps.longtitude', 'gps.longitude'],
  speed:        ['data.speed', 'speed', 'gps.speed'],
  gpsStatus:    ['data.status', 'status'],
};


// ============================================
// DATABASE SETUP
// ============================================

const db = new Database(DB_PATH, { verbose: process.env.DB_VERBOSE ? console.log : undefined });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  -- Individual counting records (one per MQTT counting message)
  CREATE TABLE IF NOT EXISTS records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT    NOT NULL,                  -- ISO 8601 UTC
    date        TEXT    NOT NULL,                  -- YYYY-MM-DD for fast date queries
    hour        INTEGER NOT NULL DEFAULT 0,        -- 0-23 for hourly aggregation
    bus_id      TEXT    NOT NULL DEFAULT '',
    route       TEXT    NOT NULL DEFAULT '',
    stop        TEXT    NOT NULL DEFAULT '-',
    boardings   INTEGER NOT NULL DEFAULT 0,        -- cumulative in_counted (daily total)
    alightings  INTEGER NOT NULL DEFAULT 0,        -- cumulative out_counted (daily total)
    evt_in      INTEGER NOT NULL DEFAULT 0,        -- per-event in (trigger/periodic)
    evt_out     INTEGER NOT NULL DEFAULT 0,        -- per-event out (trigger/periodic)
    onboard     INTEGER NOT NULL DEFAULT 0,
    occupancy   REAL    NOT NULL DEFAULT 0,
    lat         REAL    NOT NULL DEFAULT 0,
    lng         REAL    NOT NULL DEFAULT 0,
    speed       REAL    NOT NULL DEFAULT 0,
    msg_type    TEXT    NOT NULL DEFAULT 'unknown'  -- daily_total, periodic, trigger, legacy
  );

  -- Hourly summary buckets (aggregated per bus per hour per day)
  CREATE TABLE IF NOT EXISTS hourly_summary (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    hour        INTEGER NOT NULL,
    bus_id      TEXT    NOT NULL,
    boardings   INTEGER NOT NULL DEFAULT 0,
    alightings  INTEGER NOT NULL DEFAULT 0,
    max_onboard INTEGER NOT NULL DEFAULT 0,
    msg_count   INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date, hour, bus_id)
  );

  -- Daily snapshot (end-of-day totals per bus)
  CREATE TABLE IF NOT EXISTS daily_summary (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    date           TEXT    NOT NULL,
    bus_id         TEXT    NOT NULL,
    total_in       INTEGER NOT NULL DEFAULT 0,
    total_out      INTEGER NOT NULL DEFAULT 0,
    peak_onboard   INTEGER NOT NULL DEFAULT 0,
    peak_hour      INTEGER NOT NULL DEFAULT 0,
    first_seen     TEXT,
    last_seen      TEXT,
    avg_occupancy  REAL    NOT NULL DEFAULT 0,
    UNIQUE(date, bus_id)
  );

  -- Indexes for fast queries
  CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
  CREATE INDEX IF NOT EXISTS idx_records_bus_date ON records(bus_id, date);
  CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records(timestamp);
  CREATE INDEX IF NOT EXISTS idx_hourly_date ON hourly_summary(date);
  CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_summary(date);
`);

// Prepared statements for fast inserts
const insertRecord = db.prepare(`
  INSERT INTO records (timestamp, date, hour, bus_id, route, stop, boardings, alightings, evt_in, evt_out, onboard, occupancy, lat, lng, speed, msg_type)
  VALUES (@timestamp, @date, @hour, @bus_id, @route, @stop, @boardings, @alightings, @evt_in, @evt_out, @onboard, @occupancy, @lat, @lng, @speed, @msg_type)
`);

const upsertHourlySummary = db.prepare(`
  INSERT INTO hourly_summary (date, hour, bus_id, boardings, alightings, max_onboard, msg_count)
  VALUES (@date, @hour, @bus_id, @boardings, @alightings, @max_onboard, 1)
  ON CONFLICT(date, hour, bus_id) DO UPDATE SET
    boardings   = @boardings,
    alightings  = @alightings,
    max_onboard = MAX(hourly_summary.max_onboard, @max_onboard),
    msg_count   = hourly_summary.msg_count + 1
`);

const upsertDailySummary = db.prepare(`
  INSERT INTO daily_summary (date, bus_id, total_in, total_out, peak_onboard, peak_hour, first_seen, last_seen, avg_occupancy)
  VALUES (@date, @bus_id, @total_in, @total_out, @peak_onboard, @peak_hour, @first_seen, @last_seen, @avg_occupancy)
  ON CONFLICT(date, bus_id) DO UPDATE SET
    total_in      = @total_in,
    total_out     = @total_out,
    peak_onboard  = MAX(daily_summary.peak_onboard, @peak_onboard),
    peak_hour     = CASE WHEN @peak_onboard > daily_summary.peak_onboard THEN @peak_hour ELSE daily_summary.peak_hour END,
    last_seen     = @last_seen,
    avg_occupancy = @avg_occupancy
`);


// ============================================
// IN-MEMORY LIVE STATE
// ============================================

const liveDevices = {};  // { busId: { totalIn, totalOut, onboard, lat, lng, speed, ts } }
let mqttClient = null;
let mqttStats = { connected: false, messageCount: 0, lastMessage: null };

// Per-bus daily cumulative boardings/alightings (sum of all periodic deltas)
// Key: busId (e.g. 'SUS-001'), Value: { dayIn, dayOut, date }
const busDayTotals = {};


// ============================================
// FIELD EXTRACTION (same logic as dashboard)
// ============================================

function getNestedValue(obj, dotPath) {
  const parts = dotPath.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    if (/^\d+$/.test(part)) {
      current = Array.isArray(current) ? current[parseInt(part)] : current[part];
    } else {
      current = current[part];
    }
  }
  return current;
}

function extractField(obj, paths) {
  for (const p of paths) {
    const val = getNestedValue(obj, p);
    if (val !== undefined && val !== null) return val;
  }
  return null;
}

function parseGpsCoord(str) {
  if (typeof str !== 'string') return Number(str) || 0;
  const match = str.match(/([\d.]+)\s*([NSEW])/i);
  if (!match) return Number(str) || 0;
  let val = parseFloat(match[1]);
  if (match[2].toUpperCase() === 'S' || match[2].toUpperCase() === 'W') val = -val;
  return val;
}

function resolveGateway(topic) {
  const parts = topic.split('/');
  if (parts.length >= 2 && parts[0] === 'bus') {
    const busBase = parts.slice(0, 2).join('/');
    for (const gw of GATEWAYS) {
      if (gw.topic && busBase.includes(gw.topic)) return gw;
    }
    return { topic: busBase, label: busBase, route: '' };
  }
  return { topic, label: topic, route: '' };
}


// ============================================
// MQTT MESSAGE HANDLER
// Uses line_periodic_data directly as per-interval deltas (NOT cumulative).
// Uses line_total_data for authoritative onboard count.
// Merges bus/002/door1 + bus/002/door2 into single SUS-001 record.
// Extracts GPS from bus/001 (UR35 gateway).
// ============================================

// Merge window: collect deltas from all doors, then write one merged record
const pendingDeltas = {};  // { busId: { deltaIn, deltaOut, onboard, lat, lng, speed, msgType, timeout } }
const MERGE_WINDOW_MS = 2000;  // Wait 2s for all door messages to arrive

// Debug: store last N raw MQTT payloads
const DEBUG_RAW_PAYLOADS = [];
const DEBUG_MAX = 20;

function handleMessage(topic, rawPayload) {
  let payload;
  const raw = rawPayload.toString();

  // Try JSON parse
  try {
    payload = JSON.parse(raw);
  } catch {
    // NMEA sentences from UR35 GPS — silently skip
    if (raw.startsWith('$GP') || raw.startsWith('$GN')) return;
    return;
  }

  // Store raw payload for debug endpoint
  DEBUG_RAW_PAYLOADS.unshift({ topic, timestamp: new Date().toISOString(), payload });
  if (DEBUG_RAW_PAYLOADS.length > DEBUG_MAX) DEBUG_RAW_PAYLOADS.length = DEBUG_MAX;

  mqttStats.messageCount++;
  mqttStats.lastMessage = Date.now();

  // Resolve which bus this topic belongs to
  const gw = resolveGateway(topic);
  const busId = gw.label;  // e.g. 'SUS-001'
  const route = gw.route || '';

  // Ensure live device state exists
  if (!liveDevices[busId]) {
    liveDevices[busId] = { totalIn: 0, totalOut: 0, onboard: 0, lat: 0, lng: 0, speed: 0, ts: 0 };
  }
  const dev = liveDevices[busId];
  dev.ts = Date.now();

  // ---- GPS EXTRACTION ----
  // bus/001 is the UR35 gateway — it sends GPS data for the bus
  let lat = extractField(payload, FIELD_PATHS.latitude);
  let lng = extractField(payload, FIELD_PATHS.longitude);
  if (typeof lat === 'string' && lat.match(/[NSEW]/i)) lat = parseGpsCoord(lat);
  if (typeof lng === 'string' && lng.match(/[NSEW]/i)) lng = parseGpsCoord(lng);
  const speed = Number(extractField(payload, FIELD_PATHS.speed)) || 0;

  if (lat != null && Number(lat) !== 0) dev.lat = Number(lat);
  if (lng != null && Number(lng) !== 0) dev.lng = Number(lng);
  if (!dev.lat && LAST_KNOWN_GPS.lat) dev.lat = LAST_KNOWN_GPS.lat;
  if (!dev.lng && LAST_KNOWN_GPS.lng) dev.lng = LAST_KNOWN_GPS.lng;
  dev.speed = speed;

  // ---- EXTRACT COUNTING DATA ----
  const periodicIn  = extractField(payload, FIELD_PATHS.periodicIn);
  const periodicOut = extractField(payload, FIELD_PATHS.periodicOut);
  const dailyIn     = extractField(payload, FIELD_PATHS.totalIn);   // line_total_data cumulative
  const dailyOut    = extractField(payload, FIELD_PATHS.totalOut);  // line_total_data cumulative
  const triggerIn   = extractField(payload, FIELD_PATHS.triggerIn);
  const triggerOut  = extractField(payload, FIELD_PATHS.triggerOut);

  const hasPeriodic    = periodicIn != null || periodicOut != null;
  const hasDailyTotals = dailyIn != null || dailyOut != null;
  const hasTrigger     = triggerIn != null || triggerOut != null;

  // If no counting data at all, this is a pure GPS/status message — done
  if (!hasPeriodic && !hasDailyTotals && !hasTrigger) {
    console.log(`[MQTT] ${busId} (${topic}) GPS/status only — no counting data`);
    return;
  }

  // ---- BOARDINGS & ALIGHTINGS (per-interval deltas) ----
  // line_periodic_data.total.in / .out are ALREADY deltas for the reporting interval.
  // Use them DIRECTLY — do NOT compute deltas from cumulative values.
  let deltaIn = 0, deltaOut = 0, msgType = 'unknown';

  if (hasPeriodic) {
    // Primary source: periodic data is the per-interval delta
    deltaIn = Number(periodicIn) || 0;
    deltaOut = Number(periodicOut) || 0;
    msgType = 'periodic';
    console.log(`[MQTT] ${busId} (${topic}) periodic: in=${deltaIn} out=${deltaOut}`);
  } else if (hasTrigger) {
    // line_trigger_data: real-time single-person events (already per-event)
    deltaIn = Number(triggerIn) || 0;
    deltaOut = Number(triggerOut) || 0;
    msgType = 'trigger';
    console.log(`[MQTT] ${busId} (${topic}) trigger: in=${deltaIn} out=${deltaOut}`);
  }

  // ---- ONBOARD COUNT (from line_total_data cumulative) ----
  // line_total_data.in_counted - out_counted = current onboard
  let onboardFromTotal = null;
  if (hasDailyTotals) {
    const cumIn = Number(dailyIn) || 0;
    const cumOut = Number(dailyOut) || 0;
    onboardFromTotal = Math.max(0, cumIn - cumOut);
    console.log(`[MQTT] ${busId} (${topic}) total_data: cumIn=${cumIn} cumOut=${cumOut} onboard=${onboardFromTotal}`);
  }

  // Skip if no actual movement (delta=0 and no onboard update)
  if (deltaIn === 0 && deltaOut === 0 && onboardFromTotal === null) return;

  // ---- MERGE deltas from multiple doors into one bus record ----
  if (!pendingDeltas[busId]) {
    pendingDeltas[busId] = {
      deltaIn: 0, deltaOut: 0, onboard: null,
      lat: dev.lat, lng: dev.lng, speed: dev.speed,
      msgType, route, timeout: null
    };
  }
  const pending = pendingDeltas[busId];
  pending.deltaIn += deltaIn;
  pending.deltaOut += deltaOut;
  pending.lat = dev.lat;
  pending.lng = dev.lng;
  pending.speed = dev.speed;
  // Use onboard from line_total_data if available (most authoritative)
  if (onboardFromTotal !== null) pending.onboard = onboardFromTotal;
  if (msgType === 'periodic') pending.msgType = 'periodic';

  // Clear previous timeout and set a new merge window
  if (pending.timeout) clearTimeout(pending.timeout);
  pending.timeout = setTimeout(() => flushBusDelta(busId), MERGE_WINDOW_MS);
}

function flushBusDelta(busId) {
  const pending = pendingDeltas[busId];
  if (!pending) return;
  delete pendingDeltas[busId];

  const deltaIn = pending.deltaIn;
  const deltaOut = pending.deltaOut;

  // Skip if truly nothing happened
  if (deltaIn === 0 && deltaOut === 0 && pending.onboard === null) return;

  const now = new Date();
  const isoTs = now.toISOString();
  const dateStr = isoTs.slice(0, 10);
  const hour = now.getUTCHours();

  // ---- Update bus day totals ----
  if (!busDayTotals[busId]) {
    busDayTotals[busId] = { dayIn: 0, dayOut: 0, date: dateStr };
  }
  const dayState = busDayTotals[busId];
  // Reset on new day
  if (dayState.date !== dateStr) {
    dayState.dayIn = 0;
    dayState.dayOut = 0;
    dayState.date = dateStr;
  }
  dayState.dayIn += deltaIn;
  dayState.dayOut += deltaOut;

  // ---- Determine onboard count ----
  // Prefer line_total_data onboard (authoritative). Fallback: day cumulative.
  let onboard;
  if (pending.onboard !== null) {
    onboard = pending.onboard;
  } else {
    onboard = Math.max(0, dayState.dayIn - dayState.dayOut);
  }
  const occupancy = BUS_CAPACITY > 0 ? Math.min(100, Math.round((onboard / BUS_CAPACITY) * 100)) : 0;

  // ---- Update live device state ----
  if (liveDevices[busId]) {
    liveDevices[busId].totalIn = dayState.dayIn;
    liveDevices[busId].totalOut = dayState.dayOut;
    liveDevices[busId].onboard = onboard;
  }

  // Find route from gateway config
  const gwMatch = GATEWAYS.find(g => g.label === busId);
  const route = gwMatch ? gwMatch.route || '' : '';

  // ---- Insert merged record into database ----
  try {
    insertRecord.run({
      timestamp: isoTs,
      date: dateStr,
      hour,
      bus_id: busId,
      route,
      stop: '-',
      boardings: deltaIn,
      alightings: deltaOut,
      evt_in: deltaIn,
      evt_out: deltaOut,
      onboard,
      occupancy,
      lat: pending.lat || 0,
      lng: pending.lng || 0,
      speed: pending.speed || 0,
      msg_type: pending.msgType || 'merged',
    });

    // Upsert hourly summary — cumulative day totals
    upsertHourlySummary.run({
      date: dateStr,
      hour,
      bus_id: busId,
      boardings: dayState.dayIn,
      alightings: dayState.dayOut,
      max_onboard: onboard,
    });

    // Upsert daily summary
    upsertDailySummary.run({
      date: dateStr,
      bus_id: busId,
      total_in: dayState.dayIn,
      total_out: dayState.dayOut,
      peak_onboard: onboard,
      peak_hour: hour,
      first_seen: isoTs,
      last_seen: isoTs,
      avg_occupancy: occupancy,
    });
  } catch (err) {
    console.error('[DB] Insert error:', err.message);
  }

  console.log(`[FLUSH] ${busId} merged: Δin=${deltaIn} Δout=${deltaOut} onboard=${onboard} dayTotal: in=${dayState.dayIn} out=${dayState.dayOut}`);
}


// ============================================
// MQTT CLIENT
// ============================================

function connectMqtt() {
  const url = `mqtts://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}`;
  console.log(`[MQTT] Connecting to ${url}...`);

  mqttClient = mqtt.connect(url, {
    username: MQTT_CONFIG.username,
    password: MQTT_CONFIG.password,
    clientId: 'sus-backend-' + Math.random().toString(16).slice(2, 8),
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 15000,
    protocolVersion: 4,
    rejectUnauthorized: true,
  });

  mqttClient.on('connect', () => {
    console.log('[MQTT] Connected');
    mqttStats.connected = true;
    mqttClient.subscribe(MQTT_CONFIG.topic, { qos: 0 }, (err) => {
      if (err) console.error('[MQTT] Subscribe error:', err);
      else console.log(`[MQTT] Subscribed to: ${MQTT_CONFIG.topic}`);
    });
  });

  mqttClient.on('message', handleMessage);

  mqttClient.on('error', (err) => {
    console.error('[MQTT] Error:', err.message);
    mqttStats.connected = false;
  });

  mqttClient.on('close', () => {
    console.log('[MQTT] Disconnected — will reconnect');
    mqttStats.connected = false;
  });

  mqttClient.on('reconnect', () => {
    console.log('[MQTT] Reconnecting...');
  });
}


// ============================================
// MIDNIGHT RESET
// ============================================

function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0); // next UTC midnight
  const msUntilMidnight = midnight.getTime() - now.getTime();

  console.log(`[RESET] Next midnight reset in ${Math.round(msUntilMidnight / 60000)} minutes`);

  setTimeout(() => {
    console.log('[RESET] Midnight — resetting all daily counters');
    const newDate = new Date().toISOString().slice(0, 10);
    // Reset per-bus day totals
    for (const busId of Object.keys(busDayTotals)) {
      busDayTotals[busId].dayIn = 0;
      busDayTotals[busId].dayOut = 0;
      busDayTotals[busId].date = newDate;
    }
    // Reset live device counters
    for (const busId of Object.keys(liveDevices)) {
      liveDevices[busId].totalIn = 0;
      liveDevices[busId].totalOut = 0;
      liveDevices[busId].onboard = 0;
    }
    // Schedule next midnight
    scheduleMidnightReset();
  }, msUntilMidnight);
}


// ============================================
// EXPRESS API
// ============================================

const app = express();
app.use(cors());
app.use(express.json());

// Serve static dashboard files from public/ folder
app.use(express.static(path.join(__dirname, 'public')));


// --- Live State ---

app.get('/api/live', (req, res) => {
  const buses = Object.entries(liveDevices).map(([busId, dev]) => {
    const ageSeconds = dev.ts ? Math.round((Date.now() - dev.ts) / 1000) : 999;
    const passengers = dev.onboard || Math.max(0, dev.totalIn - dev.totalOut);
    const occupancy = BUS_CAPACITY > 0 ? Math.min(100, Math.round((passengers / BUS_CAPACITY) * 100)) : 0;
    return {
      busId,
      lineIn: dev.totalIn,
      lineOut: dev.totalOut,
      passengers,
      onboard: dev.onboard || 0,
      occupancy,
      lat: dev.lat || 0,
      lng: dev.lng || 0,
      speed: dev.speed || 0,
      status: ageSeconds < 300 ? 'active' : 'idle',
      sensorStatus: ageSeconds < 300 ? 'Online' : ageSeconds < 600 ? 'Degraded' : 'Offline',
      lastUpdate: ageSeconds,
    };
  });

  res.json({
    mqtt: {
      connected: mqttStats.connected,
      messageCount: mqttStats.messageCount,
      lastMessage: mqttStats.lastMessage,
    },
    buses,
  });
});


// --- Records (raw data for Data Explorer) ---

app.get('/api/records', (req, res) => {
  const { date, bus_id, limit = 500, offset = 0 } = req.query;
  let sql = 'SELECT * FROM records WHERE 1=1';
  const params = {};

  if (date) {
    sql += ' AND date = @date';
    params.date = date;
  }
  if (bus_id) {
    sql += ' AND bus_id = @bus_id';
    params.bus_id = bus_id;
  }

  // Count total
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const totalRow = db.prepare(countSql).get(params);

  sql += ' ORDER BY timestamp DESC LIMIT @limit OFFSET @offset';
  params.limit = Number(limit);
  params.offset = Number(offset);

  const rows = db.prepare(sql).all(params);
  res.json({ total: totalRow.total, records: rows });
});


// --- Hourly data (for charts) ---

app.get('/api/hourly', (req, res) => {
  const { date, bus_id } = req.query;
  let sql = 'SELECT * FROM hourly_summary WHERE 1=1';
  const params = {};

  if (date) {
    sql += ' AND date = @date';
    params.date = date;
  }
  if (bus_id) {
    sql += ' AND bus_id = @bus_id';
    params.bus_id = bus_id;
  }

  sql += ' ORDER BY date, hour';
  const rows = db.prepare(sql).all(params);
  res.json({ hourly: rows });
});


// --- Daily summary (for ridership trends, comparison) ---

app.get('/api/daily', (req, res) => {
  const { from, to, bus_id } = req.query;
  let sql = 'SELECT * FROM daily_summary WHERE 1=1';
  const params = {};

  if (from) {
    sql += ' AND date >= @from';
    params.from = from;
  }
  if (to) {
    sql += ' AND date <= @to';
    params.to = to;
  }
  if (bus_id) {
    sql += ' AND bus_id = @bus_id';
    params.bus_id = bus_id;
  }

  sql += ' ORDER BY date';
  const rows = db.prepare(sql).all(params);
  res.json({ daily: rows });
});


// --- Summary (aggregated stats for a period) ---

app.get('/api/summary', (req, res) => {
  const { period = 'today' } = req.query;
  const now = new Date();
  let fromDate;

  switch (period) {
    case 'today':
      fromDate = now.toISOString().slice(0, 10);
      break;
    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      fromDate = d.toISOString().slice(0, 10);
      break;
    }
    case 'month': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      fromDate = d.toISOString().slice(0, 10);
      break;
    }
    case 'year': {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - 1);
      fromDate = d.toISOString().slice(0, 10);
      break;
    }
    default:
      fromDate = period; // Allow raw date
  }

  const toDate = now.toISOString().slice(0, 10);

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(total_in), 0) as total_boardings,
      COALESCE(SUM(total_out), 0) as total_alightings,
      COALESCE(MAX(peak_onboard), 0) as peak_onboard,
      COUNT(DISTINCT bus_id) as bus_count,
      COUNT(DISTINCT date) as days_count,
      COALESCE(AVG(avg_occupancy), 0) as avg_occupancy
    FROM daily_summary WHERE date >= @from AND date <= @to
  `).get({ from: fromDate, to: toDate });

  const peakHour = db.prepare(`
    SELECT hour, SUM(boardings) as total
    FROM hourly_summary WHERE date >= @from AND date <= @to
    GROUP BY hour ORDER BY total DESC LIMIT 1
  `).get({ from: fromDate, to: toDate });

  const dailyBreakdown = db.prepare(`
    SELECT date, SUM(total_in) as boardings, SUM(total_out) as alightings, AVG(avg_occupancy) as avg_occ
    FROM daily_summary WHERE date >= @from AND date <= @to
    GROUP BY date ORDER BY date
  `).all({ from: fromDate, to: toDate });

  res.json({
    period: { from: fromDate, to: toDate },
    totals,
    peakHour: peakHour || { hour: 0, total: 0 },
    dailyBreakdown,
  });
});


// --- Compare two date ranges ---

app.get('/api/compare', (req, res) => {
  const { date_a, date_b } = req.query;
  if (!date_a || !date_b) {
    return res.status(400).json({ error: 'Provide date_a and date_b' });
  }

  function getDateData(date) {
    const daily = db.prepare(`
      SELECT COALESCE(SUM(total_in), 0) as boardings, COALESCE(SUM(total_out), 0) as alightings
      FROM daily_summary WHERE date = @date
    `).get({ date });

    const hourly = db.prepare(`
      SELECT hour, SUM(boardings) as boardings, SUM(alightings) as alightings
      FROM hourly_summary WHERE date = @date GROUP BY hour ORDER BY hour
    `).all({ date });

    return { date, ...daily, hourly };
  }

  res.json({ a: getDateData(date_a), b: getDateData(date_b) });
});


// --- Available dates (for date pickers) ---

app.get('/api/dates', (req, res) => {
  const dates = db.prepare(`
    SELECT DISTINCT date FROM daily_summary ORDER BY date DESC LIMIT 365
  `).all().map(r => r.date);

  res.json({ dates });
});


// --- Available buses ---

app.get('/api/buses', (req, res) => {
  const buses = db.prepare(`
    SELECT DISTINCT bus_id FROM daily_summary ORDER BY bus_id
  `).all().map(r => r.bus_id);

  res.json({ buses });
});


// --- Health check ---

app.get('/api/health', (req, res) => {
  const recordCount = db.prepare('SELECT COUNT(*) as cnt FROM records').get().cnt;
  res.json({
    status: 'ok',
    mqtt: mqttStats.connected ? 'connected' : 'disconnected',
    mqttMessages: mqttStats.messageCount,
    dbRecords: recordCount,
    uptime: Math.round(process.uptime()),
  });
});


// --- Debug endpoints ---

app.get('/api/debug', (req, res) => {
  res.json({
    description: 'Last 20 raw MQTT JSON payloads (newest first)',
    count: DEBUG_RAW_PAYLOADS.length,
    payloads: DEBUG_RAW_PAYLOADS,
  });
});

app.get('/api/debug/state', (req, res) => {
  // Serialize pendingDeltas without the timeout handle
  const pending = {};
  for (const [k, v] of Object.entries(pendingDeltas)) {
    pending[k] = { deltaIn: v.deltaIn, deltaOut: v.deltaOut, msgType: v.msgType, lat: v.lat, lng: v.lng };
  }
  res.json({
    busDayTotals,
    pendingDeltas: pending,
    liveDevices,
    gateways: GATEWAYS,
  });
});


// ============================================
// START
// ============================================

app.listen(PORT, () => {
  console.log(`[SERVER] APC Backend running on http://localhost:${PORT}`);
  console.log(`[SERVER] Database: ${DB_PATH}`);
  console.log(`[SERVER] API Health: http://localhost:${PORT}/api/health`);
  console.log('[SERVER] Delta-based counting with multi-door merge enabled');

  // Purge old cumulative-based data from before the delta fix
  try {
    const today = new Date().toISOString().slice(0, 10);
    const purged = db.prepare('DELETE FROM records WHERE date < ?').run(today);
    if (purged.changes > 0) console.log(`[DB] Purged ${purged.changes} old records (pre-delta data)`);
    db.prepare('DELETE FROM hourly_summary WHERE date < ?').run(today);
    db.prepare('DELETE FROM daily_summary WHERE date < ?').run(today);
    // Also purge today's data since it was cumulative-based
    const purgedToday = db.prepare('DELETE FROM records WHERE date = ?').run(today);
    if (purgedToday.changes > 0) console.log(`[DB] Purged ${purgedToday.changes} today records (resetting for delta-based counting)`);
    db.prepare('DELETE FROM hourly_summary WHERE date = ?').run(today);
    db.prepare('DELETE FROM daily_summary WHERE date = ?').run(today);
  } catch (err) {
    console.error('[DB] Purge error:', err.message);
  }

  connectMqtt();
  scheduleMidnightReset();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[SERVER] Shutting down...');
  if (mqttClient) mqttClient.end(true);
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (mqttClient) mqttClient.end(true);
  db.close();
  process.exit(0);
});
