/* ==========================================================================
   SERVICE SCORECARD — productivity, service quality and passenger welfare
   --------------------------------------------------------------------------
   One endpoint, GET /api/scorecard?from&to, that turns the counts, stop
   visits and welfare incidents the system already holds into the handful of
   measures an operator or client reports each month:

     productivity   passengers, hours in service, passengers per hour,
                    passengers per loop, share of seats used
     service        typical gap against the timetable, gaps on target,
                    average wait, fullest point of each loop, loops full
     welfare        incidents and serious incidents per 1,000 passengers,
                    time to first response, urgent alerts answered within
                    5 minutes, time to close, driver "passenger OK" share

   Every measure is given for the period, the period before it (same
   length) and per route, plus a trend split into days, weeks or months.
   Targets are defaults that can be overridden with SCORECARD_TARGETS (JSON).
   Test alerts (source 'simulated') and sensor/system events are excluded.
   ========================================================================== */

const { analyseRoute } = require('./service');

const DAY_MS = 86400000;
const URGENT_SLA_MIN = 5; // matches the Level 4 escalation SLA in welfare/index.js

// Sensor and housekeeping events are not passenger welfare incidents.
const SYSTEM_EVENT = /^(sensor_|shift_|data_quality|heartbeat)|_recovered$/;

// Direction: 'up' = higher is better, 'down' = lower is better.
// green/amber are thresholds; anything worse than amber is red.
const DEFAULT_TARGETS = {
  pax_per_hour:      { dir: 'up',   green: 10, amber: 6,  unit: '/h' },
  seat_use:          { dir: 'up',   green: 30, amber: 15, unit: '%' },
  on_target:         { dir: 'up',   green: 90, amber: 75, unit: '%' },
  wait_vs_timetable: { dir: 'down', green: 2,  amber: 5,  unit: 'min' }, // minutes over half the timetable gap
  peak_load:         { dir: 'down', green: 85, amber: 100, unit: '%' },
  loops_full:        { dir: 'down', green: 5,  amber: 10, unit: '%' },
  // No national benchmark for incident rates, so these are judged against the
  // previous period: green if no worse, amber if up to 10% worse, red beyond.
  incidents_per_k:   { dir: 'down', mode: 'trend', amber_pct: 10, unit: '/1k' },
  serious_per_k:     { dir: 'down', mode: 'trend', amber_pct: 10, unit: '/1k' },
  response_median:   { dir: 'down', green: 5,  amber: 15, unit: 'min' },
  urgent_in_sla:     { dir: 'up',   green: 95, amber: 80, unit: '%' },
  close_median:      { dir: 'down', green: 30, amber: 60, unit: 'min' },
};

function loadTargets() {
  try {
    if (process.env.SCORECARD_TARGETS) {
      const o = JSON.parse(process.env.SCORECARD_TARGETS);
      const t = JSON.parse(JSON.stringify(DEFAULT_TARGETS));
      for (const [k, v] of Object.entries(o || {})) if (t[k] && v && typeof v === 'object') Object.assign(t[k], v);
      return t;
    }
  } catch (_) { /* fall back to defaults */ }
  return DEFAULT_TARGETS;
}

