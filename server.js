/* ============================================
   SMART URBAN SENSING — APC Backend Server
   MQTT Subscriber → SQLite → REST API
   ============================================ */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const mqtt = require('mqtt');

// ============================================
// CONFIGURATION
// ============================================

const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'apc_data.db');
const BUS_CAPACITY = Number(process.env.BUS_CAPACITY) || 16;

// Display timezone — all "day" buckets roll over at local midnight in this zone
// so the dashboard's date boundary matches its clock (Minnesota / US Central).
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/Chicago';
// Returns the calendar date (YYYY-MM-DD) in DISPLAY_TZ for the given Date (defaults to now).
function displayDateStr(d = new Date()) {
  // en-CA locale yields YYYY-MM-DD formatting
  return new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TZ }).format(d);
}

const MQTT_CONFIG = {
  host: process.env.MQTT_HOST || '492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud',
  port: Number(process.env.MQTT_PORT) || 8883,
  username: process.env.MQTT_USER || 'sus-dashboard',
  password: process.env.MQTT_PASS || 'SuS-Mqtt#2026!Secure',
  topic: process.env.MQTT_TOPIC || 'bus/#',
};

// Gateway / bus mapping — multiple topics can map to the same bus (multi-door)
// Bus 515 (first bus): bus/001 = door 1, bus/002 = door 2 (merged into one record).
// Bus 419 (second bus): bus/003 (+ bus/004 if it gains a second door later).
const GATEWAYS = [
  { topic: 'bus/001', label: '515', route: '' },
  { topic: 'bus/002', label: '515', route: '' },
  { topic: 'bus/003', label: '419', route: '' },
  { topic: 'bus/004', label: '419', route: '' },
];

// ============================================
// GPS RESILIENT FALLBACK SYSTEM
// ============================================
// The UR35 gateway only emits a valid fix when it has line-of-sight to the
// sky and the GPS antenna is connected. Indoors / no-antenna it reports
// status=52 (no fix). Without resilience, the live map shows nothing useful.
//
// Priority order (highest first) for the live bus location:
//   1. Real-time valid UR35 GPS fix
//   2. Persisted last-known fix for this bus (survives restart)
//   3. Static stop/depot coordinates for this bus_id
//   4. Generic depot fallback
//
// Per-bus last-known GPS is written to disk on every valid fix so a Railway
// redeploy doesn't lose location memory.

// Per-bus static depot/stop coordinates — Mayo Clinic Rochester, MN inter-campus shuttles.
// Used when no real fix has ever been seen for that bus.
//   515 = Mayo Downtown inter-campus loop, anchored at Gonda Building (200 1st St SW)
//   419 = Mayo NW patient parking shuttle, anchored at Medical Complex NW Building B (3033 41st St NW)
const BUS_STATIC_LOCATIONS = {
  '515': { lat: 44.02302, lng: -92.46657, label: 'Gonda Building (Mayo Downtown)' },
  '419': { lat: 44.07770, lng: -92.50580, label: 'Medical Complex NW — Building B' },
};

// Ultimate fallback when bus_id has no static mapping — Mayo Clinic main downtown campus.
const DEPOT_FALLBACK = { lat: 44.02302, lng: -92.46657, label: 'Mayo Clinic Rochester (downtown)' };

// Persisted last-known GPS file — survives restarts/redeploys.
const GPS_CACHE_PATH = process.env.GPS_CACHE_PATH || path.join(__dirname, 'gps-cache.json');
let lastKnownGpsByBus = {};
try {
  if (fs.existsSync(GPS_CACHE_PATH)) {
    lastKnownGpsByBus = JSON.parse(fs.readFileSync(GPS_CACHE_PATH, 'utf8')) || {};
    console.log(`[GPS] Loaded last-known fixes for ${Object.keys(lastKnownGpsByBus).length} bus(es) from ${GPS_CACHE_PATH}`);
  }
} catch (err) {
  console.warn(`[GPS] Failed to load ${GPS_CACHE_PATH}:`, err.message);
  lastKnownGpsByBus = {};
}

// Throttle disk writes — only persist once every 30s per bus at most.
const gpsCacheLastWriteAt = {};
function persistGpsCache(busId) {
  const now = Date.now();
  if (gpsCacheLastWriteAt[busId] && now - gpsCacheLastWriteAt[busId] < 30000) return;
  gpsCacheLastWriteAt[busId] = now;
  try {
    fs.writeFileSync(GPS_CACHE_PATH, JSON.stringify(lastKnownGpsByBus, null, 2));
  } catch (err) {
    console.warn('[GPS] Failed to persist cache:', err.message);
  }
}

// ============================================
// STATIC STOP REGISTRY (route + scheduled-stop resolver)
// ============================================
// Stops are loaded from data/stops.json and the server cycles each bus through
// its route's ordered stops using a fixed loop_minutes cadence. This gives the
// live map a sensible 'current scheduled stop' for each bus until real GPS
// from the UR35 starts flowing.
const STOPS_PATH = process.env.STOPS_PATH || path.join(__dirname, 'data', 'stops.json');
let STOP_REGISTRY = { routes: {} };
try {
  if (fs.existsSync(STOPS_PATH)) {
    STOP_REGISTRY = JSON.parse(fs.readFileSync(STOPS_PATH, 'utf8'));
    const totalStops = Object.values(STOP_REGISTRY.routes || {}).reduce((s, r) => s + (r.stops || []).length, 0);
    console.log(`[STOPS] Loaded ${Object.keys(STOP_REGISTRY.routes || {}).length} route(s), ${totalStops} stop(s) from ${STOPS_PATH}`);
  } else {
    console.warn(`[STOPS] ${STOPS_PATH} not found — stop-based location disabled`);
  }
} catch (err) {
  console.warn(`[STOPS] Failed to load ${STOPS_PATH}:`, err.message);
  STOP_REGISTRY = { routes: {} };
}

// Build a fast lookup: busId -> { routeKey, route, stops, loop_minutes }
const BUS_ROUTE_LOOKUP = {};
for (const [routeKey, route] of Object.entries(STOP_REGISTRY.routes || {})) {
  for (const bid of route.bus_ids || []) {
    BUS_ROUTE_LOOKUP[bid] = {
      routeKey,
      routeName: route.name,
      stops: route.stops || [],
      loopMinutes: route.loop_minutes || 45,
    };
  }
}

// Resolve the bus's current scheduled stop based on time-of-day modulo the
// route loop. Returns the stop object or null if the bus has no route.
function currentScheduledStop(busId, nowMs) {
  const r = BUS_ROUTE_LOOKUP[busId];
  if (!r || !r.stops.length) return null;
  const now = nowMs || Date.now();
  const loopMs = r.loopMinutes * 60 * 1000;
  const positionInLoop = (now % loopMs) / loopMs; // 0..1
  const idx = Math.min(r.stops.length - 1, Math.floor(positionInLoop * r.stops.length));
  const nextIdx = (idx + 1) % r.stops.length;
  const stop = r.stops[idx];
  return {
    ...stop,
    routeKey: r.routeKey,
    routeName: r.routeName,
    nextStop: r.stops[nextIdx] || null,
    loopMinutes: r.loopMinutes,
  };
}

