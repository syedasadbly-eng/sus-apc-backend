/* ============================================
   WELFARE RULES ENGINE — no camera required
   Smart Urban Sensing

   R12  Sensor health & data integrity    gates everything else
   R3   Lone traveller
   R4   Lone traveller, late night
   R6   End-of-service occupancy (depot / terminus)
   R9   Stationary with occupants (falls out of R6)

   Design principle: a broken feed must never look like a welfare event.
   Every alerting rule checks isTrustworthy() first. A stuck passenger
   counter would otherwise fire "passenger left on the bus" every night and
   destroy operator confidence in the whole system.

   GPS caution: server.js falls back to static depot coordinates when the
   UR35 has no fix. Geofence rules therefore only run on gpsValid === true
   live fixes, otherwise every bus would appear permanently parked at its
   depot anchor.
   ============================================ */

'use strict';

const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envJson(name, fallback) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : fallback;
  } catch (err) {
    console.warn(`[welfare] ${name} is not valid JSON, using default:`, err.message);
    return fallback;
  }
}

// Mayo Clinic Rochester, MN — anchors taken from BUS_STATIC_LOCATIONS in
// server.js. Replace radii with surveyed values once GPS history is analysed.
const DEFAULT_DEPOTS = [
  { name: 'Gonda Building (Mayo Downtown)', lat: 44.02302, lng: -92.46657, radiusM: 180, buses: ['515'] },
  { name: 'Medical Complex NW — Building B', lat: 44.07770, lng: -92.50580, radiusM: 180, buses: ['419'] },
];

const CONFIG = {
  // ---- R12 sensor health -------------------------------------------------
  // Calibrated against 68 service days of real Mayo history (54,704 records).
  // The feed has genuine multi-minute gaps, so the original 600s/1800s pair
  // produced 20.5 events/service day. Measured gap distribution:
  //   bus 515  median 0.2 min, p90 2.5 min, p99  8.3 min  (50,538 records)
  //   bus 419  median 0.3 min, p90 9.7 min, p99 54.1 min  ( 4,166 records)
  // Bus 419 reports ~12x less often than 515 and causes nearly all the noise.
  // Fleet-wide events/service day by stale threshold:
  //   10 min 20.53 | 15 min 10.03 | 20 min 6.82
  //   30 min  4.37 | 45 min  2.38 | 60 min 1.31
  // 45 min / 120 min chosen for ~2.4 events/day. This is a dead-sensor check,
  // not a welfare emergency, so a longer confirmation window is acceptable.
  // Better long-term fix: per-vehicle thresholds derived from each bus's own
  // reporting cadence, once 419's intermittency is understood.
  staleAfterSec: Number(process.env.WELFARE_STALE_SEC ?? 2700),
  offlineAfterSec: Number(process.env.WELFARE_OFFLINE_SEC ?? 7200),
  stuckCounterMinutes: Number(process.env.WELFARE_STUCK_MIN ?? 45),
  stuckCounterMinDistanceKm: Number(process.env.WELFARE_STUCK_KM ?? 2),
  imbalanceToleranceFraction: 0.10,
  imbalanceToleranceFloor: 5,

  // ---- R3 / R4 lone traveller -------------------------------------------
  // 1800s, not the original 300s. Replaying 68 service days through the
  // modelled occupancy: 300s gave 11.50 lone_traveller/day, 900s gave 1.26,
  // 1800s gives 0.60. The modelled tally has a p90 error of 55 passengers, so
  // a short sustain window mostly catches the model passing through 1 on its
  // way somewhere else. Thirty minutes of sustained single occupancy is also
  // the case that actually matters for welfare.
  loneSustainSec: Number(process.env.WELFARE_LONE_SUSTAIN_SEC ?? 1800),
  lateNightFrom: Number(process.env.WELFARE_LATE_FROM ?? 20),
  lateNightTo: Number(process.env.WELFARE_LATE_TO ?? 6),

  // ---- R1 dwell ----------------------------------------------------------
  // This is NOT the VS125 device dwell field, which Milesight has not yet
  // given us the name or interval for. The VS125 reports counts, not
  // identities, so per-passenger dwell is not derivable from this feed at all.
  //
  // What IS derivable: how long the vehicle has held occupants with nobody
  // alighting. That is the welfare case that matters (someone aboard who has
  // not got off), and it needs only the cumulative alighting counter.
  //
  // 1200s from 68 service days, feed gaps over 20 min excluded because a
  // silent feed is sensor health's problem, not dwell:
  //   bus 515  p90 4 min, p99 13 min, max 39 min
  //   bus 419  p90 1 min, p99 13 min, max 20 min
  // At 1200s: 0.28/day on 515, 0.00/day on 419. At 1800s: 0.03/day and 0.
  // 1200s sits just above p99 on both vehicles.
  dwellNoAlightSec: Number(process.env.WELFARE_DWELL_SEC ?? 1200),
  // Any reporting gap longer than this restarts the dwell window rather than
  // counting the silence as time held. See ruleDwell for why.
  dwellMaxGapSec: Number(process.env.WELFARE_DWELL_MAX_GAP_SEC ?? 1200),

  // ---- R6 end of service -------------------------------------------------
  depots: envJson('WELFARE_DEPOTS', DEFAULT_DEPOTS),
  termini: envJson('WELFARE_TERMINI', []),
  // 3600s, not the original 300s. Same replay: 300s gave 12.21
  // end_of_service_occupancy/day at ESCALATE, 1800s gave 0.49, 3600s gives
  // 0.40. The volume is driven by bus 515 sitting inside the Gonda depot
  // radius with a reportedly valid fix and a non-zero tally for most of the
  // service day, not by real end-of-service events.
  eosStationarySec: Number(process.env.WELFARE_EOS_SEC ?? 3600),
  stationarySpeedKph: Number(process.env.WELFARE_STATIONARY_KPH ?? 3),

  // ---- rule enablement ---------------------------------------------------
  // Comma-separated families allowed to raise events. Valid values:
  //   sensor_health   feed liveness, stuck counter, day imbalance
  //   lone_traveller  R3 / R4
  //   end_of_service  R6 depot/terminus occupancy
  //   stationary      R9 stationary with occupants
  //   all             enable everything
  //
  // Default: sensor_health, lone_traveller, end_of_service.
  //
  // Replaying 68 service days of real Mayo history (54,704 records) on the RAW
  // counters produced 60.96 events/service day, 53.34 of them ESCALATE, because
  // the rules were firing on data artefacts:
  //   - `speed` is 0.0 in every record, so "stationary" is always true
  //   - bus 515 logs 1.48 boardings per alighting, so its onboard tally never
  //     returns to zero and "occupants still aboard" is always true
  //   - bus 515 reports only 18 distinct positions across 68 days
  //
  // The derived occupancy in welfare/occupancy.js fixes the second of those by
  // rebalancing alightings, which makes the occupancy rules viable. Re-measured
  // against the same 68 days using modelled occupancy:
  //   lone_traveller  bus 515  1.2/day   bus 419  0.4/day  (raw: 0.2 and 0.6)
  //   onboard != 0 at last reading of the day: 515 28/68, 419 24/56
  //     (raw was 68/68 on 515 — permanently true, hence the old flood)
  // Before the 5-minute sustain and 10-minute cooldown, so actual volume is
  // lower. That is a workable signal rather than noise.
  //
  // `stationary` stays OFF and must not be enabled while `speed` is 0.0 in
  // every record: that rule's own movement test is then permanently satisfied
  // and it fires on every stopped reading. It produced 9 false events on
  // 3 September alone.
  //
  // Note `end_of_service` is gated on gpsValid inside ruleEndOfService, and
  // both buses currently report a fallback position rather than a live fix, so
  // it will raise nothing until GNSS push is enabled on the UR35s. It is
  // switched on deliberately so it starts working the moment GPS does.
  //
  // Occupancy rules read a MODELLED tally that invents alightings — see the
  // accuracy figures in welfare/occupancy.js. p90 error is still 55 passengers.
  // Treat anything they raise as a lead, not as an observation.
  enabledRules: String(process.env.WELFARE_RULES
    ?? 'sensor_health,lone_traveller,end_of_service,dwell')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // ---- shared ------------------------------------------------------------
  alertCooldownSec: Number(process.env.WELFARE_COOLDOWN_SEC ?? 600),
  // Matches DISPLAY_TZ in server.js — Mayo Clinic Rochester is US Central
  timezone: process.env.DISPLAY_TZ || 'America/Chicago',

  // Per-bus local time after which a feed going quiet is end of shift, not a
  // fault. Derived from 68 service days of real history (America/Chicago):
  //
  //   515  first 06:26 median, last 17:45 median (p10 17:30, p90 18:19,
  //        max 18:26). 64 of 68 days finish between 17:00 and 18:59.
  //   419  first 08:06 median, last 13:53 median (p10 12:34, p90 14:57,
  //        max 15:38). 54 of 56 days finish between 12:00 and 15:59.
  //
  // Set an hour BEFORE the earliest normal finish so a genuine mid-service
  // dropout is still caught: 419 has finished as early as 11:xx once, so 12
  // is not conservative enough on its own — the zero-occupancy condition in
  // isEndOfShift does the real work.
  shiftEndsAfter: envJson('WELFARE_SHIFT_ENDS_AFTER', { 515: 17, 419: 12 }),
  // Buses with no entry above never suppress. Silence from an unknown bus is
  // a fault until somebody tells us its timetable.
  shiftEndDefault: process.env.WELFARE_SHIFT_END_DEFAULT
    ? Number(process.env.WELFARE_SHIFT_END_DEFAULT) : null,
  // Require a zero occupancy reading before treating silence as end of shift.
  // Off until bus/001/door2 is repaired — see isEndOfShift for the measured
  // reason. Turning it on today would suppress nothing.
  shiftEndOccupancyGate: process.env.WELFARE_SHIFT_END_REQUIRE_EMPTY === 'true',
};

