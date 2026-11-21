/* ============================================================================
   SMART URBAN SENSING — DEMO MODE
   ----------------------------------------------------------------------------
   A self-contained sample-data source for promotion, sales demos and
   screenshots. Inert unless DEMO_MODE=true.

   What it does when enabled
     1. Forces the live MQTT feed OFF (server and browser), so a demo service
        can never read or write the real client feed.
     2. Backfills history (default 400 days) of realistic passenger counts for
        buses 515 and 419, written straight into `records` exactly as the live
        ingest writes them. Daily alightings land at ~99% of boardings.
     3. Runs a live simulator that pushes VS125-style trigger payloads and
        UR35-style GPS payloads through the SAME handleMessage() path real
        sensors use, so every page (KPIs, charts, map, stops, welfare
        occupancy) moves on its own.
     4. Generates welfare incidents — falls, altercations, loud noise,
        altercation + noise, overcrowding, unresponsive passenger, nobody
        getting off, parked with people on, lone traveller, left on board at
        the depot — with realistic acknowledge / resolve follow-up.

   Everything is deterministic per (bus, day): restarts and redeploys re-derive
   the same day and only fill in what is missing, so there are no duplicates.

   Safety
     - Refuses to run against a database that already holds non-demo data
       (no demo_meta row) — point DB_PATH at a fresh volume.
     - Never set DEMO_MODE on a client-facing / production service.
   ========================================================================== */

'use strict';

const ENABLED = process.env.DEMO_MODE === 'true';

// Applied at require time, BEFORE welfare/engine.js reads its config. server.js
// requires this module first for exactly that reason.
if (ENABLED) {
  process.env.MQTT_ENABLED = 'false';
  if (process.env.FEATURE_WELFARE === undefined) process.env.FEATURE_WELFARE = 'true';
  // Every rule family on, so Signal Delivery reads "Watching" across the board
  // and the rules genuinely run on the simulated feed (overcrowding fires on
  // its own at the peaks). Camera-side incidents are scripted below.
  if (process.env.WELFARE_RULES === undefined) process.env.WELFARE_RULES = 'all';
  // The derived-occupancy model corrects for real sensors that miss
  // alightings. The simulated count is already near-true, so the model would
  // only make the Welfare Console disagree with the dashboard.
  if (process.env.WELFARE_DERIVED_OCCUPANCY === undefined) process.env.WELFARE_DERIVED_OCCUPANCY = 'false';
}

const CFG = {
  historyDays: Number(process.env.DEMO_HISTORY_DAYS || 400),
  welfareHistoryDays: Number(process.env.DEMO_WELFARE_HISTORY_DAYS || 45),
  // Local service window (DISPLAY_TZ). Defaults are wider than the real Mayo
  // timetable so the demo is "live" across UK and US working hours.
  serviceStart: process.env.DEMO_SERVICE_START || '05:00',
  serviceEnd: process.env.DEMO_SERVICE_END || '23:30',
  weekends: process.env.DEMO_WEEKENDS !== 'false',
  // Share of movements the simulated sensor misses. Missing ~0.9% of
  // alightings (and no boardings) gives alightings ≈ 99% of boardings over a
  // full service day, never above 100%.
  missOut: Number(process.env.DEMO_MISS_ALIGHT || 0.009),
  missIn: Number(process.env.DEMO_MISS_BOARD || 0),
  // Mean minutes between welfare incidents during service.
  welfareEveryMin: Number(process.env.DEMO_WELFARE_EVERY_MIN || 30),
  tickMs: 5000,
  gpsEveryMs: 20000,
  badge: process.env.DEMO_BADGE !== 'false',
  openAccess: process.env.DEMO_OPEN_ACCESS === 'true',
  // White-label: hide the pilot client's name and logo (on by default).
  // Set DEMO_WHITE_LABEL=false to keep the client branding.
  whiteLabel: process.env.DEMO_WHITE_LABEL !== 'false',
};

const BUSES = {
  '515': {
    topics: ['bus/001', 'bus/002'],         // door 1 (gateway + GPS), door 2
    gpsTopic: 'bus/001',
    base: 5.6,                              // mean boardings per stop at weight 1, profile 1
    // role: 'start' | 'mid' | 'end' — how many people alight there
    stops: [
      { weight: 1.25, role: 'start' },      // Gonda
      { weight: 1.0, role: 'mid' },         // Charlton
      { weight: 1.1, role: 'end' },         // Mary Brigh — Saint Marys
      { weight: 0.6, role: 'mid' },         // Charlton (return)
      { weight: 0.15, role: 'end' },        // Gonda (return)
    ],
  },
  '419': {
    topics: ['bus/003'],
    gpsTopic: 'bus/003',
    base: 2.9,
    stops: [
      { weight: 1.35, role: 'start' },      // Building B
      { weight: 1.0, role: 'end' },         // Baldwin
      { weight: 0.1, role: 'end' },         // Building B (return)
    ],
  },
};

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngFor(key) {
  let a = hashStr(key) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(rng, lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(rng)));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}