function round(n, dp = 1) {
  if (n == null || !isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
function dateMs(d) { return Date.parse(d + 'T00:00:00Z'); }
function minutesBetween(a, b) {
  const x = Date.parse(a); const y = Date.parse(b);
  return isFinite(x) && isFinite(y) && y >= x ? (y - x) / 60000 : null;
}

function rag(key, value, targets, prevValue) {
  const t = targets[key];
  if (!t || value == null) return null;
  if (t.mode === 'trend') {
    if (prevValue == null) return null;
    const slack = Math.abs(prevValue) * ((t.amber_pct || 10) / 100);
    const worse = t.dir === 'up' ? prevValue - value : value - prevValue;
    return worse <= 0 ? 'green' : worse <= slack ? 'amber' : 'red';
  }
  if (t.dir === 'up') return value >= t.green ? 'green' : value >= t.amber ? 'amber' : 'red';
  return value <= t.green ? 'green' : value <= t.amber ? 'amber' : 'red';
}

/**
 * Pure: compute the scorecard measures for one route (or the whole fleet when
 * given several route analyses) from already-fetched inputs.
 *
 * @param {object} p
 *   analyses  array of analyseRoute() results
 *   hours     array of { date, hour, bus_id, boardings } rows with service
 *   events    array of welfare_events rows (already filtered to the period)
 */
function measures({ analyses, hours, events }) {
  // ---- productivity ----
  const passengers = hours.reduce((s, h) => s + (h.boardings || 0), 0);
  const serviceHours = hours.length; // one row per bus per local hour with data
  let loops = 0; let loopsFull = 0; let loopsBusy = 0; let peakSum = 0; let peakN = 0;
  let loadSum = 0; let visits = 0; let cap = 16;
  let gapW = 0; let onTargetW = 0; let gapMedW = 0; let headwayW = 0; let waitW = 0; let ttWaitW = 0; let gapN = 0;
  for (const a of analyses) {
    cap = a.load.capacity || cap;
    const c = a.crowding;
    loops += c.loops || 0; loopsFull += c.loops_full || 0; loopsBusy += c.loops_busy || 0;
    if (c.peak_load_factor != null && c.loops) { peakSum += c.peak_load_factor * c.loops; peakN += c.loops; }
    for (const s of a.load.stops) { loadSum += s.avg_load * s.visits; visits += s.visits; }
    const g = a.gaps;
    if (g.count) {
      const w = g.count;
      gapN += w;
      if (g.on_target != null) { onTargetW += g.on_target * w; gapW += w; }
      if (g.median != null) gapMedW += g.median * w;
      if (g.headway != null) headwayW += g.headway * w;
      const wait = g.partial ? g.timetable_wait : g.wait;
      if (wait != null) waitW += wait * w;
      if (g.timetable_wait != null) ttWaitW += g.timetable_wait * w;
    }
  }
  const seatUse = visits ? (loadSum / visits / cap) * 100 : null;
  const wait = gapN ? waitW / gapN : null;
  const ttWait = gapN ? ttWaitW / gapN : null;

  // ---- welfare ----
  const inc = events.filter((e) => !SYSTEM_EVENT.test(e.event_type || ''));
  const serious = inc.filter((e) => (e.severity || 0) >= 3);
  const urgent = inc.filter((e) => (e.severity || 0) >= 4);
  const firstResponse = (e) => {
    const t = [minutesBetween(e.detected_at, e.acknowledged_at), minutesBetween(e.detected_at, e.driver_response_at)].filter((x) => x != null);
    return t.length ? Math.min(...t) : null;
  };
  const resp = inc.map(firstResponse).filter((x) => x != null);
  const urgentResp = urgent.map(firstResponse);
  const closeT = inc.filter((e) => e.resolved).map((e) => minutesBetween(e.detected_at, e.resolved_at)).filter((x) => x != null);
  const answered = inc.filter((e) => e.driver_response === 'ok' || e.driver_response === 'help');
  const byType = {};
  for (const e of inc) byType[e.event_type] = (byType[e.event_type] || 0) + 1;

  return {
    productivity: {
      passengers,
      service_hours: serviceHours,
      pax_per_hour: serviceHours ? round(passengers / serviceHours, 1) : null,
      loops,
      pax_per_loop: loops ? round(passengers / loops, 1) : null,
      seat_use: round(seatUse, 0),
      capacity: cap,
    },
    service: {
      gap_median: gapN ? round(gapMedW / gapN, 1) : null,
      headway: gapN && headwayW ? round(headwayW / gapN, 1) : null,
      on_target: gapW ? round(onTargetW / gapW, 0) : null,
      wait: round(wait, 1),
      timetable_wait: round(ttWait, 1),
      wait_vs_timetable: wait != null && ttWait != null ? round(Math.max(0, wait - ttWait), 1) : null,
      peak_load: peakN ? round(peakSum / peakN, 0) : null,
      loops_full: loops ? round((loopsFull / loops) * 100, 1) : null,
      loops_full_n: loopsFull,
      loops_busy_n: loopsBusy,
    },
    welfare: {
      incidents: inc.length,
      serious: serious.length,
      urgent: urgent.length,
      incidents_per_k: passengers ? round((inc.length / passengers) * 1000, 1) : null,
      serious_per_k: passengers ? round((serious.length / passengers) * 1000, 2) : null,
      response_median: round(median(resp), 1),
      urgent_in_sla: urgent.length ? round((urgentResp.filter((x) => x != null && x <= URGENT_SLA_MIN).length / urgent.length) * 100, 0) : null,
      close_median: round(median(closeT), 0),
      open: inc.filter((e) => !e.resolved).length,
      driver_answered: answered.length,
      passenger_ok: answered.length ? round((answered.filter((e) => e.driver_response === 'ok').length / answered.length) * 100, 0) : null,
      need_help: answered.filter((e) => e.driver_response === 'help').length,
      by_type: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, n })),
    },
  };
}

