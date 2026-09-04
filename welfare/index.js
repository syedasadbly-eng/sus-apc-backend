/* ============================================
   WELFARE MODULE — integration surface
   Smart Urban Sensing

   Everything the welfare development interface needs, behind one flag.
   server.js touches this module in exactly three places (see INTEGRATION.md).

   Safety properties:
     - Additive only. One new table, no change to records / hourly_summary /
       daily_summary / bus_state, so no existing query is affected.
     - Disabled unless FEATURE_WELFARE=true. When off, no table is created,
       no route is mounted and no timer runs.
     - Every hook is wrapped so a welfare fault can never break the APC
       ingest path or the Mayo dashboard.
   ============================================ */

'use strict';

const express = require('express');
const { WelfareEngine, SEVERITY } = require('./engine');
const doorlog = require('./doorlog');
const occupancy = require('./occupancy');

const ENABLED = process.env.FEATURE_WELFARE === 'true';

// Second, independent gate for the dev write endpoints: /simulate,
// /simulate/observe and /simulate/purge. Defaults to OFF, so enabling
// FEATURE_WELFARE on a client-facing service does not also hand its users
// event injection and a purge button.
const ALLOW_SIM = process.env.WELFARE_ALLOW_SIM === 'true';

// ---------------------------------------------------------------------------
// SQLite store
// ---------------------------------------------------------------------------

function createStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS welfare_events (
      event_id       TEXT PRIMARY KEY,
      detected_at    TEXT    NOT NULL,
      date           TEXT    NOT NULL,
      bus_id         TEXT    NOT NULL,
      source         TEXT    NOT NULL DEFAULT 'vs125',
      event_type     TEXT    NOT NULL,
      severity       INTEGER NOT NULL DEFAULT 1,
      rule           TEXT,
      reason         TEXT,
      use_case       INTEGER,
      route          TEXT,
      lat            REAL,
      lng            REAL,
      onboard        INTEGER,
      sensor_health  TEXT,
      acknowledged   INTEGER NOT NULL DEFAULT 0,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      detail         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_welfare_detected ON welfare_events(detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_welfare_bus ON welfare_events(bus_id, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_welfare_type ON welfare_events(event_type, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_welfare_sev ON welfare_events(severity, detected_at DESC);
  `);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO welfare_events
      (event_id, detected_at, date, bus_id, source, event_type, severity, rule, reason,
       use_case, route, lat, lng, onboard, sensor_health, acknowledged, detail)
    VALUES
      (@event_id, @detected_at, @date, @bus_id, @source, @event_type, @severity, @rule, @reason,
       @use_case, @route, @lat, @lng, @onboard, @sensor_health, 0, @detail)
  `);

  return {
    insert(row) {
      insertStmt.run({
        event_id: row.event_id,
        detected_at: row.detected_at,
        date: row.detected_at.slice(0, 10),
        bus_id: row.bus_id,
        source: row.source,
        event_type: row.event_type,
        severity: row.severity,
        rule: row.rule ?? null,
        reason: row.reason ?? null,
        use_case: row.use_case ?? null,
        route: row.route ?? null,
        lat: Number.isFinite(row.lat) ? row.lat : null,
        lng: Number.isFinite(row.lng) ? row.lng : null,
        onboard: row.onboard ?? null,
        sensor_health: row.sensor_health ?? null,
        detail: row.detail ? JSON.stringify(row.detail) : null,
      });
    },

    query({ limit = 100, busId, eventType, minSeverity, from, to, unackOnly } = {}) {
      const where = [];
      const params = {};
      if (busId) { where.push('bus_id = @busId'); params.busId = busId; }
      if (eventType) { where.push('event_type = @eventType'); params.eventType = eventType; }
      if (minSeverity) { where.push('severity >= @minSeverity'); params.minSeverity = Number(minSeverity); }
      if (from) { where.push('detected_at >= @from'); params.from = from; }
      if (to) { where.push('detected_at <= @to'); params.to = to; }
      if (unackOnly) where.push('acknowledged = 0');
      const sql = `SELECT * FROM welfare_events
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY detected_at DESC LIMIT @limit`;
      params.limit = Math.min(1000, Number(limit) || 100);
      return db.prepare(sql).all(params).map(hydrate);
    },

    /**
     * Aggregates for the dev interface.
     *
     * Defaults to REAL events only. Simulated rows are written by the test
     * buttons with hardcoded severities and are indistinguishable from real
     * ones in a GROUP BY, so counting them corrupts exactly the numbers used
     * to tune thresholds: on 3 Sep the volume chart read 20 events when 14
     * were real. Callers that genuinely want the test rows (Rules & Testing)
     * pass includeSimulated.
     */
    stats(days = 7, includeSimulated = false) {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const simClause = includeSimulated ? '' : " AND source != 'simulated'";
      const w = `WHERE detected_at >= ?${simClause}`;
      const sevCols = `SUM(CASE WHEN severity >= 3 THEN 1 ELSE 0 END) AS alerts`;
      return {
        by_type: db.prepare(`SELECT event_type, COUNT(*) AS n, MAX(detected_at) AS last_seen
          FROM welfare_events ${w} GROUP BY event_type ORDER BY n DESC`).all(since),
        by_day: db.prepare(`SELECT date, COUNT(*) AS n, ${sevCols}
          FROM welfare_events ${w} GROUP BY date ORDER BY date`).all(since),
        by_bus: db.prepare(`SELECT bus_id, COUNT(*) AS n, ${sevCols}
          FROM welfare_events ${w} GROUP BY bus_id ORDER BY n DESC`).all(since),
        totals: db.prepare(`SELECT COUNT(*) AS total, ${sevCols},
            SUM(CASE WHEN severity = 4 THEN 1 ELSE 0 END) AS escalations,
            SUM(CASE WHEN acknowledged = 0 AND severity >= 3 THEN 1 ELSE 0 END) AS unacknowledged
          FROM welfare_events ${w}`).get(since),
        // Always reported, so the interface can say how many test rows were
        // excluded rather than silently dropping them.
        simulated_excluded: includeSimulated ? 0
          : db.prepare(`SELECT COUNT(*) AS n FROM welfare_events
              WHERE detected_at >= ? AND source = 'simulated'`).get(since).n,
        includes_simulated: includeSimulated,
        window_days: days,
      };
    },

    /** Per-event-type totals from the DB, real events only. Survives restart. */
    countsByType(days = 7) {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const rows = db.prepare(`SELECT event_type, COUNT(*) AS n FROM welfare_events
        WHERE detected_at >= ? AND source != 'simulated' GROUP BY event_type`).all(since);
      const out = Object.create(null);
      for (const r of rows) out[r.event_type] = r.n;
      return out;
    },

    acknowledge(eventId, by) {
      const r = db.prepare(`UPDATE welfare_events
        SET acknowledged = 1, acknowledged_at = ?, acknowledged_by = ?
        WHERE event_id = ?`).run(new Date().toISOString(), by || 'dev-console', eventId);
      return r.changes > 0;
    },

    purgeAll() {
      return db.prepare('DELETE FROM welfare_events').run().changes;
    },
  };
}

function hydrate(r) {
  let detail = null;
  if (r.detail) { try { detail = JSON.parse(r.detail); } catch { detail = null; } }
  return { ...r, detail, severity_name: { 1: 'log', 2: 'notify', 3: 'alert', 4: 'escalate' }[r.severity] };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function createRouter(engine, store, meta) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({
      enabled: true,
      allow_sim: ALLOW_SIM,
      topic_mode: meta.topicMode,
      camera_connected: false,
      started_at: meta.startedAt,
      config: engine.config(),
      counters: engine.counters,
    });
  });

  router.get('/signals', (req, res) => {
    // Counts come from the database, not engine.counters. The in-memory
    // counters reset to {} on every restart, so this column read 0 for every
    // signal after each deploy while 15 real events sat in the table.
    let counts;
    try { counts = store.countsByType(7); } catch { counts = null; }
    // Summary and rows are built from the SAME counts snapshot on purpose.
    // Two requests would let the header disagree with the table beneath it.
    // `?shape=array` preserves the original bare-array response for any
    // caller written against it.
    const rows = engine.signals(counts);
    if (req.query.shape === 'array') { res.json(rows); return; }
    res.json({ summary: engine.signalSummary(counts), signals: rows });
  });

  router.get('/fleet-health', (req, res) => res.json(engine.fleetHealth()));

  router.get('/events', (req, res) => {
    try {
      res.json(store.query({
        limit: req.query.limit,
        busId: req.query.bus,
        eventType: req.query.type,
        minSeverity: req.query.min_severity,
        from: req.query.from,
        to: req.query.to,
        unackOnly: req.query.unack === 'true',
      }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/events/live', (req, res) => res.json(engine.recent.slice(0, Number(req.query.limit) || 50)));

  router.get('/stats', (req, res) => {
    try {
      res.json(store.stats(Number(req.query.days) || 7, req.query.include_simulated === 'true'));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/events/:id/ack', (req, res) => {
    const ok = store.acknowledge(req.params.id, req.body?.by);
    res.status(ok ? 200 : 404).json({ acknowledged: ok });
  });

  // ---- Dev-only simulation ------------------------------------------------
  // Lets the interface be exercised and demonstrated before the camera is
  // fitted. Writes into welfare_events flagged source='simulated'.
  // Single guard for all three dev write endpoints.
  const requireSim = (req, res, next) => {
    if (!ALLOW_SIM) {
      return res.status(403).json({
        error: 'Simulation is disabled on this instance',
        hint: 'Set WELFARE_ALLOW_SIM=true to enable. Do not set it on a client-facing service.',
      });
    }
    return next();
  };

  router.post('/simulate', requireSim, (req, res) => {
    const { bus_id: busId = '515', scenario = 'lone_night' } = req.body ?? {};
    const scenarios = {
      lone_night: {
        event_type: 'lone_traveller_late_night', severity: SEVERITY.ALERT,
        rule: 'R4_lone_traveller_late_night', use_case: 6,
        reason: 'Simulated: single occupant for 7 min on an off-peak service',
      },
      end_of_service: {
        event_type: 'end_of_service_occupancy', severity: SEVERITY.ESCALATE,
        rule: 'R6_end_of_service_occupancy', use_case: 6,
        reason: 'Simulated: 1 passenger still aboard at the depot after 6 min stationary',
      },
      sensor_offline: {
        event_type: 'sensor_offline', severity: SEVERITY.ALERT,
        rule: 'R12_sensor_health', reason: 'Simulated: no data for 31 min',
      },
      stuck_counter: {
        event_type: 'sensor_suspect', severity: SEVERITY.NOTIFY,
        rule: 'R12_sensor_health', reason: 'Simulated: no count change in 48 min over 6.2 km',
      },
      fall: {
        event_type: 'fall', severity: SEVERITY.ALERT,
        rule: 'camera_fall', use_case: 2, reason: 'Simulated camera event: passenger fall detected',
      },
      violence: {
        event_type: 'violence', severity: SEVERITY.ESCALATE,
        rule: 'camera_violence', use_case: 7, reason: 'Simulated camera event: violent behaviour detected',
      },
    };
    const s = scenarios[scenario];
    if (!s) return res.status(400).json({ error: `Unknown scenario. Options: ${Object.keys(scenarios).join(', ')}` });

    const nowIso = new Date().toISOString();
    const row = {
      event_id: `sim-${busId}-${scenario}-${Date.now()}`,
      bus_id: busId, source: 'simulated',
      detected_at: nowIso, ...s,
      route: null, lat: null, lng: null, onboard: null,
      sensor_health: 'simulated', detail: { simulated: true, scenario },
      severity_name: { 1: 'log', 2: 'notify', 3: 'alert', 4: 'escalate' }[s.severity],
      acknowledged: 0,
    };
    try { store.insert(row); } catch (err) { return res.status(500).json({ error: err.message }); }
    engine.recent.unshift(row);
    if (engine.recent.length > engine.recentLimit) engine.recent.length = engine.recentLimit;
    engine.counters[s.event_type] = (engine.counters[s.event_type] ?? 0) + 1;
    res.json({ created: row });
  });

  router.post('/simulate/purge', requireSim, (req, res) => {
    res.json({ deleted: store.purgeAll() });
  });

  /**
   * Dev-only: push observations straight into the rule engine, exactly as
   * server.js does from the live MQTT feed. This exercises the real rule path
   * rather than writing a canned row, which is what /simulate does.
   *
   * Body: a single observation object, or { observations: [ ... ] }.
   * Fields match engine.ingest(): busId, onboard, dayIn, dayOut, lat, lng,
   * speed, gpsValid, route, ts.
   */
  /* Simulated observations go through the SAME occupancy substitution as the
     live MQTT path. They did not, which made every rule test on this service
     a test of raw counts while production ran on the modelled tally — the one
     difference most likely to change whether a rule fires at all. Pass
     rawOccupancy:true to deliberately test the unmodelled path. */
  router.post('/simulate/observe', requireSim, (req, res) => {
    const body = req.body ?? {};
    const list = Array.isArray(body.observations) ? body.observations : [body];
    const useRaw = body.rawOccupancy === true;
    const raised = [];
    try {
      list.forEach((o) => {
        if (!o || !o.busId) return;
        raised.push(...(engine.ingest(useRaw ? o : applyDerivedOccupancy(o)) ?? []));
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    return res.json({
      observed: list.length,
      occupancy_source: useRaw ? 'raw' : engine.occupancyBasis().source,
      raised,
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let engine = null;
let store = null;

/**
 * Call once after `db` and `app` exist in server.js.
 * Returns null when the feature flag is off.
 */
function initWelfare(app, db, opts = {}) {
  if (!ENABLED) {
    console.log('[welfare] disabled (set FEATURE_WELFARE=true to enable)');
    return null;
  }
  try {
    store = createStore(db);
    engine = new WelfareEngine({ store, config: opts.config });

    const meta = { startedAt: new Date().toISOString(), topicMode: opts.topicMode ?? 'bus/#' };
    app.use('/api/welfare', createRouter(engine, store, meta));

    // Per-door count logging. Separate table, separate routes, and its own
    // try/catch so a failure here cannot stop the welfare API mounting.
    try {
      if (doorlog.initDoorLog(db)) app.use('/api/welfare', doorlog.createDoorRouter());
    } catch (err) {
      console.error('[doorlog] mount failed, continuing without it:', err.message);
    }

    // Derived occupancy. Welfare console only — see the header of
    // occupancy.js for why this exists and what it deliberately does not do.
    try {
      if (occupancy.initOccupancy(db, { capacity: opts.capacity })) {
        app.use('/api/welfare', occupancy.createOccupancyRouter());
      }
    } catch (err) {
      console.error('[occupancy] mount failed, continuing on raw counts:', err.message);
    }

    // Tell the engine which figure its rules are being fed. observe() below
    // does the substitution, so this must agree with occupancy.isEnabled() or
    // the console will misreport its own data basis — which it did: with no
    // bus in memory after a restart it inferred "measured" from an empty
    // vehicle map while the model was live and calibrated.
    engine.setOccupancyMode(occupancy.isEnabled() ? 'modelled' : 'raw');
    console.log(`[welfare] rules read ${occupancy.isEnabled() ? 'MODELLED' : 'raw'} occupancy`);

    engine.on('alert', (row) => {
      console.log(`[welfare] ${String(row.severity_name).toUpperCase()} ${row.bus_id} ${row.event_type}: ${row.reason}`);
    });

    const timer = setInterval(() => {
      try { engine.sweep(); } catch (err) { console.error('[welfare] sweep error:', err.message); }
    }, 60000);
    if (timer.unref) timer.unref();

    console.log('[welfare] enabled — API at /api/welfare, UI under the Welfare menu');
    console.log(`[welfare] depots: ${engine.cfg.depots.map((d) => d.name).join(', ') || 'none configured'}`);
    return engine;
  } catch (err) {
    console.error('[welfare] init failed, continuing without welfare:', err.message);
    engine = null;
    return null;
  }
}

/**
 * Feed one observation. Safe to call unconditionally — no-op when disabled.
 * Never throws.
 */
/* Substitute the derived occupancy before the engine sees the reading, so the
   rules run on a tally that can return to zero. The raw counter travels
   alongside as onboardRaw and is what the console displays as measured.

   Deliberately the only place this swap happens: server.js has already
   committed the true value to `records` by this point, so nothing upstream
   and nothing the Mayo dashboard reads can be reached from here. */
function applyDerivedOccupancy(o) {
  if (!occupancy.isEnabled()) return o;
  const model = occupancy.derive({
    busId: o.busId,
    dayIn: o.dayIn,
    dayOut: o.dayOut,
    onboardRaw: o.onboard,
  });
  if (!model.derived) return o;
  return {
    ...o,
    onboard: model.onboard,
    onboardRaw: model.onboard != null ? o.onboard : null,
    occupancyModel: model,
  };
}

function observe(o) {
  if (!engine) return;
  let reading = o;
  // Wrapped separately: if the model throws, welfare must still see the raw
  // reading rather than lose the observation entirely.
  try {
    reading = applyDerivedOccupancy(o);
  } catch (err) {
    console.error('[occupancy] derive failed, falling back to raw count:', err.message);
    reading = o;
  }
  try { engine.ingest(reading); } catch (err) {
    console.error('[welfare] ingest error:', err.message);
  }
}

module.exports = { initWelfare, observe, isEnabled: () => Boolean(engine), ENABLED };