// Haversine distance in metres between two lat/lng pairs.
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Find the nearest stop on this bus's route within `maxMeters`. Returns
// { stop, distanceMeters } or null if no GPS, no route, or nothing within range.
// Default radius 60m — large enough to cover bus length + GPS jitter, small
// enough to avoid attributing one stop's events to its neighbour.
function nearestStopByProximity(busId, lat, lng, maxMeters = 60) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const r = BUS_ROUTE_LOOKUP[busId];
  if (!r || !r.stops.length) return null;
  let best = null;
  for (const s of r.stops) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const d = haversineMeters(lat, lng, s.lat, s.lng);
    if (!best || d < best.distanceMeters) best = { stop: s, distanceMeters: d };
  }
  if (!best || best.distanceMeters > maxMeters) return null;
  return { ...best, routeKey: r.routeKey, routeName: r.routeName };
}

// Resolve the best location for a bus given its current state.
// Priority: live GPS > cached last-known > current scheduled stop > static depot > generic depot.
function resolveBusLocation(busId, devLat, devLng) {
  // 1. Real-time valid fix already on dev (validated upstream)
  if (devLat && devLng) return { lat: devLat, lng: devLng, source: 'live' };
  // 2. Persisted last-known fix for this bus
  const cached = lastKnownGpsByBus[busId];
  if (cached && cached.lat && cached.lng) {
    return { lat: cached.lat, lng: cached.lng, source: 'cached', ts: cached.ts };
  }
  // 3. Current scheduled stop on the bus's route
  const stop = currentScheduledStop(busId);
  if (stop && stop.lat && stop.lng) {
    return {
      lat: stop.lat, lng: stop.lng, source: 'stop',
      label: stop.name, stopId: stop.id, routeName: stop.routeName,
      nextStopName: stop.nextStop ? stop.nextStop.name : null,
    };
  }
  // 4. Static per-bus depot
  const stat = BUS_STATIC_LOCATIONS[busId];
  if (stat) return { lat: stat.lat, lng: stat.lng, source: 'static', label: stat.label };
  // 5. Generic depot
  return { lat: DEPOT_FALLBACK.lat, lng: DEPOT_FALLBACK.lng, source: 'depot', label: DEPOT_FALLBACK.label };
}