const SEVERITY = { LOG: 1, NOTIFY: 2, ALERT: 3, ESCALATE: 4 };
const SEVERITY_NAME = { 1: 'log', 2: 'notify', 3: 'alert', 4: 'escalate' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function haversineM(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => !Number.isFinite(v))) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function insideAny(lat, lng, places, busId) {
  for (const p of places) {
    if (Array.isArray(p.buses) && p.buses.length && !p.buses.includes(busId)) continue;
    const d = haversineM(lat, lng, p.lat, p.lng ?? p.lon);
    if (d != null && d <= (p.radiusM ?? 150)) return { place: p, distanceM: Math.round(d) };
  }
  return null;
}

/**
 * Normalise a rule-family list. Accepts an array or the comma-separated
 * string an env var or a `replay.js --set` override supplies.
 * @param {string[]|string} value
 * @returns {string[]}
 */
function ruleFamilies(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function localHour(tsMs, timezone) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', hour12: false,
    }).format(new Date(tsMs)));
  } catch {
    return new Date(tsMs).getHours();
  }
}

function inLateNight(tsMs, cfg) {
  const h = localHour(tsMs, cfg.timezone);
  const { lateNightFrom: f, lateNightTo: t } = cfg;
  return f > t ? (h >= f || h < t) : (h >= f && h < t);
}

/**
 * Is this vehicle's silence the normal end of its working day?
 *
 * Every bus goes quiet once a night when it is switched off. Across 124
 * service days of real history that produced 128 offline ALERTs — almost
 * exactly one per bus per day, and the single most common thing on the
 * welfare console. That is how a safety screen gets ignored.
 *
 * This deliberately tests the CLOCK ONLY, and the reason matters.
 *
 * The obvious condition is "quiet AND empty", so a bus that goes dark with
 * somebody still aboard keeps alerting. It was written that way first and
 * then measured against the history, where it fell over:
 *
 *   - modelled occupancy at shutdown is 0 on 0 of 68 days for 515
 *     (median 14) and 6 of 56 for 419 (median 2);
 *   - the last door event lands in the same minute as the last message on
 *     66 of 68 days for 515, so "doors quiet before shutdown" fails too.
 *
 * Both are the SAME underlying fault: bus/001/door2 counts 202 boardings
 * against 93 alightings (2.17), so the tally never returns to zero. The
 * occupancy estimate is least trustworthy exactly at end of day, which is
 * where an emptiness test would have to do its work. Gating on it would
 * either suppress nothing, or — if believed — raise "14 passengers left on
 * a parked bus" every single night. That is the same noise in a better
 * costume, and it dresses a counting fault up as a welfare emergency.
 *
 * So the clock decides, and shiftEndOccupancyGate stays off until the door
 * fault is fixed. This is a real reduction in cover and is stated as such:
 * between the cutoff and the next morning, a feed that dies with a
 * passenger aboard is recorded, not alerted. See countersNotCleared(),
 * which reports the underlying fault instead of hiding it.
 *
 * @returns {boolean}
 */
