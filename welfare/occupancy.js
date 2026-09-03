/* ---------------------------------------------------------------------------
   Derived occupancy — WELFARE CONSOLE ONLY.

   WHAT THIS IS
   The VS125s under-report exits. Over 68 days of Mayo history bus 515 logged
   35,148 boardings against 23,695 alightings (ratio 1.48), so its running
   tally only ever climbs and spends 33% of records pinned at the capacity
   clamp of 16. Bus 419 leans the other way, 2,441 in against 2,790 out
   (ratio 0.87). Every occupancy-dependent welfare rule is therefore reading
   a counter that never returns to zero.

   This module scales the alighting count by a per-bus factor so the two
   sides balance, and publishes the result as a SEPARATE derived figure.

   WHAT THIS IS NOT
   This is not a fix, and it is not a measurement. It invents alightings that
   were never observed. The correct fix is to repair the sensor mapping or
   mounting on the offending door. Until that happens, any rule fed from this
   number is reasoning about a model, not about passengers.

   MEASURED ACCURACY (68 days, leave-one-out so no day is scored against a
   factor fitted to itself)

     bus 515   end-of-day unmatched passengers
       raw        median 184    mean 168    p90 233    max 268
       modelled   median  -5.5  mean   0.0  p90  55    max 105
       days closing within +-2:  raw 0/68   modelled 3/68
       days still reaching the clamp:      modelled 24/68

     bus 419
       raw        median  -6    mean  -6.2
       modelled   median   0.1  mean   0.0  p90 7.8   max 18.5
       days closing within +-2:  raw 18/56  modelled 18/56

   Read that carefully. The model removes the systematic drift — 515's mean
   end-of-day error goes from 168 passengers to zero, and it stops ratcheting
   into the clamp on most days. It does NOT make any individual day correct:
   the p90 error is still 55 passengers, and 24 of 68 days still hit the
   clamp. Bus 419 gains nothing in per-day accuracy.

   Consequence: this is good enough for a trend line and for taking 515 off
   the permanent clamp. It is NOT good enough for rules that need an exact
   value — Lone Traveller needs onboard == 1 and End of Service needs
   onboard == 0. Those stay disabled.

   HARD BOUNDARIES
     - Reads `records` with SELECT only, for calibration. Writes nothing to it.
     - Touches no APC endpoint, no daily_summary, no hourly bucket, and
       nothing the Mayo Clinic dashboard reads.
     - The raw counter is always preserved alongside as `onboard_raw`.
     - Off unless FEATURE_WELFARE=true, and killable with
       WELFARE_DERIVED_OCCUPANCY=false.
--------------------------------------------------------------------------- */

'use strict';

const ENABLED = process.env.FEATURE_WELFARE === 'true'
  && process.env.WELFARE_DERIVED_OCCUPANCY !== 'false';

// Measured over the full 68-day Mayo history held in mayo_real.db
// (2026-06-01 to 2026-09-03, 54,704 records). Used only until the live
// database holds enough of its own history to calibrate against.
const SEED_FACTORS = {
  515: { factor: 1.483, evt_in: 35148, evt_out: 23695, source: 'seed_68d_history' },
  419: { factor: 0.875, evt_in: 2441, evt_out: 2790, source: 'seed_68d_history' },
};

// A factor outside this range means something is badly wrong with the feed,
// not that 4x the passengers alighted. Clamp rather than trust it.
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 4.0;

// Below this many alightings the ratio is noise. Bus 419 only reports about
// a twelfth as often as 515, so this matters.
const MIN_SAMPLE_OUT = 200;

const CALIBRATION_DAYS = 21;
const RECALIBRATE_EVERY_MS = 30 * 60 * 1000;

let db = null;
let factors = {};
let lastCalibrated = 0;
let capacity = Number(process.env.BUS_CAPACITY) || 16;

function clampFactor(f) {
  if (!Number.isFinite(f) || f <= 0) return null;
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, f));
}

/* Recompute per-bus factors from the live record history, excluding today —
   today's totals are still moving, and calibrating against them would be
   circular: dayIn - dayOut*(dayIn/dayOut) is zero by construction. */