// VS125 field extraction paths (same as dashboard)
const FIELD_PATHS = {
  totalIn:      ['line_total_data.0.total.out_counted'],   // VS125 inverted: sensor 'out' = boarding
  totalOut:     ['line_total_data.0.total.in_counted'],    // VS125 inverted: sensor 'in' = alighting
  periodicIn:   ['line_periodic_data.0.total.out'],        // VS125 inverted: sensor 'out' = boarding
  periodicOut:  ['line_periodic_data.0.total.in'],         // VS125 inverted: sensor 'in' = alighting
  triggerIn:    ['line_trigger_data.0.total.out'],         // VS125 inverted: sensor 'out' = boarding
  triggerOut:   ['line_trigger_data.0.total.in'],          // VS125 inverted: sensor 'in' = alighting
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
    msg_type    TEXT    NOT NULL DEFAULT 'unknown', -- daily_total, periodic, trigger, legacy
    stop_source TEXT    NOT NULL DEFAULT 'scheduled', -- 'gps' = matched by live GPS proximity; 'scheduled' = timetable guess; 'none' = no route
    stop_dist_m REAL    NOT NULL DEFAULT 0          -- distance in metres from GPS fix to matched stop (0 when stop_source != 'gps')
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

  -- Persistent per-bus running state (survives restarts/redeploys).
  -- running_onboard is a CONTINUOUS occupancy tally that carries across
  -- midnight and does NOT reset daily (continuous running-tally model).
  CREATE TABLE IF NOT EXISTS bus_state (
    bus_id          TEXT    PRIMARY KEY,
    running_onboard INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT
  );

  -- Indexes for fast queries
  CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
  CREATE INDEX IF NOT EXISTS idx_records_bus_date ON records(bus_id, date);
  CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records(timestamp);
  CREATE INDEX IF NOT EXISTS idx_hourly_date ON hourly_summary(date);
  CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_summary(date);
`);

// ----- One-time label migration: SUS-001 -> 515 -----
// The canonical bus label was renamed. Carry existing history and the
// persisted running-onboard tally over to the new label so nothing is lost.
// Idempotent: only runs while old-label rows still exist.
try {
  const OLD_LABEL = 'SUS-001';
  const NEW_LABEL = '515';
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM records WHERE bus_id = ?').get(OLD_LABEL).n;
  const stateCnt = db.prepare('SELECT COUNT(*) AS n FROM bus_state WHERE bus_id = ?').get(OLD_LABEL).n;
  if (cnt > 0 || stateCnt > 0) {
    const migrate = db.transaction(() => {
      db.prepare('UPDATE records SET bus_id = ? WHERE bus_id = ?').run(NEW_LABEL, OLD_LABEL);
      db.prepare('UPDATE hourly_summary SET bus_id = ? WHERE bus_id = ?').run(NEW_LABEL, OLD_LABEL);
      // daily_summary has UNIQUE(date,bus_id): merge instead of blind rename.
      db.prepare(`
        INSERT INTO daily_summary (date, bus_id, total_in, total_out, peak_onboard, peak_hour, first_seen, last_seen, avg_occupancy)
        SELECT date, ?, total_in, total_out, peak_onboard, peak_hour, first_seen, last_seen, avg_occupancy
        FROM daily_summary WHERE bus_id = ?
        ON CONFLICT(date, bus_id) DO UPDATE SET
          total_in      = daily_summary.total_in  + excluded.total_in,
          total_out     = daily_summary.total_out + excluded.total_out,
          peak_onboard  = MAX(daily_summary.peak_onboard, excluded.peak_onboard),
          last_seen     = excluded.last_seen,
          avg_occupancy = (daily_summary.avg_occupancy + excluded.avg_occupancy) / 2
      `).run(NEW_LABEL, OLD_LABEL);
      db.prepare('DELETE FROM daily_summary WHERE bus_id = ?').run(OLD_LABEL);
      // bus_state PRIMARY KEY: keep the larger running value if both exist.
      db.prepare(`
        INSERT INTO bus_state (bus_id, running_onboard, updated_at)
        SELECT ?, running_onboard, updated_at FROM bus_state WHERE bus_id = ?
        ON CONFLICT(bus_id) DO UPDATE SET
          running_onboard = MAX(bus_state.running_onboard, excluded.running_onboard),
          updated_at      = excluded.updated_at
      `).run(NEW_LABEL, OLD_LABEL);
      db.prepare('DELETE FROM bus_state WHERE bus_id = ?').run(OLD_LABEL);
    });
    migrate();
    console.log(`[MIGRATE] Renamed bus label ${OLD_LABEL} -> ${NEW_LABEL} (${cnt} records, ${stateCnt} state rows)`);
  }
} catch (err) {
  console.error('[MIGRATE] Label rename failed:', err.message);
}

// ----- One-time label migration: 002 -> 419 -----
// The second bus's canonical label was renamed from 002 to 419. Carry existing
// history and the persisted running-onboard tally over to the new label so
// nothing is lost. Idempotent: only runs while old-label rows still exist.
try {
  const OLD_LABEL = '002';
  const NEW_LABEL = '419';
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM records WHERE bus_id = ?').get(OLD_LABEL).n;
  const stateCnt = db.prepare('SELECT COUNT(*) AS n FROM bus_state WHERE bus_id = ?').get(OLD_LABEL).n;
  if (cnt > 0 || stateCnt > 0) {
    const migrate = db.transaction(() => {
      db.prepare('UPDATE records SET bus_id = ? WHERE bus_id = ?').run(NEW_LABEL, OLD_LABEL);
      db.prepare('UPDATE hourly_summary SET bus_id = ? WHERE bus_id = ?').run(NEW_LABEL, OLD_LABEL);
      // daily_summary has UNIQUE(date,bus_id): merge instead of blind rename.
      db.prepare(`
        INSERT INTO daily_summary (date, bus_id, total_in, total_out, peak_onboard, peak_hour, first_seen, last_seen, avg_occupancy)
        SELECT date, ?, total_in, total_out, peak_onboard, peak_hour, first_seen, last_seen, avg_occupancy
        FROM daily_summary WHERE bus_id = ?
        ON CONFLICT(date, bus_id) DO UPDATE SET
          total_in      = daily_summary.total_in  + excluded.total_in,
          total_out     = daily_summary.total_out + excluded.total_out,
          peak_onboard  = MAX(daily_summary.peak_onboard, excluded.peak_onboard),
          last_seen     = excluded.last_seen,
          avg_occupancy = (daily_summary.avg_occupancy + excluded.avg_occupancy) / 2
      `).run(NEW_LABEL, OLD_LABEL);
      db.prepare('DELETE FROM daily_summary WHERE bus_id = ?').run(OLD_LABEL);
      // bus_state PRIMARY KEY: keep the larger running value if both exist.
      db.prepare(`
        INSERT INTO bus_state (bus_id, running_onboard, updated_at)
        SELECT ?, running_onboard, updated_at FROM bus_state WHERE bus_id = ?
        ON CONFLICT(bus_id) DO UPDATE SET
          running_onboard = MAX(bus_state.running_onboard, excluded.running_onboard),
          updated_at      = excluded.updated_at
      `).run(NEW_LABEL, OLD_LABEL);
      db.prepare('DELETE FROM bus_state WHERE bus_id = ?').run(OLD_LABEL);
    });
    migrate();
    console.log(`[MIGRATE] Renamed bus label ${OLD_LABEL} -> ${NEW_LABEL} (${cnt} records, ${stateCnt} state rows)`);
  }
} catch (err) {
  console.error('[MIGRATE] Label rename failed (002->419):', err.message);
}

// ----- Schema migration: add stop_source / stop_dist_m to existing records table -----
// Safe & idempotent: only runs ADD COLUMN if the column doesn't already exist.
try {
  const cols = db.prepare("PRAGMA table_info(records)").all().map(c => c.name);
  if (!cols.includes('stop_source')) {
    db.prepare("ALTER TABLE records ADD COLUMN stop_source TEXT NOT NULL DEFAULT 'scheduled'").run();
    console.log('[MIGRATE] Added records.stop_source column');
  }
  if (!cols.includes('stop_dist_m')) {
    db.prepare("ALTER TABLE records ADD COLUMN stop_dist_m REAL NOT NULL DEFAULT 0").run();
    console.log('[MIGRATE] Added records.stop_dist_m column');
  }
} catch (err) {
  console.error('[MIGRATE] stop_source/stop_dist_m migration failed:', err.message);
}

// Prepared statements for fast inserts
const insertRecord = db.prepare(`
  INSERT INTO records (timestamp, date, hour, bus_id, route, stop, boardings, alightings, evt_in, evt_out, onboard, occupancy, lat, lng, speed, msg_type, stop_source, stop_dist_m)
  VALUES (@timestamp, @date, @hour, @bus_id, @route, @stop, @boardings, @alightings, @evt_in, @evt_out, @onboard, @occupancy, @lat, @lng, @speed, @msg_type, @stop_source, @stop_dist_m)
`);

const upsertHourlySummary = db.prepare(`
  INSERT INTO hourly_summary (date, hour, bus_id, boardings, alightings, max_onboard, msg_count)
  VALUES (@date, @hour, @bus_id, @boardings, @alightings, @max_onboard, 1)
  ON CONFLICT(date, hour, bus_id) DO UPDATE SET
    boardings   = hourly_summary.boardings + @boardings,
    alightings  = hourly_summary.alightings + @alightings,
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

// Persist the continuous running-onboard tally so it survives restarts/redeploys.
const upsertBusState = db.prepare(`
  INSERT INTO bus_state (bus_id, running_onboard, updated_at)
  VALUES (@bus_id, @running_onboard, @updated_at)
  ON CONFLICT(bus_id) DO UPDATE SET
    running_onboard = @running_onboard,
    updated_at      = @updated_at
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

// Per-bus CONTINUOUS running occupancy (running-tally model). This carries
// across midnight and is NOT reset by the daily counter reset. Rehydrated
// from the bus_state table on startup so redeploys/restarts resume the count.
// Key: busId, Value: integer (clamped 0..BUS_CAPACITY)
const busRunningOnboard = {};


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

// Debug: track every distinct topic seen since boot, with the sensor serial,
// resolved bus label, message count and last-seen time. This is the single
// source of truth for "is a given bus/door actually transmitting?".
const TOPIC_REGISTRY = {};  // { topic: { deviceSn, busLabel, count, firstSeen, lastSeen } }

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

  // Track this topic in the connectivity registry
  {
    const sn = (payload && payload.device_info && payload.device_info.device_sn) || null;
    const lbl = resolveGateway(topic).label;
    const nowIso = new Date().toISOString();
    const reg = TOPIC_REGISTRY[topic] || { deviceSn: sn, busLabel: lbl, count: 0, firstSeen: nowIso, lastSeen: nowIso };
    reg.count++;
    reg.lastSeen = nowIso;
    if (sn) reg.deviceSn = sn;
    reg.busLabel = lbl;
    TOPIC_REGISTRY[topic] = reg;
  }

  mqttStats.messageCount++;
  mqttStats.lastMessage = Date.now();

  // Resolve which bus this topic belongs to
  const gw = resolveGateway(topic);
  const busId = gw.label;  // e.g. 'SUS-001'
  const route = gw.route || '';

  // Ensure live device state exists. Seed onboard from the persisted running
  // tally (running-tally model) so a freshly-created device reflects the
  // continuous occupancy rather than starting at 0.
  if (!liveDevices[busId]) {
    const seedOnboard = busRunningOnboard[busId] != null ? busRunningOnboard[busId] : 0;
    const seed = resolveBusLocation(busId, 0, 0);
    liveDevices[busId] = {
      totalIn: 0, totalOut: 0, onboard: seedOnboard,
      lastEventIn: 0, lastEventOut: 0,
      lat: seed.lat, lng: seed.lng, gpsSource: seed.source, gpsLabel: seed.label || null,
      speed: 0, ts: 0
    };
  }
  const dev = liveDevices[busId];
  dev.ts = Date.now();

  // ---- GPS EXTRACTION ----
  // bus/001 is the UR35 gateway — it sends GPS data for the bus
  let lat = extractField(payload, FIELD_PATHS.latitude);
  let lng = extractField(payload, FIELD_PATHS.longitude);
  if (typeof lat === 'string' && lat.match(/[NSEW]/i)) lat = parseGpsCoord(lat);
  if (typeof lng === 'string' && lng.match(/[NSEW]/i)) lng = parseGpsCoord(lng);
  lat = (lat != null) ? Number(lat) : null;
  lng = (lng != null) ? Number(lng) : null;
  const speed = Number(extractField(payload, FIELD_PATHS.speed)) || 0;

  // UR35 GPS status: 53 = valid fix, 52 = no fix. Only accept a real, in-range fix.
  const gpsStatusRaw = extractField(payload, FIELD_PATHS.gpsStatus);
  const gpsStatus = (gpsStatusRaw != null) ? Number(gpsStatusRaw) : null;
  const hasValidFix = gpsStatus == null ? true : gpsStatus !== 52;
  const inRange = (v, max) => v != null && !isNaN(v) && Math.abs(v) <= max && v !== 0;
  const validFix = inRange(lat, 90) && inRange(lng, 180) && hasValidFix;

  if (validFix) {
    dev.lat = lat; dev.lng = lng; dev.gpsValid = true; dev.gpsSource = 'live'; dev.gpsTs = Date.now();
    // Persist the fix so the bus keeps its location across restarts.
    lastKnownGpsByBus[busId] = { lat, lng, ts: dev.gpsTs };
    persistGpsCache(busId);
  } else if (lat != null || lng != null) {
    console.warn(`[GPS] ${busId} ignoring invalid coords lat=${lat} lng=${lng} status=${gpsStatus}`);
  }
  // If no live fix on dev, fall through to cached / static / depot.
  if (!dev.lat || !dev.lng) {
    const resolved = resolveBusLocation(busId, dev.lat, dev.lng);
    dev.lat = resolved.lat;
    dev.lng = resolved.lng;
    dev.gpsSource = resolved.source;
    dev.gpsLabel = resolved.label || null;
  }
  dev.speed = speed;

  // ---- EXTRACT COUNTING DATA ----
  const periodicIn  = extractField(payload, FIELD_PATHS.periodicIn);
  const periodicOut = extractField(payload, FIELD_PATHS.periodicOut);
  const dailyIn     = extractField(payload, FIELD_PATHS.totalIn);   // line_total_data cumulative
  const dailyOut    = extractField(payload, FIELD_PATHS.totalOut);  // line_total_data cumulative
  const triggerIn   = extractField(payload, FIELD_PATHS.triggerIn);
  const triggerOut  = extractField(payload, FIELD_PATHS.triggerOut);

  const hasPeriodic    = periodicIn != null || periodicOut != null;
  const totalDataStartTime = extractField(payload, ['time_info.start_time']);
  const totalDataDate = totalDataStartTime ? totalDataStartTime.slice(0, 10) : null;
  const todayDateStr = displayDateStr(new Date());
  const hasDailyTotals = dailyIn != null || dailyOut != null;
  // Skip stale MQTT messages from previous days entirely
  if (totalDataDate !== null && totalDataDate !== todayDateStr) {
    console.log(`[SKIP] Stale message from ${totalDataDate}, today is ${todayDateStr}`);
    return;
  }
  const hasTrigger     = triggerIn != null || triggerOut != null;

  // If no counting data at all, this is a pure GPS/status message — done
  if (!hasPeriodic && !hasDailyTotals && !hasTrigger) {
    console.log(`[MQTT] ${busId} (${topic}) GPS/status only — no counting data`);
    return;
  }

  // ---- BOARDINGS & ALIGHTINGS (per-event deltas) ----
  // line_trigger_data is the authoritative per-event counting source. The device
  // ALSO emits line_periodic_data that re-reports the same movement over a fixed
  // interval; counting both as separate messages double-counts ridership (this
  // caused June 2's impossible 1262 boardings). So trigger is primary, and
  // periodic movement is IGNORED for counting (periodic messages are still kept
  // for GPS / onboard snapshots, just with zero count delta).
  let deltaIn = 0, deltaOut = 0, msgType = 'unknown';

  if (hasTrigger) {
    // Primary source: real-time single-person events (already per-event).
    deltaIn = Number(triggerIn) || 0;
    deltaOut = Number(triggerOut) || 0;
    msgType = 'trigger';
    console.log(`[MQTT] ${busId} (${topic}) trigger: in=${deltaIn} out=${deltaOut}`);
  } else if (hasPeriodic) {
    // Periodic data exists but no trigger data on this message: treat it as a
    // heartbeat only — do NOT count its movement (avoids double-counting the
    // trigger events that report the same passengers).
    deltaIn = 0;
    deltaOut = 0;
    msgType = 'periodic';
    console.log(`[MQTT] ${busId} (${topic}) periodic heartbeat (movement ignored for counting)`);
  }

  // ---- ONBOARD COUNT (from line_total_data cumulative) ----
  // onboard is always computed from dayIn-dayOut in flushBusDelta (line_total_data totals are stale device lifetime counts)
  let onboardFromTotal = null;
  if (false) { // disabled: hasDailyTotals stale
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
  // Accumulate BOTH boardings and alightings for this merge window.
  // periodicIn/triggerIn = boardings, periodicOut/triggerOut = alightings
  // (VS125 in/out already de-inverted upstream via FIELD_PATHS).
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
  const dateStr = displayDateStr(now); // Central calendar date
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

  // ---- Determine onboard count (CONTINUOUS RUNNING TALLY) ----
  // Onboard is a running occupancy that carries across midnight and does NOT
  // reset with the daily counters. On each event we apply the net delta to the
  // prior running value, clamped to [0, capacity]. If the sensor reports its
  // own onboard value we trust it and resync the running tally to it.
  let onboard;
  const prevRunning = busRunningOnboard[busId] != null ? busRunningOnboard[busId] : 0;
  if (pending.onboard !== null) {
    onboard = Math.max(0, Math.min(BUS_CAPACITY, pending.onboard));
  } else {
    onboard = Math.max(0, Math.min(BUS_CAPACITY, prevRunning + deltaIn - deltaOut));
  }
  busRunningOnboard[busId] = onboard;
  // Persist running tally so a restart/redeploy resumes from here.
  try {
    upsertBusState.run({ bus_id: busId, running_onboard: onboard, updated_at: isoTs });
  } catch (err) {
    console.error('[DB] bus_state upsert error:', err.message);
  }
  const occupancy = BUS_CAPACITY > 0 ? Math.min(100, Math.round((onboard / BUS_CAPACITY) * 100)) : 0;

  // ---- Update live device state ----
  if (liveDevices[busId]) {
    liveDevices[busId].totalIn = dayState.dayIn;
    liveDevices[busId].totalOut = dayState.dayOut;
    liveDevices[busId].lastEventIn = deltaIn || 0;
    liveDevices[busId].lastEventOut = deltaOut || 0;
    liveDevices[busId].onboard = onboard;
  }

  // Find route from gateway config
  const gwMatch = GATEWAYS.find(g => g.label === busId);
  const route = gwMatch ? gwMatch.route || '' : '';

  // ---- Insert merged record into database ----
  try {
    // Stop attribution priority:
    //   1. Live GPS proximity — if a recent valid fix is within 60m of a stop on this bus's route,
    //      attribute the boarding/alighting event to that stop (stop_source='gps').
    //   2. Scheduled timetable — otherwise use the bus's current scheduled stop (stop_source='scheduled').
    //   3. None — if the bus has no route at all (stop_source='none').
    let stopName = '-';
    let stopSource = 'none';
    let stopDistM = 0;
    let recordRoute = route;

    // 1. Try GPS proximity match first (only if we have a real GPS fix on this event).
    const dev = liveDevices[busId];
    const haveLiveGps = dev && dev.gpsValid && Number.isFinite(dev.lat) && Number.isFinite(dev.lng);
    const lat = haveLiveGps ? dev.lat : (pending.lat || null);
    const lng = haveLiveGps ? dev.lng : (pending.lng || null);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const prox = nearestStopByProximity(busId, lat, lng, 60);
      if (prox) {
        stopName = prox.stop.name || prox.stop.id || '-';
        stopSource = 'gps';
        stopDistM = Math.round(prox.distanceMeters * 10) / 10;
        recordRoute = recordRoute || prox.routeKey;
      }
    }

    // 2. Fallback to scheduled timetable if proximity didn't match.
    if (stopSource === 'none') {
      const schedStop = currentScheduledStop(busId);
      if (schedStop) {
        stopName = schedStop.name || schedStop.id || '-';
        stopSource = 'scheduled';
        recordRoute = recordRoute || schedStop.routeKey;
      }
    }

    insertRecord.run({
      timestamp: isoTs,
      date: dateStr,
      hour,
      bus_id: busId,
      route: recordRoute || '',
      stop: stopName,
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
      stop_source: stopSource,
      stop_dist_m: stopDistM,
    });

    // Upsert hourly summary — accumulate the PER-HOUR deltas (not the running day
    // total) so each hour bucket reflects passenger flow within that hour.
    upsertHourlySummary.run({
      date: dateStr,
      hour,
      bus_id: busId,
      boardings: deltaIn,
      alightings: deltaOut,
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

// Milliseconds until the next local midnight in DISPLAY_TZ.
function msUntilDisplayMidnight() {
  const now = new Date();
  const todayStr = displayDateStr(now);
  // Probe forward in 15-min steps (max 26h) to find when the Central date changes.
  for (let m = 1; m <= 26 * 60; m++) {
    const probe = new Date(now.getTime() + m * 60000);
    if (displayDateStr(probe) !== todayStr) {
      return probe.getTime() - now.getTime();
    }
  }
  return 24 * 60 * 60000; // fallback
}

function scheduleMidnightReset() {
  const msUntilMidnight = msUntilDisplayMidnight();

  console.log(`[RESET] Next ${DISPLAY_TZ} midnight reset in ${Math.round(msUntilMidnight / 60000)} minutes`);

  setTimeout(() => {
    console.log('[RESET] Midnight — resetting all daily counters');
    const newDate = displayDateStr();
    // Reset per-bus day totals
    for (const busId of Object.keys(busDayTotals)) {
      busDayTotals[busId].dayIn = 0;
      busDayTotals[busId].dayOut = 0;
      busDayTotals[busId].date = newDate;
    }
    // Reset live device DAILY counters only. The running onboard occupancy
    // is a continuous tally that CARRIES OVER midnight, so we deliberately
    // leave liveDevices[busId].onboard and busRunningOnboard untouched.
    for (const busId of Object.keys(liveDevices)) {
      liveDevices[busId].totalIn = 0;
      liveDevices[busId].totalOut = 0;
      // onboard intentionally preserved (running-tally model)
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
    // If the bus has no live GPS, re-resolve every call so the scheduled-stop
    // tracking moves the bus along its route as time passes.
    let lat = dev.lat || 0, lng = dev.lng || 0;
    let gpsSource = dev.gpsSource || 'unknown', gpsLabel = dev.gpsLabel || null;
    let stopId = null, routeName = null, nextStopName = null;
    if (gpsSource !== 'live') {
      const resolved = resolveBusLocation(busId, 0, 0);
      lat = resolved.lat; lng = resolved.lng;
      gpsSource = resolved.source; gpsLabel = resolved.label || null;
      stopId = resolved.stopId || null;
      routeName = resolved.routeName || null;
      nextStopName = resolved.nextStopName || null;
    }
    return {
      busId,
      lineIn: dev.totalIn,       lastEventIn: dev.lastEventIn || 0,       lastEventOut: dev.lastEventOut || 0,
      lineOut: dev.totalOut,
      passengers,
      onboard: dev.onboard || 0,
      occupancy,
      lat,
      lng,
      gpsSource,
      gpsLabel,
      stopId,
      routeName,
      nextStopName,
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


// --- GPS diagnostics ---
// Shows current location resolution for each bus and the cached last-known
// fixes on disk. Use this when you suspect the device isn't sending GPS or
// is being rejected as invalid.
app.get('/api/gps-debug', (req, res) => {
  const live = Object.entries(liveDevices).map(([busId, dev]) => ({
    busId,
    lat: dev.lat || 0,
    lng: dev.lng || 0,
    gpsSource: dev.gpsSource || 'unknown',
    gpsLabel: dev.gpsLabel || null,
    gpsValid: !!dev.gpsValid,
    gpsTs: dev.gpsTs || null,
    lastMessageAgeSec: dev.ts ? Math.round((Date.now() - dev.ts) / 1000) : null,
  }));
  res.json({
    live,
    cached: lastKnownGpsByBus,
    staticLocations: BUS_STATIC_LOCATIONS,
    depotFallback: DEPOT_FALLBACK,
    cachePath: GPS_CACHE_PATH,
  });
});


// --- Stop registry endpoints ---
// Full registry: every route with its ordered stop list. Used by the map to
// render stop pins along each route.
app.get('/api/stops', (req, res) => {
  const routes = {};
  for (const [k, v] of Object.entries(STOP_REGISTRY.routes || {})) {
    routes[k] = {
      name: v.name,
      loop_minutes: v.loop_minutes,
      bus_ids: v.bus_ids || [],
      stops: v.stops || [],
    };
  }
  res.json({ routes });
});

// Admin: replace the entire stop registry. Body should match the data/stops.json
// shape: { routes: { '<key>': { name, loop_minutes, bus_ids, stops: [...] } } }.
// Persists to disk and reloads the in-memory lookup, no redeploy needed.
app.put('/api/stops', express.json({ limit: '256kb' }), (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || typeof body.routes !== 'object') {
    return res.status(400).json({ error: 'Body must be { routes: { ... } }' });
  }
  // Validate every stop has lat/lng numbers.
  for (const [k, r] of Object.entries(body.routes)) {
    if (!Array.isArray(r.stops)) return res.status(400).json({ error: `Route ${k}: stops must be an array` });
    for (const s of r.stops) {
      if (typeof s.lat !== 'number' || typeof s.lng !== 'number') {
        return res.status(400).json({ error: `Route ${k}: stop ${s.id || s.name || '?'} missing numeric lat/lng` });
      }
      if (Math.abs(s.lat) > 90 || Math.abs(s.lng) > 180) {
        return res.status(400).json({ error: `Route ${k}: stop ${s.id || s.name || '?'} lat/lng out of range` });
      }
    }
  }
  try {
    fs.writeFileSync(STOPS_PATH, JSON.stringify(body, null, 2));
    STOP_REGISTRY = body;
    // Rebuild lookup
    for (const k of Object.keys(BUS_ROUTE_LOOKUP)) delete BUS_ROUTE_LOOKUP[k];
    for (const [routeKey, route] of Object.entries(STOP_REGISTRY.routes || {})) {
      for (const bid of route.bus_ids || []) {
        BUS_ROUTE_LOOKUP[bid] = {
          routeKey, routeName: route.name,
          stops: route.stops || [], loopMinutes: route.loop_minutes || 45,
        };
      }
    }
    console.log('[STOPS] Registry updated via admin API');
    res.json({ ok: true, routes: Object.keys(STOP_REGISTRY.routes || {}).length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save: ' + err.message });
  }
});

// Per-stop boardings/alightings aggregation. Defaults to today, optional date / from / to / bus_id.
// Returns one row per (route, stop) with totals and a breakdown of attribution source.
//   GET /api/stops/boardings              — today, all buses
//   GET /api/stops/boardings?date=YYYY-MM-DD
//   GET /api/stops/boardings?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET /api/stops/boardings?bus_id=515
app.get('/api/stops/boardings', (req, res) => {
  try {
    const { date, from, to, bus_id } = req.query;
    let where = ' WHERE stop != \'-\' ';
    const params = {};
    if (bus_id) { where += ' AND bus_id = @bus_id'; params.bus_id = bus_id; }
    if (date)   { where += ' AND date = @date';     params.date = date; }
    else if (from && to) { where += ' AND date BETWEEN @from AND @to'; params.from = from; params.to = to; }
    else if (!date && !from && !to) {
      const today = new Date().toISOString().slice(0, 10);
      where += ' AND date = @today'; params.today = today;
    }
    const rows = db.prepare(`
      SELECT
        route,
        stop,
        SUM(evt_in)  AS boardings,
        SUM(evt_out) AS alightings,
        SUM(CASE WHEN stop_source = 'gps'       THEN evt_in + evt_out ELSE 0 END) AS evt_gps,
        SUM(CASE WHEN stop_source = 'scheduled' THEN evt_in + evt_out ELSE 0 END) AS evt_scheduled,
        COUNT(*) AS event_count,
        MIN(timestamp) AS first_seen,
        MAX(timestamp) AS last_seen
      FROM records
      ${where}
      GROUP BY route, stop
      ORDER BY boardings DESC, alightings DESC
    `).all(params);
    res.json({ filters: { date: date || null, from: from || null, to: to || null, bus_id: bus_id || null }, stops: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historical GPS breadcrumbs for the Live Map playback view.
// Returns one row per recorded GPS sample, filtered by date range / bus.
//   GET /api/history-locations?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET /api/history-locations?date=YYYY-MM-DD
//   GET /api/history-locations?bus_id=515&date=YYYY-MM-DD
// Hard cap of 5000 points to keep the map snappy; if exceeded we downsample uniformly.
app.get('/api/history-locations', (req, res) => {
  try {
    const { date, from, to, bus_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
    let where = " WHERE lat != 0 AND lng != 0 ";
    const params = {};
    if (bus_id)            { where += " AND bus_id = @bus_id"; params.bus_id = bus_id; }
    if (date)              { where += " AND date = @date";     params.date = date; }
    else if (from && to)   { where += " AND date BETWEEN @from AND @to"; params.from = from; params.to = to; }
    else if (!date && !from && !to) {
      const today = new Date().toISOString().slice(0, 10);
      where += " AND date = @today"; params.today = today;
    }

    // Count first so we can decide whether to downsample.
    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM records ${where}`).get(params);
    const total = totalRow.n || 0;
    let rows;
    if (total <= limit) {
      rows = db.prepare(`
        SELECT timestamp, bus_id, route, stop, lat, lng, speed, onboard, stop_source
        FROM records ${where}
        ORDER BY timestamp ASC
      `).all(params);
    } else {
      // Uniform downsample: pick every Nth row so the trail still represents the full span.
      const step = Math.ceil(total / limit);
      params.step = step;
      rows = db.prepare(`
        SELECT timestamp, bus_id, route, stop, lat, lng, speed, onboard, stop_source
        FROM (
          SELECT *, (ROW_NUMBER() OVER (ORDER BY timestamp ASC)) AS rn
          FROM records ${where}
        )
        WHERE rn % @step = 0
        ORDER BY timestamp ASC
      `).all(params);
    }

    res.json({
      filters: { date: date || null, from: from || null, to: to || null, bus_id: bus_id || null },
      total_available: total,
      returned: rows.length,
      downsampled: total > limit,
      points: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current scheduled stop per bus right now — useful for dashboards/tooltips.
app.get('/api/stops/current', (req, res) => {
  const now = Date.now();
  const buses = {};
  for (const busId of Object.keys(BUS_ROUTE_LOOKUP)) {
    const s = currentScheduledStop(busId, now);
    if (s) buses[busId] = s;
  }
  res.json({ now: new Date(now).toISOString(), buses });
});


// --- Records (raw data for Data Explorer) ---

app.get('/api/records', (req, res) => {
  const { date, from, to, bus_id, limit = 500, offset = 0 } = req.query;
  let sql = 'SELECT * FROM records WHERE 1=1';
  const params = {};

  if (date) {
    sql += ' AND date = @date';
    params.date = date;
  } else if (from && to) {
    sql += ' AND date BETWEEN @from AND @to';
    params.from = from;
    params.to = to;
  } else if (from) {
    sql += ' AND date >= @from';
    params.from = from;
  } else if (to) {
    sql += ' AND date <= @to';
    params.to = to;
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
      fromDate = displayDateStr(now);
      break;
    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      fromDate = displayDateStr(d);
      break;
    }
    case 'month': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      fromDate = displayDateStr(d);
      break;
    }
    case 'year': {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - 1);
      fromDate = displayDateStr(d);
      break;
    }
    default:
      fromDate = period; // Allow raw date
  }

  const toDate = displayDateStr(now);

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

// ===========================================
// COUNTER RESET ENDPOINT
// ===========================================
// POST /api/reset-counter/:busId
// Resets the live onboard counter for a specific bus to 0
// Also inserts a reset event record into the database
app.post('/api/reset-counter/:busId', (req, res) => {
  const busId = req.params.busId;
  if (!busId) return res.status(400).json({ error: 'busId required' });

  // Reset live in-memory state
  if (liveDevices[busId]) {
    liveDevices[busId].onboard = 0;
    liveDevices[busId].occupancy = 0;
    liveDevices[busId].lastReset = new Date().toISOString();
    console.log(`[RESET] Onboard counter reset to 0 for bus: ${busId}`);
  }

  // Reset the continuous running-onboard tally (in-memory + persisted) so the
  // running-tally model genuinely starts from 0 and does not resurrect on the
  // next flush from the stored bus_state value.
  busRunningOnboard[busId] = 0;
  try {
    upsertBusState.run({ bus_id: busId, running_onboard: 0, updated_at: new Date().toISOString() });
  } catch (err) {
    console.error('[RESET] bus_state reset error:', err.message);
  }

  // Insert a reset marker record into the database
  try {
    const now = new Date();
    const ts = now.toISOString().slice(0, 16).replace('T', ' ');
    const dateStr = now.toISOString().slice(0, 10);
    const hour = now.getHours();
    db.prepare(`
      INSERT INTO records (timestamp, date, hour, bus_id, route, stop, boardings, alightings, onboard, occupancy, lat, lng, msg_type)
      VALUES (?, ?, ?, ?, '-', '-', 0, 0, 0, 0, 0, 0, 'RESET')
    `).run(ts, dateStr, hour, busId);
  } catch (e) {
    console.warn('[RESET] DB insert failed:', e.message);
  }

  res.json({ success: true, busId, onboard: 0, resetAt: new Date().toISOString() });
});

// POST /api/admin/backfill-history-locations — re-snap stale Minneapolis-era
// rows to their scheduled route position based on timestamp. Idempotent.
app.post('/api/admin/backfill-history-locations', (req, res) => {
  try {
    const STALE_LAT = 44.9778;
    const STALE_LNG = -93.265;
    const TOL = 0.001;
    const near = (a, b) => Math.abs(a - b) < TOL;
    const lerp = (a, b, t) => a + (b - a) * t;

    // Build per-bus route lookup from in-memory ROUTES (loaded from data/stops.json).
    const busRoute = {};
    try {
      const stopsRaw = JSON.parse(fs.readFileSync(STOPS_PATH, 'utf8'));
      for (const [routeKey, route] of Object.entries(stopsRaw.routes || {})) {
        for (const busId of (route.bus_ids || [])) {
          busRoute[busId] = {
            routeKey,
            loopMinutes: route.loop_minutes || 40,
            stops: route.stops || [],
          };
        }
      }
    } catch (e) {
      return res.status(500).json({ error: 'Failed to load stops.json', detail: e.message });
    }

    const rows = db.prepare(`
      SELECT rowid, timestamp, bus_id, lat, lng
      FROM records
      WHERE lat IS NOT NULL AND lng IS NOT NULL
    `).all();

    const upd = db.prepare(`
      UPDATE records SET lat = @lat, lng = @lng, stop = @stop, route = @route, stop_source = 'backfilled'
      WHERE rowid = @rowid
    `);

    let touched = 0, skippedNotStale = 0, skippedNoRoute = 0;
    const updates = [];
    for (const r of rows) {
      if (!(near(r.lat, STALE_LAT) && near(r.lng, STALE_LNG))) { skippedNotStale++; continue; }
      const rt = busRoute[r.bus_id];
      if (!rt || !rt.stops.length) { skippedNoRoute++; continue; }

      const ts = new Date(r.timestamp);
      const minsSinceEpoch = Math.floor(ts.getTime() / 60000);
      const elapsed = minsSinceEpoch % rt.loopMinutes;
      const n = rt.stops.length;
      const segmentMinutes = rt.loopMinutes / n;
      const rawSeg = elapsed / segmentMinutes;
      const segIdx = Math.floor(rawSeg) % n;
      const frac = rawSeg - Math.floor(rawSeg);
      const a = rt.stops[segIdx];
      const b = rt.stops[(segIdx + 1) % n];
      const lat = Math.round(lerp(a.lat, b.lat, frac) * 1e6) / 1e6;
      const lng = Math.round(lerp(a.lng, b.lng, frac) * 1e6) / 1e6;
      const stop = frac < 0.2 ? a.name : (frac > 0.8 ? b.name : `${a.name} -> ${b.name}`);
      updates.push({ rowid: r.rowid, lat, lng, stop, route: rt.routeKey });
      touched++;
    }

    const tx = db.transaction((items) => {
      for (const it of items) upd.run(it);
    });
    if (updates.length > 0) tx(updates);

    res.json({
      scanned: rows.length,
      updated: touched,
      skipped_not_stale: skippedNotStale,
      skipped_no_route: skippedNoRoute,
    });
  } catch (e) {
    console.error('[BACKFILL]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  const recordCount = db.prepare('SELECT COUNT(*) as cnt FROM records').get().cnt;
  let dbFile = { path: DB_PATH, exists: false, sizeBytes: 0, mtime: null };
  try {
    const st = fs.statSync(DB_PATH);
    dbFile = { path: DB_PATH, exists: true, sizeBytes: st.size, mtime: st.mtime.toISOString() };
  } catch (e) { /* file missing */ }
  res.json({
    status: 'ok',
    mqtt: mqttStats.connected ? 'connected' : 'disconnected',
    mqttMessages: mqttStats.messageCount,
    dbRecords: recordCount,
    uptime: Math.round(process.uptime()),
    dbFile,
  });
});


// POST /api/clear-today — wipe today's DB records and reset in-memory day totals
app.all('/api/clear-today', (req, res) => {
     const today = displayDateStr(new Date());
     try {
            db.prepare('DELETE FROM records WHERE date = ?').run(today);
            db.prepare('DELETE FROM hourly_summary WHERE date = ?').run(today);
            db.prepare('DELETE FROM daily_summary WHERE date = ?').run(today);
            // Reset in-memory day totals for all buses
            for (const busId of Object.keys(busDayTotals)) {
                     busDayTotals[busId] = { dayIn: 0, dayOut: 0, date: today };
                     if (liveDevices[busId]) {
                                liveDevices[busId].totalIn = 0;
                                liveDevices[busId].totalOut = 0;
                                liveDevices[busId].onboard = 0;
                              }
                   }
            console.log(`[CLEAR-TODAY] Cleared all records for ${today}`);
            res.json({ ok: true, date: today, message: 'Today data cleared and counters reset' });
          } catch (err) {
            console.error('[CLEAR-TODAY] Error:', err.message);
            res.status(500).json({ ok: false, error: err.message });
          }
   });

// --- Debug endpoints ---

app.get('/api/debug', (req, res) => {
  res.json({
    description: 'Last 20 raw MQTT JSON payloads (newest first)',
    count: DEBUG_RAW_PAYLOADS.length,
    payloads: DEBUG_RAW_PAYLOADS,
  });
});

app.get('/api/debug/topics', (req, res) => {
  // Connectivity view: which topics/sensors are transmitting and which bus they map to.
  const now = Date.now();
  const topics = Object.entries(TOPIC_REGISTRY)
    .map(([topic, r]) => ({
      topic,
      deviceSn: r.deviceSn,
      busLabel: r.busLabel,
      count: r.count,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      secondsSinceLastSeen: Math.round((now - new Date(r.lastSeen).getTime()) / 1000),
    }))
    .sort((a, b) => a.topic.localeCompare(b.topic));
  // Summarise which configured buses are live
  const busesSeen = [...new Set(topics.map(t => t.busLabel))];
  const configuredBuses = [...new Set(GATEWAYS.map(g => g.label))];
  res.json({
    description: 'Distinct MQTT topics/sensors seen since boot, with resolved bus label',
    configuredBuses,
    busesSeen,
    topics,
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
// Recalculate today's daily_summary from busDayTotals
app.post('/api/recalculate-daily', (req, res) => {
  const today = displayDateStr();
  let updated = 0;
  for (const [busId, ds] of Object.entries(busDayTotals)) {
    if (ds.date !== today) continue;
    const onboard = Math.max(0, ds.dayIn - ds.dayOut);
    const occ = BUS_CAPACITY > 0 ? Math.min(100, Math.round((onboard / BUS_CAPACITY) * 100)) : 0;
    upsertDailySummary.run({ date: today, bus_id: busId, total_in: ds.dayIn, total_out: ds.dayOut, peak_onboard: onboard, peak_hour: new Date().getHours(), avg_occupancy: occ });
    updated++;
  }
  res.json({ success: true, updated, date: today });
});

// ============================================
// START
// ============================================

app.listen(PORT, () => {
  console.log(`[SERVER] APC Backend running on http://localhost:${PORT}`);
  console.log(`[SERVER] Database: ${DB_PATH}`);
  console.log(`[SERVER] API Health: http://localhost:${PORT}/api/health`);
  console.log('[SERVER] Delta-based counting with multi-door merge enabled');

  // NOTE: Previously this block deleted ALL records (including the current day)
  // on every server start — a one-time migration hack for the delta-counting
  // change. It was wiping counts on every redeploy/restart, so it has been
  // removed. Data now persists across restarts on the mounted volume.

  // One-time repair: on June 1-2 the device's `periodic` heartbeat messages
  // carried boarding/alighting movement that the `trigger` events had already
  // recorded, double-counting ridership (e.g. June 2 showed an impossible 1262
  // boardings on a 16-seat bus). Triggers are the authoritative per-event
  // source, so zero out all movement fields on `periodic` records. Heartbeats
  // are kept as rows (for GPS/onboard snapshots) but contribute no counts.
  // Idempotent: already-zeroed rows are skipped.
  try {
    const zeroed = db.prepare(`
      UPDATE records
      SET boardings = 0, alightings = 0, evt_in = 0, evt_out = 0
      WHERE msg_type = 'periodic'
        AND (boardings <> 0 OR alightings <> 0 OR evt_in <> 0 OR evt_out <> 0)
    `).run();
    if (zeroed.changes > 0) console.log(`[REPAIR] Zeroed movement on ${zeroed.changes} periodic heartbeat records (counts now trigger-only)`);
  } catch (err) {
    console.error('[REPAIR] Periodic movement zeroing failed:', err.message);
  }

  // One-time repair: earlier builds wrote physically impossible onboard / occupancy
  // snapshots into raw `records` (e.g. 263, 429 on a 16-seat bus) from device
  // heartbeats. Recompute ONLY the onboard + occupancy columns from the
  // running-tally model (clamp(prev + in - out, 0, capacity)) in timestamp order
  // per bus, using the per-event deltas. With periodic movement zeroed above,
  // the tally is driven purely by trigger events.
  // Idempotent: re-running on already-correct data reproduces the same values.
  try {
    const buses = db.prepare('SELECT DISTINCT bus_id FROM records').all().map(r => r.bus_id);
    let fixedRows = 0;
    const fixTx = db.transaction(() => {
      const upd = db.prepare('UPDATE records SET onboard = ?, occupancy = ? WHERE id = ?');
      for (const busId of buses) {
        // Walk this bus's records in chronological order, carrying the tally
        // across days (matches the live continuous running-tally model).
        const rows = db.prepare(`
          SELECT id, evt_in, evt_out, onboard, occupancy
          FROM records WHERE bus_id = ?
          ORDER BY timestamp ASC, id ASC
        `).all(busId);
        let running = 0;
        for (const row of rows) {
          running = Math.max(0, Math.min(BUS_CAPACITY, running + (row.evt_in || 0) - (row.evt_out || 0)));
          const occ = BUS_CAPACITY > 0 ? Math.round((running / BUS_CAPACITY) * 100) : 0;
          if (row.onboard !== running || Math.round(row.occupancy) !== occ) {
            upd.run(running, occ, row.id);
            fixedRows++;
          }
        }
      }
    });
    fixTx();
    if (fixedRows > 0) console.log(`[REPAIR] Recomputed onboard/occupancy on ${fixedRows} raw records (running-tally, clamped to ${BUS_CAPACITY})`);
  } catch (err) {
    console.error('[REPAIR] Raw onboard recompute failed:', err.message);
  }

  // One-time repair: earlier builds wrote the running DAY total into each hourly
  // bucket (so later hours showed the whole day's total). Rebuild hourly_summary
  // from the per-event deltas in `records`, which are the source of truth, so the
  // Hourly Passenger Flow chart shows true per-hour flow.
  try {
    const rebuilt = db.prepare(`
      SELECT date, hour, bus_id,
             SUM(boardings)  AS boardings,
             SUM(alightings) AS alightings,
             MAX(onboard)    AS max_onboard,
             COUNT(*)        AS msg_count
      FROM records
      GROUP BY date, hour, bus_id
    `).all();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM hourly_summary').run();
      const ins = db.prepare(`
        INSERT INTO hourly_summary (date, hour, bus_id, boardings, alightings, max_onboard, msg_count)
        VALUES (@date, @hour, @bus_id, @boardings, @alightings, @max_onboard, @msg_count)
      `);
      rebuilt.forEach(r => ins.run(r));
    });
    tx();
    console.log(`[REPAIR] Rebuilt ${rebuilt.length} hourly buckets from raw records`);
  } catch (err) {
    console.error('[REPAIR] Hourly rebuild failed:', err.message);
  }

  // One-time repair: earlier (broken) builds wrote impossible values into
  // daily_summary — e.g. peak_onboard 429 and avg_occupancy pinned at 100 on a
  // 16-seat bus — which made the Ridership graphs look wrong. Rebuild
  // daily_summary from the raw `records` (source of truth), clamping onboard to
  // [0, capacity] so peak occupancy and averages are realistic.
  try {
    const dailyRebuilt = db.prepare(`
      SELECT date, bus_id,
             SUM(boardings)  AS total_in,
             SUM(alightings) AS total_out,
             MIN(onboard)    AS min_ob,
             MAX(onboard)    AS max_ob,
             AVG(onboard)    AS avg_ob,
             MIN(timestamp)  AS first_seen,
             MAX(timestamp)  AS last_seen
      FROM records
      GROUP BY date, bus_id
    `).all();
    // Peak hour per (date,bus): the hour with the most boardings.
    const peakHourRows = db.prepare(`
      SELECT date, bus_id, hour, SUM(boardings) AS b
      FROM records GROUP BY date, bus_id, hour
    `).all();
    const peakHourMap = {};
    peakHourRows.forEach(r => {
      const k = r.date + '|' + r.bus_id;
      if (!peakHourMap[k] || r.b > peakHourMap[k].b) peakHourMap[k] = { hour: r.hour, b: r.b };
    });
    const tx2 = db.transaction(() => {
      db.prepare('DELETE FROM daily_summary').run();
      const ins = db.prepare(`
        INSERT INTO daily_summary (date, bus_id, total_in, total_out, peak_onboard, peak_hour, first_seen, last_seen, avg_occupancy)
        VALUES (@date, @bus_id, @total_in, @total_out, @peak_onboard, @peak_hour, @first_seen, @last_seen, @avg_occupancy)
      `);
      dailyRebuilt.forEach(r => {
        const peakOnboard = Math.max(0, Math.min(BUS_CAPACITY, r.max_ob || 0));
        // True average occupancy = mean onboard across the day's records,
        // clamped to capacity, expressed as a percentage of capacity.
        const avgOnboard = Math.max(0, Math.min(BUS_CAPACITY, r.avg_ob != null ? r.avg_ob : 0));
        const avgOccupancy = BUS_CAPACITY > 0
          ? Math.min(100, Math.round((avgOnboard / BUS_CAPACITY) * 100))
          : 0;
        const k = r.date + '|' + r.bus_id;
        ins.run({
          date: r.date, bus_id: r.bus_id,
          total_in: r.total_in || 0, total_out: r.total_out || 0,
          peak_onboard: peakOnboard,
          peak_hour: peakHourMap[k] ? peakHourMap[k].hour : 0,
          first_seen: r.first_seen, last_seen: r.last_seen,
          avg_occupancy: avgOccupancy,
        });
      });
    });
    tx2();
    console.log(`[REPAIR] Rebuilt ${dailyRebuilt.length} daily_summary rows from raw records (onboard clamped to ${BUS_CAPACITY})`);
  } catch (err) {
    console.error('[REPAIR] Daily rebuild failed:', err.message);
  }

  // Rehydrate in-memory day totals from the database so a restart resumes the
  // running count instead of resetting it to zero (which previously caused the
  // daily_summary upsert to overwrite the day's total with a near-zero value).
  try {
    const today = displayDateStr();
    const rows = db.prepare(
      'SELECT bus_id, total_in, total_out FROM daily_summary WHERE date = ?'
    ).all(today);
    rows.forEach(r => {
      busDayTotals[r.bus_id] = { dayIn: r.total_in || 0, dayOut: r.total_out || 0, date: today };
      if (liveDevices[r.bus_id]) {
        liveDevices[r.bus_id].totalIn = r.total_in || 0;
        liveDevices[r.bus_id].totalOut = r.total_out || 0;
      }
    });
    if (rows.length) console.log(`[REHYDRATE] Restored day totals for ${rows.length} bus(es) from DB`);
  } catch (err) {
    console.error('[REHYDRATE] Failed to restore day totals:', err.message);
  }

  // Rehydrate the CONTINUOUS running-onboard tally from bus_state so the
  // occupancy count resumes across restarts/redeploys (running-tally model).
  try {
    const stateRows = db.prepare('SELECT bus_id, running_onboard FROM bus_state').all();
    stateRows.forEach(r => {
      const val = Math.max(0, Math.min(BUS_CAPACITY, r.running_onboard || 0));
      busRunningOnboard[r.bus_id] = val;
      if (liveDevices[r.bus_id]) liveDevices[r.bus_id].onboard = val;
    });
    if (stateRows.length) console.log(`[REHYDRATE] Restored running onboard for ${stateRows.length} bus(es) from bus_state`);
  } catch (err) {
    console.error('[REHYDRATE] Failed to restore running onboard:', err.message);
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