function gauss(rng) {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function binomialMiss(rng, n, p) { let m = 0; for (let i = 0; i < n; i++) if (rng() < p) m++; return m; }
function pickWeighted(rng, items) {
  const total = items.reduce((s, it) => s + it.w, 0);
  let r = rng() * total;
  for (const it of items) { r -= it.w; if (r <= 0) return it; }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// Time-zone helpers (DISPLAY_TZ local wall clock <-> UTC ms)
// ---------------------------------------------------------------------------

let TZ = 'America/Chicago';
function localParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = {};
  f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return {
    y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second,
    weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}`,
  };
}
// UTC offset is resolved once per date (at local noon) and cached. Service
// never runs across the 02:00 DST switch, so one offset per day is exact.
const offsetCache = new Map();
function localToUtcMs(dateStr, minutesOfDay) {
  let off = offsetCache.get(dateStr);
  if (off === undefined) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d, 12, 0);
    let ms = guess;
    for (let i = 0; i < 2; i++) {
      const lp = localParts(ms);
      ms += guess - Date.UTC(lp.y, lp.m - 1, lp.d, lp.hh, lp.mm, lp.ss);
    }
    off = ms - guess;
    offsetCache.set(dateStr, off);
    if (offsetCache.size > 2000) offsetCache.delete(offsetCache.keys().next().value);
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, 0) + minutesOfDay * 60000 + off;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function hm(s) { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); }

// ---------------------------------------------------------------------------
// Demand model
// ---------------------------------------------------------------------------

function g(x, mu, s) { return Math.exp(-((x - mu) ** 2) / (2 * s * s)); }
// Hospital shuttle: morning appointments, lunchtime, afternoon discharges.
function profile(hourFloat) {
  const shoulder = (hourFloat < 6 || hourFloat > 20) ? 0.12 : 0.28;
  return shoulder + 0.95 * g(hourFloat, 7.8, 0.9) + 0.6 * g(hourFloat, 12.2, 1.1) + 0.85 * g(hourFloat, 16.4, 0.9);
}
const WEEKDAY_FACTOR = { Mon: 1.08, Tue: 1.02, Wed: 1.0, Thu: 1.04, Fri: 0.93, Sat: 0.42, Sun: 0.3 };
const NO_SERVICE = new Set(['12-25', '01-01', '07-04']);

function dayFactor(dateStr, weekday, epochDate) {
  const rng = rngFor(`day:${dateStr}`);
  // Gentle month-on-month growth so trend views read like a maturing service.
  const months = Math.max(0, (Date.parse(dateStr) - Date.parse(epochDate)) / (30.4 * 86400000));
  const growth = 1 + 0.018 * months;
  const noise = 1 + 0.07 * gauss(rng);
  return (WEEKDAY_FACTOR[weekday] || 1) * growth * Math.max(0.75, Math.min(1.25, noise));
}

// ---------------------------------------------------------------------------
// Day plan: every stop visit for one bus on one service day
// ---------------------------------------------------------------------------

let STOPS = {};      // busId -> [{name, lat, lng}]
let LOOP_MIN = {};   // busId -> loop minutes
let EPOCH = null;    // first demo date (growth baseline)
const planCache = new Map();

function serviceDay(dateStr) {
  const wd = localParts(localToUtcMs(dateStr, 12 * 60)).weekday;
  if (NO_SERVICE.has(dateStr.slice(5))) return { running: false, wd };
  if (!CFG.weekends && (wd === 'Sat' || wd === 'Sun')) return { running: false, wd };
  return { running: true, wd };
}

/**
 * Returns { visits: [{ts, stopIdx, name, lat, lng, boardings, alightings,
 *   countedIn, countedOut, onboard (true), tally (as the server will hold it)}],
 *   resetTs, residual } — deterministic for (busId, dateStr).
 */
function planDay(busId, dateStr, capacity) {
  const key = `${busId}|${dateStr}`;
  if (planCache.has(key)) return planCache.get(key);
  const bus = BUSES[busId];
  const stops = STOPS[busId];
  const sd = serviceDay(dateStr);
  const plan = { visits: [], resetTs: null, residual: 0, running: sd.running };
  if (!sd.running || !stops || !stops.length) { planCache.set(key, plan); return plan; }

  const rng = rngFor(`plan:${key}`);
  const df = dayFactor(dateStr, sd.wd, EPOCH);
  const stepMin = LOOP_MIN[busId] / stops.length;
  // Each bus starts a little differently each day (driver, traffic).
  const startMin = hm(CFG.serviceStart) + (busId === '419' ? 12 : 0) + Math.round(rng() * 6);
  const endMin = hm(CFG.serviceEnd) - (busId === '419' ? 15 : 0);

  let onboard = 0;   // true passengers aboard
  let tally = 0;     // what the server's clamped running tally will read
  const nVisits = Math.floor((endMin - startMin) / stepMin);
  for (let i = 0; i <= nVisits; i++) {
    const minute = startMin + i * stepMin + (rng() - 0.5) * 1.5;
    const ts = localToUtcMs(dateStr, minute);
    const stopIdx = i % stops.length;
    const spec = bus.stops[stopIdx] || { weight: 1, role: 'mid' };
    const last = i === nVisits;

    let alight;
    if (last || spec.role === 'end') alight = onboard;
    else if (spec.role === 'mid') alight = Math.round(onboard * (0.3 + rng() * 0.25));
    else alight = Math.round(onboard * rng() * 0.15);
    alight = Math.min(onboard, alight);
    onboard -= alight;

    let board = 0;
    if (!last) {
      const lambda = bus.base * spec.weight * profile(minute / 60) * df;
      board = Math.min(capacity - onboard, poisson(rng, lambda));
    }
    onboard += board;

    // Sensor view: a small share of movements are missed.
    const countedOut = alight - binomialMiss(rng, alight, CFG.missOut);
    const countedIn = board - binomialMiss(rng, board, CFG.missIn);
    tally = Math.max(0, Math.min(capacity, tally + countedIn - countedOut));

    if (board === 0 && alight === 0) {
      plan.visits.push({ ts, stopIdx, ...stops[stopIdx], boardings: 0, alightings: 0, countedIn: 0, countedOut: 0, onboard, tally, empty: true });
      continue;
    }
    plan.visits.push({ ts, stopIdx, ...stops[stopIdx], boardings: board, alightings: alight, countedIn, countedOut, onboard, tally });
  }
  const lastTs = plan.visits.length ? plan.visits[plan.visits.length - 1].ts : localToUtcMs(dateStr, endMin);
  plan.resetTs = lastTs + 6 * 60000;   // depot reset after the final run
  plan.residual = tally;
  plan.depot = stops[0];
  planCache.set(key, plan);
  if (planCache.size > 64) planCache.delete(planCache.keys().next().value);
  return plan;
}

// ---------------------------------------------------------------------------
// Welfare incident plan
// ---------------------------------------------------------------------------

const WELFARE_TYPES = [
  { w: 16, type: 'fall', source: 'camera', severity: 3, rule: 'camera_fall', use_case: 2,
    reason: () => 'Fall detected by AI Pro Dome' },
  { w: 15, type: 'sound_classification', source: 'camera', severity: 2, rule: 'camera_sound', use_case: 7,
    reason: (r) => pick(r, ['Loud noise detected by AI Pro Dome (shouting)', 'Loud noise detected by AI Pro Dome (scream)', 'Loud noise detected by AI Pro Dome (glass break)']) },
  { w: 10, type: 'violence', source: 'camera', severity: 4, rule: 'camera_violence', use_case: 7,
    reason: () => 'Violent behaviour detected by AI Pro Dome' },
  { w: 8, type: 'violence_disruption', source: 'camera', severity: 4, rule: 'camera_violence_sound', use_case: 7,
    reason: (r) => `Violence and sound agree within ${8 + Math.floor(r() * 50)}s \u2014 ${r() < 0.5 ? 'sound then violence' : 'violence then sound'}` },
  { w: 13, type: 'overcrowding', source: 'vs125', severity: 3, rule: 'R5_overcrowding', use_case: 5,
    reason: (r, ctx) => `Route capacity exceeded: ${ctx.capacity}/${ctx.capacity} passengers aboard (100%) for ${2 + Math.floor(r() * 6)} min`, peak: true },
  { w: 4, type: 'dwell_distress_unresponsive', source: 'camera', severity: 4, rule: 'R2_dwell_distress', use_case: 3,
    reason: () => 'Fall detected and passenger has not moved for 3 min with the vehicle held' },
  { w: 9, type: 'dwell_no_alighting', source: 'vs125', severity: 2, rule: 'R1_dwell_no_alighting', use_case: 1,
    reason: (r, ctx) => `${Math.max(1, ctx.onboard)} aboard for ${45 + Math.floor(r() * 30)} min with nobody alighting` },
  { w: 7, type: 'stationary_with_occupants', source: 'vs125', severity: 2, rule: 'R9_stationary_with_occupants', use_case: 1,
    reason: (r, ctx) => `${Math.max(1, ctx.onboard)} aboard, stationary ${6 + Math.floor(r() * 9)} min` },
  { w: 6, type: 'lone_traveller', source: 'vs125', severity: 2, rule: 'R3_lone_traveller', use_case: 6,
    reason: (r) => `Single occupant for ${5 + Math.floor(r() * 8)} min` },
];
const RESOLUTION_NOTES = {
  fall: ['Driver attended — passenger helped to seat, no injury', 'Passenger assisted at stop by site staff', 'Driver checked, passenger OK'],
  sound_classification: ['Live view checked — raised voices, no incident', 'Passenger phone call, no action needed', 'Dropped bag, no incident'],
  violence: ['Driver de-escalated, passengers separated', 'Security met the bus at next stop', 'Incident logged, CCTV clip saved'],
  violence_disruption: ['Security met the bus at next stop — incident report filed', 'Driver held at stop, police informed, resolved on scene'],
  overcrowding: ['Second vehicle dispatched', 'Load eased at next stop', 'Operator notified, headway adjusted'],
  dwell_distress_unresponsive: ['Paramedics attended, passenger transferred to ED', 'Passenger responsive after driver check, assisted off'],
  dwell_no_alighting: ['Driver walked the bus — all OK', 'Passengers on round trip, no action'],
  stationary_with_occupants: ['Held for wheelchair boarding', 'Traffic hold on 2nd St SW'],
  lone_traveller: ['Driver checked passenger knows their stop', 'No action needed'],
  end_of_service_occupancy: ['Driver walked the bus — passenger assisted off', 'Passenger asleep, woken and assisted'],
};
function pick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }

function welfareDay(dateStr, capacity) {
  const rng = rngFor(`welfare:${dateStr}`);
  const out = [];
  if (!serviceDay(dateStr).running) return out;
  const start = hm(CFG.serviceStart) + 20, end = hm(CFG.serviceEnd) - 20;
  let t = start + rng() * CFG.welfareEveryMin;
  let n = 0;
  while (t < end) {
    const busId = rng() < 0.62 ? '515' : '419';
    let spec = pickWeighted(rng, WELFARE_TYPES);
    let minute = t;
    if (spec.peak) {
      // Overcrowding only makes sense near a peak.
      const peaks = [7.8, 12.2, 16.4].map((h) => h * 60);
      minute = peaks[Math.floor(rng() * peaks.length)] + (rng() - 0.5) * 50;
    }
    out.push(buildIncident(dateStr, minute, busId, spec, rng, capacity, n++));
    t += CFG.welfareEveryMin * (0.4 + rng() * 1.2);
  }
  // Left on board at the depot — roughly twice a week, after the last run.
  if (rng() < 0.3) {
    const busId = rng() < 0.6 ? '515' : '419';
    const plan = planDay(busId, dateStr, capacity);
    if (plan.visits.length) {
      const spec = { type: 'end_of_service_occupancy', source: 'vs125', severity: 4, rule: 'R6_end_of_service_occupancy', use_case: 6,
        reason: () => `1 passenger(s) still aboard at ${STOPS[busId][0].name} after ${6 + Math.floor(rng() * 6)} min stationary \u2014 vehicle appears out of service` };
      const minute = (plan.resetTs - localToUtcMs(dateStr, 0)) / 60000 - 2;
      out.push(buildIncident(dateStr, minute, busId, spec, rng, capacity, n++));
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function buildIncident(dateStr, minute, busId, spec, rng, capacity, n) {
  const ts = Math.round(localToUtcMs(dateStr, minute));
  const plan = planDay(busId, dateStr, capacity);
  // Nearest visit before the incident gives position and onboard count.
  let v = null;
  for (const x of plan.visits) { if (x.ts <= ts) v = x; else break; }
  if (!v) v = plan.visits[0] || { ...(STOPS[busId] || [{}])[0], onboard: 0 };
  const onboard = spec.type === 'overcrowding' ? capacity
    : spec.type === 'lone_traveller' ? 1
      : Math.max(spec.source === 'camera' ? 2 : 1, v.onboard || 0);
  const ctx = { capacity, onboard };
  // Most incidents are picked up in a few minutes and closed within the hour,
  // so the console normally shows one or two open items alongside history.
  const ackAfterMin = 3 + rng() * 17;
  const resolveAfterMin = ackAfterMin + 12 + rng() * 45;
  const notes = RESOLUTION_NOTES[spec.type] || ['Resolved'];
  return {
    ts,
    ackAt: ts + ackAfterMin * 60000,
    resolveAt: ts + resolveAfterMin * 60000,
    ackBy: rng() < 0.7 ? 'Control room' : `Driver ${busId}`,
    driverOk: spec.source === 'camera' && rng() < 0.35,
    notes: pick(rng, notes),
    row: {
      event_id: `demo-${busId}-${spec.type}-${dateStr}-${n}`,
      detected_at: new Date(ts).toISOString(),
      bus_id: busId,
      source: spec.source,
      event_type: spec.type,
      severity: spec.severity,
      severity_name: { 1: 'log', 2: 'notify', 3: 'alert', 4: 'escalate' }[spec.severity],
      rule: spec.rule,
      reason: spec.reason(rng, ctx),
      use_case: spec.use_case,
      route: busId,
      lat: v.lat ?? null,
      lng: v.lng ?? null,
      onboard,
      sensor_health: spec.source === 'camera' ? 'camera' : 'ok',
      acknowledged: 0,
      detail: {
        demo: true,
        signal: spec.type,
        device: spec.source === 'camera' ? 'MS-C2972-RFPG1' : 'VS125',
        location: v.name || null,
        vehicle_context: { route: busId, onboard, gps_valid: true },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

let ctx = null;          // set by init()
let active = false;
const lastEmitted = {};  // busId -> ts of last visit pushed live
const lastGpsAt = {};
const resetDone = {};    // busId|date -> true

function init(c) {
  if (!ENABLED) return false;
  ctx = c;
  TZ = c.displayTz || TZ;
  for (const [routeKey, route] of Object.entries((c.stopRegistry && c.stopRegistry.routes) || {})) {
    for (const bid of route.bus_ids || [routeKey]) {
      if (!BUSES[bid]) continue;
      STOPS[bid] = (route.stops || []).map((s) => ({ name: s.name, lat: s.lat, lng: s.lng }));
      LOOP_MIN[bid] = route.loop_minutes || 45;
    }
  }
  c.db.exec(`CREATE TABLE IF NOT EXISTS demo_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const meta = c.db.prepare(`SELECT value FROM demo_meta WHERE key = 'epoch'`).get();
  const realRows = c.db.prepare(`SELECT COUNT(*) AS n FROM records`).get().n;
  if (!meta && realRows > 0) {
    console.error('[DEMO] REFUSING TO START: this database already holds non-demo records. '
      + 'Point DB_PATH at a fresh volume for the demo service.');
    return false;
  }
  if (meta) EPOCH = meta.value;
  else {
    EPOCH = addDays(c.displayDateStr(), -CFG.historyDays);
    c.db.prepare(`INSERT INTO demo_meta (key, value) VALUES ('epoch', ?)`).run(EPOCH);
  }
  active = true;
  console.log(`[DEMO] Demo mode ON — sample data from ${EPOCH}, service ${CFG.serviceStart}-${CFG.serviceEnd} ${TZ}, MQTT disabled`);
  return true;
}

/** Fill every visit and reset between the last stored record and now. Runs
 *  BEFORE server.js's startup repairs, which then rebuild the summaries. */
function catchUp() {
  if (!active) return;
  const { db, capacity } = ctx;
  const now = Date.now();
  const today = ctx.displayDateStr();
  const ins = db.prepare(`
    INSERT INTO records (timestamp, date, hour, bus_id, route, stop, boardings, alightings, evt_in, evt_out,
      onboard, occupancy, lat, lng, speed, msg_type, stop_source, stop_dist_m)
    VALUES (@timestamp, @date, @hour, @bus_id, @route, @stop, @boardings, @alightings, @evt_in, @evt_out,
      @onboard, @occupancy, @lat, @lng, 0, @msg_type, @stop_source, @stop_dist_m)`);
  let written = 0;
  const tx = db.transaction(() => {
    for (const busId of Object.keys(BUSES)) {
      if (!STOPS[busId]) continue;
      const lastRow = db.prepare(`SELECT MAX(timestamp) AS t FROM records WHERE bus_id = ?`).get(busId);
      const lastTs = lastRow && lastRow.t ? Date.parse(lastRow.t) : 0;
      let d = lastTs ? ctx.displayDateStr(new Date(lastTs)) : EPOCH;
      let tally = 0;
      const st = db.prepare('SELECT running_onboard FROM bus_state WHERE bus_id = ?').get(busId);
      if (st) tally = st.running_onboard || 0;
      while (d <= today) {
        const plan = planDay(busId, d, capacity);
        const rng = rngFor(`dist:${busId}|${d}`);
        for (const v of plan.visits) {
          if (v.ts <= lastTs || v.ts > now || v.empty) continue;
          const dt = new Date(v.ts);
          ins.run({
            timestamp: dt.toISOString(), date: ctx.displayDateStr(dt), hour: dt.getUTCHours(), bus_id: busId,
            route: busId, stop: v.name, boardings: v.countedIn, alightings: v.countedOut,
            evt_in: v.countedIn, evt_out: v.countedOut, onboard: v.tally,
            occupancy: Math.round((v.tally / capacity) * 100), lat: v.lat, lng: v.lng,
            msg_type: 'trigger', stop_source: 'gps', stop_dist_m: Math.round((4 + rng() * 22) * 10) / 10,
          });
          tally = v.tally;
          written++;
        }
        if (plan.resetTs && plan.resetTs > lastTs && plan.resetTs <= now) {
          const dt = new Date(plan.resetTs);
          // Depot reset: clears the residual from missed alightings. Counts
          // nothing (boardings/alightings 0, stop '-') — only evt_out moves the
          // running tally, so the startup onboard recompute lands on 0.
          ins.run({
            timestamp: dt.toISOString(), date: ctx.displayDateStr(dt), hour: dt.getUTCHours(), bus_id: busId,
            route: busId, stop: '-', boardings: 0, alightings: 0, evt_in: 0, evt_out: plan.residual + 2,
            onboard: 0, occupancy: 0, lat: plan.depot.lat, lng: plan.depot.lng,
            msg_type: 'RESET', stop_source: 'none', stop_dist_m: 0,
          });
          tally = 0;
          resetDone[`${busId}|${d}`] = true;
        }
        d = addDays(d, 1);
      }
      db.prepare(`INSERT INTO bus_state (bus_id, running_onboard, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(bus_id) DO UPDATE SET running_onboard = excluded.running_onboard, updated_at = excluded.updated_at`)
        .run(busId, tally, new Date().toISOString());
      lastEmitted[busId] = now;
    }
  });
  tx();
  if (written) console.log(`[DEMO] Backfilled ${written} stop visits up to now`);
  welfareCatchUp();
}

function welfareCatchUp() {
  if (!ctx.welfare || !ctx.welfare.demoStore) return;
  const store = ctx.welfare.demoStore();
  if (!store) return;
  const { db, capacity } = ctx;
  const now = Date.now();
  const lastRow = db.prepare(`SELECT MAX(detected_at) AS t FROM welfare_events WHERE event_id LIKE 'demo-%' AND event_id NOT LIKE 'demo-manual-%'`).get();
  const lastTs = lastRow && lastRow.t ? Date.parse(lastRow.t) : 0;
  const today = ctx.displayDateStr();
  let d = lastTs ? ctx.displayDateStr(new Date(lastTs)) : addDays(today, -CFG.welfareHistoryDays);
  let n = 0;
  while (d <= today) {
    for (const inc of welfareDay(d, capacity)) {
      if (inc.ts <= lastTs || inc.ts > now) continue;
      store.insert(inc.row);
      applyFollowUp(inc, now, true);
      n++;
    }
    d = addDays(d, 1);
  }
  if (n) console.log(`[DEMO] Backfilled ${n} welfare incidents`);
  if (ctx.welfare.demoCameraSeen) ctx.welfare.demoCameraSeen(db.prepare(
    `SELECT MAX(detected_at) AS t FROM welfare_events WHERE source = 'camera'`).get().t);
}

function applyFollowUp(inc, now, historical) {
  const { db } = ctx;
  const id = inc.row.event_id;
  if (inc.driverOk && now >= inc.ackAt) {
    db.prepare(`UPDATE welfare_events SET driver_response = 'ok', driver_response_at = ?, driver_response_by = ?
      WHERE event_id = ? AND driver_response IS NULL`).run(new Date(inc.ackAt).toISOString(), `driver-${inc.row.bus_id}`, id);
  }
  if (now >= inc.ackAt) {
    db.prepare(`UPDATE welfare_events SET acknowledged = 1, acknowledged_at = ?, acknowledged_by = ?
      WHERE event_id = ? AND acknowledged = 0`).run(new Date(inc.ackAt).toISOString(), inc.ackBy, id);
  }
  if (now >= inc.resolveAt) {
    db.prepare(`UPDATE welfare_events SET resolved = 1, resolved_at = ?, resolved_by = ?, resolution_notes = ?
      WHERE event_id = ? AND resolved = 0`).run(new Date(inc.resolveAt).toISOString(), inc.ackBy, inc.notes, id);
  }
  if (!historical) return;
}

function gpsPayload(lat, lng, speedKph) {
  return {
    data: {
      latitude: `${Math.abs(lat).toFixed(5)} ${lat >= 0 ? 'N' : 'S'}`,
      longitude: `${Math.abs(lng).toFixed(5)} ${lng >= 0 ? 'E' : 'W'}`,
      status: 53,
      speed: Math.round(speedKph * 10) / 10,
    },
  };
}
function triggerPayload(boardings, alightings) {
  // VS125 is mounted inverted on these doors: sensor 'out' = boarding.
  return {
    device_info: { device_sn: 'DEMO-VS125' },
    time_info: { start_time: new Date().toISOString() },
    line_trigger_data: [{ total: { out: boardings, in: alightings } }],
  };
}
function send(topic, payload) {
  try { ctx.handleMessage(topic, Buffer.from(JSON.stringify(payload))); } catch (err) {
    console.error('[DEMO] handleMessage failed:', err.message);
  }
}

function positionAt(busId, plan, now) {
  const vs = plan.visits;
  if (!vs.length || now < vs[0].ts - 5 * 60000 || now > plan.resetTs) {
    const depot = (STOPS[busId] || [])[0];
    return depot ? { lat: depot.lat, lng: depot.lng, speed: 0, inService: false } : null;
  }
  let i = 0;
  while (i < vs.length - 1 && vs[i + 1].ts <= now) i++;
  const a = vs[i], b = vs[Math.min(i + 1, vs.length - 1)];
  const dwellMs = 45000;
  if (now <= a.ts + dwellMs || a === b) return { lat: a.lat, lng: a.lng, speed: 0, inService: true };
  const f = Math.min(1, (now - a.ts - dwellMs) / Math.max(1, b.ts - a.ts - 2 * dwellMs));
  if (f >= 1) return { lat: b.lat, lng: b.lng, speed: 0, inService: true };
  const jitter = (Math.sin(now / 9000) * 0.00008);
  return { lat: a.lat + (b.lat - a.lat) * f + jitter, lng: a.lng + (b.lng - a.lng) * f - jitter, speed: 22 + 8 * Math.sin(now / 13000), inService: true };
}

function tick() {
  const now = Date.now();
  const today = ctx.displayDateStr();
  const yesterday = addDays(today, -1);
  for (const busId of Object.keys(BUSES)) {
    if (!STOPS[busId]) continue;
    const bus = BUSES[busId];
    for (const d of [yesterday, today]) {
      const plan = planDay(busId, d, ctx.capacity);
      for (const v of plan.visits) {
        if (v.ts <= (lastEmitted[busId] || 0) || v.ts > now || v.empty) continue;
        // Arrive (GPS at the stop), then each door reports its share.
        send(bus.gpsTopic, gpsPayload(v.lat, v.lng, 0));
        if (bus.topics.length > 1) {
          const in1 = Math.round(v.countedIn * 0.6), out1 = Math.round(v.countedOut * 0.45);
          if (in1 || out1) send(bus.topics[0], triggerPayload(in1, out1));
          if (v.countedIn - in1 || v.countedOut - out1) send(bus.topics[1], triggerPayload(v.countedIn - in1, v.countedOut - out1));
        } else {
          send(bus.topics[0], triggerPayload(v.countedIn, v.countedOut));
        }
      }
      if (plan.resetTs && plan.resetTs <= now && !resetDone[`${busId}|${d}`] && plan.resetTs > (lastEmitted[busId] || 0)) {
        resetDone[`${busId}|${d}`] = true;
        try { ctx.resetOnboard(busId); } catch (err) { console.error('[DEMO] reset failed:', err.message); }
      }
    }
    lastEmitted[busId] = now;

    if (now - (lastGpsAt[busId] || 0) >= CFG.gpsEveryMs) {
      lastGpsAt[busId] = now;
      const pos = positionAt(busId, planDay(busId, today, ctx.capacity), now);
      if (pos) send(bus.gpsTopic, gpsPayload(pos.lat, pos.lng, pos.speed));
    }
  }
  welfareTick(now, today);
}

const pendingIncidents = new Map(); // event_id -> incident (inserted, follow-up pending)
let welfareSeeded = false;
function welfareTick(now, today) {
  if (!ctx.welfare || !ctx.welfare.demoInject) return;
  if (!welfareSeeded) {
    // Re-attach follow-ups for today's incidents already stored (restart).
    for (const d of [addDays(today, -1), today]) {
      for (const inc of welfareDay(d, ctx.capacity)) if (inc.ts <= now && now < inc.resolveAt) pendingIncidents.set(inc.row.event_id, inc);
    }
    welfareSeeded = true;
  }
  const lastRow = ctx.db.prepare(`SELECT MAX(detected_at) AS t FROM welfare_events WHERE event_id LIKE 'demo-%' AND event_id NOT LIKE 'demo-manual-%'`).get();
  const lastTs = lastRow && lastRow.t ? Date.parse(lastRow.t) : 0;
  for (const inc of welfareDay(today, ctx.capacity)) {
    if (inc.ts <= lastTs || inc.ts > now) continue;
    // Live, the real R5 rule raises overcrowding from the simulated load.
    if (inc.row.event_type === 'overcrowding') continue;
    ctx.welfare.demoInject(inc.row);
    pendingIncidents.set(inc.row.event_id, inc);
    console.log(`[DEMO] welfare ${inc.row.severity_name.toUpperCase()} ${inc.row.bus_id} ${inc.row.event_type}`);
  }
  for (const [id, inc] of pendingIncidents) {
    applyFollowUp(inc, now, false);
    if (now >= inc.resolveAt) pendingIncidents.delete(id);
  }
}

function start() {
  if (!active) return;
  try { tick(); } catch (err) { console.error('[DEMO] tick error:', err.message); }
  const t = setInterval(() => {
    try { tick(); } catch (err) { console.error('[DEMO] tick error:', err.message); }
  }, CFG.tickMs);
  if (t.unref) t.unref();
  console.log('[DEMO] Live simulator running');
}

/**
 * Raise one incident now, for live sales demos ("watch what happens when a
 * passenger falls"). Left open: the presenter acknowledges and resolves it in
 * the console. Types: fall, sound (loud noise), violence, violence_sound,
 * overcrowding, unresponsive, nobody_off, parked, lone, left_on_board.
 */
const MANUAL_ALIASES = {
  fall: 'fall', sound: 'sound_classification', noise: 'sound_classification', loud_noise: 'sound_classification',
  violence: 'violence', altercation: 'violence', violence_sound: 'violence_disruption', fight: 'violence_disruption',
  overcrowding: 'overcrowding', unresponsive: 'dwell_distress_unresponsive', nobody_off: 'dwell_no_alighting',
  parked: 'stationary_with_occupants', lone: 'lone_traveller', left_on_board: 'end_of_service_occupancy',
};
function triggerIncident(kind, busId) {
  if (!active || !ctx.welfare || !ctx.welfare.demoInject) return { error: 'demo mode is not active' };
  const type = MANUAL_ALIASES[String(kind || 'fall').toLowerCase()] || String(kind);
  let spec = WELFARE_TYPES.find((t) => t.type === type);
  const bus = BUSES[String(busId)] ? String(busId) : '515';
  if (!spec && type === 'end_of_service_occupancy') {
    spec = { type, source: 'vs125', severity: 4, rule: 'R6_end_of_service_occupancy', use_case: 6,
      reason: () => `1 passenger(s) still aboard at ${STOPS[bus][0].name} after 7 min stationary \u2014 vehicle appears out of service` };
  }
  if (!spec) return { error: `Unknown type. Options: ${Object.keys(MANUAL_ALIASES).join(', ')}` };
  const now = Date.now();
  const today = ctx.displayDateStr();
  const minute = (now - localToUtcMs(today, 0)) / 60000;
  const inc = buildIncident(today, minute, bus, { ...spec, peak: false }, rngFor(`manual:${now}`), ctx.capacity, now);
  inc.row.event_id = `demo-manual-${bus}-${type}-${now}`;
  inc.row.detected_at = new Date(now).toISOString();
  ctx.welfare.demoInject(inc.row);
  console.log(`[DEMO] manual ${inc.row.severity_name.toUpperCase()} ${bus} ${type}`);
  return { created: inc.row };
}

// ---------------------------------------------------------------------------
// White-label text scrub. Removes the pilot client's name from any string the
// demo service sends to a browser (stop names, route names, weather label,
// welfare notes). Ordered so phrases collapse cleanly, e.g.
//   'Rochester, MN (Mayo Clinic)'      -> 'Rochester, MN'
//   'Gonda Building (Mayo Downtown)'   -> 'Gonda Building (Downtown)'
//   'Mayo NW Patient Parking Shuttle'  -> 'NW Patient Parking Shuttle'
// ---------------------------------------------------------------------------
const { scrub: sharedScrub } = require('../public/demo-scrub.js');
function scrubText(str) { return sharedScrub(str); }
function scrubDeep(v, depth = 0) {
  if (depth > 12 || v == null) return v;
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  if (typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = scrubDeep(v[k], depth + 1);
    return o;
  }
  return v;
}
// Express middleware: every res.json() on a white-label demo is scrubbed.
function whiteLabelMiddleware(req, res, next) {
  if (!ENABLED || !CFG.whiteLabel) return next();
  const orig = res.json.bind(res);
  res.json = (body) => orig(scrubDeep(body));
  next();
}

function clientConfig() {
  // `enabled` follows the env flag, not whether the simulator started: if the
  // demo refused to run, the browser must still stay off the live broker.
  return { enabled: ENABLED, running: active, badge: CFG.badge, openAccess: CFG.openAccess, whiteLabel: ENABLED && CFG.whiteLabel };
}

module.exports = {
  ENABLED,
  isActive: () => active,
  init,
  catchUp,
  start,
  clientConfig,
  triggerIncident,
  scrubText,
  scrubDeep,
  whiteLabelMiddleware,
  // exported for the self-test
  _internal: { planDay, welfareDay, localToUtcMs, localParts, addDays, BUSES, STOPS, LOOP_MIN, CFG, setEpoch: (e) => { EPOCH = e; }, setTz: (z) => { TZ = z; } },
};
