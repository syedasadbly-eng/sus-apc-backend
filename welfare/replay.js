#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   welfare/replay.js — calibration harness

   Streams historical rows from the `records` table through the welfare rule
   engine and reports what alert volume the current thresholds WOULD have
   produced. No broker, no server, no writes.

   The source database is opened READ-ONLY. This process cannot modify the
   production database even if it is pointed straight at it.

   Usage
     node welfare/replay.js --db ./apc_data.db
     node welfare/replay.js --db /data/apc_data.db --from 2026-06-01 --to 2026-08-31
     node welfare/replay.js --db ./apc_data.db --csv /tmp/events.csv
     node welfare/replay.js --db ./apc_data.db --set loneSustainSec=600,eosStationarySec=900

   Notes
     - Duration-based rules are driven by each row's own timestamp, so a
       replay produces the same result regardless of how fast it runs.
     - `gpsValid` is inferred from stop_source: 'gps' means the row was
       matched by live GPS proximity. Anything else is treated as no live fix,
       which matches how the geofence rules behave in production.
--------------------------------------------------------------------------- */

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { WelfareEngine, SEVERITY_NAME } = require('./engine');

// ---- args -----------------------------------------------------------------

function parseArgs(argv) {
  const out = { db: process.env.DB_PATH || './apc_data.db', from: null, to: null, csv: null, set: {}, quiet: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i += 1];
    if (a === '--db') out.db = next();
    else if (a === '--from') out.from = next();
    else if (a === '--to') out.to = next();
    else if (a === '--csv') out.csv = next();
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--set') {
      for (const pair of String(next()).split(',')) {
        const [k, v] = pair.split('=');
        if (k && v !== undefined) out.set[k.trim()] = Number.isNaN(Number(v)) ? v : Number(v);
      }
    } else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

const args = parseArgs(process.argv);

if (args.help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('--------------------------------------------------------------------------- */')[0]);
  process.exit(0);
}

// ---- open source read-only ------------------------------------------------

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`Could not open ${dbPath} read-only: ${err.message}`);
  process.exit(1);
}

// ---- collect --------------------------------------------------------------

const collected = [];
const engineOpts = {
  store: { insert: (row) => { collected.push(row); return row; } },
  config: args.set,
  now: () => clock,
};
let clock = Date.now();

const engine = new WelfareEngine(engineOpts);

const where = [];
const params = {};
if (args.from) { where.push('date >= @from'); params.from = args.from; }
if (args.to) { where.push('date <= @to'); params.to = args.to; }
const sql = `
  SELECT timestamp, date, bus_id, route, boardings, alightings, onboard, lat, lng, speed, stop_source
  FROM records
  ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
  ORDER BY timestamp ASC, id ASC
`;

let rows;
try {
  rows = db.prepare(sql).all(params);
} catch (err) {
  console.error(`Query failed: ${err.message}`);
  console.error('Does this database have a `records` table with the expected columns?');
  process.exit(1);
}

if (rows.length === 0) {
  console.error('No rows matched. Check --db, --from and --to.');
  process.exit(1);
}

// ---- replay ---------------------------------------------------------------

const t0 = Date.now();
let skipped = 0;

for (const r of rows) {
  const ms = Date.parse(r.timestamp);
  if (Number.isNaN(ms)) { skipped += 1; continue; }
  clock = ms;

  engine.ingest({
    busId: String(r.bus_id || '').trim() || 'unknown',
    onboard: r.onboard,
    dayIn: r.boardings,
    dayOut: r.alightings,
    lat: r.lat,
    lng: r.lng,
    speed: r.speed,
    // 'gps' means the row was matched against a live fix. Anything else is
    // a scheduled guess, which the geofence rules must not trust.
    gpsValid: r.stop_source === 'gps',
    route: r.route,
    ts: ms,
  });
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// ---- report ---------------------------------------------------------------

const first = rows[0].timestamp;
const last = rows[rows.length - 1].timestamp;
const days = new Set(rows.map((r) => r.date)).size;

// The store normally stamps `date` on insert; in replay we derive it from
// detected_at in the configured timezone so day buckets match the dashboard.
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: engine.cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
});
for (const e of collected) {
  if (!e.date) {
    const ms = Date.parse(e.detected_at);
    e.date = Number.isNaN(ms) ? 'unknown' : dayFmt.format(new Date(ms));
  }
}