function calibrate({ force = false, today = null } = {}) {
  if (!ENABLED || !db) return factors;
  const now = Date.now();
  if (!force && now - lastCalibrated < RECALIBRATE_EVERY_MS) return factors;
  lastCalibrated = now;

  const next = {};
  try {
    const cutoffToday = today || new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT bus_id,
             SUM(COALESCE(evt_in, 0))  AS evt_in,
             SUM(COALESCE(evt_out, 0)) AS evt_out,
             COUNT(DISTINCT date)      AS days
        FROM records
       WHERE date < ?
         AND date >= date(?, ?)
       GROUP BY bus_id
    `).all(cutoffToday, cutoffToday, `-${CALIBRATION_DAYS} day`);

    for (const r of rows) {
      const busId = String(r.bus_id);
      const evtIn = Number(r.evt_in) || 0;
      const evtOut = Number(r.evt_out) || 0;
      if (evtOut < MIN_SAMPLE_OUT) continue;
      const f = clampFactor(evtIn / evtOut);
      if (f == null) continue;
      next[busId] = {
        factor: Number(f.toFixed(4)),
        evt_in: evtIn,
        evt_out: evtOut,
        days: Number(r.days) || 0,
        source: 'live_history',
        clamped: Math.abs(f - evtIn / evtOut) > 1e-9,
      };
    }
  } catch (err) {
    console.error('[occupancy] calibration failed, keeping previous factors:', err.message);
  }

  // Seeded values fill any gap, so a fresh database still behaves sensibly.
  for (const [busId, seed] of Object.entries(SEED_FACTORS)) {
    if (!next[busId]) next[busId] = { ...seed, days: 68 };
  }

  factors = next;
  return factors;
}

function factorFor(busId) {
  const entry = factors[String(busId)];
  return entry ? entry.factor : 1;
}

/* The model. dayIn and dayOut are cumulative for the service day.

   onboard = clamp(dayIn - dayOut * factor, 0, capacity)

   With 515's factor of 1.483 the two sides converge as the day runs, so the
   tally drifts back toward zero instead of ratcheting into the clamp. It will
   not land exactly on zero — the factor is historical, not today's truth —
   so the residual is reported rather than hidden. */
function derive({ busId, dayIn, dayOut, onboardRaw = null }) {
  const inN = Number(dayIn);
  const outN = Number(dayOut);
  if (!ENABLED || !Number.isFinite(inN) || !Number.isFinite(outN)) {
    return {
      enabled: false,
      onboard: onboardRaw,
      onboard_raw: onboardRaw,
      factor: null,
      derived: false,
    };
  }

  const factor = factorFor(busId);
  const adjustedOut = outN * factor;
  const raw = inN - outN;
  const modelled = inN - adjustedOut;
  const bounded = Math.max(0, Math.min(capacity, Math.round(modelled)));

  return {
    enabled: true,
    derived: true,
    onboard: bounded,
    onboard_raw: onboardRaw != null ? onboardRaw : Math.max(0, Math.min(capacity, raw)),
    factor,
    factor_source: (factors[String(busId)] || {}).source || 'none',
    day_in: inN,
    day_out: outN,
    day_out_adjusted: Number(adjustedOut.toFixed(1)),
    unmatched_raw: raw,
    residual: Number(modelled.toFixed(1)),
    clamped_at_capacity: bounded === capacity,
    clamped_at_zero: modelled < 0,
  };
}

function initOccupancy(database, opts = {}) {
  if (!ENABLED) return false;
  db = database;
  if (opts.capacity) capacity = Number(opts.capacity) || capacity;
  calibrate({ force: true, today: opts.today || null });
  const summary = Object.entries(factors)
    .map(([b, f]) => `${b}=${f.factor}(${f.source})`).join(' ');
  console.log(`[occupancy] derived occupancy ON (welfare only) — factors: ${summary || 'none'}`);
  return true;
}

function state() {
  return {
    enabled: ENABLED,
    capacity,
    calibration_days: CALIBRATION_DAYS,
    min_sample_out: MIN_SAMPLE_OUT,
    factor_bounds: [FACTOR_MIN, FACTOR_MAX],
    last_calibrated: lastCalibrated ? new Date(lastCalibrated).toISOString() : null,
    factors,
    warning: 'Derived occupancy invents alightings the sensors never reported. '
      + 'Welfare console only. It is a stand-in for a sensor repair, not evidence '
      + 'of passenger movement, and the Mayo Clinic dashboard never reads it.',
  };
}

function createOccupancyRouter() {
  const express = require('express');
  const router = express.Router();

  router.get('/occupancy/model', (_req, res) => {
    calibrate();
    res.json(state());
  });

  router.post('/occupancy/recalibrate', (_req, res) => {
    calibrate({ force: true });
    res.json(state());
  });

  return router;
}

module.exports = {
  ENABLED,
  initOccupancy,
  calibrate,
  derive,
  factorFor,
  state,
  createOccupancyRouter,
  isEnabled: () => ENABLED && Boolean(db),
  _internals: { clampFactor, SEED_FACTORS, FACTOR_MIN, FACTOR_MAX, MIN_SAMPLE_OUT },
};