function withRag(m, targets, prev) {
  const r = {};
  const pv = { incidents_per_k: prev && prev.welfare.incidents_per_k, serious_per_k: prev && prev.welfare.serious_per_k };
  const pick = { pax_per_hour: m.productivity.pax_per_hour, seat_use: m.productivity.seat_use,
    on_target: m.service.on_target, wait_vs_timetable: m.service.wait_vs_timetable, peak_load: m.service.peak_load,
    loops_full: m.service.loops_full, incidents_per_k: m.welfare.incidents_per_k, serious_per_k: m.welfare.serious_per_k,
    response_median: m.welfare.response_median, urgent_in_sla: m.welfare.urgent_in_sla, close_median: m.welfare.close_median };
  for (const [k, v] of Object.entries(pick)) r[k] = rag(k, v, targets, pv[k]);
  return { ...m, rag: r };
}

/** Days, weeks (Mon start) or calendar months, depending on period length. */
function buckets(from, to) {
  const a = dateMs(from); const b = dateMs(to);
  const days = Math.round((b - a) / DAY_MS) + 1;
  const out = [];
  if (days <= 14) {
    for (let t = a; t <= b; t += DAY_MS) out.push({ from: isoDate(t), to: isoDate(t), unit: 'day' });
  } else if (days <= 120) {
    let t = a;
    while (t <= b) {
      const dow = (new Date(t).getUTCDay() + 6) % 7; // Mon = 0
      const end = Math.min(b, t + (6 - dow) * DAY_MS);
      out.push({ from: isoDate(t), to: isoDate(end), unit: 'week' });
      t = end + DAY_MS;
    }
  } else {
    let t = a;
    while (t <= b) {
      const d = new Date(t);
      const end = Math.min(b, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      out.push({ from: isoDate(t), to: isoDate(end), unit: 'month' });
      t = end + DAY_MS;
    }
  }
  return out;
}

function createScorecardRouter({ express, db, getRegistry, capacity, tz }) {
  const router = express.Router();
  const re = /^\d{4}-\d{2}-\d{2}$/;

  const recStmt = db.prepare(`SELECT timestamp, date, bus_id, stop, evt_in, evt_out, onboard
    FROM records
    WHERE date BETWEEN @from AND @to AND stop != '-' AND msg_type != 'RESET'
      AND (route = @route OR bus_id IN (SELECT value FROM json_each(@buses)))
    ORDER BY bus_id, timestamp`);
  const hourStmt = db.prepare(`SELECT date, hour, bus_id, boardings FROM hourly_summary
    WHERE date BETWEEN @from AND @to AND msg_count > 0`);
  // Prepared on first use: the welfare table may be created after this router.
  let evStmt = null;
  const getEvStmt = () => {
    if (evStmt) return evStmt;
    evStmt = db.prepare(`SELECT detected_at, date, bus_id, route, event_type, severity, acknowledged_at,
        resolved, resolved_at, driver_response, driver_response_at
      FROM welfare_events WHERE date BETWEEN @from AND @to AND source != 'simulated'`);
    return evStmt;
  };

  function compute(from, to) {
    const registry = getRegistry() || {};
    const routes = Object.entries(registry.routes || {}).map(([key, r]) => ({ key: String(key), ...r, bus_ids: (r.bus_ids || []).map(String) }));
    const busToRoute = new Map();
    for (const r of routes) for (const b of r.bus_ids) busToRoute.set(b, r.key);
    const hours = hourStmt.all({ from, to });
    let events = [];
    try { events = getEvStmt().all({ from, to }); } catch (_) { events = []; } // no welfare table yet

    const perRoute = routes.map((r) => {
      const rows = recStmt.all({ from, to, route: r.key, buses: JSON.stringify(r.bus_ids) });
      const a = analyseRoute(r, rows, { capacity, tz });
      return {
        key: r.key, name: r.name || `Route ${r.key}`, analysis: a, rows,
        hours: hours.filter((h) => busToRoute.get(String(h.bus_id)) === r.key),
        events: events.filter((e) => (e.route && String(e.route) === r.key) || (!e.route && busToRoute.get(String(e.bus_id)) === r.key)),
      };
    });
    return { routes, perRoute, hours, events };
  }

  router.get('/scorecard', (req, res) => {
    try {
      const targets = loadTargets();
      const to = re.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0, 10);
      const from = re.test(req.query.from || '') && req.query.from <= to ? req.query.from : isoDate(dateMs(to) - 29 * DAY_MS);
      const len = Math.round((dateMs(to) - dateMs(from)) / DAY_MS) + 1;
      const prevTo = isoDate(dateMs(from) - DAY_MS);
      const prevFrom = isoDate(dateMs(from) - len * DAY_MS);

      const cur = compute(from, to);
      const prev = compute(prevFrom, prevTo);

      // Fleet uses every bus's hours and every passenger incident, so buses
      // not yet assigned to a route still count.
      const fleetPrev = measures({ analyses: prev.perRoute.map((p) => p.analysis), hours: prev.hours, events: prev.events });
      const fleet = withRag(measures({ analyses: cur.perRoute.map((p) => p.analysis), hours: cur.hours, events: cur.events }), targets, fleetPrev);

      const routes = cur.perRoute.map((p) => {
        const pp = prev.perRoute.find((x) => x.key === p.key);
        const previous = pp ? measures({ analyses: [pp.analysis], hours: pp.hours, events: pp.events }) : null;
        return {
          route: p.key,
          name: p.name,
          current: withRag(measures({ analyses: [p.analysis], hours: p.hours, events: p.events }), targets, previous),
          previous,
        };
      });

      // Trend: re-run on each bucket from the rows already loaded.
      const trend = buckets(from, to).map((bk) => {
        const inB = (d) => d >= bk.from && d <= bk.to;
        const analyses = cur.perRoute.map((p) => analyseRoute(cur.routes.find((r) => r.key === p.key), p.rows.filter((r) => inB(r.date)), { capacity, tz }));
        const m = measures({ analyses, hours: cur.hours.filter((h) => inB(h.date)), events: cur.events.filter((e) => inB(e.date)) });
        return {
          ...bk,
          passengers: m.productivity.passengers,
          service_hours: m.productivity.service_hours,
          pax_per_hour: m.productivity.pax_per_hour,
          seat_use: m.productivity.seat_use,
          on_target: m.service.on_target,
          peak_load: m.service.peak_load,
          incidents: m.welfare.incidents,
          incidents_per_k: m.welfare.incidents_per_k,
          response_median: m.welfare.response_median,
        };
      });

      res.json({
        from, to, tz, days: len,
        previous: { from: prevFrom, to: prevTo },
        targets,
        fleet: { current: fleet, previous: fleetPrev },
        routes,
        trend,
        notes: {
          service_hours: 'Hours in which a bus reported data, counted per bus per local hour.',
          incidents: 'Passenger welfare incidents only; sensor/system events and test alerts are excluded.',
          urgent_sla_minutes: URGENT_SLA_MIN,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  return router;
}

module.exports = { createScorecardRouter, measures, buckets, rag, DEFAULT_TARGETS, SYSTEM_EVENT };