const by = (key) => collected.reduce((m, e) => { m[e[key]] = (m[e[key]] ?? 0) + 1; return m; }, {});
const table = (obj, label) => {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return `  (none)\n`;
  const w = Math.max(label.length, ...entries.map(([k]) => String(k).length));
  let s = `  ${label.padEnd(w)}  count   per day\n  ${'-'.repeat(w)}  -----   -------\n`;
  for (const [k, v] of entries) {
    s += `  ${String(k).padEnd(w)}  ${String(v).padStart(5)}   ${(v / days).toFixed(2).padStart(7)}\n`;
  }
  return s;
};

const cfg = engine.cfg;
console.log(`
WELFARE REPLAY
==============================================================
Source        ${dbPath}  (read-only)
Rows          ${rows.length.toLocaleString()}${skipped ? `  (${skipped} skipped: unparseable timestamp)` : ''}
Window        ${first}  ->  ${last}
Service days  ${days}
Replayed in   ${elapsed}s

Thresholds used
  lone traveller sustain   ${cfg.loneSustainSec}s
  night window             ${cfg.lateNightFrom}:00 - ${cfg.lateNightTo}:00 ${cfg.timezone}
  end-of-service dwell     ${cfg.eosStationarySec}s under ${cfg.stationarySpeedKph} km/h
  stale / offline          ${cfg.staleAfterSec}s / ${cfg.offlineAfterSec}s
  stuck counter            ${cfg.stuckCounterMinutes} min across ${cfg.stuckCounterMinDistanceKm} km
  cooldown                 ${cfg.alertCooldownSec}s per rule per vehicle

TOTAL EVENTS  ${collected.length.toLocaleString()}   (${(collected.length / days).toFixed(2)} per service day)

By severity
${table(by('severity_name'), 'severity')}
By type
${table(by('event_type'), 'event type')}
By vehicle
${table(by('bus_id'), 'bus')}`);

// Noisiest days — the useful signal for spotting a threshold that is too tight.
const perDay = by('date');
const worst = Object.entries(perDay).sort((a, b) => b[1] - a[1]).slice(0, 8);
if (worst.length) {
  console.log('Noisiest days');
  const w = Math.max(4, ...worst.map(([d]) => d.length));
  console.log(`  ${'date'.padEnd(w)}  events`);
  console.log(`  ${'-'.repeat(w)}  ------`);
  for (const [d, n] of worst) console.log(`  ${d.padEnd(w)}  ${String(n).padStart(6)}`);
  console.log('');
}

// How much of the window was actually trustworthy — the honest caveat on
// every number above.
const r12 = collected.filter((e) => String(e.rule || '').startsWith('R12')).length;
if (r12) {
  const pct = ((r12 / collected.length) * 100).toFixed(0);
  console.log(`NOTE  ${r12} of ${collected.length} events (${pct}%) are Rule 12 data-integrity`);
  console.log('      findings, not welfare incidents. A high share here means the');
  console.log('      feed quality needs attention before the welfare thresholds');
  console.log('      can be judged at all.\n');
}

if (args.csv) {
  const cols = ['detected_at', 'date', 'bus_id', 'event_type', 'severity', 'severity_name', 'rule', 'reason', 'onboard', 'lat', 'lng'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(','), ...collected.map((e) => cols.map((c) => esc(e[c])).join(','))].join('\n');
  fs.writeFileSync(args.csv, `${body}\n`);
  console.log(`CSV written: ${args.csv}  (${collected.length} rows)\n`);
}

db.close();
