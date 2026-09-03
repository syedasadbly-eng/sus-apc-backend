/* ============================================
   PER-DOOR COUNT LOGGING
   Smart Urban Sensing

   Purpose
   -------
   Records `records` merge both doors of a bus into a single row, so the
   per-door detail is lost before anything is persisted. That makes it
   impossible to answer the question that matters:

     Bus 515 logs 1.48 boardings for every alighting across 68 service days
     (35,148 in vs 23,695 out). Its onboard tally therefore drifts upward and
     sits pinned at the capacity clamp of 16 for a third of its records.
     Bus 419, which has one door, is near-balanced at 0.87.

   The leading hypothesis is that one of bus 515's two doors is physically
   oriented opposite to the assumption in server.js:225, where a VS125 sensor
   `out` event is treated as a boarding. If that is wrong for one door, exits
   at that door are counted as entries, which produces exactly this signature.

   This module captures in/out per topic — that is, per door — immediately
   before the merge window accumulates them, so the hypothesis can be tested
   against real traffic.

   Safety properties
   -----------------
     - Additive only. One new table, `door_counts`. No change to records,
       hourly_summary, daily_summary or bus_state, so no existing query or
       dashboard number is affected.
     - Read-only with respect to counting. It observes the deltas; it never
       modifies them or influences what gets written to `records`.
     - Off unless FEATURE_WELFARE=true, and separately disableable with
       WELFARE_DOORLOG=false.
     - Never throws. Every entry point swallows its own errors, and the call
       site in server.js is wrapped as well. The 1 September outage happened
       because a hook's *argument object* was built outside the guard, so the
       guard here covers the whole call.
     - Bounded growth. Rows are hourly aggregates upserted per topic, not one
       row per message: 24 x topics x days, rather than unbounded.
   ============================================ */

'use strict';

const express = require('express');

const ENABLED = process.env.FEATURE_WELFARE === 'true'
  && process.env.WELFARE_DOORLOG !== 'false';

// In-memory ring of the most recent raw samples, for eyeballing live traffic
// in the console without waiting for an hour to close.
const RECENT_LIMIT = 300;

let db = null;
let upsertStmt = null;
const recent = [];

/**
 * Create the table and prepare the upsert.
 * @param {object} database better-sqlite3 handle
 * @returns {boolean} true when logging is active
 */