function isEndOfShift(v, tsMs, cfg) {
  const cutoff = cfg.shiftEndsAfter?.[v.id] ?? cfg.shiftEndDefault;
  if (cutoff == null) return false;   // unknown bus — silence stays a fault

  // Off by default, and honest about why. Flip it on once the door counters
  // balance and this becomes a genuine safety gate rather than a formality.
  if (cfg.shiftEndOccupancyGate) {
    const aboard = v.onboard ?? v.onboardRaw;
    if (aboard == null || aboard > 0) return false;
  }

  const h = localHour(tsMs, cfg.timezone);
  // Runs from the cutoff to the 04:00 service-day rollover, so a bus still
  // silent at 02:00 is the same shutdown, not a fresh fault.
  return h >= cutoff || h < 4;
}

function serviceDay(tsMs, timezone) {
  // Service day rolls at 04:00 local so a 01:30 night run belongs to the
  // previous day's service, which is how operators think about it.
  const shifted = tsMs - 4 * 3600 * 1000;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(shifted));
  } catch {
    return new Date(shifted).toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------

class VehicleState {
  constructor(id) {
    this.id = id;
    this.firstSeen = null;
    this.lastSeen = null;
    this.reportCount = 0;

    this.onboard = null;
    this.onboardRaw = null;
    this.occupancyModel = null;
    this.lat = null;
    this.lng = null;
    this.speed = null;
    this.gpsValid = false;
    this.route = null;

    this.serviceDay = null;
    this.dayIn = 0;
    this.dayOut = 0;

    this.lastCounterSig = null;
    this.lastCounterChangeTs = null;
    this.kmSinceCounterChange = 0;

    this.health = 'unknown';
    this.offShift = false;
    this.healthReasons = new Set();

    this.loneSinceTs = null;
    this.stationarySinceTs = null;
    this.noAlightSinceTs = null;
    this.lastDayOut = null;
    this.prevSeen = null;
    this.lastAlertTs = {};
  }
}

// ---------------------------------------------------------------------------

class WelfareEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{insert:function}} [opts.store] persistence adapter
   * @param {object} [opts.config] config overrides
   * @param {function} [opts.now] injectable clock for tests
   */
  constructor(opts = {}) {
    super();
    this.cfg = { ...CONFIG, ...(opts.config ?? {}) };
    this.store = opts.store ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.vehicles = new Map();
    this.recent = [];              // in-memory ring for the dev console
    this.recentLimit = 200;
    this.counters = Object.create(null);

    // Which occupancy figure the rules are actually being fed.
    //
    //   'modelled'  welfare/index.js is swapping in occupancy.js's rebalanced
    //               tally before ingest, so EVERY rule below reads a modelled
    //               number whether or not a bus is reporting right now.
    //   'raw'       the swap is off; rules read the VS125 counter as sent.
    //   null        unknown — infer from what has been observed. Tests and
    //               offline callers construct the engine directly.
    //
    // Declared rather than inferred because inference lies: with no vehicle
    // in memory after a restart the console reported "measured / Raw VS125
    // counters" while the model was live and calibrated. A basis column that
    // overstates confidence when the fleet is quiet is worse than no column.
    this.occupancyMode = opts.occupancyMode ?? null;
    this.lastModelledTs = null;    // sticky: survives vehicle expiry

    // Seed the known fleet from the depot config so a bus that has not
    // reported since startup shows as "never reported" instead of silently
    // vanishing from the list. Bus 419 disappeared from fleet-health entirely
    // after a restart, which made the interface read "1 of 1 buses are being
    // watched" - full coverage - when real coverage was 1 of 2. A welfare
    // screen must never shrink its own denominator.
    for (const d of this.cfg.depots || []) {
      for (const id of d.buses || []) this.vehicle(String(id));
    }
  }

  vehicle(id) {
    if (!this.vehicles.has(id)) this.vehicles.set(id, new VehicleState(id));
    return this.vehicles.get(id);
  }

  /**
   * Feed one observation. Call from server.js after a record is committed.
   * @param {object} o
   * @param {string} o.busId
   * @param {number|null} o.onboard
   * @param {number} [o.dayIn]
   * @param {number} [o.dayOut]
   * @param {number|null} [o.lat]
   * @param {number|null} [o.lng]
   * @param {number|null} [o.speed]
   * @param {boolean} [o.gpsValid] true only for a real live UR35 fix
   * @param {string} [o.route]
   * @param {number} [o.ts] epoch ms
   */
  ingest(o) {
    const busId = String(o.busId ?? '').trim();
    if (!busId) return [];

    const v = this.vehicle(busId);
    const nowTs = this.now();
    const ts = Number.isFinite(o.ts) ? o.ts : nowTs;
    const out = [];

    // ---- service day rollover -------------------------------------------
    const day = serviceDay(ts, this.cfg.timezone);
    if (v.serviceDay !== day) {
      if (v.serviceDay !== null && this.ruleEnabled('sensor_health')) {
        out.push(this.checkDayImbalance(v, nowTs));
      }
      v.serviceDay = day;
      v.dayIn = 0;
      v.dayOut = 0;
    }

    // ---- recovery from a gap --------------------------------------------
    if ((v.health === 'offline' || v.health === 'stale') && this.ruleEnabled('sensor_health')) {
      const gapSec = v.lastSeen ? Math.round((nowTs - v.lastSeen) / 1000) : null;
      const wasOffShift = v.offShift;
      v.healthReasons.delete('stale');
      v.healthReasons.delete('offline');
      v.offShift = false;
      const mins = gapSec != null ? Math.round(gapSec / 60) : null;
      out.push(this.raise(v, {
        event_type: 'sensor_recovered',
        severity: SEVERITY.LOG,
        rule: 'R12_sensor_health',
        reason: wasOffShift
          ? `Back in service after ${mins != null ? `${Math.round(mins / 60)} h` : 'the night'} off`
          : `Feed restored after a ${mins ?? '?'} min gap`,
        detail: { was_off_shift: wasOffShift, gap_min: mins },
      }, nowTs, { force: true }));
    }

    // ---- distance travelled ---------------------------------------------
    if (v.gpsValid && o.gpsValid) {
      const movedM = haversineM(v.lat, v.lng, o.lat, o.lng);
      if (movedM != null) v.kmSinceCounterChange += movedM / 1000;
    }

    // ---- stuck-counter signature ----------------------------------------
    const sig = `${o.dayIn ?? ''}|${o.dayOut ?? ''}|${o.onboard ?? ''}`;
    if (sig !== v.lastCounterSig) {
      v.lastCounterSig = sig;
      v.lastCounterChangeTs = nowTs;
      v.kmSinceCounterChange = 0;
      v.healthReasons.delete('stuck_counter');
    } else if (v.lastCounterChangeTs == null) {
      v.lastCounterChangeTs = nowTs;
    }

    // ---- commit the reading ---------------------------------------------
    if (Number.isFinite(o.dayIn)) v.dayIn = o.dayIn;
    if (Number.isFinite(o.dayOut)) v.dayOut = o.dayOut;
    if (o.onboard != null) v.onboard = o.onboard;
    // The measured counter, kept for display when occupancy is modelled.
    if (o.onboardRaw != null) v.onboardRaw = o.onboardRaw;
    if (o.occupancyModel) {
      v.occupancyModel = o.occupancyModel;
      this.lastModelledTs = nowTs;
    }
    if (Number.isFinite(o.lat)) v.lat = o.lat;
    if (Number.isFinite(o.lng)) v.lng = o.lng;
    if (o.speed != null) v.speed = o.speed;
    v.gpsValid = Boolean(o.gpsValid);
    if (o.route) v.route = o.route;
    if (v.firstSeen == null) v.firstSeen = nowTs;
    v.prevSeen = v.lastSeen;
    v.lastSeen = nowTs;
    v.reportCount += 1;

    // ---- R12 first, it can mark the feed untrustworthy -------------------
    if (this.ruleEnabled('sensor_health')) {
      out.push(...this.ruleSensorHealth(v, o, nowTs));
    }

    // ---- gated rules -----------------------------------------------------
    // Gated twice: the family must be enabled AND the feed trustworthy.
    const loneOn = this.ruleEnabled('lone_traveller');
    const eosOn = this.ruleEnabled('end_of_service') || this.ruleEnabled('stationary');
    const dwellOn = this.ruleEnabled('dwell');

    if ((loneOn || eosOn || dwellOn) && this.isTrustworthy(v)) {
      if (loneOn) out.push(...this.ruleLoneTraveller(v, ts, nowTs));
      if (eosOn) out.push(...this.ruleEndOfService(v, ts, nowTs));
      if (dwellOn) out.push(...this.ruleDwell(v, ts, nowTs));
    } else {
      v.loneSinceTs = null;
      v.stationarySinceTs = null;
      v.noAlightSinceTs = null;
    }

    return out.filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // R12 — sensor health & data integrity
  // -------------------------------------------------------------------------

  ruleSensorHealth(v, o, nowTs) {
    const out = [];

    if (o.onboard != null && o.onboard < 0) {
      v.healthReasons.add('negative_occupancy');
      out.push(this.raise(v, {
        event_type: 'sensor_fault',
        severity: SEVERITY.ALERT,
        rule: 'R12_sensor_health',
        reason: `Negative occupancy reported (${o.onboard}) — counter fault`,
      }, nowTs));
    }

    if (!o.gpsValid && o.onboard != null && o.onboard > 0) v.healthReasons.add('no_gps_fix');
    else v.healthReasons.delete('no_gps_fix');

    if (v.lastCounterChangeTs != null) {
      const stillSec = (nowTs - v.lastCounterChangeTs) / 1000;
      if (stillSec > this.cfg.stuckCounterMinutes * 60
        && v.kmSinceCounterChange >= this.cfg.stuckCounterMinDistanceKm
        && !v.healthReasons.has('stuck_counter')) {
        v.healthReasons.add('stuck_counter');
        out.push(this.raise(v, {
          event_type: 'sensor_suspect',
          severity: SEVERITY.NOTIFY,
          rule: 'R12_sensor_health',
          reason: `No count change in ${Math.round(stillSec / 60)} min over `
            + `${v.kmSinceCounterChange.toFixed(1)} km — counter may be stuck`,
        }, nowTs));
      }
    }

    v.health = this.deriveHealth(v);
    return out;
  }

  deriveHealth(v) {
    if (v.healthReasons.has('offline')) return 'offline';
    if (v.healthReasons.has('stale')) return 'stale';
    if (v.healthReasons.has('negative_occupancy') || v.healthReasons.has('stuck_counter')) return 'faulty';
    if (v.healthReasons.size > 0) return 'degraded';
    return 'ok';
  }

  /** Absence of a message cannot be seen from message handling. Run on a timer. */
  sweep() {
    const nowTs = this.now();
    const out = [];
    for (const v of this.vehicles.values()) {
      if (v.lastSeen == null) continue;
      const silentSec = (nowTs - v.lastSeen) / 1000;

      // End of shift is recorded, not alerted. The vehicle is still marked
      // offline so every downstream rule stays suppressed - an off-shift bus
      // is not being watched, and the interface must keep saying so.
      const endOfShift = isEndOfShift(v, nowTs, this.cfg);

      if (silentSec >= this.cfg.offlineAfterSec && !v.healthReasons.has('offline')) {
        v.healthReasons.add('offline');
        v.health = 'offline';
        v.offShift = endOfShift;
        // Carry the unresolved tally on the record. The bus is not claimed to
        // be empty - it is claimed to have stopped reporting at its normal
        // finishing time - and the gap between those two statements is the
        // door fault, stated on every record rather than quietly dropped.
        const unresolved = v.onboard ?? v.onboardRaw;
        out.push(this.raise(v, endOfShift ? {
          event_type: 'shift_ended',
          severity: SEVERITY.LOG,
          rule: 'R12_sensor_health',
          reason: unresolved > 0
            ? `Finished for the day — counter left ${unresolved} unresolved, not confirmed empty`
            : 'Finished for the day',
          detail: {
            off_shift: true,
            silent_min: Math.round(silentSec / 60),
            unresolved_onboard: unresolved ?? null,
            confirmed_empty: unresolved === 0,
          },
        } : {
          event_type: 'sensor_offline',
          severity: SEVERITY.ALERT,
          rule: 'R12_sensor_health',
          reason: `No data for ${Math.round(silentSec / 60)} min — vehicle feed lost`,
        }, nowTs, { force: true }));
      } else if (silentSec >= this.cfg.staleAfterSec
        && !v.healthReasons.has('offline') && !v.healthReasons.has('stale')) {
        v.healthReasons.add('stale');
        v.health = 'stale';
        v.offShift = endOfShift;
        // Nothing is raised for a stale empty bus at the end of its day. The
        // shift_ended record above covers it once it crosses offline, and
        // emitting both would just move the noise rather than remove it.
        if (!endOfShift) {
          out.push(this.raise(v, {
            event_type: 'sensor_stale',
            severity: SEVERITY.NOTIFY,
            rule: 'R12_sensor_health',
            reason: `No data for ${Math.round(silentSec / 60)} min`,
          }, nowTs, { force: true }));
        }
      }
    }
    return out.filter(Boolean);
  }

  checkDayImbalance(v, nowTs) {
    const { dayIn: b, dayOut: a } = v;
    if (!b && !a) return null;
    const diff = Math.abs(b - a);
    const tol = Math.max(this.cfg.imbalanceToleranceFloor, b * this.cfg.imbalanceToleranceFraction);
    if (diff <= tol) return null;
    return this.raise(v, {
      event_type: 'data_quality_drift',
      severity: SEVERITY.NOTIFY,
      rule: 'R12_sensor_health',
      reason: `Day imbalance: ${b} boardings vs ${a} alightings (diff ${diff}, tolerance ${Math.round(tol)})`,
      detail: { boardings: b, alightings: a, service_day: v.serviceDay },
    }, nowTs, { force: true });
  }

  isTrustworthy(v) {
    // A seeded bus that has never sent a message has no health reasons, so
    // without this guard it would report as trustworthy purely because
    // nothing has gone wrong yet. Nothing has gone right either.
    if (v.lastSeen == null) return false;
    return !['offline', 'stale', 'negative_occupancy', 'stuck_counter']
      .some((r) => v.healthReasons.has(r));
  }

  /**
   * Is a rule family allowed to raise events?
   * See CONFIG.enabledRules for why the default is sensor health only.
   * @param {string} family
   * @returns {boolean}
   */
  ruleEnabled(family) {
    const on = ruleFamilies(this.cfg.enabledRules);
    if (on.length === 0) return false;
    return on.includes('all') || on.includes(family);
  }

  // -------------------------------------------------------------------------
  // R3 / R4 — lone traveller
  // -------------------------------------------------------------------------

  ruleLoneTraveller(v, ts, nowTs) {
    const out = [];
    if (v.onboard !== 1) { v.loneSinceTs = null; return out; }
    if (v.loneSinceTs == null) { v.loneSinceTs = nowTs; return out; }

    const sustainedSec = (nowTs - v.loneSinceTs) / 1000;
    if (sustainedSec < this.cfg.loneSustainSec) return out;

    const late = inLateNight(ts, this.cfg);
    out.push(this.raise(v, {
      event_type: late ? 'lone_traveller_late_night' : 'lone_traveller',
      severity: late ? SEVERITY.ALERT : SEVERITY.NOTIFY,
      rule: late ? 'R4_lone_traveller_late_night' : 'R3_lone_traveller',
      use_case: 6,
      reason: late
        ? `Single occupant for ${Math.round(sustainedSec / 60)} min on an off-peak service`
        : `Single occupant for ${Math.round(sustainedSec / 60)} min`,
      detail: {
        sustained_minutes: Math.round(sustainedSec / 60),
        local_hour: localHour(ts, this.cfg.timezone),
      },
    }, nowTs));
    return out;
  }

  // -------------------------------------------------------------------------
  // R1 — dwell: occupants held with nobody alighting
  //
  // Deliberately a PROXY, and labelled as one everywhere it surfaces. The
  // VS125 gives counts, not identities, so this cannot tell you that the same
  // person stayed aboard for the whole window — only that the vehicle has had
  // someone on it and the alighting counter has not moved.
  //
  // Reads the RAW counter, not the modelled occupancy. The model invents
  // alightings to rebalance the day, which is exactly the signal this rule
  // watches, so feeding it modelled numbers would let the model mask a real
  // dwell. On bus 419 right now the model says 0 aboard while the counter
  // says 2 — this rule must see the 2.
  // -------------------------------------------------------------------------
  ruleDwell(v, ts, nowTs) {
    const out = [];

    // A quiet feed is indistinguishable from a dwelling bus: no alighting
    // arrives because no message arrives at all. Sensor health does not catch
    // this either, since it only calls a feed stale after 2700s. Without this
    // guard the rule measured 2.00 events/day on real history against the
    // 0.28/day the same data gives when gaps are excluded — nearly all of the
    // excess was silence, including every one of bus 419's raises.
    const sinceLastReportSec = v.prevSeen == null ? 0 : (nowTs - v.prevSeen) / 1000;
    if (sinceLastReportSec > this.cfg.dwellMaxGapSec) {
      v.noAlightSinceTs = null;
      v.lastDayOut = v.dayOut;
      return out;
    }

    const aboard = v.onboardRaw != null ? v.onboardRaw : v.onboard;
    if (!Number.isFinite(aboard) || aboard <= 0) {
      v.noAlightSinceTs = null;
      v.lastDayOut = v.dayOut;
      return out;
    }

    // Somebody got off: the window restarts. Also restarts on a counter reset
    // (new service day), where dayOut goes backwards.
    if (v.lastDayOut == null || v.dayOut !== v.lastDayOut) {
      const moved = v.lastDayOut != null && v.dayOut !== v.lastDayOut;
      v.lastDayOut = v.dayOut;
      if (moved) { v.noAlightSinceTs = nowTs; return out; }
    }

    if (v.noAlightSinceTs == null) { v.noAlightSinceTs = nowTs; return out; }

    const heldSec = (nowTs - v.noAlightSinceTs) / 1000;
    if (heldSec < this.cfg.dwellNoAlightSec) return out;

    const late = inLateNight(ts, this.cfg);
    const mins = Math.round(heldSec / 60);
    out.push(this.raise(v, {
      event_type: 'dwell_no_alighting',
      severity: late ? SEVERITY.ALERT : SEVERITY.NOTIFY,
      rule: 'R1_dwell_no_alighting',
      use_case: 1,
      reason: `${aboard} aboard for ${mins} min with nobody alighting`
        + (late ? ' on an off-peak service' : ''),
      detail: {
        held_minutes: mins,
        aboard_raw: aboard,
        day_out: v.dayOut,
        local_hour: localHour(ts, this.cfg.timezone),
        proxy: true,
        basis: 'no alighting counter movement — not per-passenger dwell',
      },
    }, nowTs));
    return out;
  }

  // -------------------------------------------------------------------------
  // R6 — end-of-service occupancy  /  R9 — stationary with occupants
  // -------------------------------------------------------------------------

  ruleEndOfService(v, ts, nowTs) {
    const out = [];
    if (v.onboard == null || v.onboard <= 0) { v.stationarySinceTs = null; return out; }

    const moving = v.speed != null && v.speed > this.cfg.stationarySpeedKph;
    if (moving) { v.stationarySinceTs = null; return out; }

    if (v.stationarySinceTs == null) { v.stationarySinceTs = nowTs; return out; }
    const stationarySec = (nowTs - v.stationarySinceTs) / 1000;
    if (stationarySec < this.cfg.eosStationarySec) return out;

    // Geofencing is only meaningful on a real fix. server.js substitutes the
    // depot anchor when GPS is unavailable, which would make every bus look
    // parked at its depot and fire this rule permanently.
    if (!v.gpsValid) {
      if (!this.ruleEnabled('stationary')) return out;
      out.push(this.raise(v, {
        event_type: 'stationary_with_occupants',
        severity: SEVERITY.NOTIFY,
        rule: 'R9_stationary_with_occupants',
        use_case: 1,
        reason: `${v.onboard} aboard, stationary ${Math.round(stationarySec / 60)} min `
          + '— location unconfirmed (no live GPS fix)',
        detail: { gps_valid: false, stationary_minutes: Math.round(stationarySec / 60) },
      }, nowTs));
      return out;
    }

    const depot = insideAny(v.lat, v.lng, this.cfg.depots, v.id);
    const terminus = depot ? null : insideAny(v.lat, v.lng, this.cfg.termini, v.id);
    const hit = depot ?? terminus;
    const late = inLateNight(ts, this.cfg);

    if (!hit) {
      if (!this.ruleEnabled('stationary')) return out;
      out.push(this.raise(v, {
        event_type: 'stationary_with_occupants',
        severity: SEVERITY.NOTIFY,
        rule: 'R9_stationary_with_occupants',
        use_case: 1,
        reason: `${v.onboard} aboard, stationary ${Math.round(stationarySec / 60)} min `
          + 'away from any known depot or terminus',
        detail: { gps_valid: true, stationary_minutes: Math.round(stationarySec / 60) },
      }, nowTs));
      return out;
    }

    const atDepot = Boolean(depot);
    if (!this.ruleEnabled('end_of_service')) return out;
    out.push(this.raise(v, {
      event_type: atDepot ? 'end_of_service_occupancy' : 'terminus_occupancy',
      severity: atDepot ? SEVERITY.ESCALATE : SEVERITY.ALERT,
      rule: 'R6_end_of_service_occupancy',
      use_case: 6,
      reason: atDepot
        ? `${v.onboard} passenger(s) still aboard at ${hit.place.name} after `
          + `${Math.round(stationarySec / 60)} min stationary — vehicle appears out of service`
        : `${v.onboard} passenger(s) still aboard at terminus ${hit.place.name} after `
          + `${Math.round(stationarySec / 60)} min stationary`,
      detail: {
        location: hit.place.name,
        distance_m: hit.distanceM,
        stationary_minutes: Math.round(stationarySec / 60),
        late_night: late,
        lone: v.onboard === 1,
        gps_valid: true,
      },
    }, nowTs));
    return out;
  }

  // -------------------------------------------------------------------------

  raise(v, spec, nowTs, opts = {}) {
    const key = `${spec.rule}:${spec.event_type}`;
    if (!opts.force) {
      const last = v.lastAlertTs[key] ?? 0;
      if ((nowTs - last) / 1000 < this.cfg.alertCooldownSec) return null;
    }
    v.lastAlertTs[key] = nowTs;

    const row = {
      event_id: `${v.id}-${spec.event_type}-${nowTs}`,
      bus_id: v.id,
      source: 'vs125',
      event_type: spec.event_type,
      severity: spec.severity,
      severity_name: SEVERITY_NAME[spec.severity],
      detected_at: new Date(nowTs).toISOString(),
      route: v.route ?? null,
      lat: v.gpsValid ? v.lat : null,
      lng: v.gpsValid ? v.lng : null,
      onboard: v.onboard,
      onboard_raw: v.onboardRaw ?? null,
      onboard_is_modelled: Boolean(v.occupancyModel),
      sensor_health: v.health,
      rule: spec.rule,
      reason: spec.reason,
      use_case: spec.use_case ?? null,
      detail: spec.detail ?? null,
      acknowledged: 0,
    };

    this.counters[spec.event_type] = (this.counters[spec.event_type] ?? 0) + 1;
    this.recent.unshift(row);
    if (this.recent.length > this.recentLimit) this.recent.length = this.recentLimit;

    if (this.store) {
      try { this.store.insert(row); } catch (err) {
        console.error('[welfare] store insert failed:', err.message);
      }
    }

    this.emit(spec.severity >= SEVERITY.ALERT ? 'alert' : 'log', row);
    return row;
  }

  // -------------------------------------------------------------------------

  fleetHealth() {
    const nowTs = this.now();
    return [...this.vehicles.values()].map((v) => ({
      bus_id: v.id,
      health: v.health,
      reasons: [...v.healthReasons],
      trustworthy: this.isTrustworthy(v),
      onboard: v.onboard,
      onboard_raw: v.onboardRaw ?? null,
      onboard_is_modelled: Boolean(v.occupancyModel),
      route: v.route,
      gps_valid: v.gpsValid,
      speed: v.speed,
      last_seen_sec_ago: v.lastSeen ? Math.round((nowTs - v.lastSeen) / 1000) : null,
      // A seeded bus that has never sent anything is not healthy-by-default.
      never_reported: !v.lastSeen,
      off_shift: Boolean(v.offShift),
      reports: v.reportCount,
      service_day: v.serviceDay,
      day_in: v.dayIn,
      day_out: v.dayOut,
      lone_for_sec: v.loneSinceTs ? Math.round((nowTs - v.loneSinceTs) / 1000) : null,
      stationary_for_sec: v.stationarySinceTs ? Math.round((nowTs - v.stationarySinceTs) / 1000) : null,
    }));
  }

  /** Injected by welfare/index.js once the camera router is mounted. Kept as a
   *  callback so the signal matrix reads the live figure at request time. */
  setCameraStatusProvider(fn) {
    this._cameraStatusProvider = typeof fn === 'function' ? fn : null;
    return Boolean(this._cameraStatusProvider);
  }

  cameraStatus() {
    if (!this._cameraStatusProvider) {
      return { wired: false, connected: false, basis: 'Camera analytics — no HTTP callback wired to this service' };
    }
    try {
      const s = this._cameraStatusProvider() ?? {};
      return {
        wired: true,
        connected: Boolean(s.connected),
        basis: s.connected
          ? `AI Pro Dome HTTP callback — last seen ${s.last_seen_at}`
          : 'AI Pro Dome HTTP callback mounted — no request received yet',
      };
    } catch {
      return { wired: false, connected: false, basis: 'Camera ingest status unavailable' };
    }
  }

  /** Declare what the rules are being fed. Called by welfare/index.js once
   *  occupancy.js has initialised, since the model can fail to start (no
   *  database, feature flag off) after the engine already exists. */
  setOccupancyMode(mode) {
    this.occupancyMode = (mode === 'modelled' || mode === 'raw') ? mode : null;
    return this.occupancyMode;
  }

  /** Resolve the occupancy data basis for the reporting layer.
   *
   *  Three sources of truth, in descending order of reliability:
   *    1. a declared mode from index.js  — what is actually plumbed in
   *    2. a reading seen this process     — sticky, survives vehicle expiry
   *    3. a vehicle currently in memory   — the old inference, last resort
   *
   *  `confirmed` distinguishes "the model is wired" from "the model is wired
   *  and a bus has proved it", which is the distinction the quiet-fleet bug
   *  collapsed.
   */
  occupancyBasis() {
    const vehicles = [...this.vehicles.values()];
    const observed = vehicles.some((v) => v.occupancyModel);
    const everObserved = observed || this.lastModelledTs != null;
    const reporting = vehicles.some((v) => v.lastSeen);

    const modelled = this.occupancyMode
      ? this.occupancyMode === 'modelled'
      : everObserved;

    return {
      modelled,
      source: modelled ? 'modelled' : 'raw',
      declared: Boolean(this.occupancyMode),
      confirmed: everObserved,
      reporting,
      // Only meaningful while modelled: says whether a bus has actually
      // arrived on the rebalanced tally yet, or we are trusting the plumbing.
      note: modelled && !everObserved
        ? 'model wired, no reading through it yet since restart'
        : (modelled && !reporting ? 'no bus reporting since restart' : null),
    };
  }

  /** Signal delivery matrix for the dev console.
   *
   * Each row carries the engineering detail the status alone hides:
   *
   *   basis / trust  what the rule actually reads. 'modelled' means the tally
   *                  has invented alightings (occupancy.js, p90 error ~55
   *                  passengers) and anything raised is a lead, not an
   *                  observation. 'proxy' means the signal is a stand-in for
   *                  the thing named. Without this column a modelled KPI and a
   *                  measured one look identical at 'live'.
   *   threshold      the calibrated value in force, so a reader can tell
   *                  whether a quiet KPI is quiet or just set too wide.
   *   blocked_by     why an ENABLED rule still raises nothing. 'live' and
   *                  'enabled' are not the same thing and the difference has
   *                  already caused one false all-clear.
   */
  signals(counts) {
    // Prefer durable per-type counts from the store; fall back to the
    // in-process counters when none are supplied (tests, offline callers).
    const c = counts || this.counters;
    const cfg = this.cfg;
    const anyLone = (c.lone_traveller ?? 0) + (c.lone_traveller_late_night ?? 0);
    const anyGpsFix = [...this.vehicles.values()].some((v) => v.gpsValid);
    const occ = this.occupancyBasis();
    const anyModelled = occ.modelled;
    const mins = (sec) => `${Math.round(sec / 60)} min`;
    // Appended to every modelled basis string so a quiet fleet cannot be
    // mistaken for a confirmed one.
    const occNote = occ.note ? ` (${occ.note})` : '';
    // Camera ingest state comes from a provider rather than a require, so the
    // engine stays free of a dependency on the module that already depends on
    // it. No provider (tests, offline callers) means not wired.
    const cam = this.cameraStatus();

    return [
      {
        signal: 'Occupancy', use_case: 5, status: 'live', source: 'VS125',
        detail: anyModelled
          ? 'Onboard count and occupancy % — MODELLED, alightings rebalanced'
          : 'Live onboard count and occupancy percentage',
        events: null,
        family: null,
        enabled: true,
        basis: anyModelled
          ? `Modelled tally — alightings rebalanced by occupancy.js${occNote}`
          : 'Raw VS125 counters, as sent',
        trust: anyModelled ? 'modelled' : 'measured',
        threshold: 'No threshold — continuous measure',
        blocked_by: null,
      },
      {
        signal: 'Sensor integrity', use_case: null, status: 'live', source: 'VS125 + UR35',
        detail: 'Gates every welfare rule below',
        events: (c.sensor_stale ?? 0) + (c.sensor_offline ?? 0)
          + (c.sensor_fault ?? 0) + (c.sensor_suspect ?? 0) + (c.data_quality_drift ?? 0),
        family: 'sensor_health',
        enabled: this.ruleEnabled('sensor_health'),
        basis: 'Feed liveness + counter integrity — measured, nothing derived',
        trust: 'measured',
        threshold: `Stale ${mins(cfg.staleAfterSec)} / offline ${mins(cfg.offlineAfterSec)}; `
          + `stuck counter ${cfg.stuckCounterMinutes} min over ${cfg.stuckCounterMinDistanceKm} km`,
        blocked_by: null,
      },
      {
        signal: 'Lone Traveller', use_case: 6,
        status: this.ruleEnabled('lone_traveller') ? 'live' : 'disabled',
        source: 'VS125 (derived)',
        detail: this.ruleEnabled('lone_traveller')
          ? 'Occupancy = 1 sustained, escalated at night — reads the MODELLED tally'
          : 'Disabled — needs a passenger count that returns to zero',
        events: anyLone,
        family: 'lone_traveller',
        enabled: this.ruleEnabled('lone_traveller'),
        basis: anyModelled
          ? `Modelled tally — invented alightings, p90 error ~55 on 515, treat raises as leads${occNote}`
          : 'Raw VS125 counter — pins at the capacity clamp on 515, so this can never fire there',
        trust: anyModelled ? 'modelled' : 'measured',
        threshold: `Occupancy = 1 sustained ${mins(cfg.loneSustainSec)}; `
          + `escalates ${String(cfg.lateNightFrom).padStart(2, '0')}:00–`
          + `${String(cfg.lateNightTo).padStart(2, '0')}:00`,
        blocked_by: null,
      },
      {
        // Enabled is not the same as working. The rule is gated on a live GPS
        // fix, and server.js substitutes the depot anchor when there is none,
        // so report it as blocked rather than live until a fix appears.
        status: this.ruleEnabled('end_of_service')
          ? (anyGpsFix ? 'live' : 'blocked')
          : 'disabled',
        signal: 'End of service', use_case: 6,
        source: 'VS125 + GPS',
        detail: this.ruleEnabled('end_of_service')
          ? (anyGpsFix
            ? 'Occupants aboard at a depot or terminus'
            : 'Enabled, but waiting on a live GPS fix — no vehicle is reporting one')
          : 'Disabled — speed is 0 in every record and bus 515 never empties',
        events: (c.end_of_service_occupancy ?? 0) + (c.terminus_occupancy ?? 0),
        family: 'end_of_service',
        enabled: this.ruleEnabled('end_of_service'),
        basis: anyModelled
          ? `Modelled occupancy + geofence, live GPS fix only${occNote}`
          : 'Raw occupancy + geofence, live GPS fix only',
        trust: anyModelled ? 'modelled' : 'measured',
        threshold: `Stationary ${mins(cfg.eosStationarySec)} under `
          + `${cfg.stationarySpeedKph} kph inside a depot or terminus radius`,
        blocked_by: this.ruleEnabled('end_of_service') && !anyGpsFix
          ? 'No live GPS fix — enable GNSS push on the UR35s'
          : null,
      },
      {
        signal: 'Stationary with occupants', use_case: 1,
        status: this.ruleEnabled('stationary') ? 'live' : 'disabled',
        source: 'VS125 + GPS',
        detail: this.ruleEnabled('stationary')
          ? 'Occupants aboard while stationary away from a known stop'
          : 'Disabled — cannot distinguish stationary from missing speed data',
        events: c.stationary_with_occupants ?? 0,
        family: 'stationary',
        enabled: this.ruleEnabled('stationary'),
        basis: 'Occupancy + speed field, which reads 0.0 in every record',
        trust: 'none',
        threshold: `Stationary ${mins(cfg.eosStationarySec)} away from a known depot or terminus`,
        blocked_by: this.ruleEnabled('stationary')
          ? 'speed is 0.0 in every record — the movement test is always satisfied'
          : null,
      },
      {
        signal: 'Dwell (proxy)', use_case: 1,
        status: this.ruleEnabled('dwell') ? 'live' : 'disabled',
        source: 'VS125 (derived)',
        detail: this.ruleEnabled('dwell')
          ? 'Occupants held with no alighting \u2014 PROXY, not per-passenger dwell'
          : 'Awaiting dwell field name and interval from Milesight',
        events: c.dwell_no_alighting ?? 0,
        family: 'dwell',
        enabled: this.ruleEnabled('dwell'),
        basis: 'RAW alighting counter — deliberately not the modelled tally',
        trust: 'proxy',
        threshold: `${mins(cfg.dwellNoAlightSec)} with no alighting; `
          + `feed gaps over ${mins(cfg.dwellMaxGapSec)} restart the window`,
        blocked_by: null,
      },
      {
        signal: 'Distress', use_case: 2, status: cam.wired ? 'live' : 'camera', source: 'AI Pro Dome',
        detail: 'Fall detection — HTTP callback to /api/welfare/camera/fall',
        events: c.fall ?? 0,
        family: 'camera',
        enabled: cam.wired,
        basis: cam.basis,
        // 'measured' is not claimable until a staged fall has actually been
        // detected at saloon height. An arrived callback proves the transport
        // works, not that the detector works at 2.1 m.
        trust: (c.fall ?? 0) > 0 ? 'measured' : 'unproven',
        threshold: 'Min. duration 5 s, sensitivity 5 — set on the camera, not in this engine',
        blocked_by: cam.wired
          ? (cam.connected ? null : 'No callback received yet — camera egress to this service unconfirmed')
          : 'Camera ingest route not mounted',
      },
      {
        signal: 'Aggression', use_case: 7, status: cam.wired ? 'live' : 'camera', source: 'AI Pro Dome',
        detail: 'Violence detection — HTTP callback to /api/welfare/camera/violence',
        events: c.violence ?? 0,
        family: 'camera',
        enabled: cam.wired,
        basis: cam.basis,
        trust: (c.violence ?? 0) > 0 ? 'measured' : 'unproven',
        threshold: 'Min. duration 12 s, sensitivity 5 — set on the camera, not in this engine',
        blocked_by: cam.wired
          ? (cam.connected ? null : 'No callback received yet — camera egress to this service unconfirmed')
          : 'Camera ingest route not mounted',
      },
      {
        signal: 'Violence & Disruption', use_case: 7, status: 'camera', source: 'AI Pro Dome',
        detail: 'Violence plus sound classification compound rule',
        events: c.sound_classification ?? 0,
        family: 'camera',
        enabled: false,
        // Both feeds now arrive independently; what does not exist is the rule
        // that correlates them. Saying 'ingest wired' here would overstate it.
        basis: 'Sound and violence ingest separately — compound rule not built',
        trust: 'none',
        threshold: 'Set on the camera, not in this engine',
        blocked_by: 'Compound violence + sound rule not implemented',
      },
    ];
  }

  /**
   * Roll the signal matrix into one status line.
   *
   * Counts by status rather than reporting "n of 9 live", because the three
   * not-live states have completely different owners: `blocked` is waiting on
   * a config change we control, `disabled` is a deliberate engineering
   * decision, `camera` is waiting on hardware. Collapsing them into one
   * "not working" number is what let "3 of 9" read as a delivery problem when
   * five of the six gaps are unbuilt hardware paths.
   */
  signalSummary(counts) {
    const rows = this.signals(counts);
    const byStatus = { live: 0, blocked: 0, disabled: 0, camera: 0 };
    let modelled = 0;
    let proxy = 0;
    const blockers = [];

    for (const r of rows) {
      if (byStatus[r.status] == null) byStatus[r.status] = 0;
      byStatus[r.status] += 1;
      if (r.status === 'live' || r.status === 'blocked') {
        if (r.trust === 'modelled') modelled += 1;
        if (r.trust === 'proxy') proxy += 1;
      }
      if (r.blocked_by) blockers.push({ signal: r.signal, status: r.status, blocked_by: r.blocked_by });
    }

    const events = rows.reduce((n, r) => n + (Number.isFinite(r.events) ? r.events : 0), 0);

    return {
      total: rows.length,
      by_status: byStatus,
      // Live signals whose numbers are derived rather than measured. Reported
      // separately so "live" is never read as "trustworthy".
      modelled_live: modelled,
      proxy_live: proxy,
      events_7d: events,
      blockers,
      enabled_rules: ruleFamilies(this.cfg.enabledRules),
      // What the rules are being fed, stated rather than inferred. Kept in the
      // summary so the header carries it even when the table is collapsed.
      occupancy: this.occupancyBasis(),
    };
  }

  config() {
    const c = this.cfg;
    return {
      timezone: c.timezone,
      stale_after_sec: c.staleAfterSec,
      offline_after_sec: c.offlineAfterSec,
      stuck_counter_minutes: c.stuckCounterMinutes,
      enabled_rules: c.enabledRules,
      lone_sustain_sec: c.loneSustainSec,
      dwell_no_alight_sec: c.dwellNoAlightSec,
      dwell_max_gap_sec: c.dwellMaxGapSec,
      late_night_from: c.lateNightFrom,
      late_night_to: c.lateNightTo,
      eos_stationary_sec: c.eosStationarySec,
      stationary_speed_kph: c.stationarySpeedKph,
      alert_cooldown_sec: c.alertCooldownSec,
      depots: c.depots,
      termini: c.termini,
    };
  }
}

module.exports = {
  WelfareEngine, CONFIG, SEVERITY, SEVERITY_NAME,
  haversineM, insideAny, inLateNight, serviceDay, localHour, ruleFamilies,
};
