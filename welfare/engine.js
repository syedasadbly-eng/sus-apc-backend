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
  staleAfterSec: Number(process.env.WELFARE_STALE_SEC ?? 600),
  offlineAfterSec: Number(process.env.WELFARE_OFFLINE_SEC ?? 1800),
  stuckCounterMinutes: Number(process.env.WELFARE_STUCK_MIN ?? 45),
  stuckCounterMinDistanceKm: Number(process.env.WELFARE_STUCK_KM ?? 2),
  imbalanceToleranceFraction: 0.10,
  imbalanceToleranceFloor: 5,

  // ---- R3 / R4 lone traveller -------------------------------------------
  loneSustainSec: Number(process.env.WELFARE_LONE_SUSTAIN_SEC ?? 300),
  lateNightFrom: Number(process.env.WELFARE_LATE_FROM ?? 20),
  lateNightTo: Number(process.env.WELFARE_LATE_TO ?? 6),

  // ---- R6 end of service -------------------------------------------------
  depots: envJson('WELFARE_DEPOTS', DEFAULT_DEPOTS),
  termini: envJson('WELFARE_TERMINI', []),
  eosStationarySec: Number(process.env.WELFARE_EOS_SEC ?? 300),
  stationarySpeedKph: Number(process.env.WELFARE_STATIONARY_KPH ?? 3),

  // ---- shared ------------------------------------------------------------
  alertCooldownSec: Number(process.env.WELFARE_COOLDOWN_SEC ?? 600),
  // Matches DISPLAY_TZ in server.js — Mayo Clinic Rochester is US Central
  timezone: process.env.DISPLAY_TZ || 'America/Chicago',
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
    this.healthReasons = new Set();

    this.loneSinceTs = null;
    this.stationarySinceTs = null;
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
      if (v.serviceDay !== null) out.push(this.checkDayImbalance(v, nowTs));
      v.serviceDay = day;
      v.dayIn = 0;
      v.dayOut = 0;
    }

    // ---- recovery from a gap --------------------------------------------
    if (v.health === 'offline' || v.health === 'stale') {
      const gapSec = v.lastSeen ? Math.round((nowTs - v.lastSeen) / 1000) : null;
      v.healthReasons.delete('stale');
      v.healthReasons.delete('offline');
      out.push(this.raise(v, {
        event_type: 'sensor_recovered',
        severity: SEVERITY.LOG,
        rule: 'R12_sensor_health',
        reason: `Feed restored after a ${gapSec != null ? Math.round(gapSec / 60) : '?'} min gap`,
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
    if (Number.isFinite(o.lat)) v.lat = o.lat;
    if (Number.isFinite(o.lng)) v.lng = o.lng;
    if (o.speed != null) v.speed = o.speed;
    v.gpsValid = Boolean(o.gpsValid);
    if (o.route) v.route = o.route;
    if (v.firstSeen == null) v.firstSeen = nowTs;
    v.lastSeen = nowTs;
    v.reportCount += 1;

    // ---- R12 first, it can mark the feed untrustworthy -------------------
    out.push(...this.ruleSensorHealth(v, o, nowTs));

    // ---- gated rules -----------------------------------------------------
    if (this.isTrustworthy(v)) {
      out.push(...this.ruleLoneTraveller(v, ts, nowTs));
      out.push(...this.ruleEndOfService(v, ts, nowTs));
    } else {
      v.loneSinceTs = null;
      v.stationarySinceTs = null;
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

      if (silentSec >= this.cfg.offlineAfterSec && !v.healthReasons.has('offline')) {
        v.healthReasons.add('offline');
        v.health = 'offline';
        out.push(this.raise(v, {
          event_type: 'sensor_offline',
          severity: SEVERITY.ALERT,
          rule: 'R12_sensor_health',
          reason: `No data for ${Math.round(silentSec / 60)} min — vehicle feed lost`,
        }, nowTs, { force: true }));
      } else if (silentSec >= this.cfg.staleAfterSec
        && !v.healthReasons.has('offline') && !v.healthReasons.has('stale')) {
        v.healthReasons.add('stale');
        v.health = 'stale';
        out.push(this.raise(v, {
          event_type: 'sensor_stale',
          severity: SEVERITY.NOTIFY,
          rule: 'R12_sensor_health',
          reason: `No data for ${Math.round(silentSec / 60)} min`,
        }, nowTs, { force: true }));
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
    return !['offline', 'stale', 'negative_occupancy', 'stuck_counter']
      .some((r) => v.healthReasons.has(r));
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
      route: v.route,
      gps_valid: v.gpsValid,
      speed: v.speed,
      last_seen_sec_ago: v.lastSeen ? Math.round((nowTs - v.lastSeen) / 1000) : null,
      reports: v.reportCount,
      service_day: v.serviceDay,
      day_in: v.dayIn,
      day_out: v.dayOut,
      lone_for_sec: v.loneSinceTs ? Math.round((nowTs - v.loneSinceTs) / 1000) : null,
      stationary_for_sec: v.stationarySinceTs ? Math.round((nowTs - v.stationarySinceTs) / 1000) : null,
    }));
  }

  /** Signal delivery matrix for the dev console. */
  signals() {
    const c = this.counters;
    const anyLone = (c.lone_traveller ?? 0) + (c.lone_traveller_late_night ?? 0);
    return [
      {
        signal: 'Occupancy', use_case: 5, status: 'live', source: 'VS125',
        detail: 'Live onboard count and occupancy percentage', events: null,
      },
      {
        signal: 'Sensor integrity', use_case: null, status: 'live', source: 'VS125 + UR35',
        detail: 'Gates every welfare rule below',
        events: (c.sensor_stale ?? 0) + (c.sensor_offline ?? 0)
          + (c.sensor_fault ?? 0) + (c.sensor_suspect ?? 0) + (c.data_quality_drift ?? 0),
      },
      {
        signal: 'Lone Traveller', use_case: 6, status: 'live', source: 'VS125 (derived)',
        detail: 'Occupancy = 1 sustained, escalated at night', events: anyLone,
      },
      {
        signal: 'End of service', use_case: 6, status: 'live', source: 'VS125 + GPS',
        detail: 'Occupants aboard at a depot or terminus',
        events: (c.end_of_service_occupancy ?? 0) + (c.terminus_occupancy ?? 0)
          + (c.stationary_with_occupants ?? 0),
      },
      {
        signal: 'Dwell', use_case: 1, status: 'blocked', source: 'VS125',
        detail: 'Awaiting dwell field name and interval from Milesight', events: 0,
      },
      {
        signal: 'Distress', use_case: 2, status: 'camera', source: 'AI Pro Dome',
        detail: 'Fall detection — bench testing at 2.1 m', events: 0,
      },
      {
        signal: 'Aggression', use_case: 7, status: 'camera', source: 'AI Pro Dome',
        detail: 'Violence detection — bench testing', events: 0,
      },
      {
        signal: 'Violence & Disruption', use_case: 7, status: 'camera', source: 'AI Pro Dome',
        detail: 'Violence plus sound classification compound rule', events: 0,
      },
    ];
  }

  config() {
    const c = this.cfg;
    return {
      timezone: c.timezone,
      stale_after_sec: c.staleAfterSec,
      offline_after_sec: c.offlineAfterSec,
      stuck_counter_minutes: c.stuckCounterMinutes,
      lone_sustain_sec: c.loneSustainSec,
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
  haversineM, insideAny, inLateNight, serviceDay, localHour,
};