function initDoorLog(database) {
  if (!ENABLED) return false;
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS door_counts (
        date        TEXT    NOT NULL,
        hour        INTEGER NOT NULL,
        topic       TEXT    NOT NULL,
        bus_id      TEXT    NOT NULL,
        door        TEXT,
        msg_type    TEXT,
        evt_in      INTEGER NOT NULL DEFAULT 0,
        evt_out     INTEGER NOT NULL DEFAULT 0,
        messages    INTEGER NOT NULL DEFAULT 0,
        first_seen  TEXT,
        last_seen   TEXT,
        PRIMARY KEY (date, hour, topic, msg_type)
      );
      CREATE INDEX IF NOT EXISTS idx_door_counts_bus ON door_counts(bus_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_door_counts_topic ON door_counts(topic, date DESC);
    `);

    upsertStmt = database.prepare(`
      INSERT INTO door_counts
        (date, hour, topic, bus_id, door, msg_type, evt_in, evt_out, messages, first_seen, last_seen)
      VALUES
        (@date, @hour, @topic, @bus_id, @door, @msg_type, @evt_in, @evt_out, 1, @ts, @ts)
      ON CONFLICT(date, hour, topic, msg_type) DO UPDATE SET
        evt_in    = evt_in  + @evt_in,
        evt_out   = evt_out + @evt_out,
        messages  = messages + 1,
        last_seen = @ts
    `);

    db = database;
    console.log('[doorlog] enabled — per-door counts to door_counts, API at /api/welfare/doors');
    return true;
  } catch (err) {
    console.error('[doorlog] init failed, continuing without per-door logging:', err.message);
    db = null;
    upsertStmt = null;
    return false;
  }
}

/**
 * Extract the door segment from a topic like `bus/002/door1/telemetry`.
 * Returns null when the topic carries no door element.
 * @param {string} topic
 * @returns {string|null}
 */
function doorFromTopic(topic) {
  if (typeof topic !== 'string') return null;
  const hit = topic.split('/').find((p) => /^door\d+$/i.test(p));
  return hit ? hit.toLowerCase() : null;
}

/**
 * Record one door message's contribution. Never throws.
 *
 * Called immediately before the merge window accumulates these deltas, which
 * is the last point at which they are still attributable to a single door.
 *
 * @param {object} o
 * @param {string} o.topic     full MQTT topic
 * @param {string} o.busId     merged bus label, e.g. '515'
 * @param {number} o.deltaIn   boardings from this message
 * @param {number} o.deltaOut  alightings from this message
 * @param {string} [o.msgType] 'trigger' or 'periodic'
 * @param {Date}   [o.at]      timestamp, defaults to now
 */
function recordDoor(o) {
  if (!upsertStmt) return;
  try {
    const at = o.at instanceof Date ? o.at : new Date();
    const iso = at.toISOString();
    const evtIn = Number(o.deltaIn) || 0;
    const evtOut = Number(o.deltaOut) || 0;

    // Nothing to attribute.
    if (evtIn === 0 && evtOut === 0) return;

    const row = {
      date: iso.slice(0, 10),
      hour: at.getUTCHours(),
      topic: String(o.topic ?? 'unknown'),
      bus_id: String(o.busId ?? 'unknown'),
      door: doorFromTopic(o.topic),
      msg_type: String(o.msgType ?? 'unknown'),
      evt_in: evtIn,
      evt_out: evtOut,
      ts: iso,
    };
    upsertStmt.run(row);

    recent.unshift({
      at: iso, topic: row.topic, bus_id: row.bus_id, door: row.door,
      msg_type: row.msg_type, evt_in: evtIn, evt_out: evtOut,
    });
    if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
  } catch (err) {
    console.error('[doorlog] record failed (APC unaffected):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Per-door totals with the in/out ratio, which is the number that answers the
 * inversion question. A balanced door sits near 1.00.
 * @param {{days?: number, from?: string, to?: string}} opts
 */
function summary(opts = {}) {
  if (!db) return { enabled: false, doors: [] };
  const where = [];
  const params = {};
  if (opts.from) { where.push('date >= @from'); params.from = opts.from; }
  if (opts.to) { where.push('date <= @to'); params.to = opts.to; }
  if (!opts.from && !opts.to && opts.days) {
    params.since = new Date(Date.now() - Number(opts.days) * 86400000)
      .toISOString().slice(0, 10);
    where.push('date >= @since');
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const doors = db.prepare(`
    SELECT topic, bus_id, door,
           SUM(evt_in)  AS evt_in,
           SUM(evt_out) AS evt_out,
           SUM(messages) AS messages,
           COUNT(DISTINCT date) AS days,
           MIN(first_seen) AS first_seen,
           MAX(last_seen)  AS last_seen
      FROM door_counts ${clause}
     GROUP BY topic, bus_id, door
     ORDER BY bus_id, topic
  `).all(params);

  return {
    enabled: true,
    window: { from: opts.from ?? params.since ?? null, to: opts.to ?? null },
    doors: doors.map((d) => ({
      ...d,
      // A door that only ever counts one direction is the strongest signal
      // that its orientation does not match the code's assumption.
      in_out_ratio: d.evt_out > 0 ? Number((d.evt_in / d.evt_out).toFixed(3)) : null,
      one_directional: d.evt_in === 0 || d.evt_out === 0,
    })),
    note: 'A balanced door sits near 1.00. Persistent one-directional counting, '
      + 'or two doors on the same bus with opposite ratios, indicates an '
      + 'orientation mismatch against the VS125 mapping in server.js:225.',
  };
}

/** Per-bus roll-up, comparable to the figures measured from `records`. */
function byBus(opts = {}) {
  if (!db) return [];
  const s = summary(opts);
  const acc = new Map();
  for (const d of s.doors) {
    const cur = acc.get(d.bus_id) ?? { bus_id: d.bus_id, evt_in: 0, evt_out: 0, doors: 0 };
    cur.evt_in += d.evt_in;
    cur.evt_out += d.evt_out;
    cur.doors += 1;
    acc.set(d.bus_id, cur);
  }
  return [...acc.values()].map((b) => ({
    ...b,
    in_out_ratio: b.evt_out > 0 ? Number((b.evt_in / b.evt_out).toFixed(3)) : null,
  }));
}

/** Daily series per door, for spotting the day a door changed behaviour. */
function daily(opts = {}) {
  if (!db) return [];
  const params = {};
  let clause = '';
  if (opts.bus) { clause = 'WHERE bus_id = @bus'; params.bus = String(opts.bus); }
  return db.prepare(`
    SELECT date, topic, door,
           SUM(evt_in) AS evt_in, SUM(evt_out) AS evt_out, SUM(messages) AS messages
      FROM door_counts ${clause}
     GROUP BY date, topic, door
     ORDER BY date DESC, topic
     LIMIT 500
  `).all(params);
}

// ---------------------------------------------------------------------------
// Router — mounted by welfare/index.js under /api/welfare
// ---------------------------------------------------------------------------

function createDoorRouter() {
  const router = express.Router();

  router.get('/doors', (req, res) => {
    try {
      res.json({
        ...summary({ days: Number(req.query.days) || undefined, from: req.query.from, to: req.query.to }),
        by_bus: byBus({ days: Number(req.query.days) || undefined, from: req.query.from, to: req.query.to }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/doors/daily', (req, res) => {
    try {
      res.json(daily({ bus: req.query.bus }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/doors/recent', (req, res) => {
    res.json(recent.slice(0, Math.min(RECENT_LIMIT, Number(req.query.limit) || 50)));
  });

  return router;
}

module.exports = {
  initDoorLog,
  recordDoor,
  createDoorRouter,
  summary,
  byBus,
  daily,
  doorFromTopic,
  isEnabled: () => Boolean(upsertStmt),
  ENABLED,
  // exported for the selftest
  _recent: recent,
};
