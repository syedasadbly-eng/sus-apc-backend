#!/usr/bin/env node
/**
 * Backfill historical record lat/lng based on the bus's scheduled route.
 *
 * The historical rows were written when DEPOT_FALLBACK was Minneapolis
 * (44.9778, -93.265) and validFix was false on every MQTT message. So every
 * row has the same Minneapolis coords, which makes playback look static.
 *
 * Strategy: for each row, compute where the bus *should* have been on its
 * scheduled loop at that timestamp, and snap lat/lng to an interpolated
 * point between the surrounding scheduled stops.
 *
 * Idempotent: only updates rows whose lat/lng matches the stale
 * Minneapolis coords (within a tolerance). New real-GPS rows are left alone.
 *
 * Usage:
 *   DB_PATH=./data/apc.db node scripts/backfill-history-locations.js [--dry-run]
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'apc.db');
const STOPS_PATH = path.join(__dirname, '..', 'data', 'stops.json');
const DRY = process.argv.includes('--dry-run');

// The exact stale coords we're replacing (old Minneapolis depot fallback).
const STALE_LAT = 44.9778;
const STALE_LNG = -93.265;
const TOL = 0.001; // ~100m tolerance

function near(a, b) { return Math.abs(a - b) < TOL; }

// Linear interpolation between two stops.
function lerp(a, b, t) { return a + (b - a) * t; }

function pickPositionOnLoop(stops, loopMinutes, elapsedMinutes) {
  const n = stops.length;
  if (n === 0) return null;
  if (n === 1) return { lat: stops[0].lat, lng: stops[0].lng };
  // Map elapsedMinutes (0..loopMinutes) onto segment index + fractional progress.
  const segmentMinutes = loopMinutes / n;
  const rawSeg = elapsedMinutes / segmentMinutes;
  const segIdx = Math.floor(rawSeg) % n;
  const frac = rawSeg - Math.floor(rawSeg);
  const a = stops[segIdx];
  const b = stops[(segIdx + 1) % n];
  return {
    lat: lerp(a.lat, b.lat, frac),
    lng: lerp(a.lng, b.lng, frac),
    stop_name: frac < 0.2 ? a.name : (frac > 0.8 ? b.name : `${a.name} → ${b.name}`),
    near_stop_id: frac < 0.5 ? a.id : b.id,
  };
}

console.log(`[backfill] DB: ${DB_PATH}`);
console.log(`[backfill] Stops: ${STOPS_PATH}`);
console.log(`[backfill] Dry run: ${DRY}`);

if (!fs.existsSync(DB_PATH)) {
  console.error(`[backfill] DB not found: ${DB_PATH}`);
  process.exit(1);
}

const stopsData = JSON.parse(fs.readFileSync(STOPS_PATH, 'utf8'));
const routes = stopsData.routes || {};

// Build per-bus route info.
const busRoute = {};
for (const [routeKey, route] of Object.entries(routes)) {
  for (const busId of (route.bus_ids || [])) {
    busRoute[busId] = {
      routeKey,
      loopMinutes: route.loop_minutes || 40,
      stops: route.stops || [],
    };
  }
}
console.log('[backfill] Bus routes loaded:', Object.keys(busRoute));

const db = new Database(DB_PATH);
const rows = db.prepare(`
  SELECT rowid, timestamp, bus_id, lat, lng, stop, route
  FROM records
  WHERE lat IS NOT NULL AND lng IS NOT NULL
`).all();
console.log(`[backfill] Found ${rows.length} candidate rows`);

const update = db.prepare(`
  UPDATE records SET lat = @lat, lng = @lng, stop = @stop, route = @route, stop_source = 'backfilled'
  WHERE rowid = @rowid
`);

let touched = 0;
let skippedNotStale = 0;
let skippedNoRoute = 0;

const tx = db.transaction((items) => {
  for (const it of items) update.run(it);
});

const updates = [];
for (const r of rows) {
  if (!(near(r.lat, STALE_LAT) && near(r.lng, STALE_LNG))) {
    skippedNotStale++;
    continue;
  }
  const route = busRoute[r.bus_id];
  if (!route) { skippedNoRoute++; continue; }

  const ts = new Date(r.timestamp);
  // Minutes since midnight LOCAL (America/Chicago is server tz; just use UTC minutes mod loop).
  const minsSinceEpoch = Math.floor(ts.getTime() / 60000);
  const elapsed = minsSinceEpoch % route.loopMinutes;
  const pos = pickPositionOnLoop(route.stops, route.loopMinutes, elapsed);
  if (!pos) continue;

  updates.push({
    rowid: r.rowid,
    lat: Math.round(pos.lat * 1e6) / 1e6,
    lng: Math.round(pos.lng * 1e6) / 1e6,
    stop: pos.stop_name,
    route: route.routeKey,
  });
  touched++;
}

console.log(`[backfill] Will update: ${touched}`);
console.log(`[backfill] Skipped (not stale coords): ${skippedNotStale}`);
console.log(`[backfill] Skipped (no route): ${skippedNoRoute}`);

if (!DRY && updates.length > 0) {
  console.log('[backfill] Applying updates in a transaction...');
  tx(updates);
  console.log('[backfill] Done.');
} else if (DRY) {
  console.log('[backfill] DRY RUN — no changes written.');
  console.log('[backfill] Sample updates:');
  for (const u of updates.slice(0, 5)) console.log(' ', u);
}

db.close();
